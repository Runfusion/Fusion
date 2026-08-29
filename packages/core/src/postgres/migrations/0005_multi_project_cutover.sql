/*
FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
Project metadata keys and SQLite revision identities are file-local. Upgrade shared PostgreSQL targets so each registered project retains its own __meta rows and task-document revisions preserve their project plus original-SQLite identity instead of colliding on an integer copied from another file.
*/
DO $$
DECLARE
  completed_project_id text := '';
BEGIN
  IF to_regclass('project.__meta') IS NOT NULL THEN
    ALTER TABLE project.__meta
      ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';

    IF to_regclass('public.fusion_sqlite_migrations') IS NOT NULL THEN
      SELECT project_id INTO completed_project_id
      FROM public.fusion_sqlite_migrations
      WHERE status = 'complete' AND project_id IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT 1;
    END IF;

    UPDATE project.__meta
    SET project_id = COALESCE(completed_project_id, '')
    WHERE project_id = '';

    ALTER TABLE project.__meta DROP CONSTRAINT IF EXISTS __meta_pkey;
    ALTER TABLE project.__meta
      ADD CONSTRAINT __meta_pkey PRIMARY KEY (project_id, key);
  END IF;

  IF to_regclass('project.task_document_revisions') IS NOT NULL THEN
    DROP INDEX IF EXISTS project.task_document_revisions_natural_key_unique;
    ALTER TABLE project.task_document_revisions
      ADD COLUMN IF NOT EXISTS project_id text,
      ADD COLUMN IF NOT EXISTS legacy_sqlite_id integer;

    UPDATE project.task_document_revisions
    SET project_id = COALESCE(completed_project_id, ''),
        legacy_sqlite_id = id
    WHERE legacy_sqlite_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS task_document_revisions_legacy_identity_unique
      ON project.task_document_revisions(project_id, legacy_sqlite_id);
  END IF;
END $$;
