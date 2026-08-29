---
"@runfusion/fusion": patch
---

summary: Let operators explicitly remove incoming dependency references when soft-deleting a task.
category: fix
dev: `fn_task_delete` forwards `removeDependencyReferences` to the existing PostgreSQL store transaction.
