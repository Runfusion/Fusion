-- FNXC:WorkspaceWorktree 2026-08-23-19:52: R15 pins a workspace task's directory segment at first acquisition so later resolutions never re-derive it.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS workspace_worktree_dir_segment text;
