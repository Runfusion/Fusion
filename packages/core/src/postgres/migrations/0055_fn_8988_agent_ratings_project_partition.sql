/*
FNXC:AgentRatingsProjectIsolation 2026-08-12-01:00:
Migration 0006 dynamically gave every project table an ownership column, RLS policy, trigger, and composite key. This targeted reconciliation is intentionally idempotent: it is a no-op on that healthy shape while repairing historical databases whose agent_ratings metadata or ORM contract drifted.
*/
DO $$
DECLARE
  legacy_owner text := '__legacy_unscoped__';
  migration_project_count integer := 0;
  primary_key_name text;
  primary_key_is_project_partition boolean;
BEGIN
  IF to_regclass('project.agent_ratings') IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.fusion_sqlite_migrations') IS NOT NULL THEN
    SELECT count(DISTINCT project_id), min(project_id)
      INTO migration_project_count, legacy_owner
    FROM public.fusion_sqlite_migrations
    WHERE project_id IS NOT NULL AND project_id <> '';
    IF migration_project_count <> 1 THEN
      legacy_owner := '__legacy_unscoped__';
    END IF;
  END IF;

  ALTER TABLE project.agent_ratings ADD COLUMN IF NOT EXISTS project_id text;
  UPDATE project.agent_ratings
    SET project_id = legacy_owner
    WHERE project_id IS NULL OR project_id = '';
  ALTER TABLE project.agent_ratings
    ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
    ALTER COLUMN project_id SET NOT NULL;

  ALTER TABLE project.agent_ratings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE project.agent_ratings FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS fusion_project_isolation ON project.agent_ratings;
  CREATE POLICY fusion_project_isolation ON project.agent_ratings
    USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
    WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));

  IF to_regprocedure('project.fusion_assign_project_id()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.agent_ratings;
    CREATE TRIGGER fusion_assign_project_id
      BEFORE INSERT OR UPDATE OF project_id ON project.agent_ratings
      FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
  END IF;

  /*
  FNXC:AgentRatingsProjectPartition 2026-08-12-01:30:
  A primary key merely containing project_id does not establish rating identity:
  (project_id, agent_id) still allows duplicate rating ids within a project.
  Rebuild every non-exact key so the durable contract is ordered (project_id, id).
  */
  SELECT c.conname,
    ARRAY(
      SELECT a.attname::text
      FROM unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_column.attnum
      ORDER BY key_column.ordinal
    ) = ARRAY['project_id', 'id']
    INTO primary_key_name, primary_key_is_project_partition
  FROM pg_constraint c
  WHERE c.conrelid = 'project.agent_ratings'::regclass AND c.contype = 'p';

  IF primary_key_name IS NOT NULL AND NOT primary_key_is_project_partition THEN
    EXECUTE format('ALTER TABLE project.agent_ratings DROP CONSTRAINT %I', primary_key_name);
    ALTER TABLE project.agent_ratings ADD CONSTRAINT agent_ratings_pkey PRIMARY KEY (project_id, id);
  ELSIF primary_key_name IS NULL THEN
    ALTER TABLE project.agent_ratings ADD CONSTRAINT agent_ratings_pkey PRIMARY KEY (project_id, id);
  END IF;

  CREATE INDEX IF NOT EXISTS "idxAgentRatingsProjectAgentId"
    ON project.agent_ratings(project_id, agent_id);
END $$;
