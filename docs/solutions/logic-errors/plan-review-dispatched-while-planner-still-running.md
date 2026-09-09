---
category: logic-errors
module: "@fusion/engine (planning liveness, workflow continuation recovery, Plan Review routing)"
tags: [planning, plan-review, workflow-work-items, lease-renewal, race-condition, self-healing, output-exclusivity]
problem_type: race_condition
applies_when: "A recovery or dispatch path decides that graph work is abandoned without accounting for every live owner, or a review outcome test stops at a gate instead of proving the selected downstream effect."
---

# Plan Review dispatched while the planner is still running

## Symptom

A task's `plan` workflow continuation was re-queued as `dead-lease` after the
staleness grace and dispatched into `plan-review` while the planning session was
still writing the specification. The reviewer inspected an incomplete draft,
returned `REVISE`, and requested replanning even though the original planner had
not finished.

The incident chronology made the overlap visible: planning started first, the
self-healing log reported `plan was stranded in 'running' (dead-lease)`, Plan
Review started next, and only later did the planner publish the finished prompt.
The intended sequence is strictly `plan` → `plan-review` → one of execution,
replanning, or terminal no-op.

## Root cause

Two omissions combined:

1. **Planner ownership was absent from the shared liveness decision.** Recovery
   checked active session paths, the executor lock, and executor task activity.
   Planning has no worktree path and holds none of those executor signals, so a
   live planner looked dead to self-healing.
2. **The durable planning continuation did not prove renewable ownership.** Its
   `running` row had an owner but no expiry. Once its timestamp crossed the
   recovery grace, another process had no durable way to distinguish a slow live
   planner from an abandoned one.

The downstream characterization also exposed two fail-closed gaps. A
verdict-required Plan Review response with no verdict could retain a successful
group outcome and reach the execution successor. An explicit `plan-replan`
remediation decline stopped traversal but returned before projecting
`remediation-not-scheduled` into graph context, depriving recovery of its exact
terminal reason.

## Fix

- `isTaskPlanningOrExecutionLive` now enumerates five named signals: active
  session path, executor lock, executor task activity, triage's planning-task
  set, and the process-wide planning probe. Probe and planning-set failures are
  conservative: uncertain planning ownership is live.
- All three self-healing continuation sweeps and the hold-release diagnostic use
  that shared predicate. Stranded-continuation recovery reports
  `live-planning` and leaves the row untouched while any planning signal lives.
- Triage writes the `plan` continuation with a future ten-minute lease and a
  unique owner for that planning attempt. It renews every one-third lease interval
  with an owner/state compare-and-set, uses an unreferenced timer, and applies the
  same owner/state fence before terminalizing. A stale callback therefore cannot
  renew or complete a successor that has returned to `running` under a new owner.
- The continuation drain independently resolves live planning to `planner-live`
  and defers the observed state for a short 15-second window. Capacity admission
  can await mutable state, so its final dispatch takes the planning lifecycle lock,
  rechecks planner liveness, rereads the exact durable task and continuation, then
  atomically changes that row to `running` under a distinct dispatch owner before
  launching execution. Triage installs planner ownership under the same lock and
  refuses to replace that durable dispatch claim. Whichever side wins is therefore
  visible after lock release; the loser exits without starting a second authority.
  Triage's existing stale-processing eviction remains the bounded escape when an
  in-memory planner wedges.
- Plan Review now treats a required-but-missing verdict as a failed non-plan
  defect that holds before route selection. A declined integrated remediation
  projects `remediation-not-scheduled` before returning. For a real verdict,
  exactly one integrated edge is possible: `success`, `failure` to
  `plan-replan`, or `outcome:close-no-op` to terminal completion. Scheduled
  replanning stops the current traversal, so it cannot also reach execution.

Abandoned planners still recover: after the probe/planning-set ownership is gone
and the durable lease expires, the existing `dead-lease` path makes the
continuation runnable again.

## Lessons

- **Liveness must enumerate every possible owner.** A generic “session is live”
  predicate is unsafe when one lane deliberately has no worktree/session-path
  registration. Name the signals so adding a new owner forces a visible policy
  decision.
- **A durable lease must be renewable for the full critical section.** A future
  expiry at acquisition is insufficient for long planning sessions; renewal,
  compare-and-set ownership, timer teardown, and terminal release are one
  protocol.
- **Defence-in-depth belongs at recovery, selection, and the point of use.**
  Preventing a stale row from being re-queued does not prove another writer cannot
  make it runnable, and a liveness sample taken before asynchronous capacity work
  does not authorize a later dispatch. The final launch must share the planner's
  durable lock, revalidate the exact continuation, and publish its winner as durable
  state before releasing the lock; mutual exclusion alone does not preserve ownership.
- **A harness whose first event arms a short-circuiting disjunct proves nothing
  about later disjuncts.** An `awaiting-approval` event made approval tests pass
  through the held-task set without exercising either durable approval proof.
- **Covering a disjunct through an exception form is not nominal coverage.** An
  operator bypass satisfied `isPlanReviewSatisfied`, but did not prove that an
  ordinary `status: "passed"` reviewer result queues execution.
- **To prove “X sends data to Y”, assert at Y through its real reader.** The
  replanning writer's activity-log entry is intentionally excluded by the
  planner. The real input is the Plan Review result's `notes ?? output`, read by
  `specifyTask` together with the rejected draft and cumulative ledger.
- **Shared top-level outcomes are not routing evidence.** Both remediation
  scheduling variants report success. Assert visited nodes, durable writes, and
  the downstream queue/replan effect instead.

## Verification

- `planning-execution-liveness.test.ts` covers every named signal and
  conservative probe behavior.
- `self-healing-stranded-continuation-reclaim.test.ts`,
  `self-healing-stranded-hold-continuation.test.ts`, and
  `self-healing-principal-held-planning.test.ts` prove live-planning exclusion
  plus release after ownership ends.
- `triage-planning-continuation-lease.test.ts` drives the real planning method
  and proves initial lease, compare-and-set renewal, terminal cleanup,
  preservation of a same-state successor with a different owner, and the inverse
  race where dispatch claims first and the later planner never starts.
- `workflow-continuation-selection.test.ts` proves `planner-live` deferral and
  guard priority.
- `plan-review-not-concurrent-with-planning.test.ts` replays the incident through
  self-healing and the drain, proves no concurrent dispatch, then proves ordered
  recovery after planner release and bounded stale-owner eviction. Its
  production-shaped admission cases also start a planner during the capacity wait
  and replace the durable continuation before the lock-held launch check.
- `plan-review-exclusive-outcomes.test.ts` drives every shipped built-in IR that
  declares Plan Review and proves the exact three-edge route set, both REVISE
  outcome forms, declined remediation, no-op validation, missing-verdict hold,
  and the durable approval/replan gates.
- `scheduler-planning-finished-wake.test.ts` and
  `plan-approval-hold-invariant.test.ts` prove ordinary approval reaches both
  production event consumers without an approval-held pre-event, including
  idempotence and negative states.
- `triage-replan-feedback-from-plan-review.test.ts` first invokes the real
  `requestPreMergeOptionalStepFix` writer, passes that exact mutated task to real
  `specifyTask`, and proves notes/output, rejected-draft, ledger, and no-draft
  behavior.
- `plan-review-outcome-queues-or-replans.test.ts` checks the complete state table
  with the production approval and planning predicates so no rendered verdict
  arms both output chains.
