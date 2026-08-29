---
"@runfusion/fusion": patch
---

summary: Fix lost sub-repo worktree entries when workspace repos are acquired concurrently.
category: fix
dev: Per-repo workspace state now uses mergeWorkspaceWorktreeEntry under the task advisory lock.
