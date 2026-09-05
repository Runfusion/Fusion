---
"@runfusion/fusion": patch
---

summary: Stop two workspace tasks from claiming the same ticket-derived checkout directory.
category: fix
dev: Adds migration 0068, a partial unique index on `(project_id, workspace_worktree_dir_segment)`, so a derived segment is a project-wide claim rather than a per-row write. `pinWorkspaceWorktreeDirSegment` reports a lost claim (`claimed: false`) instead of raising, and acquisition re-mints with the task-id fallback before any checkout exists.
