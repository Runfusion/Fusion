/*
FNXC:ProjectDataIsolation 2026-07-14-12:10:
Every application table in the shared project schema is owned by exactly one project unless it is an explicitly cluster-wide coordination table. Enforce ownership with a required project_id and forced row-level security so omitted application predicates cannot mix agents, secrets, inbox messages, missions, workflows, plugin data, or other project records.

Legacy rows with no trustworthy owner must not be assigned to an arbitrary project. A single project across every complete, running, or failed SQLite cutover marker supplies unambiguous ownership; otherwise quarantine them in __legacy_unscoped__ for operator reconciliation. Merge queues and distributed task-ID allocation are project-owned too, so unrelated projects never share queue leases, prefixes, counters, or reservations.
*/

CREATE TABLE IF NOT EXISTS project.mission_feature_evidence_links (
  project_id text NOT NULL,
  legacy_row_hash text NOT NULL,
  legacy_row jsonb NOT NULL,
  source_schema_sql text,
  migrated_at text NOT NULL,
  PRIMARY KEY (project_id, legacy_row_hash)
);

CREATE TABLE IF NOT EXISTS project.agent_log_entries_legacy (
  project_id text NOT NULL,
  legacy_row_hash text NOT NULL,
  legacy_row jsonb NOT NULL,
  source_schema_sql text,
  migrated_at text NOT NULL,
  PRIMARY KEY (project_id, legacy_row_hash)
);

/*
FNXC:ProjectDataIsolation 2026-07-14-12:45:
Embedded PostgreSQL is administered by a superuser, which bypasses RLS. Application pools assume this deliberately non-superuser role; only the separate migration connection retains administrative bypass.
*/
DO $$
DECLARE
  current_user_is_superuser boolean;
BEGIN
  SELECT rolsuper INTO current_user_is_superuser FROM pg_roles WHERE rolname = current_user;
  IF current_user_is_superuser THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
      CREATE ROLE fusion_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    EXECUTE format('GRANT fusion_runtime TO %I', current_user);
  END IF;
END $$;

/*
FNXC:ProjectWriteOwnership 2026-07-14-14:38:
Legacy async stores sometimes send an explicit NULL project_id, which bypasses a column default. Normalize NULL/empty writes before constraints run so bound sessions always stamp their project and unbound administrative compatibility writes enter the explicit quarantine instead of failing or creating ownerless data.
*/
CREATE OR REPLACE FUNCTION project.fusion_assign_project_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.project_id := COALESCE(
    NULLIF(NEW.project_id, ''),
    NULLIF(current_setting('fusion.project_id', true), ''),
    '__legacy_unscoped__'
  );
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  schema_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    RETURN;
  END IF;
  FOREACH schema_name IN ARRAY ARRAY['project', 'central', 'archive'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO fusion_runtime', schema_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO fusion_runtime', schema_name);
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO fusion_runtime', schema_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fusion_runtime', schema_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO fusion_runtime', schema_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_record record;
  migration_project_count integer := 0;
  legacy_owner text := '__legacy_unscoped__';
BEGIN
  IF to_regclass('public.fusion_sqlite_migrations') IS NOT NULL THEN
    SELECT count(DISTINCT project_id), min(project_id)
      INTO migration_project_count, legacy_owner
    FROM public.fusion_sqlite_migrations
    WHERE project_id IS NOT NULL
      AND project_id <> '';

    IF migration_project_count <> 1 THEN
      legacy_owner := '__legacy_unscoped__';
    END IF;
  END IF;

  FOR table_record IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'project'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  LOOP
    EXECUTE format(
      'ALTER TABLE project.%I ADD COLUMN IF NOT EXISTS project_id text',
      table_record.table_name
    );
    EXECUTE format(
      'UPDATE project.%I SET project_id = $1 WHERE project_id IS NULL OR project_id = %L',
      table_record.table_name,
      ''
    ) USING legacy_owner;
    EXECUTE format(
      'ALTER TABLE project.%I ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting(%L, true), %L), %L)',
      table_record.table_name,
      'fusion.project_id',
      '',
      '__legacy_unscoped__'
    );
    EXECUTE format(
      'ALTER TABLE project.%I ALTER COLUMN project_id SET NOT NULL',
      table_record.table_name
    );
    EXECUTE format('ALTER TABLE project.%I ENABLE ROW LEVEL SECURITY', table_record.table_name);
    EXECUTE format('ALTER TABLE project.%I FORCE ROW LEVEL SECURITY', table_record.table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS fusion_project_isolation ON project.%I',
      table_record.table_name
    );
    EXECUTE format(
      'CREATE POLICY fusion_project_isolation ON project.%I USING (' ||
      'current_setting(%L, true) = %L OR project_id = current_setting(%L, true)' ||
      ') WITH CHECK (' ||
      'current_setting(%L, true) = %L OR project_id = current_setting(%L, true)' ||
      ')',
      table_record.table_name,
      'fusion.project_bypass', 'on', 'fusion.project_id',
      'fusion.project_bypass', 'on', 'fusion.project_id'
    );
    EXECUTE format('DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.%I', table_record.table_name);
    EXECUTE format(
      'CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.%I FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id()',
      table_record.table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE
  index_record record;
  key_expressions text;
  predicate_clause text;
BEGIN
  FOR index_record IN
    SELECT i.indexrelid, i.indrelid::regclass AS table_name, idx.relname AS index_name,
      i.indnkeyatts, am.amname AS access_method, pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE n.nspname = 'project'
      AND i.indisunique
      AND NOT i.indisprimary
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(i.indkey::smallint[]) key_attnum
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key_attnum
        WHERE a.attname = 'project_id'
      )
  LOOP
    SELECT string_agg(pg_get_indexdef(index_record.indexrelid, position, true), ', ' ORDER BY position)
      INTO key_expressions
    FROM generate_series(1, index_record.indnkeyatts) position;
    predicate_clause := CASE WHEN index_record.predicate IS NULL THEN '' ELSE ' WHERE ' || index_record.predicate END;
    EXECUTE format('DROP INDEX %I.%I', 'project', index_record.index_name);
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON %s USING %I (project_id, %s)%s',
      index_record.index_name, index_record.table_name, index_record.access_method, key_expressions, predicate_clause
    );
  END LOOP;
