---
"@runfusion/fusion": patch
---

summary: Merge-evidence repair now runs on boards whose complete column is renamed.
category: fix
dev: `reconcileDoneTaskIntegrity` queried `listTasks({ column: "done" })`, which returns nothing on a renamed board, so the sweep never executed. It now resolves the project's complete lanes via `resolveProjectColumnsForRoles` and queries each, unioned with the legacy id.
