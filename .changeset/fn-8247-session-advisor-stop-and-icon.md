---
"@runfusion/fusion": patch
---

summary: Stop now disables the session advisor, and its on/off state correctly updates the task-detail oversight icon.
category: fix
dev: stopOverseerTask persists sessionAdvisorEnabled:false and clears the advisor runtime; TaskDetailModal effective-state derivation now honors the resolver's workflow-legacy tier (plannerOverseerAdvisorEnabled).
