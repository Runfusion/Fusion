---
category: architecture-patterns
module: fusion-plugin-acp-runtime
date: 2026-06-03
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Integrating a new external coding agent or agent protocol into Fusion"
  - "Building anything that holds a long-lived bidirectional JSON-RPC peer over stdio"
  - "Running an untrusted subprocess that can call back into Fusion (permissions, filesystem)"
tags:
  - acp
  - agent-client-protocol
  - runtime-plugin
  - json-rpc
  - untrusted-subprocess
  - security-floor
  - path-jail
related_components:
  - development_workflow
  - testing_framework
---

# Integrating a persistent bidirectional JSON-RPC agent (the ACP runtime pattern)

## Context

`plugins/fusion-plugin-acp-runtime` (PR #1354, 2026-06) was the first integration in this codebase that holds a **persistent, bidirectional JSON-RPC peer** over stdio. Every prior agent integration (droid, cursor, hermes, openclaw, pi-claude-cli) is one-shot: write one NDJSON turn, read stdout, force-kill. ACP inverts part of the relationship — Fusion spawns the agent, but the agent **calls back into Fusion mid-turn** (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`). That makes the agent untrusted *input* on every channel, and several hard-won rules from this build will apply to any future integration with the same shape.

## Guidance

**1. The canonical integration shape is a runtime plugin, not a `packages/*-cli` package.**
`packages/pi-claude-cli` / `droid-cli` are legacy shims. New agent integrations live in `plugins/fusion-plugin-<name>-runtime` using `@fusion/plugin-sdk`'s `definePlugin` with a `runtime: { metadata: { runtimeId }, factory }` block, implementing the `AgentRuntime` interface (`createSession` / `promptWithFallback` / `describeModel` / `dispose`). The engine resolves it via `getRuntimeById(runtimeId)` once installed.

**2. Engine lifecycle truths (verified against the engine, not docs):**
- The engine's `AgentRuntimeOptions` (`packages/engine/src/agent-runtime.ts`) **already carries `actionGateContext`** — populated at every run call site and funneled through `createResolvedAgentSession`. Consume it **structurally** via a narrow plugin-local interface; never import `@fusion/engine` and never add a parallel permission channel to the shared contract.
- There is **no `AbortSignal`** in the runtime contract. Teardown enters via an **unawaited synchronous `dispose()`** (StuckTaskDetector, executor timeout) plus the process-registry kill. Design teardown so the registry SIGKILL is the authoritative no-orphan/no-deadlock guarantee; any graceful protocol cancel (`session/cancel` + pending-request drain) is opportunistic. Register `process.on("exit", killAllProcesses)`.
- Bundling is **not automatic**: a new runtime plugin must be added to `RUNTIME_PLUGIN_IDS` in `packages/cli/tsup.config.ts` (or it silently never ships) and to an install list (`BUILTIN_PLUGINS` for on-demand, `BUNDLED_PLUGIN_IDS` for auto-install), plus `pnpm-workspace.yaml`.

**3. Security floor for an untrusted callback-capable subprocess:**
- **Per-category permission gating, never per-preset.** The shipped default policy preset is `unrestricted` (every category → allow). A preset-level shortcut auto-approves everything the moment the runtime is selected. Classify each call's kind into a category and read `permissionPolicy.rules[category]`; add an explicit acknowledgement setting before honoring blanket allows on sensitive categories.
- Select `allow_once` only — never `allow_always`/`reject_always` (a persisted grant inside untrusted code loses per-call interception). Unmappable/missing kinds, missing gate/policy, and HITL-without-a-readable-decision all default-deny. Require **both** `pauseForApproval` AND `findApprovalByDedupeKey` before creating an approval request — otherwise a human approval is silently discarded and a pending record is orphaned.
- **Filesystem jail = realpath, not string checks.** `project-root-guard.ts` is a suffix check, not a jail. Use realpath-within-realpath(cwd), `lstat` the final component for new files, `O_NOFOLLOW` open, and **truncate only after post-open re-validation** (passing `O_TRUNC` into open() truncates an escaped target before validation — write-path TOCTOU). Deny-list secrets and `.git/**` by basename regardless of cwd membership. Stat-gate reads (a full `readFile` before a byte ceiling is an OOM vector).
- **Bound everything the agent emits**, including the channels that don't look like output: per-turn + per-chunk caps on text/thinking, ANSI/control stripping, bounded identifier lengths and correlation maps, and **plan/structured events** (entry size was bounded but entry *count* wasn't — 1,000 × 64KB entries bypassed the per-turn budget). Redact stderr across chunk boundaries, not per-chunk (secrets split across `data` events evade per-chunk regexes). Build the subprocess env from an allow-list, never inherited `process.env` — but make the list **complete**: a thin `{HOME,PATH}` starves agent CLIs of the vars they use to find auth (`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`USER`/`SHELL`/`LANG`), and even a correct env can't beat macOS login-Keychain session isolation for detached daemons. See `integration-issues/acp-bridge-not-logged-in-thin-env-keychain-isolation.md`.

**4. Per-turn bridge state must actually reset per turn.** Anything accumulated per "turn" (output budgets, cap-flag latches, tool-call correlation maps) needs an explicit `reset()` invoked at the top of each prompt — a latch that never resets silently suppresses all output for the rest of the session after one flood. Write a two-turns-through-the-same-handler test; single-turn tests cannot catch it.

**5. The installed SDK's types are authoritative over docs/research.** Verify a young SDK's exports with a smoke-import test at scaffold time (a missing export is a day-one blocker, not a late surprise), and read the generated `.d.ts` for shapes: research/docs said `session/update` used `content_chunk`/`tool_call_started`; the real SDK uses `agent_message_chunk`/`tool_call`/`tool_call_update`, and `plan_update` carries a `plan` field, not `entries` (the wrong-shape cast silently no-op'd).

**6. Test fixtures for bidirectional protocols must be race-proof.** JSON-RPC notifications are dispatched concurrently with suspended request handlers. A fixture that registers a cancellable hang *after* an awaited write loses the race on loaded CI runners (cancel lands first, no-ops, prompt hangs forever). Record a pending-cancel flag so resolution is order-independent — never rely on a `setImmediate` tick for ordering.

## Why This Matters

The one-shot integrations never needed any of this: they hold no server→client channel, no long-lived session state, and their kill-after-turn lifecycle hides teardown bugs. A bidirectional peer fails in new ways — permission deadlocks on cancel, latched per-session state, TOCTOU in callback-served filesystem access, budget bypasses through structured events — and three of those shipped as P1s caught only by adversarial review, not by 170+ passing unit tests. The next protocol-shaped integration (MCP-server hosting, a future agent protocol) inherits this checklist instead of rediscovering it.

## When to Apply

- Adding any new agent runtime to Fusion (use the plugin shape + wiring checklist in §1–2).
- Any subprocess that can *call back* into Fusion — apply the full §3 security floor, not just spawn hardening.
- Any streaming bridge with per-turn accounting (§4) or any young/pinned SDK dependency (§5).
- Writing test fixtures for request/notification protocols (§6).

## Examples

Truncate-after-validate (write-path TOCTOU, `path-jail.ts` / `fs-capabilities.ts`):

```ts
// WRONG: O_TRUNC truncates an escaped target BEFORE re-validation
const h = await open(p, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW);

// RIGHT: open without truncate, re-validate realpath, then truncate via the fd
const h = await openWithinCwd(p, cwd, O_WRONLY | O_CREAT); // re-validates inside
await h.truncate(0);
```

Per-category floor, never preset (`control-handler.ts`):

```ts
// WRONG: preset shortcut — default preset is `unrestricted` ⇒ auto-approve everything
if (policy.preset === "unrestricted") return allow();

// RIGHT: classify the call, read the category rule, escalate blanket allows
const category = classifyToolKind(toolCall.kind);            // unmappable → DENY
const disposition = effectiveDisposition(category, gate, {   // allow on sensitive
  allowUnrestricted,                                         // category escalates to
});                                                          // approval unless acked
```

Reference implementation: `plugins/fusion-plugin-acp-runtime/` (184 tests), plan with full rationale at `docs/plans/2026-06-02-002-feat-acp-client-integration-plan.md`, contract at `docs/acp-contract.md`.
