---
"@runfusion/fusion": patch
---

summary: Fix a startup hang, and a skipped plugin hook, for tasks interrupted mid column-transition.
category: fix
dev: `recoverStaleTransitionPendingImpl` ran its per-task body inside `withTaskLock(id)` and then read the task with `store.getTask(id)`, which acquires the same non-reentrant lock. PostgreSQL-only — the SQLite arm already used the lock-free `readTaskFromDb`. Restores a lock-free read (`readTaskRow`) on the backend arm. Reachable only when a stale transition-pending marker names a plugin hook the trait registry still knows. Also switches that recovery's IR read from `resolveTaskWorkflowIrSync` (which returns the default workflow for every task under PostgreSQL, so a custom-workflow task's interrupted hook was silently skipped) to `resolveWorkflowIrForTask`, and drops the now-unused `lifecycle-ops.ts` entry from the sync-resolver call-site allow-list.
