---
"@runfusion/fusion": patch
---

summary: Fix a hang when editing dependencies on a task that was blocked by itself.
category: fix
dev: `updateTaskDependenciesImpl` runs inside `withTaskLock(id)` and read the current blocker via `store.getTask()`, which re-enters the same non-reentrant lock when `blockedBy === id`. Returns the in-lock task copy instead. Second instance of the class fixed in the transition-pending recovery; found by an AST scan for `getTask` nested inside `withTaskLock`.
