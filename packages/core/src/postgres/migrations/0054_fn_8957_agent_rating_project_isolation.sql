/*
FNXC:MultiProjectIsolation 2026-08-11-10:25:
FN-8957 requires agent ratings to use the same project-local identity as durable agents. Owner and superuser PostgreSQL connections bypass RLS, so the application predicates and composite primary key must prevent duplicate agent and rating IDs from crossing projects.
*/
DO $$
BEGIN
  -- Partial historical schemas used by upgrade tests may not have this satellite table yet.
  IF to_regclass('project.agent_ratings') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE project.agent_ratings
    ADD COLUMN IF NOT EXISTS project_id text;

  UPDATE project.agent_ratings
  SET project_id = COALESCE(
    NULLIF(project_id, ''),
    NULLIF(current_setting('fusion.project_id', true), ''),
    '__legacy_unscoped__'
  )
  WHERE project_id IS NULL OR project_id = '';

  ALTER TABLE project.agent_ratings
    ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
    ALTER COLUMN project_id SET NOT NULL,
    DROP CONSTRAINT IF EXISTS agent_ratings_pkey,
    ADD CONSTRAINT agent_ratings_pkey PRIMARY KEY (project_id, id);

  DROP INDEX IF EXISTS project."idxAgentRatingsAgentId";
  CREATE INDEX "idxAgentRatingsAgentId"
    ON project.agent_ratings(project_id, agent_id);
END $$;
