# Task Management

[← Docs index](./README.md)

This guide covers task creation, lifecycle behavior, task metadata, and operational workflows.

## Task Creation Options

### 1) Quick Entry (dashboard)

Use the inline input on board/list view:

- Type description
- Press Enter
- Task is created in `planning`

### Duplicate-task detection at creation time (Quick Entry)

Dashboard `POST /tasks` now performs a pre-create duplicate gate using token-overlap similarity against recent non-done tasks (default threshold `0.45`, excluding `done`/`archived`).

- `POST /api/tasks/duplicate-check` accepts `{ title?, description, limit?, threshold? }` and returns `{ matches }` for UI preflight warnings.
- `POST /api/tasks` accepts optional `acknowledgedDuplicates?: string[]` and `bypassDuplicateCheck?: boolean`.
  - If candidates remain after acknowledgement filtering, the route returns `409` with `{ error: "duplicate_candidates", details: { matches } }`.
  - If `bypassDuplicateCheck: true`, the gate is skipped.
- When creation proceeds with acknowledged candidates, created task metadata stores:
  - `task.source.sourceMetadata.duplicateWarningOverridden = true`
  - `task.source.sourceMetadata.acknowledgedDuplicateIds = [...]`
- Override creates emit activity type `task:duplicate-warning-overridden` with acknowledged IDs and scored candidate metadata.
- Duplicate lineage is persisted on the task row via canonical source fields (`sourceType: "task_duplicate"`, `sourceParentTaskId`) plus `sourceMetadata.duplicateOfTaskIds` when available, so `fn task show <id>` and Task Detail views can render duplicate-of linkage directly from task provenance.

#### Deterministic duplicate guard (FN-4918, extended by FN-5060)

Fusion applies a deterministic guard for exact normalized content matches (title + description fingerprint) within a 60s window. The shared implementation lives in `packages/core/src/duplicate-guard.ts` (`runDeterministicDuplicateGuard` + `reconcileDeterministicDuplicate`) and is wired into all primary task-creation surfaces:

- Dashboard `POST /tasks`
- CLI `fn task create` (`runTaskCreate`)
- Engine `createAgentTask` (powers `fn_task_create`, including triage subtask splits)
- Mission feature triage (`MissionStore.triageFeature`)

Behavior is consistent across these surfaces:

- If an existing same-fingerprint task is found in-window, create returns/behaves as a link-to-existing result (`duplicate_candidates` for API, `Linked existing ...` for CLI/tool responses).
- If two creates race across processes and both reach persistence, post-create reconciliation keeps the older canonical task and auto-archives the newer sibling.
- New rows stamp `task.source.sourceMetadata.contentFingerprint` for deterministic matching.
- Reconciled losers stamp `task.source.sourceMetadata.deterministicDuplicateOf = <canonicalTaskId>` and are archived (not deleted).
- Reconciliation archives record activity event `task:auto-archived-deterministic-duplicate`.

Bypass controls:

- Dashboard API: `bypassDuplicateCheck: true` skips deterministic + similarity duplicate gates.
- CLI: `fn task create --no-dedup` skips deterministic duplicate guard.

This deterministic layer complements (does not replace) the FN-4829 similarity warning gate. FN-4892 remains a separate engine-side same-agent intake heuristic at triage finalize.

##### Fail-open boundary (FN-5084)

The deterministic **pre-check** now fails open: transient store query failures, in-process mutex bookkeeping failures, and leader-lock promise rejections do not block task creation. The route logs one `runtimeLogger.warn` line tagged `FN-5084` (including `projectId` and `contentFingerprint`) and continues through the FN-4829 similarity gate to normal create handling.

Only legitimate deterministic duplicate detections continue to propagate as `409` via `ApiError` from `conflict("duplicate_candidates", ...)`. The post-create FN-4918 reconciliation pass remains the second line of defense.

#### Near-duplicate intent guard (FN-5152)

Fusion adds a separate near-duplicate layer for tasks whose raw descriptions differ but whose implementation intent converges.

Order on dashboard `POST /api/tasks` is:

1. Deterministic fingerprint guard (FN-4918 / FN-5060)
2. Similarity warning gate (FN-4829)
3. Near-duplicate intent guard (FN-5152)

Both FN-5152 layers **fail open**: extraction errors, store-query failures, parse failures, and timeout paths log a warning and continue through normal create/finalize flow.

Layer 1 runs synchronously on dashboard intake before task creation. It extracts an intent signature from the incoming title/description and compares it with active recent tasks. The signature stores four capped arrays:

- `routePaths` — route-like paths such as `/pr/options` or `/api/tasks/:id/pr/preflight`
- `filePaths` — concrete source/docs paths such as `packages/dashboard/src/routes/register-task-workflow-routes.ts`
- `identifiers` — high-signal identifier-shaped tokens such as `PrCreateModal`
- `titleTokens` — non-stopword title tokens used for the title Jaccard check

When at least two distinct high-signal tokens overlap and title-token Jaccard is at least `0.30`, dashboard intake returns `409 duplicate_candidates` with matches carrying `reason: "near-duplicate-intent"` plus `sharedTokens` so callers can explain the overlap. Clients may bypass that specific match with `acknowledgedDuplicates: ["FN-..."]`; `bypassDuplicateCheck: true` still skips the create-time duplicate gates entirely.

To avoid false positives from broad hot files, the matcher treats an overlap consisting only of generic large files (`register-git-github.ts`, `register-task-workflow-routes.ts`, `store.ts`, `types.ts`, `styles.css`) more strictly and requires title-token Jaccard of at least `0.50`.

Layer 1 persists `source.sourceMetadata.intentSignature` on created tasks so later checks can reuse pre-extracted vectors.

##### CLI direct-store coverage (FN-5171)

CLI `fn task create` now runs the same near-duplicate intent guard after the FN-4918 deterministic fingerprint guard, using shared `extractIntentSignature` / `findNearDuplicates` helpers from `@fusion/core`. Thresholds and the 7-day comparison window match the dashboard layer exactly. `--no-dedup` remains the single bypass across both duplicate layers: it skips the comparison but still stamps `source.sourceMetadata.intentSignature` when high-signal tokens were extracted. When a near-duplicate is detected, interactive TTY runs prompt `Create anyway? [y/N]`; non-interactive runs refuse creation with exit code 1 and instruct the caller to re-run with `--no-dedup`. The guard is still fail-open: extraction/list/query errors log a warning and continue. `fn task import` (GitHub import) and `fn task plan` intentionally continue to skip both duplicate guards per the FN-5060 same-content-sibling contract.

Layer 2 runs in triage `finalizeApprovedTask` after `PROMPT.md` is written and parses `## File Scope` as an additional backstop. If the new spec overlaps an older active task on concrete File Scope / intent tokens and still clears the title threshold, the newer task is flagged for user confirmation instead of being silently auto-archived.

Near-duplicate flagging now keeps the task in its normal flow column (`todo` / approval flow) and records metadata for UI warnings:

- `source.sourceMetadata.nearDuplicateOf = <canonicalTaskId>`
- `source.sourceMetadata.nearDuplicateScore = <number>`
- `source.sourceMetadata.nearDuplicateSharedTokens = <string[]>`
- optional `source.sourceMetadata.nearDuplicateDismissed = true` after user chooses Keep
- activity event `task:near-duplicate-flagged`

A near-duplicate flag is only actionable while the canonical task is active. The triage backstop does not persist `nearDuplicateOf` for archived, soft-deleted, done, or missing canonicals; when a canonical later becomes inactive through archive, soft-delete, or move-to-done, the store clears `nearDuplicateOf`, `nearDuplicateScore`, `nearDuplicateSharedTokens`, and `nearDuplicateDismissed` from active referrers and records an informational log entry without pausing or failing those tasks.

Dashboard surfaces this as a yellow Duplicate chip plus modal actions only while the canonical exists and is active:

- **Archive** (user-initiated archive path)
- **Keep** (dismisses the warning by setting `nearDuplicateDismissed: true`)

This layer complements, rather than replaces, FN-4829 similarity detection, FN-4918 deterministic deduplication, and FN-4892 same-agent intake heuristics.

#### Explicit duplicate-marker guard (FN-5220)

Fusion also recognizes the canonical one-line redirect marker:

- `DUPLICATE: FN-1234`
- `` `DUPLICATE: FN-1234` ``
- `**DUPLICATE: FN-1234**`
- fenced single-line wrappers such as:

  ```text
  DUPLICATE: FN-1234
  ```

