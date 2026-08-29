---
category: logic-errors
module: "@fusion/engine (triage planning handoff), @fusion/core (workflow work items)"
tags: [workflow-work-items, continuation, race-condition, silent-drop, self-healing-backstop, plan-review]
problem_type: race_condition
applies_when: "A node-completion handoff installs its successor continuation outside the transaction that terminalizes the predecessor, or a fire-and-forget reaction discards a seed/install result."
---

# Planning handoff race silently strands Plan Review

## Symptom

Every freshly planned (or replanned) card sat idle in Todo for ~10 minutes with
"Execution dispatch refused — task is still unplanned" in its log, then moved on
after `task:reconcile-stranded-hold-continuation` fired. 529 self-healing
recoveries in 18 days — self-healing had silently become the PRIMARY handoff,
each one costing the card the sweep's full staleness grace.

## Root cause

Two independent defects compounded:

1. **Ordering race.** Triage's `specifyTask` announced completion
   (`onSpecifyComplete`) BEFORE its `finally` block transitioned the planning
   work item to `succeeded`. The seed reaction fired concurrently, and
   `seedPreReleasePlanReviewContinuation`'s all-kinds idle check counted the
   caller's own still-`running` plan row as an "active continuation" and bailed.
2. **Silent drop.** `reactToSpecificationComplete` awaited the seed but
   discarded its result, so the bail was invisible — no log, no retry, no audit.
   The card stranded until FN-8592 self-healing re-seeded it.

## Fix (2026-08-13)

- `seedStrandedPlanReviewContinuation` gained `retirePredecessorId`: in ONE
  transaction under the task advisory lock it excludes the named predecessor
  from the idle check, re-verifies no OTHER active row and no passed Plan
  Review, transitions the predecessor to `succeeded`, and installs the
  successor. Checks run BEFORE the retirement, so a bailed seed mutates nothing.
- Triage threads `planningWorkItemId` through `PlanningHandoffReport`; the
  runtime reaction passes it as `retirePredecessorId`.
- The reaction consumes the seed result: quiet parks (`awaiting-approval`,
  `paused`, `plan-review-passed`, `no-pre-release-plan-review`) log and exit;
  anomalies retry (1s, 5s) with a fresh task/IR snapshot per attempt (so a
  mid-retry pause or `needs-replan` is honored) and warn loudly on exhaustion,
  naming self-healing as the recovery owner.

## Lessons

- **A node transition is a handoff, not two writes.** Terminalizing the
  predecessor and installing the successor must be one transaction; any code
  that does them separately has an ordering race with every observer between.
- **A discarded result is a silent stall.** Fire-and-forget reactions must
  consume the outcome and surface non-success loudly (see
  [branch-group-name-collision-strands-mission-triage](branch-group-name-collision-strands-mission-triage.md)).
- **Self-healing frequency is a bug signal.** A "backstop" firing hundreds of
  times is the primary path failing quietly; alert on recovery-event volume.
- **Reason-less bails poison retry loops.** Every refusal needs a named reason
  so consumers can distinguish legitimate configuration (no pre-release Plan
  Review node) from genuine anomalies worth retrying/warning.

## Verification

- `packages/core/src/__tests__/workflow-work-items-conditional-seed.test.ts` —
  "planning handoff retires its own predecessor atomically": both race
  orderings, only-the-named-predecessor, cross-task safety, no-mutation-on-bail.
- `packages/engine/src/__tests__/plan-approval-hold-invariant.test.ts` — "#2b
  the handoff seeder does not bail on its own named predecessor".
- `packages/engine/src/__tests__/specify-complete-reaction.test.ts` — result
  consumption, bounded retries, quiet parks, mid-retry pause/replan honoring.
