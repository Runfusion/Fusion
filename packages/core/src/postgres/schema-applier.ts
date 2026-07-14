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
export const SCHEMA_BASELINE_VERSION = "0002";
const INITIAL_SCHEMA_VERSION = "0000";
const AUTOMATION_ISOLATION_SCHEMA_VERSION = "0001";

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
    const analyticsIsolationAlreadyApplied = applied.includes(SCHEMA_BASELINE_VERSION);
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
        sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SCHEMA_BASELINE_VERSION}) ON CONFLICT (version) DO NOTHING`,
      );
      schemaChanged = true;
    }

  // Run plugin schema-init hooks regardless of whether the baseline was just
  // applied or already present — plugin tables must exist on every connection
  // the applier touches. The hooks are themselves idempotent (CREATE TABLE IF
  // NOT EXISTS), so re-running is safe.
    const pluginHooks = options.pluginHooks ?? DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS;
    await runPluginSchemaInitHooks(tx, pluginHooks);

    return { applied: schemaChanged, pluginHooksRun: pluginHooks.length };
  });
}
