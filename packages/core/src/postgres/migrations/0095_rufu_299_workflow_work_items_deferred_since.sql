/*
FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299):
Adds the durable episode anchor that bounds the stranded-continuation deferral ladder.

`reconcileStrandedWorkflowContinuations` defers a `held` continuation it cannot own by stamping a future
`retry_after`. That column is the GLOBAL due gate — `listDueWorkflowWorkItems` admits only
`retry_after IS NULL OR retry_after <= now` — so the deferral hides the card from the dispatcher, from this
sweep itself, and from every other due-gated reader. RUFU-263 bounded how OFTEN the re-check happens
(30 min -> 2 h -> 6 h); nothing bounded how MANY times it happens, so from the fourth shift on the widest
rung is re-stamped forever and the card is invisible roughly 92 % of the time with no queryable escalation.

The horizon needs a start-of-episode timestamp that the ladder itself never overwrites, and `retry_after`
cannot be it twice over: its width IS the rung input (`nextDeferralMs` reads it back off the row), and the
reclaim path zeroes the column when it recovers the row. `deferred_since` is therefore a separate field:
written at the FIRST deferral, preserved by every later one, and cleared by the reveal CAS so a reveal is
once per episode.

Additive and nullable — existing rows report "never deferred", which is the truth for every row written
before this column existed, and the sweep treats NULL as "start the episode now". No index: nothing reads
this column as a predicate, only the row it already fetched.
*/

ALTER TABLE project.workflow_work_items ADD COLUMN IF NOT EXISTS deferred_since text;
