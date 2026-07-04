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

/** The single migration version this applier knows about. */
export const SCHEMA_BASELINE_VERSION = "0000";

/** Bookkeeping table for the fresh Drizzle migration history. */
export const MIGRATION_BOOKKEEPING_TABLE = "fusion_schema_migrations";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_MIGRATION_PATH = join(__dirname, "migrations", "0000_initial.sql");

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
  await ensureBookkeepingTable(db);
  const applied = await getAppliedMigrations(db);
  const alreadyApplied = applied.includes(SCHEMA_BASELINE_VERSION);

  if (!alreadyApplied) {
    const baselineSql = await readBaselineMigrationSql();
    // The baseline contains multiple statements including CREATE SCHEMA, CREATE
    // TABLE, CREATE INDEX, and seed INSERTs. postgres.js executes a single
    // query string as one batch (simple query protocol when unparameterized).
    await db.execute(sql.raw(baselineSql));
    await db.execute(
      sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SCHEMA_BASELINE_VERSION})`,
    );
  }

  // Run plugin schema-init hooks regardless of whether the baseline was just
  // applied or already present — plugin tables must exist on every connection
  // the applier touches. The hooks are themselves idempotent (CREATE TABLE IF
  // NOT EXISTS), so re-running is safe.
  const pluginHooks = options.pluginHooks ?? DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS;
  await runPluginSchemaInitHooks(db, pluginHooks);

  return { applied: !alreadyApplied, pluginHooksRun: pluginHooks.length };
}