The shared parser lives in `packages/core/src/explicit-duplicate-marker.ts` (`parseExplicitDuplicateMarker`). It is intentionally strict: after trimming outer whitespace and one optional wrapper layer, the content must reduce to exactly one substantive line matching `^DUPLICATE:\s*FN-\d+$`. Any extra prose, multiple markers, or full PROMPT bodies that merely mention duplicate text are ignored.

This guard adds three fail-open layers on top of the existing duplicate stack, in final order:

1. Deterministic fingerprint guard (FN-4918 / FN-5060)
2. Similarity warning gate (FN-4829)
3. Near-duplicate intent guard (FN-5152)
4. Explicit duplicate-marker guard (FN-5220)

Layer behavior:

- **Dashboard intake (`POST /api/tasks`)** — after deterministic/similarity/near-duplicate checks and before `createTask`, intake returns `409 duplicate_candidates` with `reason: "explicit-marker"` when the combined title/description is exactly a canonical redirect and the canonical target exists. `acknowledgedDuplicates` and `bypassDuplicateCheck: true` both suppress the conflict. Because this guard runs before task creation, the activity breadcrumb is attached to the canonical target.
- **Triage planning loop** — after triage reads the generated `PROMPT.md`, an exact redirect marker short-circuits directly into `finalizeApprovedTask()`. Normal plans run deterministic spec hygiene checks in triage, then the selected workflow's optional Plan Review gate owns AI plan review before execution.
- **Self-healing sweep** — maintenance Batch 2 runs `resolveExplicitDuplicateMarkerTasks()` across `triage`/`todo` tasks to clean up older stuck marker tasks. The sweep is best-effort, capped at 50 marker tasks per cycle, and can be disabled with the internal setting `resolveExplicitDuplicateMarkerEnabled: false` (default `true`).

All three layers fail open: parse errors, task lookup failures, file-read failures, activity-recording errors, or other unexpected exceptions log a warning and continue normal intake/triage/self-healing flow instead of blocking task creation or recovery.

Activity uses the existing `task:auto-archived-duplicate` event with `metadata.source` disambiguators:

- `explicit-marker` — triage short-circuit / duplicate finalize path
- `explicit-marker-sweep` — self-healing maintenance sweep
- `explicit-marker-intake` — dashboard intake rejection breadcrumb

The duplicate-close task log line remains `Duplicate of <canonicalTaskId> — closed` for triage/sweep paths.

### Intake auto-archive (ghost-bug preflight + same-agent duplicate)

Fusion applies two conservative intake heuristics that may auto-archive newly filed tasks before execution starts:

- **Ghost-bug preflight** (triage finalize path): for bug-fix-shaped specs that cite concrete constructs/commands, Fusion probes current `main`. If all definitive probes show the cited bug does not reproduce, the task is archived as `auto-resolved-ghost-bug`.
- **Same-agent duplicate intake** (create path): if the same `source.sourceAgentId` filed a highly similar task within 24h (threshold `0.75`), the later task is archived as `auto-resolved-duplicate` and the earliest sibling is kept.

Both heuristics are **fail-open**: probe/detection errors, timeouts, or inconclusive signals do not block normal intake — the task continues in the regular flow.

Activity + run-audit event types:

- `task:auto-archived-ghost-bug`
- `task:auto-archived-duplicate`

These appear in task activity history; run-audit entries are emitted where run context exists (triage/engine paths). Store-only intake paths record activity without synthetic run context.

Recovery is reversible: restore archived tasks via dashboard **Unarchive** or `fn_task_unarchive`.

#### Revert/Undo affordance (FN-7525)

Done and Archived task cards (board card inline row + context menu, the detail view, and the list context menu) expose a **Revert** action alongside Archive/Unarchive when the task has a landed commit to revert. Clicking it calls `POST /tasks/:id/revert` in `"auto"` mode:

- A clean git revert shows a success toast naming the created revert commit sha.
- A conflicting/unsupported git result opens a confirm dialog offering to create an AI-undo task; confirming re-calls the route in `"ai"` mode and surfaces the created task id (or that an undo task is already open).
- A `needsHuman` result (e.g. auto-merge is off) is surfaced as an informational/error toast, never silently forked into an AI task.

The source task's column/lifecycle is never mutated as a side effect of a revert; the Revert affordance is absent when the task has no landed commit or when the hosting surface does not support it.

### 2) Plan Mode (AI interview)

On desktop/tablet, open **Planning** from the left sidebar to start or resume a planning session. You can also hand a draft from the board quick-entry row or New Task dialog to Planning with the **Plan** action.

- AI asks clarifying questions
- AI reasoning (thinking output) is preserved and visible throughout the session — expand the reasoning toggle to review the model's analysis before answering each question or accepting the summary
- Produces summary + key deliverables
- Create one task or **Break into Tasks** (multi-task generation with dependencies)
- Summary view includes a **Priority** selector (`low`, `normal`, `high`, `urgent`) so single-task creation can set priority before task creation
- Break-into-tasks mode includes per-subtask **Priority** selectors (`low`, `normal`, `high`, `urgent`) so each generated task can be prioritized before creation
- Break-into-tasks descriptions are structured with subtask-specific guidance first, then a separate larger-plan context section (plus `## Planning Interview Context` when interview history exists)
- Final multi-task creation now uses a compact request payload: unchanged generated subtask descriptions stay server-side, while any edits to title, description, size, priority, and dependencies are preserved when tasks are created
- Sessions persist when the planning surface is closed or you navigate away — resume from the Planning sidebar list at any time; reasoning context is restored automatically
- Back navigation rewinds the server-side planning session to the previous answered question so you can revise earlier answers and continue from the corrected turn
- On the summary screen, **Refine Further** continues through the backend planning session (including resumed completed sessions) and waits for a real follow-up question or updated summary; it does not switch to an empty question view

### 3) Todo item → Plan Mode

In **Todos** view, each todo item includes a planning action:

- Click the planning (💡) action on a todo item
- Opens Planning Mode with that todo text pre-filled as the initial plan
- Starts an AI planning interview (clarification questions + summary)
- You can then create one task or break the plan into multiple tasks

This action starts a planning session; it does **not** immediately create a task.

For full Todo View behavior (enablement, list/item actions, API routes, and storage), see [Todo View](./todo-view.md).

### 4) Subtask Breakdown Dialog

Use the 🌳 button:

- Generate 2–5 candidate subtasks
- Shows live thinking/progress immediately while generation runs, before the candidate list is ready
- Send the run to the background or close the dialog without canceling it; use the background-session indicator to resume running, waiting, or completed breakdowns
- Drag to reorder
- Add dependencies only on earlier items
- Set each subtask's **Priority** (`low`, `normal`, `high`, `urgent`) before create
- Create tasks in one action

### 5) Expanded Controls

Expand the creation panel (▼) to access additional controls:

- **Refine** (✨) — Improve the description with AI
- **Deps** (🔗) — Link existing tasks as dependencies
- **Attach** — Add image attachments
- **Models** (🧠) — Set per-task model overrides (executor, validator, planning)
- **Priority** (🚩) — Set task priority (`low`, `normal`, `high`, `urgent`) before creation; the selected value is applied to the created task (it does not reset to default unless omitted)
- **Agent** — Assign an agent to the task
- **Branch settings** (`branch` / `baseBranch`) remain available in full task forms and task detail editing (not in Quick Entry)
- **Review** — Set review rigor level (None, Plan Only, Plan and Code, Full)
- **Optional workflow steps** — Enable workflow-declared optional steps for the selected workflow. The built-in coding workflow exposes **Browser Verification** here and keeps it opt-in by default.

### 6) CLI creation

```bash
fn task create "Fix API timeout handling"
fn task plan "Implement role-based access control"
fn task create "Bug" --attach screenshot.png --depends FN-002
```

### 7) Create/Enrich from Research findings

From the standalone **Research** view, each finding supports two task actions:

- **Create Task** — creates a new task with `sourceType: "research"`
- **Enrich Task** — appends/updates research content on an existing task

Research actions persist detailed output in task documents (and optional attachments), not in long task descriptions.

## Task Lifecycle

Fusion task columns:

Fusion task columns use persisted enum values as the API/filter contract. Callers use enum values such as `triage`, `todo`, `in-progress`, `in-review`, `done`, and `archived`; UI labels are presentation only. In particular, `triage` is displayed as **Planning**, but `Planning` is not a valid persisted column value. Dashboard task-list API requests such as `GET /api/tasks?column=triage` return only rows whose persisted `task.column` is exactly `triage`, and invalid column values are rejected.

