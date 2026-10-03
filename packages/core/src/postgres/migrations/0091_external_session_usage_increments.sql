/*
FNXC:ExternalSessionIncrements 2026-09-24-04:51 (operator decision F1 = 3):
A session's reported usage is CUMULATIVE: the collector recomputes whole-session totals per model band on
every revision. Pricing that cumulative total at one basis cannot be right once a model or a rate changes
mid-session, because the earlier work is then repriced at the later rate.

Each revision therefore records the DELTA it added, together with the rates applicable at that moment, so a
session's cost is the sum of increments each priced at its own effective rate. Increments are immutable: a
revision's delta is a fact about what was added then, not a view that later revisions may restate.
*/
CREATE TABLE IF NOT EXISTS project.external_session_usage_increments (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  session_id text NOT NULL,
  revision bigint NOT NULL,
  usage jsonb NOT NULL,
  pricing jsonb,
  recorded_at text NOT NULL,
  PRIMARY KEY (project_id, session_id, revision),
  FOREIGN KEY (project_id, session_id) REFERENCES project.external_sessions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT external_session_increment_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX IF NOT EXISTS external_session_increment_order
  ON project.external_session_usage_increments(project_id, session_id, revision);
ALTER TABLE project.external_session_usage_increments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_usage_increments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_usage_increments;
CREATE POLICY fusion_project_isolation ON project.external_session_usage_increments
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_usage_increments;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_usage_increments
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
