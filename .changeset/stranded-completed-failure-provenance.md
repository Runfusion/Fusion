---
"@runfusion/fusion": patch
---

summary: Self-healing no longer promotes a failed/refused task into review after its work was reverted.
category: fix
dev: FN-8141 — new pure evaluator `evaluateCompletedPromotionFailureProvenance` (@fusion/core) reads the durable task log tail; both stranded-completed promoters (`recoverCompletedTasks` stuck-in-progress and `recoverStrandedCompletedTodoTasks` stranded-todo) and the shared `recoverCompletedTask` chokepoint now withhold promotion when the most recent execution-outcome was a failure/refusal park, emitting a deduped `task:reconcile-stranded-completed-no-action` run-audit event (reason `failure-provenance`). A fresh clean execution (operator retry) supersedes the park.