1. **triage** (displayed as **Planning**) — idea intake; AI writes a full plan
2. **todo** — ready for scheduling
3. **in-progress** — executor active in isolated worktree
4. **in-review** — implementation complete; awaiting finalization
   - If merge/finalization hits a terminal error, tasks can remain in `in-review` with `status: "failed"` for explicit follow-up. This state is intentionally preserved by recovery (not auto-bounced to `todo`).
   - Retry behavior splits by execution-vs-merge signals: `in-review` tasks with incomplete steps (`pending`/`in-progress`) are treated as execution failures and retried back to `todo` with `preserveProgress: true`; zero-step `in-review` tasks use `mergeRetries` as the tie-breaker (`mergeRetries === 0` or undefined → execution failure path back to `todo`, `mergeRetries > 0` → merge/finalization retry in `in-review` with merge retry state reset); tasks whose steps are all terminal (`done`/`skipped`/`failed`) also stay on the merge/finalization retry path.
   - Manual retry now clears the full persisted retry-budget counter set (`stuckKillCount`, `recoveryRetryCount`, `taskDoneRetryCount`, `worktreeSessionRetryCount`, `workflowStepRetries`, `verificationFailureCount`, `postReviewFixCount`, `mergeConflictBounceCount`, `branchConflictRecoveryCount`, `reviewerContextRetryCount`, `reviewerFallbackRetryCount`, `completionHandoffLimboRecoveryCount`, `mergeAuditBounceCount`) plus `nextRecoveryAt`; merge retry counters clear only on merge-failure/generic retry paths. `retrySummary` is recomputed from persisted counters at read time, so manual retry resets the dashboard retry badge/details back to zero immediately.
   - Persisted executor session state is resumed only when it still matches the task's current worktree context. If a retry fails with `Refusing to start coding agent in missing worktree: ...` and the persisted session points at stale worktree metadata, recovery clears stale session pointers and retries fresh so review retries do not reopen deleted worktree paths.
   - Merge-confirmed tasks still respect `getTaskMergeBlocker()` before the final `in-review` → `done` move. If merge is confirmed but a blocker remains (for example, incomplete steps), Fusion parks the task in `in-review` with `status: "failed"` and an explicit blocker error instead of retry-looping auto-finalization.
   - Self-healing can still auto-finalize retry-exhausted failed review tasks when it can prove their branch content already landed on the merge target, so already-merged work does not deadlock in `in-review`.
   - Repeated engine merge-queue drops now escalate to an explicit recoverable review failure: if auto-recovery hits `Auto-merge starvation:` in the task `error`, Fusion has already seen three consecutive enqueue attempts rejected by the engine merge queue. Operators can recover by clearing the failed state from the dashboard, which lets the usual unpause/clear flow re-attempt merge once the underlying queue wedge is resolved.
   - Non-recoverable state-machine errors during finalization (for example `Invalid transition: 'todo' → 'done'`) are treated as terminal review failures: recovery must not re-enqueue these tasks for merge unless task state changes prove they are recoverable.

#### Self-healing: stranded-completed-todo recovery

Fusion now enforces a recovery invariant for completed work that is accidentally returned to `todo`:

- `todo` tasks with all steps terminal (`done`/`skipped`), no active execution, and no unrecoverable error are auto-promoted by self-healing.
- Promotion always respects the transition table (`todo → in-progress → in-review`) via `TaskStore.moveTask()`; no direct `todo → in-review` mutation is used.
- Review Level `0` tasks are finalized to `done` by the existing no-op review finalization flow after promotion to `in-review`; Review Level `>0` tasks remain in `in-review` for normal review/merge handling.

This is a forward-safety guard for stranded completed tasks. See FN-4055/FN-4079 for deeper lifecycle root-cause and operational repair work.

#### In-review stall signal

Fusion now derives `task.inReviewStall` for non-paused `in-review` tasks when a known stuck-state shape is detected. This signal is state-based (not log-heuristic) and is computed server-side on task hydration.

`InReviewStallCode` values:
- `transient-merge-status-no-owner` — task is still in `merging`/`merging-pr`/`merging-fix` after the stale-merging age threshold, but no active merger owns it.
- `merge-retries-exhausted` — `mergeRetries` reached the auto-merge retry cap without `mergeDetails.mergeConfirmed === true`.
- `no-worktree-no-merge-confirmed` — task has no worktree path and merge is not confirmed (excluding explicit no-op merges).
- `merge-blocker` — `getTaskMergeBlocker()` reports a merge/finalization blocker.

Invariant: `inReviewStall` is **diagnostic-only**. It must never be used as an auto-completion trigger.

Self-healing surfaces this diagnosis via task log entries in the form:
- `In-review stall surfaced [<code>]: <reason>`

These entries are rate-limited per `(task, code)` over `taskStuckTimeoutMs`, so unchanged stalls are not spammed every cycle while state transitions can still surface a new code immediately.

**Dashboard surface:** In-review, non-paused tasks with `inReviewStall` set show a `Stall` badge on `TaskCard` and a code-specific diagnostic row in `TaskDetailModal` above the PR section. The diagnostic row includes headline/description/action copy, raw reason text, observed timestamp, and a `View activity log` deep-link that switches to Logs → Activity and highlights the most recent matching `In-review stall surfaced [<code>]: <reason>` entry. This UI is diagnostic only: neither the badge nor the jump button mutates task state.

#### Stale paused review signal

Fusion now derives `task.stalePausedReview` for paused `in-review` tasks whose review-column age is at/over `stalePausedReviewThresholdMs` (age source: `columnMovedAt ?? updatedAt`) while merge is still unconfirmed (`mergeDetails.mergeConfirmed !== true`).

`StalePausedReviewCode` values:
- `stale-paused-review`

Invariant: `stalePausedReview` is **diagnostic-only**. It never auto-unpauses, retries, archives, or moves tasks.

Self-healing surfaces this diagnosis via task log entries in the form:
- `Stale paused review surfaced [<code>]: paused <duration>; disposition options — unpause, retry, archive, or create follow-up task. pausedReason=<reason|none>`

These entries are rate-limited per `(task, code)` over `stalePausedReviewThresholdMs` so unchanged paused-review debt is visible without log spam.

**Dashboard surface:** paused `in-review` tasks with `stalePausedReview` set show a `Paused stall` badge on `TaskCard`, a diagnostic row in `TaskDetailModal` (age/threshold/observed timestamp + disposition copy + `View activity log` jump), and a `Stale paused review` list filter that narrows to tasks where `task.stalePausedReview != null`.

Disposition options:
- Unpause
- Retry
- Archive
- Create follow-up task

#### Task age staleness signal

Fusion now derives `task.ageStaleness` for tasks in `in-progress` and `in-review` (including paused tasks). Age is computed from `columnMovedAt` and falls back to `updatedAt` when needed.

Signal levels:
- `warning`
- `critical`

Threshold settings:
- `staleInProgressWarningMs` (default `4h`)
- `staleInProgressCriticalMs` (default `24h`)
- `staleInReviewWarningMs` (default `24h`)
- `staleInReviewCriticalMs` (default `72h`)

`0` or `undefined` disables that level.

Invariant: `ageStaleness` is **diagnostic-only**. It never moves, retries, pauses/unpauses, or auto-finalizes tasks.

Scheduler-side reporting emits structured, rate-limited task-log and engine-log entries in this exact form:
- `Stale task age threshold crossed [<level>]: column=<column> paused=<bool> ageMs=<n> warningThresholdMs=<n> criticalThresholdMs=<n>`

**Dashboard surface:** tasks with `ageStaleness` show a stale badge on `TaskCard`, a diagnostic row in `TaskDetailModal`, and the list view provides a `Stale only` filter that narrows to tasks with a live signal.

Success metric: maintainers can find all stale cards from the board UI in under 30 seconds.

Auto-completion/finalization remains owned by existing recovery passes:
- `recoverStaleMergingStatus`
- `finalizeNoOpReviewTasks`
- `recoverMergeableReviewTasks`
- `recoverAlreadyMergedReviewTasks`
5. **done** — merged/finalized
6. **archived** — preserved history, optionally cleaned from filesystem

Board ordering behavior:
- `todo` mirrors scheduler dispatch order: priority first (`urgent` → `low`), then oldest `createdAt` within a priority tier, then task ID as deterministic tie-break.
- `triage`, `in-progress`, and `in-review` remain priority-first with task-ID tie-breaks (`in-review` still pins merge-active statuses above non-merging tasks).
- The `done` column is recency-ordered by completion time (newest first), using `columnMovedAt` as primary and falling back to `updatedAt` then `createdAt` for legacy tasks.
- The dashboard **list view default ordering matches these same per-column semantics** until a user clicks a sortable header (manual list sorting still overrides defaults).

