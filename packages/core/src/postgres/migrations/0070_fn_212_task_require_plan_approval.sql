-- FNXC:PlanApproval 2026-08-28-06:24: Persist the nullable per-task manual plan-approval override.
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS require_plan_approval integer;
