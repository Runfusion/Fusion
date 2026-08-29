/*
FNXC:MultiProjectIsolation 2026-08-12-15:43:
Migration 0048 created github_check_states after ownership migration 0006 and retained its
pre-isolation empty project_id default. Reconcile only that default so omitted ownership values
continue through the database GUC/trigger path without rewriting rows, keys, RLS, or triggers.
*/
DO $$
BEGIN
  IF to_regclass('project.github_check_states') IS NOT NULL THEN
    ALTER TABLE project.github_check_states
      ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__');
  END IF;
END $$;
