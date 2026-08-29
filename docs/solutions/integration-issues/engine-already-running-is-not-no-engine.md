---
title: "EngineAlreadyRunningError means an engine IS running, not 'no engine'"
date: "2026-06-21"
category: integration-issues
module: "packages/engine project-engine-manager + packages/dashboard server health"
problem_type: integration_issue
component: tooling
symptoms:
  - "Dashboard shows a persistent 'engine not running' banner even though an engine is running"
  - "Logs repeat 'Refusing to start engine for <projectId>: Another engine is already running...' every 30s reconciliation tick"
  - "Reconciliation tries to start engines for N projects, then errors because each is already running"
root_cause: logic_error
resolution_type: code_fix
severity: medium
last_updated: "2026-06-21"
related_components:
  - engine
  - dashboard
  - development_workflow
tags:
  - engine-singleton-lock
  - multi-process
  - reconciliation
  - dashboard-health
  - regression
related_prs:
  - "https://github.com/Runfusion/Fusion/pull/1704"
  - "https://github.com/Runfusion/Fusion/pull/1699"
---

## Problem

Starting a second fusion process (e.g. `pnpm dev dashboard --no-auth` while an installed `pnpm fusion` is already running) showed a false **"engine not running"** banner — even though an engine was live on the machine for every project.

## Symptoms

- Banner visible despite a running engine.
- Repeating log line every reconciliation tick: `Refusing to start engine for <projectId>: Another engine is already running for project <projectId> on this machine (blocked by socket)`.
- The collision affects every registered project (the log "tries to start engines for two projects then refuses" maps 1:1 to the live `fusion-engine-<hash>.sock` files under `$TMPDIR`).

## What Didn't Work

- Looking only at the dashboard frontend / banner component — the banner faithfully renders `dashboardHealth.engine.available === false`; the wrong value comes from the server.
- Treating it as a warm-up race (engines still starting in the background). The banner is *permanent*, not transient: reconciliation retries forever and keeps refusing, because the lock is held by a **different process** that never exits.
- **Tempting wrong fix: make `reconcile()`/`has()` treat external engines as "owned" so it stops retrying.** This would silence the logs but break failover — the process would never re-attempt and never adopt the socket when the holder dies. `has()` (this-process-owns) and `hasRunningEngine()` (machine-level truth) must stay *separate*: reconciliation keys off `has()` and keeps retrying; the banner keys off `hasRunningEngine()`.

## Root Cause

The engine uses a **per-machine singleton lock** (`packages/engine/src/engine-singleton-lock.ts`): a lockfile under `<workingDir>/.fusion/engine.lock` plus a loopback socket `fusion-engine-<sha1(projectId)[:16]>.sock` (the hash is the first 16 hex chars of the sha1, not the full digest). Only one fusion process may own the engine for a given project. When a second process launches, `acquireEngineSingleton` correctly throws `EngineAlreadyRunningError` — **positive proof an engine is live** for that project.

But that proof was discarded. In `ProjectEngineManager.createAndStart` the catch logged "Refusing to start" and rethrew **without recording that an engine exists**. The dashboard's health check `hasDashboardEngine` (`packages/dashboard/src/server.ts`) then only counted engines *this* process owns:

```ts
// before
function hasDashboardEngine(options?: ServerOptions): boolean {
  const engines = options?.engineManager?.getAllEngines?.();
  return Boolean(options?.engine || (engines && engines.size > 0));
}
```

So `getAllEngines()` was empty → `/api/health` reported `engine.available: false` → banner. Three views of "is an engine running" disagreed: the singleton lock (machine truth: *yes*), reconciliation's `has()` (this-process-owns: *no*), and the banner (this-process-owns: *no*).

