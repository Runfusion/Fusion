-- FNXC:PrMergeEventDrivenChecks 2026-08-09-14:35: persist GitHub terminal CI per project and commit so required-check gates can use verified event delivery; received_at bounds scheduled retention when deliveries stop.
CREATE TABLE IF NOT EXISTS project.github_check_states (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL DEFAULT '',
  repo text NOT NULL,
  head_sha text NOT NULL,
  check_name text NOT NULL,
  state text NOT NULL,
  event_kind text,
  external_id text,
  details_url text,
  reported_at text NOT NULL,
  received_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  meta jsonb,
  PRIMARY KEY (project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS "idxGithubCheckStatesIdentity" ON project.github_check_states (project_id, repo, head_sha, check_name);
CREATE INDEX IF NOT EXISTS "idxGithubCheckStatesProjectCommit" ON project.github_check_states (project_id, repo, head_sha);
CREATE INDEX IF NOT EXISTS "idxGithubCheckStatesProjectReceived" ON project.github_check_states (project_id, received_at);

-- New project state must receive the same mandatory ownership fence as established tables.
ALTER TABLE project.github_check_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.github_check_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.github_check_states;
CREATE POLICY fusion_project_isolation ON project.github_check_states
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.github_check_states;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.github_check_states
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
