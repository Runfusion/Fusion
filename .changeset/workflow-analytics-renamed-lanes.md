---
"@runfusion/fusion": patch
---

summary: Per-workflow Command Center metrics now count work on renamed boards.
category: fix
dev: `aggregateWorkflowAnalytics` takes an optional lane store and resolves complete / wip / human-review columns via `resolveProjectColumnsForRoles`; its SQL previously filtered on the literal `'done'` and `('in-progress','in-review')`.
