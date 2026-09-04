-- FNXC:WorkspaceWorktree 2026-08-25-08:12: a derived workspace directory segment is claimed, not just written.
-- Two tasks that mint the same branch/title slug concurrently would otherwise both persist a write-once pin and
-- contend for one directory forever; this partial unique index makes the second write fail so the loser can take
-- its task-id fallback BEFORE any checkout exists. Existing rows are NULL, so nothing needs backfilling.
--
-- FNXC:WorkspaceWorktree 2026-09-04-05:15:
-- Archive (and every other soft-delete) disposes the checkout but leaves the live row as a tombstone with
-- deleted_at set. Live readers already ignore those rows (`deleted_at IS NULL`); the claim must too, or a
-- later task deriving the released branch/title slug loses the name to a directory that no longer exists.
DROP INDEX IF EXISTS project."uqTasksWorkspaceWorktreeDirSegment";
CREATE UNIQUE INDEX "uqTasksWorkspaceWorktreeDirSegment"
  ON project.tasks (project_id, workspace_worktree_dir_segment)
  WHERE workspace_worktree_dir_segment IS NOT NULL AND deleted_at IS NULL;
