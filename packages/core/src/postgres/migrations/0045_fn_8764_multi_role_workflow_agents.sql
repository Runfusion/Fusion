-- FNXC:WorkflowAgentRouting 2026-08-07-03:12:
-- FN-8764 changes permanent-agent capability from one role to normalized tags.
-- Keep `role` during the compatibility window, but backfill canonical `roles`
-- idempotently so upgrades preserve every legacy agent identity.
DO $$
BEGIN
  -- Partial historic schemas in the upgrade harness did not yet have agents;
  -- a later normal startup applies this idempotent migration after the baseline.
  IF to_regclass('project.agents') IS NOT NULL THEN
    ALTER TABLE project.agents
      ADD COLUMN IF NOT EXISTS roles jsonb NOT NULL DEFAULT '[]'::jsonb;

    UPDATE project.agents
    SET roles = jsonb_build_array(role)
    WHERE jsonb_typeof(roles) <> 'array'
       OR jsonb_array_length(roles) = 0;

    CREATE INDEX IF NOT EXISTS idx_agents_roles ON project.agents USING gin (roles);
  END IF;
END $$;
