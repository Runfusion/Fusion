-- FN-9439: provider-neutral current-head readiness evidence.
ALTER TABLE project.pull_requests ADD COLUMN IF NOT EXISTS readiness jsonb;
ALTER TABLE project.pull_requests ADD COLUMN IF NOT EXISTS readiness_provider text;