END $$;

/*
FNXC:ProjectArchiveIsolation 2026-07-14-13:55:
Archived task snapshots retain the same project-local task identity as live tasks. The shared cold-storage schema must permit the same task ID in different projects and enforce the session partition at the database boundary.
*/
DO $$
DECLARE
  migration_project_count integer := 0;
  legacy_owner text := '__legacy_unscoped__';
BEGIN
  IF to_regclass('archive.archived_tasks') IS NOT NULL THEN
    IF to_regclass('public.fusion_sqlite_migrations') IS NOT NULL THEN
      SELECT count(DISTINCT project_id), min(project_id)
        INTO migration_project_count, legacy_owner
      FROM public.fusion_sqlite_migrations
      WHERE project_id IS NOT NULL AND project_id <> '';
      IF migration_project_count <> 1 THEN
        legacy_owner := '__legacy_unscoped__';
      END IF;
    END IF;

    UPDATE archive.archived_tasks
    SET project_id = legacy_owner
    WHERE project_id IS NULL OR project_id = '';
    ALTER TABLE archive.archived_tasks
      ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
      ALTER COLUMN project_id SET NOT NULL,
      DROP CONSTRAINT IF EXISTS archived_tasks_pkey;
    ALTER TABLE archive.archived_tasks
      ADD CONSTRAINT archived_tasks_pkey PRIMARY KEY (project_id, id);
    ALTER TABLE archive.archived_tasks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE archive.archived_tasks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS fusion_project_isolation ON archive.archived_tasks;
    CREATE POLICY fusion_project_isolation ON archive.archived_tasks
      USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
      WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA project TO fusion_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA project TO fusion_runtime;
  END IF;
END $$;

/*
FNXC:ProjectRelationalIdentity 2026-07-14-13:42:
Every primary key, unique constraint, and intra-project foreign key is project-local, not only the initially reported agent, task-ID, and merge-queue paths. This lets independent SQLite projects reuse natural IDs such as FN-1, agent IDs, workflow IDs, document keys, and legacy integer IDs without migration collisions or cross-project references.
*/
CREATE TEMP TABLE IF NOT EXISTS fusion_project_fk_rebuild (
  child_table regclass,
  parent_table regclass,
  constraint_name text,
  child_columns text[],
  parent_columns text[],
  delete_action "char",
  update_action "char",
  match_type "char",
  is_deferrable boolean,
  is_deferred boolean
) ON COMMIT DROP;
TRUNCATE fusion_project_fk_rebuild;

INSERT INTO fusion_project_fk_rebuild(
  child_table, parent_table, constraint_name, child_columns, parent_columns,
  delete_action, update_action, match_type, is_deferrable, is_deferred
)
SELECT
  c.conrelid::regclass,
  c.confrelid::regclass,
  c.conname,
  ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord),
  ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord),
  c.confdeltype,
  c.confupdtype,
  c.confmatchtype,
  c.condeferrable,
  c.condeferred
FROM pg_constraint c
JOIN pg_class child ON child.oid = c.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = c.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
WHERE c.contype = 'f'
  AND child_ns.nspname = 'project'
  AND parent_ns.nspname = 'project';

