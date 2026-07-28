---
title: Self-healing force-removes a live planning session's worktree and parks the card branch-conflict-unrecoverable
date: 2026-07-26
category: logic-errors
module: engine self-healing / triage planning session
problem_type: logic_error
component: engine
symptoms:
  - "Healthy card parked paused with pausedReason \"branch-conflict-unrecoverable\" and userPaused false (no operator action)"
  - "Task error \"Task branch conflict: fusion/<id> is not safely reclaimable (tip-already-merged cleanup failed for <id>)\""
  - "Task log shows git worktree remove --force failing against a worktree a planning session is running in"
  - "Card sits in Todo showing \"Queued to plan\" for minutes with most concurrency slots free and no persisted reason"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/triage.ts"
  - "packages/engine/src/self-healing.ts"
  - "packages/engine/src/active-session-registry.ts"
  - "packages/engine/src/concurrency.ts"
tags:
  - worktree-lifecycle
  - active-session-registry
  - self-healing
  - planning-session
  - concurrency-admission
  - run-audit
---

# Self-healing force-removes a live planning session's worktree and parks the card branch-conflict-unrecoverable

## Problem

Planning sessions were moved to run inside the task's own git worktree, but never registered that path in `activeSessionRegistry` — the process-global registry every worktree-removal guard consults for liveness. The self-owned-branch reclaim sweep was therefore blind to a live planner, force-removed the worktree it was working in, and escalated the resulting failure into an unrecoverable pause on a perfectly healthy card.

## Symptoms

- Card parked `paused` with `pausedReason: "branch-conflict-unrecoverable"` and `userPaused: false` — i.e. the engine paused it, not a person.
- `task.error`: `Task branch conflict: fusion/<id> is not safely reclaimable (tip-already-merged cleanup failed for <id>)`
- Task log sequence:
  ```
  worktree:create  .worktrees/<name>   branch fusion/<id>
  Planning session running in task worktree .../<name>
  Auto-recovery warning: tip-already-merged cleanup failed —
    Command failed: git worktree remove --force ".../<name>"
  Preserved uncommitted worktree changes before pause: .fusion/recovery/<id>-*.patch
  auto-recovery:classify-decision → class "branch-conflict-unrecoverable"
  ```
- Separately visible in the same incident: the card sat in Todo showing "Queued to plan" for 7m18s while 10 of 12 concurrency slots were free, with nothing persisted anywhere explaining why.

## What Didn't Work

- **"It's the concurrency cap."** Wrong, and wrong for a reason worth internalizing: `project.config` was queried across *all* project rows and the output grepped, which picked up `maxConcurrent: 2` belonging to a **different project**. The real project had `maxConcurrent: 12` with 2 agents running. A multi-tenant config table read without a `project_id` filter produces a confidently wrong root cause.
- **"The execute lane is head-of-line blocking admission."** Wrong: `coordinatorReadyTasks` is populated only inside `scheduler.ts`'s legacy dispatcher, which is unreachable (the branch above it always returns), so the execute lane contributes zero coordinator candidates.
- **"A running merge is holding the admission pass."** Wrong: `pickNextMergeTaskId` splices the id out of `mergeQueue` at dequeue and the coordinator marker is cleared before the merge body runs, so a running merge offers no candidate.
- **Tooling dead end.** The local `fn` CLI could not open the database at all — *"This Fusion binary is older than the database it opened: schema migration 0036 vs binary 0031"* — forcing direct `psql` against the embedded Postgres to investigate.
- **The decisive signal existed but was unreadable.** The binding admission gate was written only to `planLog.log`, which lands in a TUI pane truncated to ~40 characters and is persisted nowhere. Even after a full DB forensics pass it was still impossible to separate "host semaphore exhausted" from "project cap consumed".

## Solution

Commit `2d263acc49`.

**1. Give planning a session kind** (`active-session-registry.ts`) — the union previously had no member for it, so a planner could not be represented at all:

```ts
export type ActiveSessionKind = "executor" | "planning" | "step-session" | ...
```

**2. Claim the worktree through the reclaim-aware seam** (`triage.ts`), not raw `registerPath`. `acquireActiveSessionPath` is what lets a leaked entry from a dead holder be reclaimed; raw `registerPath` throws on any foreign-held path, and that throw lands in the planning-failure classifier where no retry can ever succeed:

