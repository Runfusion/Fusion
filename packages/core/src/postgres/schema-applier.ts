/**
 * PostgreSQL schema applier.
 *
 * FNXC:PostgresSchema 2026-06-24-03:40:
 * Applies the fresh Drizzle migration baseline to a PostgreSQL connection
 * and records it in a migration bookkeeping table. The baseline migration
 * (migrations/0000_initial.sql) is the snapshot of the final SQLite schema
 * (SCHEMA_VERSION=128) translated to PostgreSQL — applying it to an empty
 * database yields final-schema parity (VAL-SCHEMA-001).
 *
 * After the baseline lands, plugin-owned tables are materialized via the
 * schema-init hook (VAL-SCHEMA-007). The applier calls each registered plugin
 * hook so plugins evolve their own tables independently of the core migration.
 *
 * Migration tracking uses a single-row bookkeeping table in the public schema
 * so the applier is idempotent: re-running against an already-migrated database
 * is a no-op. The version-gate discipline (the institutional learning that
 * fresh-DB tests cannot catch a skipped-on-upgrade migration) is carried
 * forward via the applier's explicit baseline marker.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { runPluginSchemaInitHooks, DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS, type PluginSchemaInitHook } from "./plugin-schema-hook.js";

/** The latest PostgreSQL schema version known to this applier. */
export const SCHEMA_BASELINE_VERSION = "0007";
const INITIAL_SCHEMA_VERSION = "0000";
const AUTOMATION_ISOLATION_SCHEMA_VERSION = "0001";
const ANALYTICS_ISOLATION_SCHEMA_VERSION = "0002";
/**
 * FNXC:PostgresMigrationIdentity 2026-07-14-01:41:
 * Each migration keeps an immutable bookkeeping identity even as SCHEMA_BASELINE_VERSION advances to newer migrations. Upgrade checks and inserts must use this dedicated 0003 identifier so a later latest-version marker cannot make an unrecorded monitor/approval migration look applied.
 */
export const MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION = "0003";
export const LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION = "0004";
export const MULTI_PROJECT_CUTOVER_SCHEMA_VERSION = "0005";
export const PROJECT_OWNERSHIP_SCHEMA_VERSION = "0006";
export const SQLITE_SCHEMA_PARITY_VERSION = "0007";

/** Bookkeeping table for the fresh Drizzle migration history. */
export const MIGRATION_BOOKKEEPING_TABLE = "fusion_schema_migrations";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_MIGRATION_PATH = join(__dirname, "migrations", "0000_initial.sql");
const AUTOMATION_ISOLATION_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0001_automation_project_isolation.sql",
);
const ANALYTICS_ISOLATION_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0002_analytics_project_isolation.sql",
);
const MONITOR_APPROVAL_ISOLATION_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0003_monitor_approval_project_isolation.sql",
);
const LEGACY_CUTOVER_PRESERVATION_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0004_legacy_cutover_preservation.sql",
);
const MULTI_PROJECT_CUTOVER_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0005_multi_project_cutover.sql",
);
const PROJECT_OWNERSHIP_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0006_project_ownership.sql",
);
const SQLITE_SCHEMA_PARITY_MIGRATION_PATH = join(
  __dirname,
  "migrations",
  "0007_sqlite_schema_parity.sql",
);

/**
 * Ensure the migration bookkeeping table exists. Lives in the public schema so
 * it survives across the three application schemas and is queryable without
 * search_path qualification.
 */
async function ensureBookkeepingTable(db: PostgresJsDatabase<Record<string, never>>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
}

/** Read the baseline migration SQL from disk. Exported for tests. */
export async function readBaselineMigrationSql(): Promise<string> {
  return readFile(BASELINE_MIGRATION_PATH, "utf8");
}

