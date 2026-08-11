-- FNXC:SpecLock 2026-08-09-07:06: immutable task-plan history is project-scoped and deliberately has no task FK, so archive/tombstone cleanup cannot erase approval evidence.
CREATE TABLE IF NOT EXISTS project.spec_locks (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), task_id text NOT NULL, version integer NOT NULL,
  accepted_at text NOT NULL, approval_fingerprint text NOT NULL, current_plan_version integer NOT NULL, current_plan_hash text NOT NULL,
  snapshot jsonb NOT NULL, prior_version integer, diff jsonb, PRIMARY KEY (project_id, task_id, version)
);
CREATE TABLE IF NOT EXISTS project.current_plan_evidence (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), task_id text NOT NULL, version integer NOT NULL,
  source_revision bigint NOT NULL, source_hash text NOT NULL, captured_at text NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY (project_id, task_id, version), UNIQUE (project_id, task_id, source_hash)
);
CREATE TABLE IF NOT EXISTS project.spec_drift_reports (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), task_id text NOT NULL, report_hash text NOT NULL,
  lock_version integer, current_plan_version integer, current_plan_hash text, execution_hash text NOT NULL, report jsonb NOT NULL, created_at text NOT NULL,
  PRIMARY KEY (project_id, task_id, report_hash)
);
CREATE INDEX IF NOT EXISTS idx_spec_locks_latest ON project.spec_locks(project_id, task_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_current_plan_evidence_latest ON project.current_plan_evidence(project_id, task_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_spec_drift_reports_latest ON project.spec_drift_reports(project_id, task_id, created_at DESC);
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['spec_locks', 'current_plan_evidence', 'spec_drift_reports'] LOOP
    EXECUTE format('ALTER TABLE project.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE project.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('DROP POLICY IF EXISTS fusion_project_isolation ON project.%I', relation_name);
    EXECUTE format('CREATE POLICY fusion_project_isolation ON project.%I USING (current_setting(''fusion.project_bypass'', true) = ''on'' OR project_id = current_setting(''fusion.project_id'', true)) WITH CHECK (current_setting(''fusion.project_bypass'', true) = ''on'' OR project_id = current_setting(''fusion.project_id'', true))', relation_name);
    EXECUTE format('DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.%I', relation_name);
    EXECUTE format('CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.%I FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id()', relation_name);
  END LOOP;
END $$;
