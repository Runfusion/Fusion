/*
FNXC:MigrationStatusRuntimeRead 2026-07-20:
Dashboard migration health runs through the project-bound fusion_runtime role.
Grant that role read-only access to the SQLite cutover ledger while row-level
security limits each session to its own project marker. Existing databases need
this forward migration because the ledger is created outside the schema baseline.
*/
DO $$
BEGIN
  IF to_regclass('public.fusion_sqlite_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    RETURN;
  END IF;

  ALTER TABLE public.fusion_sqlite_migrations ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.fusion_sqlite_migrations'::regclass
      AND polname = 'fusion_sqlite_migrations_project_read'
  ) THEN
    CREATE POLICY fusion_sqlite_migrations_project_read
      ON public.fusion_sqlite_migrations
      FOR SELECT
      TO fusion_runtime
      USING (
        current_setting('fusion.project_bypass', true) = 'on'
        OR project_id = NULLIF(current_setting('fusion.project_id', true), '')
      );
  END IF;

  GRANT SELECT ON public.fusion_sqlite_migrations TO fusion_runtime;
END $$;
