---
"@runfusion/fusion": patch
---

summary: Prevent task-bound agents from deleting the task they are currently executing.
category: fix
dev: TaskStore.deleteTask now rejects audit contexts whose caller task matches the delete target.
