-- FNXC:MissionValidation 2026-08-01-16:21:
-- FN-8694 records the exact content-addressed validator input and narrow blocked
-- provenance so recovery can stop deterministic repeat spend without reopening
-- unrelated operator/remediation blocks.
ALTER TABLE project.mission_validator_runs ADD COLUMN IF NOT EXISTS input_fingerprint text;
CREATE INDEX IF NOT EXISTS "idxValidatorRunsFeatureFingerprint" ON project.mission_validator_runs(project_id, feature_id, input_fingerprint);
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS validation_budget_fingerprint text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS validation_budget_run_id text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS validation_budget_blocked_at text;
