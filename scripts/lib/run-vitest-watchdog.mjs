
/**
 * Shared, bounded test-invocation runner (the L2 watchdog layer).
 *
 * Generalizes the process-group lifecycle proven in
 * packages/dashboard/scripts/run-vitest-with-heap.mjs so that
 * scripts/ci-test-shard.mjs and scripts/test-changed.mjs can wrap each vitest
 * invocation in a wall-clock killer instead of letting a wedged run block to
 * the CI 6h ceiling (or hang a local run forever).
 *
 * Design notes:
 * - `runWithWatchdog` spawns the command DETACHED (its own process group) and,
 *   on timeout, SIGTERMs the whole group, then SIGKILLs after a grace window —
 *   the same lifecycle the dashboard runner uses. It returns a result object
 *   ({ code, signal, timedOut }) rather than calling process.exit, so each
 *   caller decides its own exit/signal-re-raise behavior. This lets the shard
 *   runner loop over many invocations in one process without leaking handlers.
 * - Budgets are NOT a single flat constant. `deriveBudgetMs` uses per-class
 *   floor/ceiling bands as the load-bearing safety net; a fresh timings value
 *   only TIGHTENS within the band. With no fresh timings, the generous ceiling
 *   is used so a stale snapshot can never produce a too-tight (false-kill)
 *   budget. This is not an assertion-timeout widening — it bounds a currently
 *   unbounded outer wait. See the plan KTD-2.
 * - On timeout the watchdog emits inline hang diagnostics (the wrapper-side
 *   half of U2): which invocation hung, for how long, and the wrapper's own
 *   active-handle summary. The child's own open-handle dump is produced inside
 *   the vitest process by the SIGTERM diagnostics in vitest-setup.ts.
 */

const MINUTE = 60_000;

/**
 * Per-invocation-class budget bands (milliseconds). The floor/ceiling are the
 * safety net; timings tighten within them. Tune against a freshly refreshed
 * scripts/test-timings.json (see the plan's Deferred Implementation Notes).
 */
export const CLASS_BUDGET_BANDS = {
  // One CI shard command (may fan out across several packages via --filter).
  /*
  FNXC:TestInfrastructure 2026-06-20-21:51:
  The shard watchdog floor is 15min, not 5min. The heaviest CI shard slices
  (@fusion/engine and @fusion/core, each split [1/2]+[2/2]) are import- and
  real-git-subprocess heavy, and the committed scripts/test-timings.json
  undercounts that overhead (most files bucket to the 100ms floor, so the
  snapshot total sits far below current wall-clock). A "fresh" but undercounting
  snapshot was tightening these slices to ~340-405s and SIGKILLing healthy runs
  on slower CI runners (engine[2/2]=145s, core[2/2]=283s locally, both pass) —
  the exact false-kill the floor/ceiling band exists to prevent (see the
  deriveBudgetMs note above and plan KTD-2). 15min sits above the observed CI
  need while still bounding a true hang far under the job's 60min ceiling.
  The dashboard-lane floor is also 15min but for separate historical reasons;
  the two values are not coupled and may diverge.
  */
  /*
  FNXC:TestInfrastructure 2026-07-24-01:05:
  Floor raised 15min -> 25min: the July PG-cutover test additions grew the
  @fusion/core slice past the 15min floor on contended CI runners (run
  30075604930 killed core at exactly 900s while healthy; the suite passes
  locally in ~140s wall). The committed timings snapshot was 27 days old —
  "fresh" under the 30-day budget but badly undercounting — which tightened the
  budget to the floor: the same false-kill class the 5->15min raise fixed.
  The snapshot also could not be refreshed from CI because the timing-artifact
  upload silently matched nothing (hidden .timings/ dirs; fixed in
  full-suite.yml with include-hidden-files). 25min stays under the 30min
  ceiling and far under the 60min job ceiling while clearing the observed need.
  */
  shard: { floor: 25 * MINUTE, ceiling: 30 * MINUTE },
  /*
  FNXC:TestInfrastructure 2026-06-26-14:10:
  The `changed` ceiling stays 20min (general bound). The narrower requirement —
  that a per-task scoped-affected lane fails BEFORE the engine's 15min workspace
  verification kill (VERIFICATION_TIMEOUT_WORKSPACE_MS=900_000) so the engine
  doesn't SIGKILL + restart the task — is handled surgically in
  `deriveScopedAffectedBudgetMs` (test-changed.mjs), which caps the scoped lane at
  SCOPED_AFFECTED_BUDGET_CEILING_MS (14min) via Math.min. That keeps the global
  changed band generous for other callers while bounding only the lane that was
  timing out. (An earlier revision lowered this whole band to 13min; superseded by
  the scoped cap merged from main.)
  */
  // One local changed-file package invocation.
  changed: { floor: 2 * MINUTE, ceiling: 20 * MINUTE },
  // One dashboard quality lane (heap-managed). Matches the historical 15min.
  "dashboard-lane": { floor: 15 * MINUTE, ceiling: 30 * MINUTE },
};

