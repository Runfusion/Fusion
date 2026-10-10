/* FNXC:ExternalSessionTurns 2026-09-22-19:42: Bounded native transcript turns remain separate from task lifecycle and from mutable session observations. */
CREATE TABLE IF NOT EXISTS project.external_session_turns (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  session_id text NOT NULL,
  native_turn_id text NOT NULL,
  revision bigint NOT NULL,
  ordinal bigint NOT NULL,
  turn jsonb NOT NULL,
  turn_digest text NOT NULL,
  received_at text NOT NULL,
  PRIMARY KEY (project_id, session_id, native_turn_id),
  FOREIGN KEY (project_id, session_id) REFERENCES project.external_sessions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT external_session_turn_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT external_session_turn_ordinal CHECK (ordinal BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX IF NOT EXISTS external_session_turn_history
  ON project.external_session_turns(project_id, session_id, ordinal, native_turn_id);
ALTER TABLE project.external_session_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.external_session_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.external_session_turns;
CREATE POLICY fusion_project_isolation ON project.external_session_turns
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.external_session_turns;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.external_session_turns
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
