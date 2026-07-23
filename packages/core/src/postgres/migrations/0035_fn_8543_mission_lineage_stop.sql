-- FNXC:MissionLineageBudget 2026-07-22-12:00:
-- Root budget ownership and operator intervention must survive cascading feature deletion.
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS implementation_stop_reason text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS implementation_stopped_at text;
ALTER TABLE project.mission_features ADD COLUMN IF NOT EXISTS implementation_stop_origin text;

CREATE TABLE IF NOT EXISTS project.mission_lineage_stops (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  root_feature_id text NOT NULL,
  mission_id text,
  reason text NOT NULL,
  stopped_at text NOT NULL,
  origin text NOT NULL,
  PRIMARY KEY (project_id, root_feature_id)
);
CREATE INDEX IF NOT EXISTS idx_mission_lineage_stops_mission_id
  ON project.mission_lineage_stops (project_id, mission_id);

-- FNXC:MissionLineageBudget 2026-08-03-00:00:
-- Durable remediation stops are project-owned evidence. Apply the full shared
-- schema isolation contract so an admin-bypass session cannot cross partitions.
ALTER TABLE project.mission_lineage_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.mission_lineage_stops FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.mission_lineage_stops;
CREATE POLICY fusion_project_isolation ON project.mission_lineage_stops
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.mission_lineage_stops;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.mission_lineage_stops
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
