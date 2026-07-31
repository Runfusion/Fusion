---
"@runfusion/fusion": patch
---

summary: Task-duration stats now include finished work on renamed boards.
category: fix
dev: `aggregateProductivityAnalytics` takes an optional lane store and resolves the complete columns via `resolveProjectColumnsForRoles`; its duration query previously filtered on the literal `'done'`.
