/**
 * Shared Drizzle helpers and conventions for the PostgreSQL schema layer.
 *
 * FNXC:PostgresSchema 2026-06-24-02:20:
 * The three Fusion databases (project, central, archive) are mapped to three
 * PostgreSQL schemas within the same connection target so a single embedded or
 * external instance serves all three with full isolation. This mirrors the
 * SQLite topology where each database was a separate file, while keeping
 * cross-database backup/migration simple (one cluster, three schemas).
 *
 * Schema-name constants are centralized here so every table definition and the
 * migration applier reference the same names. The schema-init hook contract for
 * plugins reads `PROJECT_SCHEMA` so plugin-owned tables land in the right place.
 *
 * SQLite → PostgreSQL type mapping (binding for this migration):
 *   - INTEGER PRIMARY KEY AUTOINCREMENT → integer().generatedAlwaysAsIdentity()
 *     (identity columns give sequence continuity: VAL-SCHEMA-006)
 *   - JSON-encoded TEXT columns → jsonb (round-trip shape parity: VAL-SCHEMA-004)
 *   - BLOB (secrets ciphertext/nonce) → bytea
 *   - INTEGER 0/1 boolean flags → integer (kept as integer to preserve exact
 *     behavior; Drizzle exposes them as integer to avoid silent truthiness drift)
 *   - REAL → real / double precision
 *   - TEXT timestamps → text (ISO-8601 strings, preserved verbatim from SQLite)
 *
 * CHECK constraints, foreign-key cascade rules, and unique indexes are
 * preserved one-for-one from the SQLite source of truth
 * (SCHEMA_SQL / MIGRATION_ONLY_TABLE_SCHEMAS in db.ts, CENTRAL_SCHEMA_SQL,
 * archive BASE_SCHEMA_SQL). See VAL-SCHEMA-002, VAL-SCHEMA-003, VAL-SCHEMA-005.
 */

/** PostgreSQL schema name for the per-project working database. */
export const PROJECT_SCHEMA = "project";
/** PostgreSQL schema name for the global/central coordination database. */
export const CENTRAL_SCHEMA = "central";
/** PostgreSQL schema name for the cold-storage archive database. */
export const ARCHIVE_SCHEMA = "archive";
/** PostgreSQL schema where Drizzle's migration bookkeeping table lives. */
export const DRIZZLE_MIGRATION_SCHEMA = "public";

/**
 * All application schemas, in the order the applier creates them.
 * Plugin-owned tables are materialized separately via the schema-init hook
 * (VAL-SCHEMA-007), so they are not in this constant.
 */
export const APPLICATION_SCHEMAS: readonly string[] = [
  PROJECT_SCHEMA,
  CENTRAL_SCHEMA,
  ARCHIVE_SCHEMA,
] as const;

// ── Custom column types ──────────────────────────────────────────────

/**
 * FNXC:PostgresSchema 2026-06-24-03:25:
 * `bytea` column for PostgreSQL. drizzle-orm does not ship a built-in bytea
 * column, so it is defined via customType. Maps SQLite BLOB
 * (secrets value_ciphertext / nonce) → PostgreSQL bytea.
 */
import { customType } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * FNXC:TaskStoreSearch 2026-06-24-12:00:
 * `tsvector` column type for PostgreSQL full-text search (fts-replacement, U7).
 * Replaces the SQLite FTS5 external-content tables (tasks_fts /
 * archived_tasks_fts). drizzle-orm has no built-in tsvector column, so it is
 * defined via customType. The column data is a JS string representation of the
 * tsvector; it is only ever read for assertion/debugging, never written
 * directly (it is a GENERATED ALWAYS column).
 *
 * The actual generated-column expression and GIN index are declared in
 * project.ts (tasks) and archive.ts (archived_tasks). The 'simple' text-search
 * configuration is used (not a language-specific one) because task text is
 * code-like (task IDs, technical terms) and FTS5 used simple tokenization.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});
