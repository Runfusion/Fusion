# Diagnostics

## Goal injection diagnostics (`[goal-injection]`)

Executor, heartbeat, and planning runs emit one goal-injection diagnostic with outcome `applied`, `no-goals`, or `disabled-or-failed`.

- Run-audit event: `prompt:goal-injection` (`database` domain, target lane) with metadata `{ lane, outcome, goalCount, goalIds, provenanceGoalIds, truncated, reason?, errorClass?, runId?, agentId?, taskId? }`.
- Goal anchoring events also persist `metadata.goalIds` (alongside existing count/tool fields):
  - `goal:injection-applied` / `goal:injection-skipped` → `{ lane, count, goalIds, truncated?, reason? }`
  - `goal:retrieval-invoked` → `{ toolName, count, goalIds, notFound }`
- Run cited-goals read path: `GET /api/agents/:id/runs/:runId/cited-goals` returns `{ runId, taskId?, injectedGoalIds, retrievedGoalIds, citedGoalIds }` aggregated from `goal:*` + `prompt:goal-injection` run-audit events.
- Task log (executor lane with `taskId`): `[goal-injection] <outcome> count=<n> ids=<json-array> provenance=<json-array> truncated=<bool> ...`.
- `goalIds` / `goalCount` describe the active goals injected into the prompt; `provenanceGoalIds` additively records mission-derived task provenance and does not affect prompt selection.
- Guardrail: diagnostics persist goal IDs/counts only; never prompt text, goal titles, or goal descriptions.

## Agent performance reflection telemetry

Agent reflection generation emits one run-audit event for every `AgentReflectionService.generateReflection` attempt, covering manual dashboard requests, executor/post-task tools, heartbeat tools, and self-improve callers from the shared service seam.

- Run-audit events (`database` domain, target `agentId`):
  - `reflection:generated` metadata: `{ agentId, trigger, taskId?, reflectionId, tasksCompleted?, tasksFailed?, avgDurationMs?, commonErrorCount, insightCount, suggestedImprovementCount }`.
  - `reflection:skipped` metadata: `{ agentId, trigger, taskId?, reason: "no-history" | "not-completed" }`.
  - `reflection:failed` metadata: `{ agentId, trigger, taskId?, errorClass }`.
- Trigger taxonomy is preserved from `ReflectionTrigger`: `manual`, `periodic`, `post-task`, and `user-requested`.
- The events use synthetic run context with phase `reflection` and source equal to the trigger so they correlate in the run-audit stream without requiring caller-specific wiring.
- Guardrail: reflection diagnostics persist IDs, counts, reasons, and error classes only; never prompt text, reflection summaries, insight strings, suggested-improvement text, or free-form trigger details.

### Post-task performance capture (`reflection:captured`, FN-7528)

`AgentReflectionService.captureTaskPerformance` is a deterministic, non-LLM counterpart to `generateReflection`: it runs once per completed task at the executor completion seam (`TaskExecutor.signalTaskComplete`), guarded by `reflectionService` presence, `settings.reflectionEnabled`, and an assigned agent id. It never calls the model provider and persists a compact structured `post-task` `ReflectionMetrics` record — duration, packages/files touched, verification command(s) + file-scoped-vs-broader classification, and retry/rework count — sourced only from the completed `Task` record. Fields whose source is unavailable are omitted, never fabricated.

- Run-audit event (`database` domain, target `agentId`):
  - `reflection:captured` metadata: `{ agentId, trigger: "post-task", taskId?, reflectionId, retryReworkCount?, filesTouchedCount?, packagesTouchedCount?, verificationFileScoped?, durationMs? }`.
  - Skipped/failed captures reuse the existing `reflection:skipped` (`reason: "no-history" | "not-completed"`) and `reflection:failed` (`errorClass`) event types above.
- Guardrail: capture telemetry stays ids/counts/outcomes-only — `verificationScopeReason` free-text, the deterministic one-line `summary`, and any prompt/reflection prose never reach run-audit metadata (they are stored only in the `ReflectionMetrics`/`AgentReflection` record itself).
- Capture is best-effort and fire-and-forget: a capture failure never blocks or fails task completion, and an in-memory per-taskId guard prevents duplicate captures across the executor's several completion call sites (fresh completion, duplicate in-review re-entry, auto-recovery, paused-after-completion finalize, retry-completed).

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
- FN-5335 backward-move annotations
  - Log prefix shape: `[<stage-name>] <taskId>: triple-proof not satisfied — no action (operator-decides)`
  - Representative stage names: `no-progress-no-task-done`, `partial-progress-no-task-done`, `stale-incomplete-review`, `ghost-review`, `missing-worktree-review`, `stuck-merge-deadlock`, `finalize-no-op-review`, `reclaim-pr-conflict`, `reclaim-self-owned-branch-conflict`, `auto-rebound-paused-scope-decay`.

