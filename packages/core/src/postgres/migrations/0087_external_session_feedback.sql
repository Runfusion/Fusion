/* FNXC:RemoteAgents 2026-09-18-05:22: Standalone feedback belongs to an exact observed native generation. Claimed commands are never automatically replayed. */
CREATE TABLE IF NOT EXISTS project.external_session_feedback (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL, session_id text NOT NULL, generation text NOT NULL,
  text text NOT NULL, fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'expired', 'uncertain')),
  created_at text NOT NULL, expires_at text NOT NULL, delivered_at text,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, session_id) REFERENCES project.external_sessions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS external_session_feedback_queue ON project.external_session_feedback(project_id, session_id, state, created_at, id);
ALTER TABLE project.external_session_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_feedback;
CREATE POLICY fusion_project_isolation ON project.external_session_feedback
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_feedback;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_feedback
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
