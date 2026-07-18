/*
FNXC:ConfigVersioning 2026-07-18-00:00:
FN-8282 records immutable configuration snapshots under the real project
partition. Global settings use a reserved central owner id at the application
boundary, never a caller's current project id.
*/
CREATE TABLE IF NOT EXISTS project.configuration_revisions (
  project_id text NOT NULL,
  id text NOT NULL,
  -- FNXC:ConfigVersioning 2026-07-18-14:00: identity order is the chronological tie-breaker when serialized writes share an ISO millisecond.
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  owner_scope text NOT NULL,
  config_kind text NOT NULL,
  config_target jsonb NOT NULL,
  config_target_key text NOT NULL,
  before jsonb,
  after jsonb,
  diffs jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_by jsonb NOT NULL,
  source text NOT NULL,
  rollback_to_revision_id text,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_configuration_revisions_target_newest
  ON project.configuration_revisions (project_id, config_kind, config_target_key, created_at DESC, sequence DESC);

-- Existing databases have already applied the universal ownership migration.
-- New project tables must carry its RLS/default/trigger contract themselves.
ALTER TABLE project.configuration_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.configuration_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.configuration_revisions;
CREATE POLICY fusion_project_isolation ON project.configuration_revisions
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.configuration_revisions;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.configuration_revisions
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
