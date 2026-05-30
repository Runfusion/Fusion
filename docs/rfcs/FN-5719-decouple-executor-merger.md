# FN-5719 RFC: Decouple Executor and Merger Lifecycle Stages

## Status

Draft for CEO ratification (agent-4ec1ff85). No implementation in this task.

## 1) Current coupling and failure modes

### Current coupling in code

The executor-to-merger handoff is currently coupled through shared task lifecycle state (`in-progress -> in-review -> done`) plus shared engine event/scheduler surfaces:

- Executor completion hands off by calling `store.handoffToReview(...)` (`packages/engine/src/executor.ts:1434-1444`, used at completion paths `4528-4532`, `2791-2804`).
- TaskStore performs the authoritative transition to `in-review` through `moveTaskInternal(...)` (`packages/core/src/store.ts:5187-5231`).
- ProjectEngine listens to `task:moved` and, when `to === "in-review"`, schedules merge queue handoff after grace delay (`packages/engine/src/project-engine.ts:2391-2456`).
- Scheduler treats `in-review` as dependency-satisfying (`packages/engine/src/scheduler.ts:170-174`, `1249-1251`, `665-668`), includes live in-review worktrees in overlap leases via `setActiveScopeLease(..., "in-review")` (`1194-1209`), and runs PR-monitor lifecycle keyed to in-review transitions (`471-507`, `588-634`, `938-949`).
- Merger finalizes `in-review -> done` in `completeTask(...)` (`packages/engine/src/merger.ts:12032-12043`) and also performs retry rebounds to `todo` with progress preserved (`8028`, `8090`, `8226`).

### Failure modes caused/exacerbated by coupling

1. **Merge retry/rebound churn can hold lifecycle and scope surfaces**
   - Symptom: repeated `in-review <-> todo` rebounds or prolonged review-state occupancy while transient merge paths retry (`merger.ts:8028/8090/8226`; transient classifier `transient-merge-error-classifier.ts:37-46`).
   - Coupling cause: same lifecycle states and scheduling surfaces represent both execution completion and merge orchestration progress.

2. **Phantom-merge/already-on-main ambiguity stalls**
   - Symptom: tasks stall in review/merge recovery while already-landed detection and audit recovery determine ownership/survival (`already-merged-detector.ts:37-223`, `merger-audit-recovery.ts:29-111`).
   - Coupling cause: merge proof/classification is entangled with the same completion lifecycle that executor dispatch and dependency logic inspect.

3. **Resume-limbo interactions spill across execution and merge semantics (FN-5704)**
   - Symptom: repeated no-progress resume loops needing escalation to preserve-work `todo` rebound with `task:resume-limbo-escalated` (`self-healing.ts:2345-2396`).
   - Coupling cause: one lifecycle surface tries to encode both “execution ownership” and “merge/verification ownership,” so reclaim/recovery paths can oscillate.

4. **In-review lease/dependency behavior can starve or serialize unrelated execution**
   - Symptom: in-review tasks with worktrees participate in overlap blocking and base-branch resolution (`scheduler.ts:1194-1209`, `962-976`, `1439-1444`).
   - Coupling cause: merge-phase tasks still consume executor-adjacent scheduling semantics.

## 2) Proposed decoupled model

Introduce an explicit **Merge Request Handoff Contract** between executor completion and merger orchestration.

- **Executor owns task until completion handoff accepted.**
- On completion, executor emits `completion_handoff` with immutable payload (taskId, branch/worktree refs, merge target, evidence/run ids, automerge policy snapshot).
- Store persists a separate merge-request record/queue entry (authoritative seam), then transitions task to review-visible state.
- **Merger lane independently dequeues merge requests** and mutates merge lifecycle metadata without requiring executor lane ownership.

### State ownership

- **Executor-owned phase:** `in-progress` + execution statuses.
- **Review-owned phase:** `in-review` as human/review visibility state.
- **Merger-owned phase:** separate merge request state machine (queued/running/retry/exhausted/succeeded) not inferred from executor state.

### FN-5147 preservation

- `autoMerge:false`: task remains terminal in `in-review` until human merge. Self-healing must not move backward/re-enqueue/pause-fail these rows (existing invariant preserved).
- `autoMerge:true`: `in-review` creation also creates merge-request entry; merger consumes asynchronously.

### Worked flow: `autoMerge:true`

1. Executor finishes implementation and calls handoff (`executor.ts:1434-1444`).
2. Store atomically records `completion_handoff_accepted` + merge-request row, then moves task to `in-review`.
3. Merge lane receives `merge:request-enqueued` event (plus periodic poll fallback) and dequeues independently.
4. Merge attempts run; retries mutate merge-request state (`retrying`) without reclaiming executor ownership.
5. On success, merger moves `in-review -> done` (`merger.ts:12032-12043`) and marks merge-request `succeeded`.

### Worked flow: `autoMerge:false`

1. Executor finishes and handoff is accepted; task moves to `in-review`.
2. Merge-request row is either not created, or created as `manual-required` and never auto-dequeued.
3. Self-healing/recovery sweeps must treat this state as terminal-human-owned (FN-5147): no backward move to `todo`, no auto pause/fail mutation, no auto re-enqueue.
4. Human merge action (dashboard/CLI/manual) is the only path to done.

### Queueing and leases