### Lifecycle commands

```bash
fn task move FN-001 todo
fn task merge FN-001
fn task archive FN-001
fn task unarchive FN-001
```

### Lifecycle invariants

**Paused-state normalization on reopen:** When a task is moved from `in-progress`, `in-review`, or `done` back to `todo` or `triage` (retry/requeue), Fusion clears `task.paused` and `task.pausedByAgentId` to prevent contradictory `todo + paused` or `in-progress + paused` states. A paused task in `todo` is excluded from scheduler dispatch.

**Manual cancel park (`userPaused`):** A user-initiated move from `in-progress` to `todo` (`moveSource: "user"`) sets `task.userPaused = true` and hard-cancels active executor work. Scheduler treats `userPaused` tasks as intentionally parked and will not auto-dispatch them until `userPaused` is cleared — either by explicitly unpausing the task from the dashboard or by moving it back to `in-progress`. Engine/internal requeues (`moveSource: "engine"`) do not set this flag.

**Paused-state normalization on explicit completion:** When an agent calls `fn_task_done` on a paused task, Fusion clears `task.paused` and `task.pausedByAgentId` regardless of the task's column (`in-progress` or `todo`). `task.paused` prevents new work from starting, but does not block an agent from completing in-flight work and transitioning the task to `done`. The scheduler respects `globalPause` independently.

**Global pause vs task pause:** `settings.globalPause` gates new scheduler dispatches and is checked by the `fn_task_done` handoff logic. Task-level `task.paused` is a per-task gate that blocks execution start. They are independent — a task can be paused individually even when `globalPause` is `false`, and clearing `task.paused` does not affect `globalPause`.

**Branch-conflict tripwire:** Executor tracks branch-conflict failures per task in-memory. After more than 5 `BranchConflictError` events for the same task in one executor lifetime, Fusion short-circuits recovery, marks the task `status: "failed"`, sets `paused: true`, and sets `pausedReason: "branch-conflict-tripwire"` to stop further automatic retries and suppress additional "Branch conflict recovery required" emissions for that task.

### Stranded-worktree recovery

When Fusion detects uncommitted task-attributable changes in a task worktree during a requeue/release path, it will **not** silently move the task back to `todo`/`triage`. Instead, it parks the task in `status: "failed"` so operators can recover the stranded workspace state.

Diagnostics are written to both places:

- `task.error` (task detail summary)
- task activity log entry (timeline)

Each diagnostic includes task ID, absolute worktree path, dirty-file count, and sample dirty paths.

Recovery flow:

1. Inspect the worktree: `cd <worktreePath> && git status`
2. Rescue changes as needed: `git diff` and/or `git stash push -u`
3. Clear/retry the failed task from the dashboard/CLI so it can re-enter scheduling after the workspace is safe.

### Branch metadata semantics

Task cards on the board only surface branch metadata when it is non-default/user-meaningful: they hide the conventional auto-generated working branch (`fusion/<task-id>` and suffixed variants) and hide the default merge target (`main`), while still showing custom working branches and non-default merge targets.

The board header search panel now includes two **board-only** branch filters:
- **Working branch** filters by `task.branch`
- **Target branch** filters by `task.baseBranch`

These filters apply only to board rendering (not list view). Each filter supports concrete branch values plus a **No branch** option that matches tasks where `branch` or `baseBranch` is unset. Persisted filter state remains intentionally deferred to follow-up task FN-3426.

Task branch fields are intentionally distinct:

- `task.branch` — the actual working branch used for the task worktree (for example `fusion/fn-1234` or a conflict-suffixed variant).
- `task.baseBranch` — the task's configured merge target/base branch intent.
- `task.executionStartBranch` — internal execution provenance used when scheduler/executor temporarily start from a dependency branch; this is transient and cleared during execution resets/recovery.

`PrInfo.baseBranch` is unchanged and continues to represent pull-request target branch metadata.

### Dependency reconciliation guidance

When a task was created to resolve a temporary failure state in another task (for example, a preserved `in-review/failed` merge condition), its dependency contract may become stale after recovery.

Use supported TaskStore/API paths to reconcile safely:

- Remove/replace stale dependencies through task update APIs (do not hand-edit `task.json`/SQLite)
- Add a single comment/log entry explaining why the dependency changed
- Keep downstream blockers coherent (only tasks that still truly depend on unfinished work should remain blocked)

Completion gating treats dependencies as resolved only when the dependency task is in `done`, `in-review`, or `archived`.

Auto-merge recovery follow-up creation is deduplicated: Fusion creates at most one active (`not done/archived`) recovery task per unresolved parent failure, and merge-conflict recovery also deduplicates by active branch ownership to prevent parallel duplicate follow-ups on the same conflict branch.

### Landed-task state reconciliation (maintenance)

If a task already shipped (`column: done`) but still carries transient failure metadata (`status: failed`, `error`, `worktree`, `blockedBy`, recovery retry fields), reconcile through supported TaskStore/API paths so SQLite and task JSON stay in sync.

Recommended pattern:
- Audit first (dry-run) for contradictory `done` + transient-failure state.
- Apply reconciliation with TaskStore-backed mutations (for example `moveTask(id, "done")` for done-normalization cleanup).
- Add one durable reconciliation log entry explaining why stale transient fields were cleared (avoid duplicating historical failure logs).
- Re-audit after apply and resolve or explicitly disposition any related stale follow-up tasks.

Do **not** patch `.fusion/fusion.db` directly without synchronizing `.fusion/tasks/*/task.json` through a supported store-backed path.

## Branch conflict handling

When executor branch allocation finds `fusion/<task-id>` already checked out elsewhere, Fusion fails loudly by default instead of silently renaming to sibling branches. The task is moved back to `todo` with `status: "failed"`, and logs include the conflicting worktree path, tip SHA, and stranded commits.

