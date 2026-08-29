---
"@runfusion/fusion": patch
---

summary: Workspace tasks no longer briefly look single-repo while acquiring a sub-repo worktree.
category: fix
dev: acquireTaskWorktree gains opt-in `suppressSingularWorktreePersist`; acquireWorkspaceRepoWorktree sets it so the merged `workspaceWorktrees` write is the only durable acquisition write.