export const DEFAULT_BUDGET_MULTIPLIER = 3.5;
export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const TIMEOUT_EXIT_CODE = 124;

/**
 * Derive a wall-clock budget for one invocation.
 *
 * @param {object} opts
 * @param {keyof typeof CLASS_BUDGET_BANDS} opts.klass
 * @param {number|null} [opts.expectedDurationMs] aggregated expected duration
 *   across every package/lane packed into this invocation (sum, not a single
 *   package lookup), or null when unknown.
 * @param {boolean} [opts.timingsFresh] whether the timings snapshot feeding
 *   expectedDurationMs is fresh enough to trust.
 * @param {number} [opts.multiplier]
 * @returns {number} budget in milliseconds
 */
export function deriveBudgetMs({
  klass,
  expectedDurationMs = null,
  timingsFresh = false,
  multiplier = DEFAULT_BUDGET_MULTIPLIER,
} = {}) {
  const band = CLASS_BUDGET_BANDS[klass] ?? CLASS_BUDGET_BANDS.changed;
  // No usable, fresh timing → fall back to the generous ceiling. A stale or
  // missing snapshot must never yield a tighter-than-ceiling budget.
  if (!timingsFresh || expectedDurationMs == null || !(expectedDurationMs > 0)) {
    return band.ceiling;
  }
  const derived = Math.round(expectedDurationMs * multiplier);
  return Math.max(band.floor, Math.min(band.ceiling, derived));
}

/**
 * Summarize the wrapper process's active handles/requests, bounded so a hang
 * dump cannot itself flood CI logs. Reports handle TYPE counts only (never
 * payloads) so there is nothing to redact.
 */
export function summarizeActiveHandles({ limit = 12 } = {}) {
  const handles =
    typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  const requests =
    typeof process._getActiveRequests === "function" ? process._getActiveRequests() : [];

  const counts = new Map();
  for (const h of [...handles, ...requests]) {
    const name = h?.constructor?.name ?? typeof h;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "no pending handles in wrapper process";

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, limit).map(([name, n]) => `${name}×${n}`);
  const remainder = sorted.length - shown.length;
  const suffix = remainder > 0 ? ` (+${remainder} more types)` : "";
  return shown.join(", ") + suffix;
}

/**
 * Build the inline hang-diagnostic summary emitted on timeout (U2, wrapper side).
 */
export function captureHangDiagnostics({ label, command, args, budgetMs, startedAt, lastHeartbeatAt, now }) {
  const elapsedMs = now - startedAt;
  const sinceHeartbeat = lastHeartbeatAt ? now - lastHeartbeatAt : null;
  const lines = [
    `[watchdog] HANG: ${label} exceeded budget ${budgetMs}ms (elapsed ${elapsedMs}ms)`,
    `[watchdog]   command: ${command} ${args.join(" ")}`,
    lastHeartbeatAt != null
      ? `[watchdog]   last heartbeat: ${sinceHeartbeat}ms ago`
      : `[watchdog]   last heartbeat: none observed`,
    `[watchdog]   wrapper handles: ${summarizeActiveHandles({})}`,
    `[watchdog]   (child open-handle dump, if any, is printed by the vitest process on SIGTERM)`,
  ];
  return lines.join("\n");
}

