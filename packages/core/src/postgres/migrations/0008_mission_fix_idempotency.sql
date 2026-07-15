/*
FNXC:MissionFixIdempotency 2026-07-14-18:55:
A source feature can produce at most one generated fix for a validator run within a project. The unique index is intentionally additive and fails closed if historical duplicates exist so operators can reconcile conflicting remediation records explicitly.
*/
CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_lineage_project_source_run
  ON project.mission_fix_feature_lineage (project_id, source_feature_id, run_id);