- **Dequeue contract:** event-driven enqueue (`merge:request-enqueued`) with poll-based reconciliation fallback for crash recovery.
- **State machine:** `queued -> running -> (retrying -> queued)* -> succeeded | exhausted | cancelled`.
- **Lease boundary:** active overlap/scope leases are released when handoff is accepted; merger uses separate merge concurrency + integration-branch locks.
- **Back-pressure:** queue depth/age thresholds throttle new merge dequeues, not executor dispatch; executor lane continues scheduling unrelated work.

## 3) Impact on reliability invariants and backstops

| Invariant / backstop | Status under proposal | Notes |
|---|---|---|
| FN-5147 `autoMerge:false` terminal-until-merged | Preserved unchanged | `in-review` remains terminal for human merge when auto-merge disabled; merge-request lane cannot mutate lifecycle backward. |
| FN-5704 resume-limbo escalation | Preserved via new mechanism | Existing FN-5704 remains executor-phase (`self-healing.ts:2345-2396`); merger lane adds analogous no-progress cap (`running/retrying` age + attempt ceiling -> `exhausted` without executor rebound). |
| Self-healing stuck-budget terminalization | Preserved via new mechanism | `checkStuckBudget`/reclaim handoff paths that currently park via review handoff (`self-healing.ts` stuck-budget/reclaim paths) must emit handoff-accepted marker and only enqueue merge when policy allows. |
| Recovery policy (`recovery-policy.ts`) bounded retries | Preserved via new mechanism | `computeRecoveryDecision(...)` remains authoritative for executor/triage retries; merge retries use merge-request state transitions instead of column rebounds. |
| Move-task hard-cancel (`in-progress -> todo`) | Preserved unchanged | Cancels executor session/subprocesses; if handoff not accepted, no merge request exists; if accepted, cancel path explicitly tombstones/cancels pending merge request. |
| Scheduler dependency semantics (`in-review` satisfies deps) | Requires modification | Migration from `dep.column === in-review` checks (`scheduler.ts:170-174`, `1249-1251`) to explicit handoff-complete marker. |
| In-review overlap leases | Requires modification | Migration from `setActiveScopeLease(..., "in-review")` (`scheduler.ts:1194-1209`) to executor-phase-only scope leasing; merger gets independent merge locks. |
| Run-audit continuity | Preserved via new mechanism | Existing events remain (`task:resume-limbo-escalated`, task move/handoff events) with additive seam events (`task:completion-handoff-accepted`, `merge:request-enqueued/dequeued/cancelled`). |
| File-scope/squash invariants | Preserved unchanged | Merge policy and squash/file-scope guards remain in merger pipeline. |

### Enforcement-point migration notes

- **Dependency satisfaction:** cutover from implicit `column === in-review` to explicit `completion_handoff_accepted` indicator; during dual-run, accept either signal with audit diff logging.
- **Overlap leasing:** stop leasing in-review scopes once handoff accepted; keep backward-compatible shadow metrics on old/new blocker decisions before final cutover.
- **Retry ownership:** transient merge classification continues (`transient-merge-error-classifier.ts`), but actions mutate merge-request state (`queued/running/retrying/exhausted`) instead of forcing `in-review -> todo` rebound.

## 4) Migration/rollout, test strategy, non-goals

### Phased rollout

1. Add merge-request contract behind feature flag (write-only shadow mode).
2. Dual-write/dual-observe: existing coupling path remains authoritative; compare outcomes.
3. Cutover dequeue authority to merge-request queue; retain fallback.
4. Remove legacy implicit handoff wiring once parity is proven.

Each phase must be independently revertable.

### Test strategy (follow-on implementation)

Add/extend reliability-interaction tests under `packages/engine/src/__tests__/reliability-interactions/`:

- executor completion while merge lane busy still allows unrelated executor dispatch
- transient merge retry does not block executor lane
- `autoMerge:false` remains terminal-until-merged
- FN-5704 no-progress resume-limbo non-oscillation across seam
- move-task hard-cancel during handoff is deterministic
- phantom/already-merged advance path remains non-stalling

Per FN-5048: narrow seams, in-memory fakes, fake timers, no slow polling/network tests.

### Non-goals

- No change to AI merge arbitration policy.
- No change to PR monitor external integration semantics.
- No worktree pooling redesign.
- No dashboard UX redesign beyond lifecycle truth required by implementation.

## 5) Open questions and CEO ratification

### Open questions

1. Should dependency satisfaction switch from `column === in-review` to an explicit completion-handoff marker?
2. Should merge-request queue be persisted in existing task row JSON vs dedicated table?
3. What is the authoritative cancel behavior when user moves a review task back to todo after handoff acceptance?
4. Should merge back-pressure be global or branch-group aware by default?

### Recommendation for ratification

**Recommend: explicit persisted merge-request queue/table + explicit handoff-accepted marker as the executor/merger seam.**

Rationale: strongest observability, replayability after restarts, clean ownership boundaries, and reduced coupling to overloaded `in-review` semantics.

### CEO Ratification Gate

Per CEO directive, implementation must be coordinated with **agent-4ec1ff85** before any engine change lands. This RFC is the gating artifact; follow-on implementation remains blocked pending ratification.

Follow-on task filed: **FN-5723** (blocked pending this ratification).
