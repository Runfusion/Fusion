/*
FNXC:CommandCenterTenantIsolation 2026-07-14-01:04:
Monitor and approval analytics share PostgreSQL tables across projects. Legacy rows may be assigned only when one registered project proves ownership; ambiguous data must fail closed before bound analytics can expose another tenant's events.
*/
DO $$
DECLARE
  project_count integer;
  sole_project_id text;
  unstamped_count bigint := 0;
  table_unstamped_count bigint;
BEGIN
  SELECT count(*), min(id) INTO project_count, sole_project_id FROM central.projects;

  IF to_regclass('project.deployments') IS NOT NULL THEN
    ALTER TABLE project.deployments ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.deployments WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;
  IF to_regclass('project.incidents') IS NOT NULL THEN
    ALTER TABLE project.incidents ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.incidents WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;
  IF to_regclass('project.approval_request_audit_events') IS NOT NULL THEN
    ALTER TABLE project.approval_request_audit_events ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.approval_request_audit_events WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;

  IF unstamped_count > 0 AND project_count <> 1 THEN
    RAISE EXCEPTION 'Cannot infer project ownership for % monitor/approval rows across % registered projects; assign project_id before retrying migration', unstamped_count, project_count;
  END IF;

  IF to_regclass('project.deployments') IS NOT NULL THEN
    UPDATE project.deployments SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    ALTER TABLE project.deployments ALTER COLUMN project_id SET DEFAULT '';
    ALTER TABLE project.deployments ALTER COLUMN project_id SET NOT NULL;
    ALTER TABLE project.deployments DROP CONSTRAINT IF EXISTS deployments_deployment_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS "idxDeploymentsProjectDeploymentId" ON project.deployments(project_id, deployment_id);
    CREATE INDEX IF NOT EXISTS "idxDeploymentsProjectDeployedAt" ON project.deployments(project_id, deployed_at);
  END IF;
  IF to_regclass('project.incidents') IS NOT NULL THEN
    UPDATE project.incidents SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    ALTER TABLE project.incidents ALTER COLUMN project_id SET DEFAULT '';
    ALTER TABLE project.incidents ALTER COLUMN project_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "idxIncidentsProjectOpenedAt" ON project.incidents(project_id, opened_at);
    CREATE INDEX IF NOT EXISTS "idxIncidentsProjectStatus" ON project.incidents(project_id, status);
  END IF;
  IF to_regclass('project.approval_request_audit_events') IS NOT NULL THEN
    UPDATE project.approval_request_audit_events SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    ALTER TABLE project.approval_request_audit_events ALTER COLUMN project_id SET DEFAULT '';
    ALTER TABLE project.approval_request_audit_events ALTER COLUMN project_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "idxApprovalRequestAuditProjectCreatedAt" ON project.approval_request_audit_events(project_id, created_at);
  END IF;
END $$;
