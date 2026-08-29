-- FNXC:TaskSplittingRemoval 2026-08-20-17:42: Complexity must not persist a request that can fan one task into children or delete its parent. This migration removes only the obsolete task flag and leaves every project-scoped task, dependency, prompt, and document intact.
ALTER TABLE project.tasks DROP COLUMN IF EXISTS break_into_subtasks;
