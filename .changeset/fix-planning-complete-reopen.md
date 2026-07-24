---
"@runfusion/fusion": patch
---

summary: Fix Planning reopen after a finished session so Retry no longer dead-ends.
category: fix
dev: Treat status=complete as terminal; recover create-retry/task-created/plan-review on load and when generation retry reports already-validated.
