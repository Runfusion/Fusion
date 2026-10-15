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

It is not one card. Measured the same evening, four cards sat in `in-review` with a growing decline count and their latest decline
inside the last few minutes: `VLLM-089` (374 declines, 336 dispatches, attempt **387** still running at 17:39 UTC), `VLLM-104` (331),
`RUFU-343` (59), `SANE-484` (24). Dozens more carry the same historical counts and are now `done` — they escaped by being rebound or
moved by hand, which is why the class read as rare while every affected card was still burning a dispatch every tick.

Three links made that durable:

1. **The refusal itself is correct as written.** A review is executed as a workflow-node run, so a card in a review-lane column is
   implementation-class: `implementationColumns` counts every `humanReview`-trait column alongside intake/WIP/merge traits
   (`packages/core/src/workflows/workflow-lifecycle-traits.ts`, `FNXC:WorkflowLifecycleColumns`). Both looping lanes measured
   `roles = ["reviewer"]` with no `assignmentPolicy` override in `project.agents.metadata`, so the wake's verdict — an
   implementation-class card needs `executor` (or `engineer` under explicit routing) — is the policy answering honestly. RUFU-272's
   answer to that verdict is "decline, and let the reconcile sweep repair the placement" — written for a card parked in the lane's
   `todo`, with no second dispatcher reopening the attempt every tick.
2. **The decline wrote where the sweep could not read.** It recorded `task:lane-capability-declined` (audit) and `logWarn`. The sweep
   classifies from the reviewer-run ledger and live runs only, so it re-derived `attemptNumber = prior.maxAttempt + 1`, saw an
   already-at-limit card, and reported `reviewer-busy`.
3. **The anti-loop budget was exempt by design.** A ledger row still `running` with no session behind it is closed as `engine-lost:` by the
   self-healing `reconcile-stranded-reviewer-runs` sweep. `unfinishedAttempts` — the sweep's dispatch budget — skips those rows through
   `isEngineLossReviewerRun`, because an engine restart must not burn a card's budget: correct for its own class, fatal when it is the shape
   every refused dispatch decays into, because it left the sweep with zero unfinished attempts and nothing to count.

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
| Did a refusal stop the loop, or is it still spinning? | `select rework_round, status, failure_reasons from project.task_reviewer_runs where task_id='<ID>' order by rework_round desc limit 5` — `failure_reasons` is a text column holding a JSON array, so match `failure_reasons like '%lane-capability-declined:%'`; the last line's timestamp in the engine log is the other half |
| Was the refusal correct as written? | `select id, role, roles from project.agents where id='<lane>'` — `roles = ["reviewer"]` against a card in a `humanReview`-trait column is the policy answering honestly, not a mis-read |
| Which cards are refused right now? | the sweep's per-tick `emptyClasses()` `capability-declined` count, and each named card's History line |
| Did an operator's policy edit re-arm dispatch? | the refused row's signature no longer matches the lane's current policy signature |

## Notes

- **What the fix does not do.** It stops the loop and names the refusal; it does not decide who may review. After the fix, a card whose
  whole reviewer pool refuses sits in `in-review`, un-parked, with its History naming the refusal, until an operator either widens a
  lane's roles/binding (which retires the refusal by signature and re-arms dispatch on the next tick) or routes the card. Making a
  reviewer-only lane capable of running a review-node run is a routing-model decision beyond this card's scope, and this card deliberately
  did not smuggle it in as "stop the loop by allowing the dispatch".
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
