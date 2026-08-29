/*
FNXC:PlannerOversight 2026-07-14-18:49:
Per-task session advisor control (project default + task override + Quick Add)
persists as project.tasks.session_advisor_enabled (null = inherit, 0 = off, 1 = on).
Drizzle schema and EXPECTED_PROJECT_COLUMNS already declare the column, but
migrations 0000–0007 never created it — fresh DBs from the applier lacked the
column and boot-smoke SELECT * paths failed. Self-heal covers long-lived
embedded DBs; this versioned migration is the upgrade/fresh-install path so Gate
and multi-project boots cannot race ahead of ALTER TABLE health checks.
*/
DO $$
BEGIN
  IF to_regclass('project.tasks') IS NOT NULL THEN
    ALTER TABLE project.tasks
      ADD COLUMN IF NOT EXISTS session_advisor_enabled integer;
  END IF;
END
$$;
