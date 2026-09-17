---
"@runfusion/fusion": minor
---

summary: Retry during work can now keep the work already produced and replay only the current step.
category: feature
dev: `POST /tasks/:id/retry` accepts an optional `preserveWork` boolean body field, relayed to `planTaskColumnRestart({ preserveWork })`. It is honored only for the `implementation` scope (a request on any other scope is rejected with 400 before any durable write) and suppresses the execution-artifact clear, the `currentStep` reset, and symbol-lock release; only `in-progress` steps return to `pending`. Absent or non-boolean input keeps today's destructive restart, so existing callers are unchanged.