Surfaced by `feat: start engines by default` (#1699), which made the dashboard actively attempt engine startup instead of running UI-only.

## Solution

Track engines owned by **another** process and report them as available, while still retrying so this process can take over if the other dies.

```ts
// ProjectEngineManager
private externalEngines = new Set<string>();

hasRunningEngine(): boolean {
  return this.engines.size > 0 || this.externalEngines.size > 0;
}

// in createAndStart's acquireEngineSingleton catch:
if (err instanceof EngineAlreadyRunningError) {
  if (!this.externalEngines.has(projectId)) {       // log once, not every tick
    runtimeLog.warn(`Refusing to start engine for ${projectId}: ${err.message}`);
  }
  this.externalEngines.add(projectId);
}
throw err;

// after acquiring the lock (BEFORE engine.start()): this.externalEngines.delete(projectId);
//   — acquiring proves no other process owns it; clearing here (not after a
//     successful start()) avoids a phantom entry if start() then throws.
// in stopAll(): this.externalEngines.clear();
```

The outer fire-and-forget catches that drive startup — `reconcile()`, `startAll()`, and `onProjectAccessed()` — early-return on `EngineAlreadyRunningError` so they don't re-log `Failed to start engine…` on every 30s tick (`createAndStart` already logged it once). Only genuinely unexpected errors warn.

```ts
// dashboard server.ts — consult machine-level truth, fall back for old managers/test doubles
function hasDashboardEngine(options?: ServerOptions): boolean {
  if (options?.engine) return true;
  const manager = options?.engineManager;
  if (!manager) return false;
  if (typeof manager.hasRunningEngine === "function") return manager.hasRunningEngine();
  const engines = manager.getAllEngines?.();
  return Boolean(engines && engines.size > 0);
}
```

Reconciliation deliberately keeps retrying (it does NOT treat external engines as `has()`), so when the lock-holder exits this process acquires the lock and clears the external marker — verified live: killing the holder let the dev dashboard immediately adopt the socket.

## Why This Works

`EngineAlreadyRunningError` is the *only* signal that distinguishes "no engine anywhere" from "an engine runs in another process." Capturing it makes the dashboard report machine-level reality instead of process-local ownership. Automation still runs because the owning process's engine polls the shared DB; the second process is a correct UI-over-the-same-store.

## Prevention

- **Treat lock-acquisition failure as evidence, not an error to swallow.** A failed mutual-exclusion acquire (lock/socket/PID) usually proves the guarded resource *is* alive elsewhere — don't let downstream "is it running?" checks read process-local state instead of the lock's machine-level truth.
- **Keep `has()` and `hasRunningEngine()` semantically distinct.** `has()` = "this process owns/ is starting it" (drives retry/reconcile); `hasRunningEngine()` = "an engine is live on this machine, owned by anyone" (drives the banner). Merging them would silently kill failover *and* still pass the banner test, so a regression would be invisible.
- Tests added (had zero prior coverage — they assumed the manager always owns what it starts):
  - `packages/engine/src/__tests__/project-engine-manager.test.ts`: reports a running engine when the lock is held elsewhere; logs the refusal once across repeated attempts; stays quiet across reconciliation ticks (no repeated `Failed to start…`); takes over and clears the marker once the lock frees; clears the marker even if the takeover `start()` throws.
  - `packages/dashboard/src/__tests__/server.test.ts`: `/api/health` reports `available: true` when another process owns the engine; legacy fallback to `getAllEngines()` when `hasRunningEngine` is absent.

### Operational gotcha

`pnpm fusion` launches the full dashboard + engine and **never exits**. Piping it (e.g. `pnpm fusion 2>&1 | grep -i auth` to inspect auth output) leaves the server running in the background, orphaned, holding the engine singleton sockets indefinitely. To find/clear a stray holder:

```bash
lsof "$TMPDIR"/fusion-engine-*.sock   # PID owning the engine locks
kill <pid>                            # releases the locks; reconciliation in any waiting process takes over
```

## See also

- [`developer-experience/browser-testing-dashboard-from-worktree-safely.md`](../developer-experience/browser-testing-dashboard-from-worktree-safely.md) — running a second dashboard process safely (dual-engine / shared-DB hazard). Its "a dev dashboard is engine-disabled" framing predates `start engines by default` (#1699); post-#1699/#1704 a second dashboard *does* attempt startup and reports machine-level availability, so prefer the machine-vs-process ownership model described here.