/** Return the set of already-applied migration versions, or empty if none. */
export async function getAppliedMigrations(
  db: PostgresJsDatabase<Record<string, never>>,
): Promise<string[]> {
  await ensureBookkeepingTable(db);
  const rows = (await db.execute(
    sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} ORDER BY version`,
  )) as unknown as Array<{ version: string }>;
  return rows.map((row) => row.version);
}

/**
 * Apply the fresh baseline migration to the given connection.
 *
 * Idempotent: if the baseline version is already recorded, this is a no-op.
 * After the baseline lands, all registered plugin schema-init hooks run so
 * plugin-owned tables (e.g. roadmap) materialize (VAL-SCHEMA-007).
 *
 * The baseline SQL is applied as a single batch via postgres.js's file/unsafe
 * execution path. It uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT
 * EXISTS throughout, so a partial prior apply is safe to resume.
 */
export async function applySchemaBaseline(
  db: PostgresJsDatabase<Record<string, never>>,
  options: { pluginHooks?: readonly PluginSchemaInitHook[] } = {},
): Promise<{ applied: boolean; pluginHooksRun: number }> {
  /*
   * FNXC:PostgresSchema 2026-07-14-00:05:
   * Schema versions are a cluster-wide invariant. Serialize version discovery,
   * DDL, and bookkeeping in one transaction so concurrent Fusion processes
   * cannot both apply a version or race its primary-key marker.
  */
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:schema-applier'))`);
    await ensureBookkeepingTable(tx);
    const applied = await getAppliedMigrations(tx);
    const baselineAlreadyApplied = applied.includes(INITIAL_SCHEMA_VERSION);
    const automationIsolationAlreadyApplied = applied.includes(AUTOMATION_ISOLATION_SCHEMA_VERSION);
    const analyticsIsolationAlreadyApplied = applied.includes(ANALYTICS_ISOLATION_SCHEMA_VERSION);
    const monitorApprovalIsolationAlreadyApplied = applied.includes(MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION);
    const legacyCutoverPreservationAlreadyApplied = applied.includes(LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION);
    const multiProjectCutoverAlreadyApplied = applied.includes(MULTI_PROJECT_CUTOVER_SCHEMA_VERSION);
    const projectOwnershipAlreadyApplied = applied.includes(PROJECT_OWNERSHIP_SCHEMA_VERSION);
    const sqliteSchemaParityAlreadyApplied = applied.includes(SQLITE_SCHEMA_PARITY_VERSION);
    let schemaChanged = false;

    if (!baselineAlreadyApplied) {
      const baselineSql = await readBaselineMigrationSql();
      // The baseline contains multiple statements including CREATE SCHEMA, CREATE
      // TABLE, CREATE INDEX, and seed INSERTs. postgres.js executes a single
      // query string as one batch (simple query protocol when unparameterized).
      await tx.execute(sql.raw(baselineSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${INITIAL_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

  /*
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * A database that already recorded the initial PostgreSQL baseline must still receive project-scoped automation storage. Apply this version independently of 0000; ambiguous legacy ownership fails closed before any bound cron runner can silently omit those schedules.
   */
    if (!automationIsolationAlreadyApplied) {
      const migrationSql = await readFile(AUTOMATION_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${AUTOMATION_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:AnalyticsIsolation 2026-07-14-00:05:
    Existing PostgreSQL databases that already recorded 0001 must independently receive analytics project partitions before project-scoped readers and writers start. Keep 0002 versioned so a fresh baseline cannot hide a skipped upgrade path.
    */
    if (!analyticsIsolationAlreadyApplied) {
      const migrationSql = await readFile(ANALYTICS_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${ANALYTICS_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:CommandCenterTenantIsolation 2026-07-14-01:04:
    Version 0003 supplies durable ownership for monitor and approval analytics. It must run independently after 0002 so databases that already accepted the earlier analytics migration cannot silently skip the remaining tenant partitions.
    */
    if (!monitorApprovalIsolationAlreadyApplied) {
      const migrationSql = await readFile(MONITOR_APPROVAL_ISOLATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
    Apply retired-table preservation independently of 0000 so an older partial migration target can retry without losing board, project-auth, or task-reviewer rows. The DDL is additive and idempotent.
    */
    if (!legacyCutoverPreservationAlreadyApplied) {
      const migrationSql = await readFile(LEGACY_CUTOVER_PRESERVATION_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    /*
    FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
    Existing targets may already contain one completed project plus a partially copied second project. Apply metadata partitioning and collision-safe revision identity before any retry builds its migration plan.
    */
    if (!multiProjectCutoverAlreadyApplied) {
      const migrationSql = await readFile(MULTI_PROJECT_CUTOVER_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${MULTI_PROJECT_CUTOVER_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

  // Run plugin schema-init hooks regardless of whether the baseline was just
  // applied or already present — plugin tables must exist on every connection
  // the applier touches. The hooks are themselves idempotent (CREATE TABLE IF
  // NOT EXISTS), so re-running is safe.
    const pluginHooks = options.pluginHooks ?? DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS;
    await runPluginSchemaInitHooks(tx, pluginHooks);

    /*
    FNXC:ProjectDataIsolation 2026-07-14-12:10:
    Run universal ownership once, after plugin hooks, so first application covers core and plugin tables without duplicate DDL. Later boots validate that every newly introduced plugin table declared the same ownership contract instead of rebuilding primary keys, foreign keys, and policies on every startup.

    FNXC:ProjectArchiveIsolation 2026-07-14-14:31:
    The steady-state audit includes archive.archived_tasks because archived task IDs are project-local and must retain the same forced-RLS boundary as live task rows.
    */
    if (!projectOwnershipAlreadyApplied) {
      const projectOwnershipSql = await readFile(PROJECT_OWNERSHIP_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(projectOwnershipSql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${PROJECT_OWNERSHIP_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    } else {
      const ownershipGaps = (await tx.execute(sql`
        SELECT n.nspname || '.' || c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN information_schema.columns col
          ON col.table_schema = n.nspname
         AND col.table_name = c.relname
         AND col.column_name = 'project_id'
        WHERE (n.nspname = 'project' OR (n.nspname = 'archive' AND c.relname = 'archived_tasks'))
          AND c.relkind = 'r'
          AND (
            col.column_name IS NULL
            OR NOT c.relrowsecurity
            OR NOT c.relforcerowsecurity
            OR NOT EXISTS (
              SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid AND p.polname = 'fusion_project_isolation'
            )
          )
        ORDER BY c.relname
      `)) as unknown as Array<{ table_name: string }>;
      if (ownershipGaps.length > 0) {
        throw new Error(
          `Project-owned tables are missing required isolation: ${ownershipGaps.map(({ table_name }) => table_name).join(", ")}`,
        );
      }
      const relationalGaps = (await tx.execute(sql`
        SELECT c.conrelid::regclass::text AS object_name, c.conname AS detail
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE (n.nspname = 'project' OR (n.nspname = 'archive' AND t.relname = 'archived_tasks'))
          AND c.contype IN ('p', 'u')
          AND NOT EXISTS (
            SELECT 1 FROM unnest(c.conkey) key_attnum
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
        UNION ALL
        SELECT t.oid::regclass::text, idx.relname
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'project' AND i.indisunique
          AND NOT EXISTS (
            SELECT 1 FROM unnest(i.indkey::smallint[]) key_attnum
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
        UNION ALL
        SELECT c.conrelid::regclass::text, c.conname
        FROM pg_constraint c
        JOIN pg_class child ON child.oid = c.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = c.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE c.contype = 'f' AND child_ns.nspname = 'project' AND parent_ns.nspname = 'project'
          AND (
            NOT EXISTS (
              SELECT 1 FROM unnest(c.conkey) key_attnum
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
              WHERE a.attname = 'project_id'
            ) OR NOT EXISTS (
              SELECT 1 FROM unnest(c.confkey) key_attnum
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key_attnum
              WHERE a.attname = 'project_id'
            )
          )
        ORDER BY 1, 2
      `)) as unknown as Array<{ object_name: string; detail: string }>;
      if (relationalGaps.length > 0) {
        throw new Error(
          `Project-owned keys or relationships are globally scoped: ${relationalGaps.map(({ object_name, detail }) => `${object_name}.${detail}`).join(", ")}`,
        );
      }
    }

    /*
    FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
    Apply SQLite schema parity independently of the original baseline and ownership migration. Existing partial cutover targets must gain all late source columns before the idempotent migration retry rebuilds its table plan.
    */
    if (!sqliteSchemaParityAlreadyApplied) {
      const sqliteSchemaParitySql = await readFile(SQLITE_SCHEMA_PARITY_MIGRATION_PATH, "utf8");
      await tx.execute(sql.raw(sqliteSchemaParitySql));
      await tx.execute(
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SQLITE_SCHEMA_PARITY_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

    return { applied: schemaChanged, pluginHooksRun: pluginHooks.length };
  });
}
