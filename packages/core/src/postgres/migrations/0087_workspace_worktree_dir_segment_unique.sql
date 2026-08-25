-- FNXC:WorkspaceWorktree 2026-08-25-08:12: a derived workspace directory segment is claimed, not just written.
-- Two tasks that mint the same branch/title slug concurrently would otherwise both persist a write-once pin and
-- contend for one directory forever; this partial unique index makes the second write fail so the loser can take
-- its task-id fallback BEFORE any checkout exists. Existing rows are NULL, so nothing needs backfilling.
CREATE UNIQUE INDEX IF NOT EXISTS "uqTasksWorkspaceWorktreeDirSegment"
  ON project.tasks (project_id, workspace_worktree_dir_segment)
  WHERE workspace_worktree_dir_segment IS NOT NULL;
