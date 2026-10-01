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
/*
FNXC:RemoteAgents 2026-09-22-17:54: Repair a partial feedback table even when the 0087 ledger row survives.
CREATE TABLE IF NOT EXISTS cannot restore dropped columns or constraints. Required values cannot be invented for populated rows, so a missing NOT NULL column fails startup transactionally; empty tables are repaired.
RLS and the isolation policy stay under the global ownership audit, which fails closed before this migration runs.
*/
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS project_id text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS id text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS session_id text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS generation text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS text text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS fingerprint text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS state text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS created_at text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS expires_at text NOT NULL;
ALTER TABLE project.external_session_feedback ADD COLUMN IF NOT EXISTS delivered_at text;
ALTER TABLE project.external_session_feedback ALTER COLUMN project_id SET DEFAULT current_setting('fusion.project_id', true);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_feedback'::regclass AND conname = 'external_session_feedback_pkey') THEN
    ALTER TABLE project.external_session_feedback ADD CONSTRAINT external_session_feedback_pkey PRIMARY KEY (project_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_feedback'::regclass AND conname = 'external_session_feedback_state_check') THEN
    ALTER TABLE project.external_session_feedback ADD CONSTRAINT external_session_feedback_state_check CHECK (state IN ('queued', 'claimed', 'delivered', 'expired', 'uncertain'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_session_feedback'::regclass AND conname = 'external_session_feedback_project_id_session_id_fkey') THEN
    ALTER TABLE project.external_session_feedback ADD CONSTRAINT external_session_feedback_project_id_session_id_fkey FOREIGN KEY (project_id, session_id) REFERENCES project.external_sessions(project_id, id) ON DELETE CASCADE;
  END IF;
END $$;
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
