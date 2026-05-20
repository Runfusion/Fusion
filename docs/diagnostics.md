# Diagnostics

## Insight run sweeper (`[insight-sweeper]`)

The dashboard insight router runs stale-run recovery sweeps for `project_insight_runs` rows stuck in `pending`/`running` without a live controller owner.

- Recovery writes `terminalCause: "orphaned_active_run_recovered"` and lifecycle failure metadata (`failureClass: "non_retryable"`, `retryable: false`).
- Recovery appends both `warning` and `status_changed` events on `project_insight_run_events` with `metadata.recovery = "orphaned_active_run"`.
- `metadata.recoverySource` indicates where recovery occurred: `startup`, `periodic`, `drive_by`, or `manual`.

## Dependency-blocked Todo backlog health (`[dependency-blocked-todo]`)

Self-healing now runs `surface-dependency-blocked-todos` during both startup recovery and periodic maintenance.

- Normal path emits a workflow insight titled `Backlog health: dependency-blocked todos YYYY-MM-DD`.
- Fallback path (insight store unavailable) writes a per-task log entry prefixed with `[dependency-blocked-todo]` against the top blocker task.
- Reporter summary warnings include group count, total blocked Todo count, and top blocker IDs.

Operator interpretation:
- `ageBucket: "fresh"` → expected dependency queueing.
- `ageBucket: "aging"` → review blocker progress.
- `ageBucket: "stale"` → emerging stall; escalate/unblock blocker.

## Process supervisor (`[process-supervisor]`)

The process supervisor logs when it registers a supervised child, starts teardown, expires the grace window, escalates to `SIGKILL`, or observes a natural child exit.

- `spawned pid=<pid> pgid=<pgid|n/a> command=<cmd>` — child registered for parent-death supervision.
- `terminating pid=<pid> pgid=<pgid|n/a> reason=<reason>` — teardown cascade started.
- `grace expired for pid=<pid>; escalating to SIGKILL` — child ignored the grace window.
- `sent SIGKILL to pid=<pid> pgid=<pgid|n/a>` — hard-kill escalation sent.
- `maxLifetime exceeded for pid=<pid> after <ms>ms` — lifetime watchdog fired.
- `child pid=<pid> exited naturally code=<n|null> signal=<n|null>` — child deregistered after exit.

## Self-healing surfacing passes (`[self-healing]`)

- `surface-in-review-stalls`
  - Log prefix: `In-review stall surfaced [`
  - Purpose: reason-driven in-review stall detector (`merge-blocker`, retry exhaustion, no-worktree, transient merge-status orphaning).
- `surface-in-review-stalled`
  - Log prefix: `In-review stalled surfaced [in-review-stalled]: quiet ...`
  - Purpose: time-quiet detector for unpaused in-review tasks beyond `inReviewStalledThresholdMs`.
  - Non-overlap: skipped when reason-driven `In-review stall surfaced [` is fresh, and skipped for paused tasks (owned by stale-paused-review).
- `surface-stale-paused-reviews`
  - Log prefix: `Stale paused review surfaced [stale-paused-review]: paused ...`
  - Purpose: paused in-review backlog-health detector gated by `stalePausedReviewThresholdMs`.

## No-progress churn stuck-task escalation (`[executor]`, `[stuck-detector]`, `[self-healing]`)

- Trigger shape: one loop classification/compact-and-resume has already fired for the current `execute()` lifecycle, then ignored `fn_task_update` rebuffs accumulate to `ignoredStepUpdateCount >= 25` without intervening progress.
- Executor diagnostic: `[executor] <taskId>: no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — escalating to STUCK_NO_PROGRESS_CHURN`.
- Self-healing diagnostic: `<taskId> no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — marking failed`.
- Audit event: `task:stuck-no-progress-churn-terminalized` with `{ taskId, ignoredStepUpdateCount, stuckKillStreak, lastReason: "no-progress-churn" }`.
- Outcome: task is marked `status: "failed"`, moved to `in-review`, and not requeued; operators should decompose/rescope the task instead of waiting for more automatic stuck-kill retries.

## Broad-scope triage intake (`[triage]`)

- Trigger shape: `TriageProcessor.finalizeApprovedTask()` scores the prompt/description against `packages/engine/src/triage-broad-scope-heuristics.ts` and flags advisory decomposition risk when the score reaches `>= 3`.
- Diagnostic: `[triage] <taskId>: broad-scope flag at triage — score=<n>, reasons=<csv>`.
- Fail-soft diagnostic: `[triage] <taskId>: broad-scope heuristic failed open: <message>` when the helper throws; the task still proceeds to `todo`.
- Audit event: `task:broad-scope-flagged-at-triage` with `{ score, reasons, signals, thresholds, version }`.
- Task log side effect: `Broad-scope triage flag` advising operators to decompose via `fn_task_create` or set `breakIntoSubtasks=true` before execution.
