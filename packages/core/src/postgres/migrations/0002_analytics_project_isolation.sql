/*
FNXC:AnalyticsIsolation 2026-07-13-23:41:
Telemetry from legacy single-project PostgreSQL installations may be assigned only when ownership is unambiguous. A multi-project database with unstamped rows must fail migration for operator repair instead of leaking analytics across projects.
*/
DO $$
DECLARE
  project_count integer;
  sole_project_id text;
  unstamped_count bigint := 0;
  table_unstamped_count bigint;
BEGIN
  SELECT count(*), min(id) INTO project_count, sole_project_id FROM central.projects;

  IF to_regclass('project.activity_log') IS NOT NULL THEN
    ALTER TABLE project.activity_log ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.activity_log WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;
  IF to_regclass('project.agent_runs') IS NOT NULL THEN
    ALTER TABLE project.agent_runs ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.agent_runs WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;
  IF to_regclass('project.usage_events') IS NOT NULL THEN
    ALTER TABLE project.usage_events ADD COLUMN IF NOT EXISTS project_id text;
    SELECT count(*) INTO table_unstamped_count FROM project.usage_events WHERE project_id IS NULL OR project_id = '';
    unstamped_count := unstamped_count + table_unstamped_count;
  END IF;

  IF unstamped_count > 0 AND project_count <> 1 THEN
    RAISE EXCEPTION 'Cannot infer project ownership for % analytics rows across % registered projects; assign project_id before retrying migration', unstamped_count, project_count;
  END IF;

  IF to_regclass('project.activity_log') IS NOT NULL THEN
    IF unstamped_count > 0 THEN
      UPDATE project.activity_log SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    END IF;
    ALTER TABLE project.activity_log ALTER COLUMN project_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "idxActivityLogProjectTimestamp" ON project.activity_log(project_id, timestamp);
  END IF;
  IF to_regclass('project.agent_runs') IS NOT NULL THEN
    IF unstamped_count > 0 THEN
      UPDATE project.agent_runs SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    END IF;
    ALTER TABLE project.agent_runs ALTER COLUMN project_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "idxAgentRunsProjectStartedAt" ON project.agent_runs(project_id, started_at);
  END IF;
  IF to_regclass('project.usage_events') IS NOT NULL THEN
    IF unstamped_count > 0 THEN
      UPDATE project.usage_events SET project_id = sole_project_id WHERE project_id IS NULL OR project_id = '';
    END IF;
    ALTER TABLE project.usage_events ALTER COLUMN project_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "idxUsageEventsProjectTs" ON project.usage_events(project_id, ts);
  END IF;
END $$;