Fusion no longer provides a dedicated task-branch conflict CLI command. Resolve conflicting local branches/worktrees with standard git tooling, then retry the task. The legacy [`executorAllowSiblingBranchRename`](./settings-reference.md#executorallowsiblingbranchrename) setting still exists as an opt-in escape hatch for older workflows.

## Task Execution Modes

Each task has an execution mode that controls how the executor agent approaches the task:

| Mode | Description |
|------|-------------|
| `standard` | Full execution with complete review workflow (default) |
| `fast` | Expedited execution with minimal overhead for simple tasks |

### Fast Mode Bypassed Gates

When `executionMode: "fast"`, the following automated review/validation gates are **bypassed**:

| Gate | Standard Mode | Fast Mode |
|------|---------------|-----------|
| `review_step` tool enforcement | Available to executor agent | **Not injected** |
| Pre-merge workflow-step execution | Runs configured steps | **Skipped** |
| Custom graph pre-merge prompt/script/gate nodes | Run in selected custom workflows | **Skipped** |
| Workflow revision loop | Enabled (feedback → fix → re-review) | **Disabled** |

### Fast Mode Mandatory Gates

The bypass applies to both the legacy workflow-step path and the workflow graph executor path (including custom non-`builtin:coding` workflows). `undefined` or `null` execution mode is treated as standard mode.

The following quality gates **remain enforced** in fast mode:

| Gate | Behavior |
|------|----------|
| `task_done` requirement | Agent must call `task_done()` to complete |
| Completion blocker checks | Tests, build, and typecheck from PROMPT.md still enforced |
| Post-merge workflow steps | Run as normal (merger-owned) |

### Execution Mode Matrix

| Feature | Standard | Fast |
|---------|----------|------|
| Executor agent session | Full prompt + tools | Full prompt (minus review_step) |
| Pre-merge workflow steps (legacy, builtin, and custom graph workflows) | ✅ Run | ❌ Bypassed |
| Custom graph prompt/script/gate validation nodes | ✅ Run | ❌ Bypassed |
| `review_step` tool | ✅ Available | ❌ Not available |
| Post-merge workflow steps | ✅ Run | ✅ Run |
| Completion blockers (test/build/typecheck) | ✅ Enforced | ✅ Enforced |
| `task_done()` requirement | ✅ Required | ✅ Required |

### Setting Execution Mode

Execution mode can be set during task creation or editing:

- **Via API**: Include `executionMode` field in task create/update payload
- **Via dashboard**: Select execution mode in the task creation dialog or task detail modal
- **Task detail quick toggle**: In read mode, use the inline lightning-bolt control in task metadata to switch between **Standard** and **Fast** without entering full edit mode
- **Values**: `"standard"` (default) or `"fast"`

Example API payload:
```json
{
  "description": "Simple fix",
  "executionMode": "fast"
}
```

## Task provenance and research enrichment

Agent-created tasks now show a compact **Created by agent** marker directly on dashboard task cards when creation provenance indicates agent/automation origin (`sourceType: agent_heartbeat` or `sourceType: automation`, with legacy fallback to populated `sourceAgentId`). Where available, displays should prefer `sourceMetadata.agentName` over raw `sourceAgentId`.

Research-created tasks show provenance as **Created via Research** in the task detail header and `Source: Research` in `fn task show` output.

When `sourceMetadata.findingLabel` is present, the UI/CLI include it as context; otherwise they fall back to `runId` when available.

Research enrichment uses a canonical per-run document key:

- `research-{sanitizedRunId}`

Repeated enrichment from the same run writes new revisions to that same key (no sibling keys for the same run). Optional exported artifacts can also be attached to the task; duplicate attachment records are skipped unless an explicit replacement path is used.

Research document content appears in the existing **Documents** tab in Task Detail. Optional artifacts appear in existing task attachments.

## Task Detail Modal (Dashboard)

The task detail modal exposes multiple tabs.

In read mode, task metadata includes lightweight inline controls: priority can be changed from the priority chip, and execution mode can be toggled with a one-click lightning-bolt fast-mode button (Fast ↔ Standard) without opening full edit mode. These controls are intentionally aligned as a paired row (matched control height, baseline alignment, and mobile-safe wrapping) so frequent priority/mode changes stay quick and visually consistent.

Task metadata also shows compact `Created` / `Updated` timestamps: recent values render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates; both timestamps stay on one row across desktop and mobile widths for a compact metadata presentation.

Task settings edited from the modal now auto-save as you edit (change/blur with debounce for text-like fields). This includes title, description, dependencies, working/base branch (`branch`/`baseBranch`), workflow-step selection, model overrides in the edit form, and source issue metadata. In shared create/edit task forms, the GitHub Tracking controls are placed at the bottom of **More options** after **Workflow Steps**. The footer Save button remains available, but normal field edits no longer depend on a manual save click.

The edit footer shows inline autosave state (saving/saved/error), and successful saves propagate the returned task through `onTaskUpdated` so open detail/list state stays fresh.

The task detail modal exposes multiple tabs:

- **Details** — primary metadata and description
- **Steps** — progress across plan/implementation steps
- **Log** — task event history
- **Changes** — merge diff/change summary
- **Workflow** — workflow step results (pass/fail/skip)
- **Review** — actionable feedback surface (PR reviews/threads or reviewer-agent findings), manual refresh controls, and same-task revision actions for selected items
- **Stats** — execution timing + token usage breakdown
  - `Total execution time` prefers cumulative active runtime (`cumulativeActiveMs` + live in-progress segment)
  - `executionStartedAt` is a current-attempt anchor and may reset on reopen bounces; cards no longer rely on it alone for lifetime runtime
  - `firstExecutionAt` is the immutable first-dispatch wall-clock anchor; `executionCompletedAt` remains first-time-reaching-done
  - Task Detail also shows `Wall-clock since first execution` when it differs from active runtime (for bounced/reopened tasks)
  - Fallback order for legacy tasks: `timedExecutionMs` when present, otherwise `[timing]` log sum + workflow runtime
  - Workflow runtime is shown as a separate metric and is not double-counted into totals when `timedExecutionMs` is already available
- **Comments** — collaboration thread + steering controls
- **Model** — per-task model overrides and thinking level

## `PROMPT.md` Plan Structure

After planning, each task gets a structured `PROMPT.md` with sections like:

- Before → after transformation summary
- Mission
- Dependencies
- Context to read first
- File scope
- Steps
- Acceptance criteria
- Guardrails / Do NOT list
- Build/test/typecheck requirements

This file is the contract for execution and review.

## Task Comments vs Steering Comments

- **Task comments** (`fn task comment`) are general collaboration notes.
- **Review tab feedback** is dedicated actionable review input (PR review data in pull-request mode, reviewer-agent findings in direct/non-PR mode) used to request same-task revisions.
- Review data is served from task-scoped API endpoints: `GET /api/tasks/:id/review` and `POST /api/tasks/:id/review/refresh`.
- Both endpoints return one normalized contract (`TaskReviewData`) with stable per-item `itemId` values and `sourceMode` (`pull-request` or `reviewer-agent`) so Review UI and per-item progress can share one read model.
- The Review tab supports **manual refresh** without closing/reopening Task Detail:
  - Pull-request mode refreshes live GitHub-backed review decision/thread/comment state and updates PR metadata freshness.
  - Direct/non-PR mode refreshes normalized reviewer-agent feedback from persisted task review artifacts and does not call GitHub.
- In direct/non-PR auto-merge mode, the Review tab shows parsed reviewer-agent feedback with explicit loading/error/empty states instead of sending users to raw comments or agent logs.
- Review item bodies render markdown by default, and users can switch between **Markdown** and **Plain** modes from the Review tab action bar; the preference persists locally per user.
- **Comments remains the general discussion surface**; Review remains the actionable review surface.
- **Steering comments** (`fn task steer`) are execution guidance for the running agent.

Steering comments can be injected mid-run into active executor sessions.

When users select review items and trigger **Request revision** from the Review tab, Fusion starts an in-place same-task AI revision pass (no refinement child task):

- Review addressing progress is persisted per selected item in task state, including a durable snapshot and lifecycle timestamps.
- Each selected item transitions through `queued` → `in-progress` → `addressed`/`failed`, so Review progress survives refreshes and reloads even if upstream review data changes.
- Persisted snapshots are rendered in the Review tab when the original source item is no longer present, while Comments remains dedicated to general discussion.

- `in-progress` tasks receive compact steering guidance from the selected review items and continue on the same task/branch/worktree context.
- `in-review` tasks are resumed back to `in-progress`, reopen the last completed step, and keep same-task branch/worktree context for the revision pass.
- Assigned immediate-response agents are woken on-demand only when there is no active session; otherwise guidance is injected without forcing a new wake.

### User comments and triage re-consideration

User comments can trigger **re-triage** for already-planned but non-executing work:

- `triage` + `awaiting-approval` → user comment sets `status: "needs-replan"`
- `triage` or `todo` with a real (non-bootstrap-stub) `PROMPT.md` → user comment sets `status: "needs-replan"`
- `triage` or `todo` with only bootstrap-stub/unplanned prompt content → no re-triage transition

Execution ownership is preserved for active work:

- User comments on `in-progress` and `in-review` tasks do **not** re-route those tasks back through triage.
- Agent/system comments do **not** trigger comment-driven re-triage.

This is distinct from steering comments: steering feedback targets the currently running executor session, while comment-driven re-triage requests a fresh specification pass for planned work.
## Refinement Tasks

`fn task refine <id>` creates a new planning task that depends on the original done/in-review task.

Example:

```bash
fn task refine FN-042 --feedback "Add explicit rollback tests for partial failure"
```

Behavior:

- New title format: `Refinement: <source label>`
- New task depends on source task
- Created in `planning`
- Refinement tasks inherit the source task's GitHub tracking state (unlinked sources opt out; linked sources inherit `enabled` and optional `repoOverride`, but never copy the source issue link)

## Archive and Restore

### Archive behavior

- `fn task archive <id>` moves any live-board task (`triage`, `todo`, `in-progress`, `in-review`, or `done`) to `archived`; tasks already in `archived` are rejected.
- Archive records the task's `preArchiveColumn` so restore can return to the original live column instead of always assuming `done`.
- Dashboard delete confirmations for live tasks include an **Archive Instead** action so users can preserve history without soft-deleting the task.
- Archived tasks can also be deleted from the dashboard/API/CLI. Deleting an archived task removes the archived snapshot from lists and search, but first materializes the normal soft-delete tombstone so the task ID remains reserved unless the operator explicitly chooses allow-resurrection behavior.
- Cleanup mode can persist compact metadata and remove the task directory
- Archived tasks are read-only for task log/document writes:
  - `logEntry()` throws `Task <id> is archived — logging is read-only`
  - `upsertTaskDocument()` throws `Task <id> is archived — documents are read-only`
  - `fn_task_log` returns `ERROR: Cannot log to archived task — this task is read-only`

### Cleanup behavior

- Archived entries are persisted as compact archive snapshots in `archive.db`; legacy in-main-DB `archivedTasks` rows and older `.fusion/archive.jsonl` references may still appear in historical data/docs.
- Task directory (`task.json`, `PROMPT.md`, `agent.log`, attachments) can be removed

### Compact archive entry format

Archive entries preserve key metadata needed for restoration, including:

- `id`, `title`, `description`, `priority`, `column`, `preArchiveColumn`
- `dependencies`, `steps`, `currentStep`
- `size`, `reviewLevel`, `prInfo` (primary mirror), `prInfos` (canonical linked PR list), `issueInfo`
- `attachments` metadata
- task `log`
- timestamps (`createdAt`, `updatedAt`, `columnMovedAt`, `archivedAt`)
- model override fields (`modelProvider`, `modelId`, `validatorModel*`, `planningModel*`)

`agent.log` content is intentionally not preserved in compact archive entries.

### Restore behavior

`fn task unarchive <id>`:

- Restores archive entry if directory is missing
- Rebuilds `PROMPT.md`
- Moves task back to its recorded `preArchiveColumn` when available, falling back to the archived snapshot's prior `column`, then to `done` for legacy archive entries.
- Logs “Task restored from archive” when recovering from compact archive entry

### Task-ID collision safety and operator recovery

- Ordinary task creation, duplicate, and refine flows now fail safely if the chosen task ID already exists in active storage or archive storage. Existing task rows/files always win; the new create attempt must retry with a fresh reservation instead of overwriting data.
- A failed create may burn a distributed reservation. Gaps in `FN-*` numbering are expected and are safer than reissuing a possibly-colliding ID.
- `config.nextId` is legacy/read-only. The live allocator state is `distributed_task_id_state.nextSequence`, reconciled on store open against live tasks, archived task snapshots, and reservation history.

If you suspect **historical overwrites from pre-FN-4044 builds**, inspect surviving evidence in this order:

1. `archive.db` / archived task snapshots for the missing ID
2. `.fusion/tasks/<id>/task.json.bak`, `PROMPT.md`, attachments, and any surviving worktree branch named for the task
3. agent run logs / task documents / activity log entries that still mention the original ID
4. git commits whose subject/body references the original task ID but no longer matches the current task metadata

Recovery/backfill guidance:

- If the original task row still exists in archive storage, unarchive or manually recreate the task from that snapshot.
- If only prompt/worktree/git evidence survives, create a replacement task with a new ID and copy over the recovered description, prompt, documents, and attachments manually.
- If both the active row and archive snapshot were overwritten, Fusion cannot reconstruct lost attachments/comments automatically; recreate them from git history, branch/worktree contents, screenshots, or external issue trackers.
- Record the incident in the replacement task so future audits understand why the task ID and commit history diverge.

## Reverting Done/Archived tasks (git path + AI-undo fallback)

- `POST /api/tasks/:id/revert` (FN-7523) reverts a **Done** or **Archived** task's landed work via git. Only `done`/`archived` tasks are revertable; the source task's column/status is never mutated as a side effect.
- The engine resolves the task's attributable commit(s) (squash single-commit, rebase/cherry-pick trailer-filtered subset, or lineage-snapshot fallback), performs a non-committing dry-run to classify the outcome, and only writes a real commit when the dry-run is clean.
- The route accepts an optional request body `{ mode?: "git" | "ai" | "auto" }` (default `"auto"`; unknown values reject with 400):
  - `"git"` — the FN-7523 git-only behavior. The result (including a conflicting/unsupported result) is returned as-is and never creates a follow-up task.
  - `"ai"` — skip git entirely and always create the AI-undo fallback task (FN-7524).
  - `"auto"` — try git first. A clean/alreadyReverted/needsHuman result is returned unchanged. A conflicting or unsupported result falls back to creating the AI-undo task.
- Also accepts an optional `{ granularity?: "squash" | "per-sha" }` field (FN-7548) that selects the git-path commit granularity: `"squash"` (default, unchanged) accumulates all attributable commits into one revert commit; `"per-sha"` creates one attributed revert commit per original sha (each with its own `Fusion-Task-Id` trailer and audit line), skipping no-op shas without empty commits. A mid-batch conflict in either mode rolls back the whole batch — no partially-landed per-sha commits. This field only affects the single-repo git path and is ignored when `mode` resolves to `"ai"` or the task is a workspace task.
- Git-path response contract (additive only): `{ mode: "git", clean, revertCommitSha?, revertCommitShas?, conflicts?, alreadyReverted?, unsupported?, needsHuman?, reason? }`. A clean revert lands a `revert(FN-xxxx): ...` commit carrying a `Fusion-Task-Id` trailer on the resolved base branch; `revertCommitShas` reports every commit created (all of them for `per-sha`, the single one for `squash`) alongside the existing `revertCommitSha`.
- AI-undo response contract: `{ mode: "ai", createdTaskId: "FN-YYYY", alreadyOpen?: true }`. The created task is an ordinary `triage`-column board task (via the normal `store.createTask` path) that references the source task's id, mission, and landed files, and instructs undoing the source task's behavior while preserving unrelated later changes to the same files, using a `revert(FN-xxxx): ...` commit convention. It carries NO dependency on the (already done/archived) source task. A `sourceMetadata.revertOf` marker makes repeated fallback calls idempotent — while an AI-undo task for that source is still open, a further call returns the same `createdTaskId` with `alreadyOpen: true` instead of creating a duplicate; a prior undo task that itself reached `done`/`archived` does not suppress a fresh one.
- **Workspace (multi-repo) tasks (FN-7547):** tasks with `workspaceWorktrees` populated (`isWorkspaceTask`) are revertable too — the route dispatches to a dedicated workspace path that reasons about every sub-repo's integration branch as ONE all-or-nothing unit. It resolves each sub-repo's attributable commit(s), dry-run classifies every sub-repo first, and only commits a `revert(FN-xxxx): ...` commit on EACH sub-repo when every sub-repo classifies clean/already-reverted; if any sub-repo conflicts, no sub-repo is committed and every touched sub-repo worktree is rolled back to its pre-call state. Response contract for workspace tasks: `{ mode: "git", clean, workspace: { repos: [{ repo, classification, revertCommitSha?, conflicts?, alreadyReverted? }] }, conflicts?: {repo, file, ...}[] }`. A conflicting workspace result still falls back to the AI-undo task under `"auto"` mode, same as a single-repo conflicting result.
- **`autoMerge:false` PR-based revert (FN-7554):** for a single-repo task whose git revert classifies **clean**, `autoMerge:false` no longer dead-ends at `needsHuman`. The route prepares a dedicated `fusion/revert-<id>` branch off the resolved base branch (via the engine's `prepareRevertPrBranch`, which NEVER writes to the base branch itself), pushes it, and opens a GitHub PR through the same owner/repo resolution, `githubRateLimiter` gate, `findPrForBranch` idempotency, and `manual: true` handoff as `POST /tasks/:id/pr/create`. Response: `{ mode: "pr", clean: true, prUrl, prNumber, revertBranch, existingPr? }` — a second call while the PR is still open links the existing PR (`existingPr: true`) instead of re-pushing. GitHub unconfigured or rate-limited still degrades gracefully to `{ mode: "git", needsHuman: true, reason }`, and a conflicting/unsupported/already-reverted classification is unaffected (no PR is opened; `"auto"` mode still falls back to the AI-undo task on conflict/unsupported).
- **`autoMerge:false` PR-based revert extended to workspace tasks (FN-7577):** a workspace task whose git revert classifies **clean across every sub-repo** also opens PRs instead of dead-ending at `needsHuman` under `autoMerge:false`. The engine's `prepareWorkspaceRevertPrBranches` mirrors the workspace all-or-nothing classify-all contract: it dry-run classifies EVERY sub-repo first, and only prepares one `fusion/revert-<id>` branch per sub-repo (never writing any sub-repo's integration branch) when every sub-repo classifies clean/already-reverted — a single conflicting sub-repo aborts the WHOLE preparation with no branch created anywhere. The route then resolves owner/repo and checks the rate limiter for EVERY sub-repo before pushing/creating any PR (so a GitHub-unconfigured or rate-limited sub-repo degrades the whole task to `needsHuman` rather than opening a partial subset), then opens one PR per sub-repo reusing FN-7554's per-sub-repo `findPrForBranch` idempotency and `manual: true` handoff. Response: `{ mode: "pr", clean: true, workspace: { repos: [{ repo, revertBranch, prUrl, prNumber, existingPr? }] } }`. Existing `{ mode: "git" | "ai" | "pr" }` shapes, the `autoMerge:true` workspace path, and FN-7554's single-repo path are unchanged.
- **Dashboard auto-linking (FN-7555):** the AI-undo task's card shows an "Undo of FN-xxxx" chip and its detail view shows a clickable "Created to undo FN-xxxx" link back to the source task. The source task's detail view shows an "Undo task: FN-YYYY" link whenever an OPEN undo task referencing it exists in the loaded tasks (matching `TaskStore.findOpenRevertTaskForSource`'s open-only semantics — a `done`/`archived`/soft-deleted undo task is never surfaced as active). Both directions are derived client-side from `sourceMetadata.revertOf`; no new API. A dedicated Done/Archived card revert-trigger action is still a separate follow-up (see FN-7525).
- **Configurable AI-undo workflow default (FN-7556, UI: FN-7578):** the project setting `aiUndoTaskWorkflowId` (default `builtin:review-heavy`) selects the workflow applied to every AI-undo task created above (`mode:"ai"` and the `auto`/workspace conflict fallbacks all share one creation seam, so all three inherit this default) — a stricter review posture is warranted because these tasks reverse already-shipped code. A blank/unset value means the created task inherits the project default workflow (pre-FN-7556 behavior); the route falls back to inherit (with a logged warning) if the configured id is blank or does not resolve to a real workflow, so a misconfigured id never breaks AI-undo task creation. Editable from **Settings → General → AI-undo task workflow** (choose "Inherit project default workflow" to store the blank/inherit sentinel). See [Settings Reference → Project Settings](./settings-reference.md#project-settings).


## GitHub Issue Import and PR Creation

GitLab enablement, instance/API URL, and access-token configuration are available in Settings for GitLab.com and self-managed GitLab (`gitlabEnabled`, `gitlabInstanceUrl`, optional `gitlabApiBaseUrl`, `gitlabAuthToken`, `gitlabAuthTokenType`). Fusion accepts personal, project, and group access tokens for GitLab HTTP API import tasks; read-only project issue, group issue, and merge request imports require `read_api` or `api`, while later write actions such as comments and auto-close require `api`.

GitLab imports are HTTP API only and do not require or invoke `glab`. They require effective `gitlabEnabled !== false`; when GitLab is disabled, dashboard/API/CLI/pi import fetches fail clearly before making GitLab network calls, while saved URL/token settings and existing linked GitLab metadata remain visible for re-enable. Operators can import project issues, group issues, and project merge requests from the Import Tasks surface, CLI, or pi extension tools. Imported tasks are created in `triage`, include the GitLab body (or `(no description)`) plus `Source: <web_url>`, and persist `source.sourceType: "gitlab_import"`, `source.sourceMetadata.provider: "gitlab"`, `resourceType` (`project_issue`, `group_issue`, or `merge_request`), instance/API URL, project/group identity, IID, and web URL. Group issue imports preserve the originating project identity from GitLab so duplicate detection is project-aware instead of group-path-only. Merge request imports use MR IID as the visible number and a namespaced external ID so they do not collide with issue imports.

Duplicate detection checks existing non-archived task provenance and source URLs before creating another GitLab-imported task. GitLab lifecycle side effects (completion comments, close/reopen, source closed-at backfill, and tracking refreshes) also require GitLab to be enabled; when disabled they skip network work with task-log diagnostics instead of clearing source metadata. GitLab linked tracking display, comments/notes, auto-close/reopen, Command Center signals/analytics, research/search support, and any GitLab-star prompt remain out of scope until the later GitLab parity tasks mapped in [GitLab Parity Inventory](./gitlab-parity-inventory.md).

Linear issue import is available through the bundled **Linear Import** plugin, not the core GitHub/GitLab Import Tasks implementation. Operators enable the plugin from Plugin Manager, configure the plugin-owned Linear API key, then use the plugin dashboard view or plugin tools to browse and import issues. Imported Linear tasks are created in `triage`, include the Linear body (or `(no description)`) plus `Source: <url>`, and persist `sourceIssue.provider: "linear"` plus `source.sourceMetadata.provider: "linear"` with stable issue id, identifier, URL, team, state, assignee, and timestamps where available. Duplicate detection checks existing non-archived Linear provenance by issue id, identifier, and source URL before task creation and reports the existing task id when a duplicate is found.

Import issues:

- GitHub-imported tasks retain typed source issue metadata (`sourceIssue.provider/repository/externalIssueId/issueNumber/url`), which executor and merger flows use to include `Ref: owner/repo#N` in commit bodies.
- When `githubCloseSourceIssueOnDone` is enabled (default: `false`), Fusion also closes linked source-imported GitHub issues with `state_reason: completed` when the task moves into `done`. On startup, a bounded reconciliation sweep checks done tasks and closes any still-open source issue links that were missed due to transient failures.

```bash
fn task import owner/repo --labels bug --limit 20
fn task import owner/repo --interactive
```

Create PR for an `in-review` task:

```bash
fn task pr-create FN-120 --title "Fix flaky auth flow" --base main
```

Manual/non-auto-merge behavior:
- Task PR branches use `fusion/<task-id-lower>`.
- In the dashboard task detail modal (`in-review`), the existing primary footer action can manually drive PR-first completion when `mergeStrategy: "pull-request"` and `autoMerge: false`:
  - `Start PR Review` (no PR linked yet)
  - `Check PR Status` (open PR linked; refreshes PR status from GitHub, does not prompt merge)
  - `Finish & Close` (PR already merged)
- Manual PR creation first checks for an existing PR on that branch and links it when found.
- If no PR exists, Fusion pushes the task branch to `origin` before creating the PR.
- In the dashboard Create-PR modal, if preflight detects merge conflicts with the selected base branch, you can choose **Resolve conflicts with AI**. Fusion resolves the task branch in-place, commits the result, pushes the updated branch to `origin`, and then lets you retry PR creation.
- When buffered actionable PR feedback exists on a PR that is already merged/closed and the task leaves `in-review`, Fusion creates a dependency-linked follow-up task in `triage` so feedback is not stranded.

## GitHub Tracking Issues

GitHub tracking issues are optional issues Fusion can create from Fusion tasks. They are **not** the same as imported source issues (`issueInfo` / `sourceIssue`): imported issues represent an existing GitHub issue that created the task, while tracking issues are new GitHub issues opened to track a Fusion task.

### Agent- and tool-created task coverage

When task creation runs with tracking enabled, Fusion attempts issue creation via a **universal post-create hook** (`setTaskCreatedHook`) that fires for every task-creation path: dashboard HTTP routes, pi extension tools (`fn_task_create`, `fn_task_import_github*`, `fn_delegate_task`), CLI commands (`fn task add`, `fn task duplicate`, `fn task refine`), mission/feature triage, automation `create-task` workflow steps, agent-driven delegation, routine/cron-created tasks, and subtask creation paths. Dashboard REST API coverage explicitly includes `POST /api/tasks`, `POST /api/tasks/:id/duplicate`, `POST /api/tasks/:id/refine`, and `POST /api/subtasks/create-tasks`. The hook is registered once per process entrypoint by calling `registerGithubTrackingHook()` at startup before any reachable `store.createTask` path. See the FN-5057 audit matrix (task document `audit`) for the current surface-by-surface registration map and resolved `sourceType` values. The hook is best-effort and non-blocking: task creation still succeeds even if repo resolution fails or GitHub calls fail. For existing tasks, PATCH first persists any `githubTracking` mutation (enable/disable, repo override, or unlink), then evaluates whether the updated task is **enabled and still unlinked** and should trigger best-effort issue creation (including non-`githubTracking` edits). This keeps retry/create behavior consistent from Task Detail instead of relying on stale pre-patch state.

Tracking behavior is controlled per task:

- `task.githubTracking.enabled` turns tracking on for that task.
- `task.githubTracking.repoOverride` optionally forces a specific target repo (`owner/repo`).
- In the dashboard **Task Detail** modal, eligible existing tasks (`triage`, `todo`, `in-progress`, `in-review`) always show a compact GitHub tracking summary row. When tracking is currently disabled and editable, the header exposes a one-click **Enable GitHub tracking** button; linked-issue details and the rest of the tracking controls remain behind the disclosure arrow for disable/retarget flows.
- After an engine/dashboard restart, Task Detail preserves the fetched full `githubTracking` payload even when the board opened the modal from a slim task row that intentionally omitted tracking metadata.
- When a task is already tracking-enabled but still unlinked, Task Detail exposes a **Create tracking issue** action in the disclosure content (including non-editable columns like `done`) so "Issue not yet created" is not a dead-end state.
- Clearing the Task Detail repo override stores `null`, which reverts repo resolution to project/global defaults.
- Explicit task-level enablement is honored even when project/global GitHub tracking defaults are unset. If `enabled: true` and the repo resolves at task scope (for example via `repoOverride`), Fusion attempts tracking-issue creation on both create-time and eligible edit-time flows, including tasks imported from GitHub (`sourceType: "github_import"`).
- Explicit manual unlink (`githubTracking.issue: null`) does not recreate a tracking issue in that same update request, and disabling tracking does not create new issues.
- On board cards, Fusion shows both the imported-source provenance marker and tracking link when they refer to different issues. The tracking chip is hidden only when the linked tracking issue exactly matches the source issue (`owner/repo#number`) to avoid duplicate badges.

Repository resolution order:

1. Task override: `task.githubTracking.repoOverride`
2. Project default: `githubTrackingDefaultRepo`
3. Global default: `githubTrackingDefaultRepo`

When Fusion creates a tracking issue, it uses:

- Title: `[FN-XXXX] Task title`
- Body prefix: `Fusion task: FN-XXXX`
- Body content: bounded plain-text task summary snippet (not full prompt content)

When tracked tasks later move to `in-progress` or `done`, Fusion also posts a short lifecycle comment on the linked tracking issue. The `in-progress` comment stays plain-text and capped, while the `done` comment can include the merge commit SHA/subject, task branch, PR link, file-change stats, and merge timestamp when those fields are available.

When a tracked task moves into `done`, Fusion closes the linked GitHub issue with `state_reason: completed`; when it leaves `done` for an active column, Fusion reopens the issue with `state_reason: reopened`; and when the Fusion task is permanently deleted from the dashboard, Fusion now prompts for issue handling (`close`, `delete`, or `leave`). If no explicit choice is provided by API callers, Fusion preserves the legacy default and closes the linked issue with `state_reason: not_planned`.

For source-imported GitHub issues (`task.sourceIssue` / `sourceType: "github_import"`) without tracking metadata, delete now follows the same close/delete/leave prompt. The prompt references the source issue (`owner/repo#number`) and forwards the selected `githubIssueAction` through the existing delete route. For non-interactive callers that omit `githubIssueAction` (or send `"auto"`), the source-imported delete default is `close`.

GitHub authentication/settings are configured in [Settings Reference](./settings-reference.md) via `githubAuthMode` (`gh-cli` or `token`) and `githubAuthToken`.

## Completion Modes (`mergeStrategy`)

- **`direct`**: local squash-merge flow into target branch
- **`pull-request`**: PR-first completion flow via GitHub checks/reviews

Configured via settings.

## Per-Task Model Overrides

Each task may override:

- Executor model (`modelProvider` + `modelId`)
- Validator model (`validatorModelProvider` + `validatorModelId`)
- Planning model (`planningModelProvider` + `planningModelId`)
- Thinking level (`off|minimal|low|medium|high`)

Overrides are configured from the task model tab or task creation actions.

## Node Routing

Tasks execute on an effective node selected by routing precedence:

1. **Per-task node override** (`Task.nodeId`)
2. **Project default node** (`defaultNodeId` in project settings)
3. **Local execution** (no node configured)

At dispatch time, scheduler routing is persisted on the task as:
- `effectiveNodeId`
- `effectiveNodeSource` (`task-override`, `project-default`, or `local`)

### Create-time routing semantics

Cluster-aware task creation separates two routing decisions:

- **Transport node**: which node receives the `POST /api/tasks` request (can be local or proxied remote).
- **Execution target** (`Task.nodeId`): which node should run the task later.

These are intentionally independent. Routing a create request through node A does not force execution on node A unless `Task.nodeId` also points there.

### Per-task node override

You can set or clear a task override from:

- Task detail modal → **Routing** tab
- Quick/create flows that support node selection
- Bulk task actions
- CLI:
  - `fn task set-node <task-id> <node-name-or-id>`
  - `fn task clear-node <task-id>`
  - `fn task create "..." --node <node-name-or-id>`
- Pi extension tool `fn_task_update` with `nodeId`

### Active-task blocking

Node override changes are blocked while a task is active/in progress. Core validation (`validateNodeOverrideChange`) returns `reason: "task-in-progress"` and users must pause/stop or wait for completion before changing routing.

### Task detail routing summary

The Routing tab shows:

- Effective node (with health indicator when known)
- Routing source (override vs project default vs local)
- Unavailable-node policy value (`block` or `fallback-local`)
- Lock banner when routing is currently immutable for an active task

### Activity log entries

When a task is dispatched, task activity/log records include routing decisions such as:

- `Node routing resolved: <node-or-local> (source: <source>)`

Use `fn task show <id>` or task logs to inspect current node routing context.

### Examples

```bash
# Route one task to a specific remote node
fn task set-node FN-204 edge-runner

# Remove override and return to project default routing
fn task clear-node FN-204

# Create a task with node override immediately
fn task create "Reproduce flaky node error" --node edge-runner

# Inspect routing summary from CLI
fn task show FN-204
```

See also: [Settings Reference → Node Routing settings](./settings-reference.md#node-routing-settings-project-scope) and [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture).

## Review Level

Review levels control the rigor of the review process for a task:

| Level | Name | Description |
|-------|------|-------------|
| 0 | None | No review |
| 1 | Plan Only | Review only the plan |
| 2 | Plan and Code | Review both the plan and implementation |
| 3 | Full | Full review with all checks |

Review level can be set during task creation (in the New Task dialog under More options) or when editing a task (in the task detail modal).

The review level affects how the reviewer agent evaluates the task but does not override workflow steps or model presets.

## Model Presets and Auto-Selection by Size

Project settings support reusable model presets:

- `modelPresets`
- `autoSelectModelPreset`
- `defaultPresetBySize` (`S`, `M`, `L`)

Users can apply presets at task creation; manual model selection can override them.

## AI Title Summarization

When `autoSummarizeTitles` is enabled and a task has a long untitled description, Fusion can auto-generate a concise title. This applies to tasks created from the dashboard/API as well as tasks created by agents and tooling flows (`fn_task_create`, delegated tasks, and triage-created child tasks). GitHub tracking now waits for the `createTask`-level summarizer (explicit or auto-attached from settings) to settle before filing, then uses that resulting title and falls back to deterministic description-derived title generation only when summarization is unavailable.

If a configured title summarizer model is stale after a pi upgrade, Fusion logs a warning naming that provider/model and retries once with automatic model resolution before falling back to deterministic title generation. Genuine AI-service failures are not masked by this retry.

## Screenshots

### Board/task cards + quick entry

![Task cards and quick entry on board view](./screenshots/dashboard-overview.png)

### Task detail modal

![Task detail modal](./screenshots/task-detail.png)

For UI-level details, see [Dashboard Guide](./dashboard-guide.md).

## Decision-only tasks (`noCommitsExpected`)

Use `noCommitsExpected: true` for tasks where the deliverable is a decision/report, not code changes.

- Meaning: executor allows `fn_task_done` with zero commits for that task.
- Triage auto-sets it only when the task is clearly decision-shaped (e.g. "Decide whether...", "Evaluate...", "Verify...", "Audit...") with explicitly observational acceptance criteria and explicit no-code language.
- Review Level 1 coordination/routing tasks that are board-only, explicitly say not to change source, and scope only task documents/metadata can also complete without commits even if older prompts omitted the explicit flag. This fallback is intentionally narrow and exists to recover plan-only coordination work; it does not bypass wrong-worktree or wrong-branch checks.
- Ambiguous/forked tasks (e.g. "Investigate..." or "Investigate and fix if needed") leave it unset by default.
- Implementation, feature, bug-fix, source-docs, test, config, or broad investigation tasks still require commits unless they have an explicit and valid no-commit contract.
- If a legacy coordination task is stuck with `fn_task_done refused: no_commits`, prefer setting/verifying `noCommitsExpected` and re-running normal no-op finalization rather than editing `.fusion/fusion.db` directly.
- You can manually set/clear it in Task Detail via **No commits expected (decision-only task)**.
- Task cards show a **decision-only** badge when enabled.
- Finalization still uses the existing no-op review/merge path (`mergeDetails.noOpMerge: true`, `mergeConfirmed: true`); no synthetic merge strategy values are introduced.