/**
 * Run a command under a wall-clock watchdog in its own process group.
 *
 * Resolves to { code, signal, timedOut, diagnostics } and never rejects for an
 * ordinary child failure — callers translate the result into their own exit
 * behavior. Installs SIGINT/SIGTERM/SIGHUP forwarders and an exit cleanup hook
 * for the lifetime of THIS invocation only, removing them once the child
 * settles so sequential invocations in a loop don't accumulate handlers.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} opts.budgetMs   wall-clock budget; <=0 or non-finite disables the killer
 * @param {number} [opts.graceMs]  SIGTERM→SIGKILL grace window
 * @param {number} [opts.heartbeatMs]
 * @param {string} [opts.label]
 * @param {(msg: string) => void} [opts.log]
 * @param {object} opts.spawn      injected spawn (node:child_process spawn); required for testability
 * @param {string} [opts.cwd]       working directory for the spawned child (preserves callers that
 *   ran the test command from a fixed root, e.g. test-changed.mjs's rootDir)
 * @param {() => number} [opts.now] injected clock (defaults to Date.now)
 * @param {(signal: string) => void} [opts.killGroup] injected group-signaller
 *   (defaults to a process-group `process.kill(-pid)` with child.kill fallback);
 *   override in tests so signals are captured instead of hitting real groups.
 */
export function runWithWatchdog({
  command,
  args,
  env = process.env,
  cwd = null,
  budgetMs,
  graceMs = DEFAULT_GRACE_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  label = command,
  log = console.error,
  spawn,
  now = () => Date.now(),
  killGroup = null,
}) {
  if (typeof spawn !== "function") {
    throw new Error("runWithWatchdog requires an injected `spawn` function");
  }

  return new Promise((resolve, reject) => {
    const startedAt = now();
    let lastHeartbeatAt = null;
    let timedOut = false;
    let diagnostics = null;
    let forceKillTimer = null;
    let settled = false;

    // process-supervisor-allowlist: foreground wrapper signals the whole vitest
    // process group on death/timeout; not a background daemon.
    const child = spawn(command, args, {
      detached: true,
      stdio: "inherit",
      env,
      ...(cwd ? { cwd } : {}),
    });

    const heartbeat = setInterval(() => {
      lastHeartbeatAt = now();
      log(`[watchdog] still running: ${label}`);
    }, heartbeatMs);
    heartbeat.unref?.();

    function defaultSignalGroup(signal) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)) throw error;
        if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      }
      try {
        child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    const signalGroup = typeof killGroup === "function" ? killGroup : defaultSignalGroup;

    // Arm the SIGTERM→SIGKILL grace ladder once. Used by BOTH the timeout path
    // and external-cancellation forwarding so a child that ignores SIGTERM can't
    // keep the wrapper pending until the full budget (the original handlers
    // suppressed Node's default exit behavior, so Ctrl-C / CI cancellation could
    // otherwise hang for the whole per-command ceiling).
    function armForceKill(triggerSignal) {
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        log(`[watchdog] grace expired after ${triggerSignal}; SIGKILL: ${label}`);
        signalGroup("SIGKILL");
      }, Math.max(1, graceMs));
      forceKillTimer.unref?.();
    }

    const watchdog =
      Number.isFinite(budgetMs) && budgetMs > 0
        ? setTimeout(() => {
            timedOut = true;
            diagnostics = captureHangDiagnostics({
              label,
              command,
              args,
              budgetMs,
              startedAt,
              lastHeartbeatAt,
              now: now(),
            });
            log(diagnostics);
            signalGroup("SIGTERM");
            armForceKill("timeout");
          }, budgetMs)
        : null;
    watchdog?.unref?.();

    const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = new Map();
    for (const sig of forwardedSignals) {
      const handler = () => {
        log(`[watchdog] received ${sig}; forwarding to group: ${label}`);
        signalGroup(sig);
        armForceKill(sig);
      };
      signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }

    function onProcExit() {
      // Best-effort: don't leave an orphaned group if the wrapper itself dies.
      // Route through signalGroup so the injection contract holds everywhere.
      try {
        signalGroup("SIGTERM");
      } catch {
        /* group already gone */
      }
    }
    process.on("exit", onProcExit);

    function cleanup() {
      clearInterval(heartbeat);
      if (watchdog) clearTimeout(watchdog);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
      process.removeListener("exit", onProcExit);
    }

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: timedOut ? TIMEOUT_EXIT_CODE : code,
        signal: timedOut ? null : signal,
        timedOut,
        diagnostics,
      });
    });
  });
}