## No-progress churn stuck-task escalation (`[executor]`, `[stuck-detector]`, `[self-healing]`)

Time-based stuck/stalled/stale surfaces now floor activity timestamps using `settings.engineActiveSinceMs` plus `settings.engineActivationGraceMs` (default `300000`). The runtime stamps `engineActiveSinceMs` on startup and each unpause transition so engine pause/downtime does not count as quiet time.

- Trigger shape: one loop classification/compact-and-resume has already fired for the current `execute()` lifecycle, then ignored `fn_task_update` rebuffs accumulate to `ignoredStepUpdateCount >= 25` without intervening progress.
- Executor diagnostic: `[executor] <taskId>: no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — escalating to STUCK_NO_PROGRESS_CHURN`.
- Self-healing diagnostic: `<taskId> no-progress churn detected (ignoredStepUpdates=N, stuckKillStreak=M) — marking failed`.
- Audit event: `task:stuck-no-progress-churn-terminalized` with `{ taskId, ignoredStepUpdateCount, stuckKillStreak, lastReason: "no-progress-churn" }`.
- Outcome: task is marked `status: "failed"`, moved to `in-review`, and not requeued; operators should decompose/rescope the task instead of waiting for more automatic stuck-kill retries.

## Dispatch oscillation breaker (`[scheduler]`, `[self-healing]`)

FN-5941 adds a convergence backstop for repeated `todo↔in-progress` churn.

- Suppressed false-positive backward recoveries emit `task:reclaim-self-owned-branch-conflict-no-action`, `task:auto-recover-in-progress-limbo-no-action`, or `task:stuck-loop-exhausted-no-action` with liveness metadata (`taskId`, `branch`, `worktree`, `checkedOutBy`, `executionStartedAt`, `executionAgeMs`, `graceMs`, `liveWorktreeBoundBranch`, `reason`).
- Scheduler settle-window diagnostic: `Task <id> was engine-requeued <age>ms ago — waiting <settleMs>ms settle window before redispatch`.
- Terminal audit event: `task:dispatch-oscillation-terminalized` with `{ taskId, cycleCount, windowMs, lastMoveSource }`.
- Outcome: task stays in `todo`, is auto-paused with `pausedReason: "dispatch-oscillation"`, and requires operator unpause/forward progress to reset the counter.

## Stale self-owned active-session cleanup diagnostics (`[executor]`)

FN-5346 adds a same-task stale-binding reconcile marker before worktree removal:

- `[FN-5346] <taskId>: dropped stale self-owned activeSessionRegistry entry before removeWorktree at <worktreePath>`
- Follow-up task log entry: `Cleared stale self-owned active-session entry before remove`

## Runtime stop diagnostics (`[runtime-stop]`, `[executor]`)

Engine stop now aborts in-flight executor AI sessions before the runtime drain wait.

- Executor summary log: `[executor] abortAllInFlight: aborted N task surface(s) — engine stop`
- Runtime warning when in-flight work still exists after configured post-abort drain: `[runtime-stop] post-abort drain timeout reached with N tasks still in-flight`

Use these together to distinguish expected immediate session teardown from genuinely stuck cleanup surfaces that outlive the configured `runtimeStopDrainMs` window.

## Reports health stale-classifier diagnostics (`[reports-health]`)

Direct-report stale decisions in `HeartbeatMonitor.buildReportsHealthSection()` now emit a structured log when an agent is marked `**stale**`.

- Log shape: `[reports-health] stale report <agentId> intervalSource=<source> staleThresholdMs=<n> heartbeatAgeMs=<n>`
- `intervalSource` values:
  - `runtimeConfig` — interval came from cached per-agent runtime config
  - `persisted-agent` — cache was missing/sparse; interval came from persisted `getAgent()` row
  - `monitor-default` — no per-agent interval available; monitor default interval used
