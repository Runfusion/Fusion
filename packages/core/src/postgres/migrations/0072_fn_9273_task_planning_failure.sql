/* FNXC:TriagePlanningState 2026-09-07-19:49: Persist validator-free engine planning retry evidence. */
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS planning_failure jsonb;
