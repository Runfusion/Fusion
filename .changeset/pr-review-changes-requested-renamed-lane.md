---
"@runfusion/fusion": patch
---

summary: A GitHub "changes requested" review is no longer dropped on boards with renamed columns.
category: fix
dev: `PrCommentHandler.handleChangesRequested` gated on `task.column !== "in-review"` and requeued to a hardcoded `"in-progress"`. Both now resolve from the task's workflow — the review lane via the `mergeOrchestration` role, the requeue target via the first `countsTowardWip` column — each falling back to the legacy id.
