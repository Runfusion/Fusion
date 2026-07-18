/*
FNXC:Ideation 2026-07-30-15:30:
The universal project-ownership migration has already run on upgrades. These
new tables therefore install its RLS/default/trigger contract locally, ensuring
an ideation convergence can only link to Mission records in its own partition.
*/
CREATE TABLE IF NOT EXISTS project.ideation_sessions (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL,
  title text NOT NULL,
  prompt text,
  status text NOT NULL DEFAULT 'open',
  target_mission_id text,
  target_feature_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  converged_at text,
  PRIMARY KEY (project_id, id),
  CONSTRAINT ideation_sessions_status_check CHECK (status IN ('open','converged','archived')),
  CONSTRAINT ideation_sessions_mission_fk FOREIGN KEY (project_id, target_mission_id)
    REFERENCES project.missions(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT ideation_sessions_feature_fk FOREIGN KEY (project_id, target_feature_id)
    REFERENCES project.mission_features(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS project.ideation_candidates (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL,
  session_id text NOT NULL,
  content text NOT NULL,
  origin text NOT NULL,
  source_ref text,
  selected integer NOT NULL DEFAULT 0,
  linked_mission_id text,
  linked_feature_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  CONSTRAINT ideation_candidates_session_fk FOREIGN KEY (project_id, session_id)
    REFERENCES project.ideation_sessions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT ideation_candidates_mission_fk FOREIGN KEY (project_id, linked_mission_id)
    REFERENCES project.missions(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT ideation_candidates_feature_fk FOREIGN KEY (project_id, linked_feature_id)
    REFERENCES project.mission_features(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT ideation_candidates_origin_check CHECK (origin IN ('agent','human','research')),
  CONSTRAINT ideation_candidates_selected_check CHECK (selected IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_ideation_candidates_session ON project.ideation_candidates(project_id, session_id);

ALTER TABLE project.ideation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ideation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE project.ideation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.ideation_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.ideation_sessions;
CREATE POLICY fusion_project_isolation ON project.ideation_sessions
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP POLICY IF EXISTS fusion_project_isolation ON project.ideation_candidates;
CREATE POLICY fusion_project_isolation ON project.ideation_candidates
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ideation_sessions;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.ideation_sessions
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.ideation_candidates;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.ideation_candidates
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
