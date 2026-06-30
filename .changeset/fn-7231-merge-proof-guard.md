---
"@runfusion/fusion": patch
---

summary: Prevent workflow tasks from reaching Done without durable merge confirmation.
category: fix
dev: Workflow graph merge finalization now requires mergeConfirmed proof before accepting done/no-op states.