DO $$
DECLARE
  fk record;
  key_record record;
  key_columns text;
  constraint_kind text;
  delete_clause text;
  update_clause text;
  match_clause text;
  deferrable_clause text;
  ownership_join_clause text;
BEGIN
  FOR fk IN SELECT * FROM fusion_project_fk_rebuild LOOP
    SELECT string_agg(
      format('child.%I IS NOT DISTINCT FROM parent.%I', child_column, parent_column),
      ' AND '
      ORDER BY ord
    )
      INTO ownership_join_clause
    FROM unnest(fk.child_columns, fk.parent_columns) WITH ORDINALITY
      AS paired(child_column, parent_column, ord)
    WHERE child_column <> 'project_id';

    /*
    FNXC:ProjectMigrationRetry 2026-07-14-12:43:
    A failed pre-isolation cutover can leave a child row in the quarantine or stale partition while its globally keyed parent was already assigned to the resolved project. Reconcile ownership through the legacy foreign-key identity before replacing that relationship with its composite project-local form, otherwise the isolation migration itself can be blocked before the SQLite retry repair runs.
    */
    IF ownership_join_clause IS NOT NULL THEN
      EXECUTE format(
        'UPDATE %s AS child SET project_id = parent.project_id FROM %s AS parent WHERE child.project_id IS DISTINCT FROM parent.project_id AND %s',
        fk.child_table,
        fk.parent_table,
        ownership_join_clause
      );
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.child_table, fk.constraint_name);
  END LOOP;

  FOR key_record IN
    SELECT c.conrelid::regclass AS table_name, c.conname, c.contype, c.condeferrable, c.condeferred,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'project'
      AND c.contype IN ('p', 'u')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(c.conkey) key_attnum
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
        WHERE a.attname = 'project_id'
      )
  LOOP
    SELECT string_agg(format('%I', column_name), ', ')
      INTO key_columns
    FROM unnest(key_record.columns) column_name;
    constraint_kind := CASE key_record.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END;
    deferrable_clause := CASE
      WHEN key_record.condeferrable AND key_record.condeferred THEN ' DEFERRABLE INITIALLY DEFERRED'
      WHEN key_record.condeferrable THEN ' DEFERRABLE INITIALLY IMMEDIATE'
      ELSE ''
    END;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', key_record.table_name, key_record.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s (project_id, %s)%s',
      key_record.table_name, key_record.conname, constraint_kind, key_columns, deferrable_clause
    );
  END LOOP;

  FOR fk IN SELECT * FROM fusion_project_fk_rebuild LOOP
    delete_clause := CASE fk.delete_action
      WHEN 'c' THEN ' ON DELETE CASCADE'
      WHEN 'n' THEN format(' ON DELETE SET NULL (%s)', (SELECT string_agg(format('%I', c), ', ') FROM unnest(fk.child_columns) c WHERE c <> 'project_id'))
      WHEN 'd' THEN format(' ON DELETE SET DEFAULT (%s)', (SELECT string_agg(format('%I', c), ', ') FROM unnest(fk.child_columns) c WHERE c <> 'project_id'))
      WHEN 'r' THEN ' ON DELETE RESTRICT'
      WHEN 'a' THEN ' ON DELETE NO ACTION'
      ELSE ''
    END;
    update_clause := CASE fk.update_action
      WHEN 'c' THEN ' ON UPDATE CASCADE'
      WHEN 'n' THEN format(' ON UPDATE SET NULL (%s)', (SELECT string_agg(format('%I', c), ', ') FROM unnest(fk.child_columns) c WHERE c <> 'project_id'))
      WHEN 'd' THEN format(' ON UPDATE SET DEFAULT (%s)', (SELECT string_agg(format('%I', c), ', ') FROM unnest(fk.child_columns) c WHERE c <> 'project_id'))
      WHEN 'r' THEN ' ON UPDATE RESTRICT'
      WHEN 'a' THEN ' ON UPDATE NO ACTION'
      ELSE ''
    END;
    match_clause := CASE fk.match_type WHEN 'f' THEN ' MATCH FULL' WHEN 'p' THEN ' MATCH PARTIAL' ELSE '' END;
    deferrable_clause := ' DEFERRABLE INITIALLY IMMEDIATE';
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %s(%s)%s%s%s%s',
      fk.child_table,
      fk.constraint_name,
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(ARRAY['project_id'] || array_remove(fk.child_columns, 'project_id')) c),
      fk.parent_table,
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(ARRAY['project_id'] || array_remove(fk.parent_columns, 'project_id')) c),
      match_clause,
      update_clause,
      delete_clause,
      deferrable_clause
    );
  END LOOP;
END $$;
