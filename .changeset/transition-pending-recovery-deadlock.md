---
"@runfusion/fusion": patch
---

summary: Fix a startup hang when a task was interrupted mid column-transition hook.
category: fix
dev: `recoverStaleTransitionPendingImpl` ran its per-task body inside `withTaskLock(id)` and then read the task with `store.getTask(id)`, which acquires the same non-reentrant lock. PostgreSQL-only — the SQLite arm already used the lock-free `readTaskFromDb`. Restores a lock-free read (`readTaskRow`) on the backend arm. Reachable only when a stale transition-pending marker names a plugin hook the trait registry still knows.
