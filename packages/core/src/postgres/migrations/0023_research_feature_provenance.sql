-- FNXC:ResearchMissionBridge 2026-07-18-12:00:
-- Persist finding-level lineage and enforce retry-safe promotion per project/slice.
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS research_run_id text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS research_finding_id text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS research_source_urls jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS mission_features_research_promotion_unique
  ON project.mission_features (project_id, slice_id, research_run_id, research_finding_id)
  WHERE research_run_id IS NOT NULL AND research_finding_id IS NOT NULL;
