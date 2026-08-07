-- FNXC:WorkflowAgentRouting 2026-08-07-03:25:
-- FN-8764 requires routing identity to live on the project-scoped work item,
-- not mutable task ownership. These nullable fields preserve legacy items while
-- fencing new classified session attempts and their reviewer-node boundaries.
DO $$
BEGIN
  -- Very old upgrade fixtures can predate workflow work items entirely.
  CREATE TABLE IF NOT EXISTS project.workflow_agent_capacity_leases (
    project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
    attempt_id text NOT NULL,
    agent_id text NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    PRIMARY KEY (project_id, attempt_id)
  );
  -- FNXC:WorkflowAgentRouting 2026-08-07-07:16: Existing leases gain a finite expiry so a process crash cannot consume workflow capacity indefinitely.
  ALTER TABLE project.workflow_agent_capacity_leases
    ADD COLUMN IF NOT EXISTS expires_at text;
  UPDATE project.workflow_agent_capacity_leases
    SET expires_at = created_at
    WHERE expires_at IS NULL;
  ALTER TABLE project.workflow_agent_capacity_leases
    ALTER COLUMN expires_at SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_workflow_agent_capacity_leases_agent
    ON project.workflow_agent_capacity_leases (project_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_agent_capacity_leases_expiry
    ON project.workflow_agent_capacity_leases (project_id, expires_at);
  ALTER TABLE project.workflow_agent_capacity_leases ENABLE ROW LEVEL SECURITY;
  ALTER TABLE project.workflow_agent_capacity_leases FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS fusion_project_isolation ON project.workflow_agent_capacity_leases;
  CREATE POLICY fusion_project_isolation ON project.workflow_agent_capacity_leases
    USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
    WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
  DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.workflow_agent_capacity_leases;
  CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.workflow_agent_capacity_leases
    FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

  IF to_regclass('project.workflow_work_items') IS NOT NULL THEN
    ALTER TABLE project.workflow_work_items
      ADD COLUMN IF NOT EXISTS principal_agent_id text,
      ADD COLUMN IF NOT EXISTS workflow_role text,
      ADD COLUMN IF NOT EXISTS authority_kind text,
      ADD COLUMN IF NOT EXISTS node_instance_id text;

    CREATE INDEX IF NOT EXISTS idx_workflow_work_items_active_principal
      ON project.workflow_work_items (project_id, principal_agent_id, state)
      WHERE principal_agent_id IS NOT NULL;
  END IF;
END $$;