- `staleThresholdMs` is the computed stale threshold (`max(1.5 × interval, 5m floor)`)
- `heartbeatAgeMs` is the report's current heartbeat age at classification time
- Healthy reports do not emit this diagnostic; only stale decisions do

## Resume instrumentation (FN-5389, Phase 1)

Dashboard Phase 1 resume instrumentation adds observation-only client/server traces for refetch/reconnect attribution. It does not change visibility/pageshow/SSE behavior; FN-5392 consumes this data for fixes.

- Client event shape (`ResumeEvent`): `{ ts, view, trigger, projectId?, gapMs?, replayAttempted, replayFromEventId?, lastEventId?, sseChannel?, reason?, detail? }`.
- Trigger taxonomy: `visibility`, `pageshow`, `sse-error`, `sse-reconnect`, `sse-open`, `remount`, `route-active`, `route-inactive`, `project-context-change`.
- Sources:
  - `sse-bus` (`pageshow`, visible `visibilitychange`, `openChannel`, `forceReconnect`, EventSource `error`)
  - Hooks: `useTasks` (`visibility`, `sse-reconnect`), `useChatRooms` (`sse-reconnect`), `useChat` (`sse-open`, `project-context-change`)
  - Components: `Board` and `ChatView` mount/unmount route markers (`remount` / `route-active` / `route-inactive`)
- Access paths:
  - Client ring (500): `window.__fusionDebug.resumeInstrumentation.get()` / `.clear()`
  - Server ring (5000, in-memory): `GET /api/diagnostics/resume-events?limit=&since=&view=` returns `{ events, droppedSinceLastRead }`
- Client batching: POST `/api/diagnostics/resume-events` in idle batches (`<=25` per POST).
- Disable knob: `window.__fusionDebug.resumeInstrumentation.setEnabled(false)`.

FN-5415 extends this coverage across remaining board/data visibility hooks: `useNodes`, `useMeshState`, `useProjects`, and `useManagedDockerNodes`. Each now emits `trigger: "visibility"` with `reason: "debounced-refresh"` when refresh is taken and `reason: "debounce-skipped"` (including `detail.timeSinceLastRefreshMs`) when suppressed by debounce. This completes board/data-hook resume-correlation coverage needed for FN-5392 Phase 2 remediation analysis.

### Phase 3 coverage (FN-5416)

FN-5416 extends resume-correlation coverage to stream-focused hooks and their primary route shells:

- Hooks
  - `usePrChecksStream`: `remount`, `visibility`
  - `useDevServerLogs`: `project-context-change`, `sse-open`, `sse-reconnect`
  - `useResearch`: `sse-open`, `sse-reconnect`
  - `useBackgroundSessions`: `sse-open`, `sse-reconnect`
  - `useAgentLogs`: `project-context-change`, `sse-open`, `sse-reconnect` on `/api/tasks/:id/logs/stream` (live tail via SSE; historical reads are backed by `.fusion/tasks/{ID}/agent-log.jsonl`)
- Route shells
  - `DevServerView`: `remount` / `route-active` / `route-inactive`
  - `ResearchView`: `remount` / `route-active` / `route-inactive`

## Merge temp worktree cleanup classification (`[merger]`)

Fusion merge cleanup treats a narrow class of temporary merge/post-merge worktree removal failures as non-fatal only after Git admin state proves there is no registered worktree leak.

- Applies to Fusion-created temp merge paths such as `fusion-ai-merge-*` and post-merge paths such as `post-merge-*` during `merger-cleanup` / `merger-post-merge` removal.
- Trigger shape: `git worktree remove --force <path>` fails with validation text such as `fatal: validation failed, cannot remove working tree: '<path>/.git' is not a .git file`.
- Recovery proof: Fusion runs `git worktree prune`, then inspects `git worktree list --porcelain`.
- Harmless classification: if the target path is absent from porcelain after prune, the merger logs that cleanup remove failed but no registered worktree remains. If a directory still exists, Fusion reports it as residue for operator inspection; it does not delete arbitrary `/var/folders` content.
- Leak classification: if the target path is still present in porcelain after prune, the cleanup failure remains visible as a real registered-worktree leak.

Operator verification command:

```bash
git worktree list --porcelain | grep -F "<temp-worktree-path>"
```

No output means Git no longer registers that temp path; matching `worktree <temp-worktree-path>` output means the leak is still registered and needs operator cleanup.