```ts
const acquired = acquireActiveSessionPath(activeSessionRegistry, planningCwd, {
  taskId: task.id, kind: "planning", ownerKey: `planning:${task.id}`,
}, {
  holderLiveProbe: (holderTaskId) =>
    this.processing.has(holderTaskId) || this.hasLivePlanningWork(holderTaskId),
});
if (acquired.action === "contended") {
  planLog.warn(`${task.id}: planning worktree ${planningCwd} is held by live task ...`);
  planningCwd = this.rootDir;          // fall back to the shared checkout
} else {
  registeredPlanningPath = planningCwd;
}
```

**3. Release only what you still own.** A bare path delete here reintroduces the identical bug one lane over — see *Why This Works*:

```ts
if (registeredPlanningPath) {
  const record = activeSessionRegistry.lookupByPath(registeredPlanningPath);
  if (record?.ownerKey === `planning:${task.id}`) {
    activeSessionRegistry.unregisterPath(registeredPlanningPath);
  }
  registeredPlanningPath = null;
}
```

**4. Unstick admission** (`concurrency.ts`). `ProjectAdmissionCoordinator.admitOldest` evaluated only `candidates[0]`; if that candidate's lane declined the handoff, the pass ended having admitted nothing and the next pass re-selected the same decliner. It now walks past decliners, unwinding each attempt exactly — including the lane's pre-held executor slot, not just the semaphore slot.

**5. Make the stall answerable.** New deduped `task:plan-admission-throttled` run-audit event recording the binding gate and counts (ids/counts only), written fire-and-forget with the dedupe marker set **after** the write lands — setting it first meant a failed write silently swallowed the very stall the event exists to explain.

## Why This Works

The defect was a visibility gap, not a broken guard. The sweep's liveness check (`activeSessionRegistry.isPathActive(task.worktree)`, added by FN-4819 for exactly this failure mode) was correct and did its job — it simply had nothing to see, because planning never announced itself.

What made it fire reliably rather than rarely: **a freshly created task branch has zero commits, so its tip trivially equals the integration ref and classifies as `tip-already-merged` by construction.** Every brand-new planning worktree therefore looked like reclaimable garbage. The heuristic wasn't wrong about the branch; it was reasoning about a branch whose session it couldn't see.

The ownership-checked release matters because planning's teardown is not atomic: `finalizeApprovedTask` moves the card to `todo` while several awaited writes still follow (log flush, token-usage record, `getTask`/`updateTask`, `dispose`). The scheduler can dispatch in that window and the executor registers the **same** path — and since `registerPath` permits a same-task overwrite, the record becomes `kind: "executor"`. A delete-by-path in planning's `finally` would then clear a *live executor* entry, handing the reclaim sweep exactly the same worktree-in-use it tore out from under the planner. The first version of this fix had that bug; review caught it.

## Prevention

- **Invariant for any new session kind that owns a worktree:** it must claim the path via `acquireActiveSessionPath` (never raw `registerPath`) before doing work, and release it in a `finally` guarded by an ownership check on `ownerKey` — never a bare path delete. Any async teardown window lets another lane legitimately take over the same path.
- **Test the consuming guard, not just the producer.** Asserting "the planner registered a record" is not the invariant; asserting that the liveness predicate the sweep consults is satisfied — and that a live executor's record survives planning's teardown — is.
- **Filter multi-tenant config tables by `project_id`** before reasoning about any value read from them.
- **Promote log-only decision points to durable run-audit.** If the absence of a signal would make "why is this stuck?" unanswerable after the fact, a log line is not enough. Dedupe on a stable signature that includes the *entity ids*, not just counts, or a new entity's stall gets swallowed whenever the numbers happen to match.
- **Not retried deliberately:** lowering `STALE_SEMAPHORE_EXCESS_REPAIR_MS` (600s) was proposed and reverted under review. Nested runs are already excluded from the reclaim floor, so the window actually guards *uncounted top-level* holders — a merge body holds its slot through `paused`/`failed`/terminal row states that `isRunningAgentTask` does not count. Shortening it trades a bounded, visible stall for an unbounded, silent concurrency-cap breach. Lower it only with measured evidence from the existing "recovered stale semaphore active count X -> Y" warning.

## Related Issues

- `docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md` — nearest neighbour: also a self-healing sweep wrongly concluding a worktree isn't live, but via repo-root misclassification rather than missing registration.
- `docs/solutions/logic-errors/heartbeat-worktree-acquisition-unbounded-requeue.md` — same worktree-lifecycle family; unbounded retry rather than a liveness gap.
- `docs/architecture.md` — documents `reclaimSelfOwnedBranchConflicts` and the FN-4811/FN-4973/FN-5346/FN-6736 registry protections this sweep depends on. Those sections describe the downstream logic as fully covering "is this path live"; this incident is the upstream gap in that assumption.
