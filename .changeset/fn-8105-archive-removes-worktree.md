---
"@runfusion/fusion": patch
---

summary: Archiving a task now deletes its git worktree so pinned worktrees no longer leak.
category: fix
dev: Archive cleanup uses a store-scoped engine disposer and host-scoped worktree-path reservation; cleanup:false retains the worktree and workspace per-repo cleanup remains deferred.
