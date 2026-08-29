---
"@runfusion/fusion": patch
---

summary: Reclaim stale workspace worktrees and safe task branches after terminal tasks.
category: fix
dev: reconcileOrphanedWorkspaceWorktrees now bounds prune-only retries and skips duplicate claims.
