---
"@runfusion/fusion": patch
---

summary: Fix a task failing with a bare "exception" when an overlap review asks for a plan revision.
category: fix
dev: Migration 0075 shipped `ck_task_overlap_wait_phase` without the `repair-required` value that `OverlapWaitPhase` declares and `revalidatePendingOverlapWaitsAtGraphNode` writes on a delta REVISE verdict. The write raised a check-constraint violation inside the graph node, which surfaced as failure value `"exception"` with the message persisted nowhere (not the task log, not run-audit, not `workflow_work_items.last_error`), left the episode in `revalidation-pending`, and made each overseer retry pay for the same AI delta review until the budget parked the card. Adds migration 0077 (idempotent, re-applied whenever the live constraint still rejects the value, so projects that already recorded 0075 are repaired), advances `SCHEMA_BASELINE_VERSION`, and asserts every declared phase round-trips through the durable store.
