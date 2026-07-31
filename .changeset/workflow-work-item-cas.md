---
"@runfusion/fusion": patch
---

summary: A task queued for plan review no longer waits behind other tasks that are parked awaiting your approval.
category: fix
dev: U7 (PR #2491 review). The planning-continuation drain polls a bounded FIFO batch and a skipped item stayed `runnable` and due, so cards parked on approval re-filled every batch and starved newer plan-review work. Skipped operator-parks now get their `retryAfter` pushed out (`PARKED_CONTINUATION_DEFER_MS`, 60s) instead of a state change, so idleness predicates over `ACTIVE_WORKFLOW_WORK_ITEM_STATES` are unaffected. The write is a compare-and-set via the new `WorkflowWorkItemTransitionPatch.expectedState`, so a claim another node took between the poll and the write is never reset (`running` was not covered by the pre-existing terminal-state check). The drain loop moved to the exported `drainDuePlanningContinuations` so the wiring is testable without constructing a runtime.
