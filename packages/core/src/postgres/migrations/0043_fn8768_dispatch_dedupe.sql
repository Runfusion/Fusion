CREATE TABLE IF NOT EXISTS project.unplanned_execution_blocks (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  episode text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, task_id, episode)
);

ALTER TABLE project.unplanned_execution_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.unplanned_execution_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.unplanned_execution_blocks;
CREATE POLICY fusion_project_isolation ON project.unplanned_execution_blocks
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.unplanned_execution_blocks;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.unplanned_execution_blocks
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
