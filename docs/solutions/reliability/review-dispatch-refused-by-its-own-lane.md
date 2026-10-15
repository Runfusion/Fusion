---
title: "A review dispatch to a reviewer-only lane is refused by that lane forever"
date: 2026-10-15
problem_type: reliability
module: "@fusion/engine"
component: review-dispatch-sweep
tags:
  - review-lane
  - dispatch
  - heartbeat
  - lane-capability
  - reviewer-run-ledger
  - rufu-272
  - rufu-682
symptoms:
  - "one review-lane card accumulates dozens of `Dispatching review of <ID> to <lane> (attempt N…)` lines with no reviewer session ever starting"
  - "the same card's History shows a heartbeat decline naming roles and an implementation task, then `reviewer-busy … parked: attempts=N`"
  - "`task_reviewer_runs` rows for the card close as `engine-lost:` with no backing `agent_runs` row, at growing attempt numbers"
root_cause: "a review-lane card is implementation-class at wake time, so a reviewer-only lane refuses the dispatch its own sweep opened; the refusal left no ledger evidence, reconciliation filed the survivor as `engine-lost:`, and that prefix is deliberately exempt from the attempt budget, so the loop had no stop"
resolution_type: "record the refusal where the deciding loop reads it, then withhold dispatch"
---

## Problem

Measured on the saneca workspace, 2026-10-15 08:40–16:20 UTC, one card (`SANE-484`) in `in-review`:

- 24 review dispatches to the same lane (`agent-0031e775`), attempt numbers reaching 24, at the sweep's 15 s tick.
- **0** `task:execution-dispatch`, **0** `agent_runs`, and **0** `merge:*` rows for the card in that window — the review never
  started, so the card could not merge, and the partial-land sweep re-enqueued it 29 times (`reason=zero-land`).
- Each cycle looked like: sweep dispatches → heartbeat declines (`roles "reviewer"; implementation task`) → sweep logs
  `reviewer-busy` and parks at 24 attempts → reconciliation closes the ledger row as `engine-lost:` → next tick dispatches again.

Three links made that durable:

1. **The lane really is ineligible, correctly.** Review is executed as a workflow-node run, so `RUFU-449`'s wake revalidation treats a
   card in a review-lane column as implementation-class. On the deployed board every `reviewer`-only agent has
   `assignmentPolicy: "reviewer-only"`, which excludes implementation lanes. RUFU-272's answer to that verdict is "decline and let the
   reconcile sweep repair the placement" — written for a card stuck in the lane's `todo`, with no second dispatcher.
2. **The decline wrote where the sweep could not read.** It recorded `task:lane-capability-declined` (audit) and `logWarn`. The sweep
   classifies from the reviewer-run ledger and live runs only, so it re-derived `attemptNumber = prior.maxAttempt + 1`, saw an
   already-at-limit card, and reported `reviewer-busy`.
3. **The anti-loop budget was exempt by design.** A ledger row still `running` with no session becomes `engine-lost:` in
   `closeUncorroboratedAttemptsBefore`. `engine-lost` is excluded from `computeDispatchableAttempts` because an engine restart must not
   burn a card's budget — correct for its own class, fatal when it is the shape every refused dispatch decays into.

## Fix

The refusal is now recorded where the deciding loop reads it, in the same call that emits the named decline
(`packages/engine/src/agent-heartbeat.ts` → `recordLaneCapabilityDecline`):

- `declineReviewerRunForLane` closes that reviewer's live attempt as `failed` with reason
  `lane-capability-declined:<lane>/<binding>/<code>/<policySignature>`. It refuses to settle a row another reviewer opened, and a ledger
  outage cannot change the decline.
- The sweep derives refusals from those rows (`declinedReviewersForTask`) and classifies a card whose entire enabled reviewer pool has
  refused as **`capability-declined`**: it names the refusal once per card per policy episode on the card's History and routes no further
  dispatch to a refused binding. Partial refusal re-routes to a sibling reviewer instead.
- The refusal carries the lane's **policy signature**, so it is evidence with an expiry: editing the lane's roles, binding, or
  `assignmentPolicy` changes the signature, the old refusal stops proving anything, and dispatch re-arms on the next tick.

Deliberate boundaries: no column or lifecycle move, no unbind, no role change, and `capability-declined` stays a **separate count** from
`reviewer-busy` — "the only lane I can route to refuses this class" and "the reviewer is occupied" need different operator actions, which
is what merging them into one log line cost. The mutation owner for a mis-placed card remains the RUFU-272 sweep
(`reconcile-lane-capability-misbind`), which has never been allowed to touch a `review`-trait column.

## Symptom → check

| Symptom | Check |
| --- | --- |
| Did a refusal stop the loop, or is it still spinning? | `select count(*) from project.task_reviewer_runs where task_id='<ID>' and closed_reason like 'lane-capability-declined:%'` plus the last dispatch log line's timestamp |
| Was the refusal right? | `select role, roles, "assignmentPolicy" from central.durable_agents where id='<lane>'` — a `reviewer`-only lane against a review-lane card is a correct refusal |
| Which cards are refused right now? | the sweep's per-tick `emptyClasses()` `capability-declined` count, and each named card's History line |
| Did an operator's policy edit re-arm dispatch? | the refused row's signature no longer matches the lane's current policy signature |

## Notes

- The audit event `task:lane-capability-declined` already existed and already named the defect; the fix added **no new event**. What was
  missing was that its evidence lived in a table the deciding loop never queries. A named decline that only a human can read is not a
  stop condition.
- `engine-lost:` stays exempt. The loop needed no budget change once the refusal was distinguishable — the attempts were **never**
  dispatched-then-lost, they were refused, and counting them as lost would have burned a healthy card's budget on a routing mistake.
- Related: [`implementation-card-bound-to-audit-only-lane.md`](implementation-card-bound-to-audit-only-lane.md) (RUFU-272, the wake gate
  and the repair sweep), `docs/testing.md` → review-lane buckets (E5), `docs/run-audit.md` → lane-capability prose.
- Shape is pinned by `packages/engine/src/__tests__/review-lane-capability-refusal.test.ts` (derivation, signature lift, bucket
  precedence, routing) and `packages/engine/src/__tests__/review-lane-capability-refusal.pg.test.ts` (the decline-to-refusal path on a
  real store, loop stop, re-arm, sibling routing, and the one-way guard).
