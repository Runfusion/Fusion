---
"@runfusion/fusion": patch
---

summary: Command Center team analytics now count completed and in-flight work on renamed boards.
category: fix
dev: `aggregateTeamAnalytics` takes an optional lane store and resolves complete / wip / human-review columns via `resolveProjectColumnsForRoles`; its SQL previously filtered on the literal `'done'` and `('in-progress','in-review')`, which match nothing on a custom workflow.
