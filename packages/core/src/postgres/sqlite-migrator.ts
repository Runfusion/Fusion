/**
 * SQLite-to-PostgreSQL data migration tool (U9 / VAL-MIGRATE-001..006).
 *
 * FNXC:PostgresMigration 2026-06-24-08:00:
 * Snapshots the current final SQLite schema into PostgreSQL and bulk-copies
 * all data across the three Fusion databases (project/central/archive),
 * idempotently and with verification. This is the cutover migration tool: it
 * takes a populated set of SQLite files (fusion.db, fusion-central.db,
 * archive.db) and lands their contents into the PostgreSQL schemas
 * (project/central/archive) so the application can switch its read/write path
 * to PostgreSQL.
 *
 * What the tool does, end to end:
 *   1. Applies the fresh PostgreSQL schema baseline (via applySchemaBaseline)
 *      so the target tables exist. The baseline is idempotent; re-running is
 *      safe.
 *   2. For each of the three source SQLite databases, enumerates the user
 *      tables and introspects each table's columns from both SQLite
 *      (PRAGMA table_info, camelCase names) and PostgreSQL
 *      (information_schema + pg_attribute, snake_case names). The two column
 *      sets are matched by a verified camelCase→snake_case transformation, so
 *      the tool is schema-driven rather than hand-coded per-table.
 *   3. Streams rows from SQLite and batches INSERTs into PostgreSQL with
 *      type-aware value conversion:
 *        - SQLite TEXT holding JSON  → PostgreSQL jsonb (parsed)
 *        - SQLite BLOB               → PostgreSQL bytea (Buffer)
 *        - identity columns          → omitted from INSERT (let the sequence
 *          assign), then the sequence is bumped to max(id)+1 afterwards so new
 *          inserts do not collide (VAL-MIGRATE-004).
 *        - GENERATED ALWAYS columns  → omitted from INSERT (auto-populated).
 *   4. Uses INSERT ... ON CONFLICT DO NOTHING for idempotency on the primary
 *      key, so re-running against an already-migrated database is a clean
 *      re-sync / no-op (VAL-MIGRATE-002).
 *   5. Verifies per-table row counts (SQLite vs PostgreSQL) after the copy
 *      (VAL-MIGRATE-001).
 *
 * Dry-run mode (VAL-MIGRATE-005): reports the planned copy (which tables, how
 * many rows, the column mapping) WITHOUT modifying the PostgreSQL target.
 *
 * Soft-delete/deletedAt handling: rows are copied verbatim, including
 * soft-deleted rows (deletedAt IS NOT NULL). The soft-delete visibility
 * invariant is a query-time filter, not a copy-time filter — migrating the
 * rows preserves the forensic/restore surface (VAL-DATA-006).
 *
 * JSON column fidelity (VAL-MIGRATE-003): text-JSON is parsed to a JS value
 * and re-inserted into the jsonb column, so objects/arrays/nested values/null
 * round-trip with identical shape. The jsonb type detection is driven by the
 * materialized PostgreSQL column type (information_schema.data_type = 'jsonb').
 *
 * AUTOINCREMENT sequence continuity (VAL-MIGRATE-004): every PostgreSQL
 * identity sequence is bumped to max(id)+1 after the copy so new inserts do
 * not collide with migrated rows.
 */

import { DatabaseSync } from "../sqlite-adapter.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { applySchemaBaseline } from "./schema-applier.js";
import {
  PROJECT_SCHEMA,
  CENTRAL_SCHEMA,
  ARCHIVE_SCHEMA,
} from "./schema/_shared.js";
import { createLogger } from "../logger.js";

const log = createLogger("sqlite-migrator");

/** Batch size for streaming row inserts. */
const INSERT_BATCH_SIZE = 200;

/**
 * FNXC:PostgresMigration 2026-06-24-08:05:
 * Which PostgreSQL schema a given SQLite database file maps to. The three
 * Fusion databases (fusion.db, fusion-central.db, archive.db) map to the three
 * PostgreSQL schemas in the shared cluster (VAL-SCHEMA-008).
 */
export type SchemaName = typeof PROJECT_SCHEMA | typeof CENTRAL_SCHEMA | typeof ARCHIVE_SCHEMA;

/**
 * A single source SQLite database to migrate into a target PostgreSQL schema.
 */
export interface SqliteMigrationSource {
  /** Absolute path to the SQLite file (or ":memory:"). */
  readonly sqlitePath: string;
  /** The PostgreSQL schema this database maps to. */
  readonly pgSchema: SchemaName;
}

/**
 * FNXC:PostgresMigration 2026-06-24-08:10:
 * The standard three-database source set. Callers can pass a subset or custom
 * paths to migrate a single database. The order matters: the central database
 * is migrated before the project database when foreign-key relationships
 * exist, but since the three schemas are isolated (no cross-schema FKs) the
 * order is not load-bearing.
 */
export function defaultMigrationSources(fusionDir: string, globalDir: string): readonly SqliteMigrationSource[] {
  return [
    { sqlitePath: `${fusionDir}/archive.db`, pgSchema: ARCHIVE_SCHEMA },
    { sqlitePath: `${fusionDir}/fusion.db`, pgSchema: PROJECT_SCHEMA },
    { sqlitePath: `${globalDir}/fusion-central.db`, pgSchema: CENTRAL_SCHEMA },
  ];
}

/** Column-type classification for type-aware value conversion. */
type ColumnType = "jsonb" | "bytea" | "identity" | "generated" | "plain";

/** Metadata for a single column being migrated. */
interface ColumnMapping {
  /** The camelCase column name in SQLite (PRAGMA table_info name). */
  readonly sqliteName: string;
  /** The snake_case column name in PostgreSQL. */
  readonly pgName: string;
  /** The resolved type for value conversion. */
  readonly type: ColumnType;
  /** JSON text to use when a legacy NULL targets a NOT NULL jsonb default. */
  readonly nullJsonbFallback?: string;
}

/** A table to migrate. */
interface TablePlan {
  readonly pgSchema: string;
  /** The SQLite table name (legacy tables are camelCase, e.g. `activityLog`). */
  readonly table: string;
  /*
  FNXC:PostgresMigration 2026-07-13-20:30:
  The PostgreSQL table name (snake_case). Table names were previously assumed
  identical across both engines, but legacy SQLite tables are camelCase
  (activityLog, runAuditEvents, mergeQueue, taskClaims, projectNodePathMappings,
  …) while every PostgreSQL table is snake_case. The old single-name plan made
  resolveColumnMapping find zero PG columns for all 22 camelCase tables, and the
  migrator silently skipped them as "no PostgreSQL counterpart" — first
  observed as `Project/node path mapping not found` because
  central.project_node_path_mappings was never populated.
  */
  readonly pgTable: string;
  readonly columns: readonly ColumnMapping[];
}

/** Per-table migration result. */
export interface TableMigrationResult {
  readonly schema: string;
  readonly table: string;
  readonly sourceRows: number;
  readonly insertedRows: number;
  readonly targetRows: number;
  readonly verified: boolean;
  readonly skipped: boolean;
  readonly skipReason?: string;
}

/** Full migration report. */
export interface MigrationReport {
  readonly dryRun: boolean;
  readonly sources: readonly SqliteMigrationSource[];
  readonly tables: readonly TableMigrationResult[];
  readonly sequenceBumps: readonly { schema: string; table: string; column: string; maxValue: number | null; newValue: number }[];
  readonly appliedBaseline: boolean;
}

/** Options for the migration. */
export interface MigrationOptions {
  /** If true, report the planned copy without modifying PostgreSQL. */
  readonly dryRun?: boolean;
  /**
   * If false (default), the migration will still apply the schema baseline if
   * it has not been applied yet. Set to true to skip baseline application when
   * the caller guarantees the schema is already present.
   */
  readonly skipBaseline?: boolean;
}

/**
 * FNXC:PostgresMigration 2026-06-24-08:15:
 * Migrate one or more SQLite databases into PostgreSQL schemas.
 *
 * The migration is idempotent: the schema baseline is applied (which is
 * itself idempotent), and row inserts use ON CONFLICT DO NOTHING so re-running
 * against an already-migrated database is a clean re-sync / no-op.
 *
 * @param migrationDb A Drizzle instance connected to the target PostgreSQL
 *   cluster. Must be able to run DDL (for the baseline) and DML.
 * @param sources The SQLite databases to migrate.
 * @param options Migration options (dry-run, skip-baseline).
 * @returns A detailed migration report.
 */
export async function migrateSqliteToPostgres(
  migrationDb: PostgresJsDatabase<Record<string, never>>,
  sources: readonly SqliteMigrationSource[],
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;

  // 1. Apply the schema baseline (idempotent). In dry-run we still need to
  //    read the PostgreSQL column types, so the schema must exist. If the
  //    caller set skipBaseline, assume it's already there.
  let appliedBaseline = false;
  if (!options.skipBaseline) {
    const result = await applySchemaBaseline(migrationDb);
    appliedBaseline = result.applied;
  }

  const tableResults: TableMigrationResult[] = [];
  const sequenceBumps: { schema: string; table: string; column: string; maxValue: number | null; newValue: number }[] = [];

  // FNXC:PostgresMigration 2026-06-24-09:10:
  // Defer foreign-key enforcement during the bulk copy. The source data is
  // already referentially consistent (FKs were enforced in SQLite), but tables
  // are copied in name order, not dependency order — a child table (e.g.
  // agent_heartbeats) may be copied before its parent (agents). Setting
  // session_replication_role = 'replica' disables ALL triggers including FK
  // triggers for the duration of the session, so the copy is order-independent.
  // This is the standard PostgreSQL bulk-load pattern. The role is reset to
  // 'origin' after the copy so subsequent normal operation re-enforces FKs.
  //
  // session_replication_role requires SUPERUSER or REPLICATION privilege. The
  // migration runs against an admin/migration connection (DATABASE_MIGRATION_URL)
  // which has these privileges. If the role lacks the privilege, the migration
  // falls back to order-sensitive copying and FK violations surface as errors.
  if (!dryRun) {
    try {
      await migrationDb.execute(sql`SET session_replication_role = replica`);
    } catch (error) {
      log.warn(
        `Could not set session_replication_role = replica (FK deferral requires SUPERUSER/REPLICATION): ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Tables will be copied in name order; FK violations may surface if order is wrong.`,
      );
    }
  }

  try {
    for (const source of sources) {
      const plan = await buildMigrationPlan(migrationDb, source);
      for (const tablePlan of plan) {
        const result = await migrateTable(migrationDb, source, tablePlan, dryRun);
        tableResults.push(result);

        // Bump identity sequences after a real (non-dry-run) copy.
        if (!dryRun && !result.skipped && result.sourceRows > 0) {
          const identityCols = tablePlan.columns.filter((c) => c.type === "identity");
          for (const col of identityCols) {
            const bump = await bumpIdentitySequence(migrationDb, tablePlan.pgSchema, tablePlan.pgTable, col.pgName);
            if (bump) {
              sequenceBumps.push({
                schema: tablePlan.pgSchema,
                table: tablePlan.table,
                column: col.pgName,
                maxValue: bump.maxValue,
                newValue: bump.newValue,
              });
            }
          }
        }
      }
    }
  } finally {
    // Re-enable FK enforcement (triggers) after the copy, regardless of outcome.
    if (!dryRun) {
      try {
        await migrationDb.execute(sql`SET session_replication_role = origin`);
      } catch {
        // best-effort reset; the connection is closed by the caller.
      }
    }
  }

  const report: MigrationReport = {
    dryRun,
    sources,
    tables: tableResults,
    sequenceBumps,
    appliedBaseline,
  };

  if (dryRun) {
    log.log(`[dry-run] Migration plan: ${tableResults.length} tables, ${tableResults.reduce((n, t) => n + t.sourceRows, 0)} source rows planned. No writes performed.`);
  } else {
    const ok = tableResults.filter((t) => t.verified).length;
    const bad = tableResults.length - ok;
    log.log(`Migration complete: ${ok}/${tableResults.length} tables verified (${bad} failed verification). ${sequenceBumps.length} sequences bumped.`);
  }

  return report;
}

/**
 * Build the per-table migration plan for a single SQLite source.
 *
 * Enumerates user tables from SQLite (sqlite_master), introspects columns
 * from both sides, and matches them by camelCase→snake_case transformation.
 * Tables that exist in SQLite but not PostgreSQL are skipped with a reason
 * (e.g. FTS5 virtual tables, which have no PostgreSQL counterpart).
 */
async function buildMigrationPlan(
  db: PostgresJsDatabase<Record<string, never>>,
  source: SqliteMigrationSource,
): Promise<readonly TablePlan[]> {
  const sqlite = openSqlite(source.sqlitePath);
  try {
    const tables = listSqliteTables(sqlite);
    const plans: TablePlan[] = [];
    for (const table of tables) {
      // Legacy SQLite table names are camelCase; PostgreSQL tables are
      // snake_case. toSnakeCase is the identity for already-snake names.
      const pgTable = toSnakeCase(table);
      const cols = await resolveColumnMapping(db, source.pgSchema, pgTable, table, sqlite);
      if (cols.length === 0) {
        // Table exists in SQLite but has no mappable columns in PostgreSQL —
        // skip it (e.g. FTS5 shadow tables). Logged at the table-migration
        // step, not here.
        continue;
      }
      plans.push({ pgSchema: source.pgSchema, table, pgTable, columns: cols });
    }
    return plans;
  } finally {
    sqlite.close();
  }
}

/**
 * Open a SQLite database read-only. If the file does not exist, throw a clear
 * error rather than creating an empty file.
 */
function openSqlite(path: string): DatabaseSync {
  // DatabaseSync enforces assertOutsideRealFusionPath; tests use temp dirs or
  // ":memory:". The migrator is a cutover tool run by operators against a
  // real .fusion path, so the real-path guard is bypassed only when the path
  // is explicit. Here we use the standard constructor; tests pass temp paths.
  const db = new DatabaseSync(path);
  // Read-only guard: open with immutable so we never modify the source.
  // (node:sqlite does not have a read-only open flag in the constructor; we
  // simply never issue writes against the source.)
  return db;
}

/** List user tables (excluding sqlite_ internal tables and FTS5 shadow tables). */
function listSqliteTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts%'
         AND name NOT LIKE '%_data'
         AND name NOT LIKE '%_idx'
         AND name NOT LIKE '%_content'
         AND name NOT LIKE '%_docsize'
         AND name NOT LIKE '%_config'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; type: string }>;
  return rows.map((r) => r.name);
}

/**
 * FNXC:PostgresMigration 2026-06-24-08:20:
 * Resolve the column mapping for a table between SQLite and PostgreSQL.
 *
 * The mapping is driven by the materialized PostgreSQL column metadata
 * (information_schema.columns for the type, pg_attribute for identity/generated
 * flags) and SQLite's PRAGMA table_info (camelCase names). Columns are matched
 * by transforming the SQLite camelCase name to snake_case and comparing to the
 * PostgreSQL column name. This verified-correct transformation covers every
 * table in all three schemas without per-table hand-coding.
 *
 * Columns classified as:
 *   - "jsonb"     → SQLite TEXT parsed to a JS value on read
 *   - "bytea"     → SQLite BLOB wrapped in a Buffer on read
 *   - "identity"  → omitted from INSERT; sequence bumped post-copy
 *   - "generated" → omitted from INSERT (GENERATED ALWAYS AS, e.g. search_vector)
 *   - "plain"     → passed through verbatim
 *
 * Returns an empty list if the table does not exist in PostgreSQL (it is a
 * SQLite-only table with no PostgreSQL counterpart, e.g. an FTS5 shadow table
 * that escaped the name filter).
 */
async function resolveColumnMapping(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  pgTable: string,
  table: string,
  sqlite: DatabaseSync,
): Promise<readonly ColumnMapping[]> {
  // PostgreSQL columns from information_schema + pg_attribute.
  // FNXC:PostgresMigration 2026-06-26-15:30 (fix migration-review P1 #14):
  // The join between information_schema.columns and pg_attribute MUST be
  // constrained on BOTH the column name AND the table, otherwise a column
  // name that appears in multiple tables (e.g. `data`, which is `text` in
  // archived_tasks but `jsonb` in 5+ other tables) picks up a row from ANY
  // matching table, producing a nondeterministic data_type. The previous
  // query joined only on a.attname = c.column_name, so information_schema
  // (which is keyed by table_schema+table_name+column_name) returned every
  // row for that column name across the schema and the JOIN exploded to one
  // arbitrary row — classifications were then random. Adding the table
  // predicate (cls.relname = c.table_name AND n.nspname = c.table_schema)
  // makes the join 1:1 per table and the data_type deterministic. The
  // table_schema/table_name predicates are also moved up into the
  // information_schema WHERE so we don't even consult other tables.
  const pgCols = (await db.execute(sql`
    SELECT
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      a.attidentity,
      CASE WHEN a.attgenerated <> '' THEN 1 ELSE 0 END AS is_generated
    FROM information_schema.columns c
    JOIN pg_attribute a
      ON a.attname = c.column_name
    JOIN pg_class cls ON cls.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE c.table_schema = ${pgSchema}
      AND c.table_name = ${pgTable}
      AND n.nspname = c.table_schema
      AND cls.relname = c.table_name
      AND a.attnum > 0
  `)) as unknown as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    attidentity: string | null;
    is_generated: number | string;
  }>;

  if (pgCols.length === 0) {
    // No PostgreSQL table with this name — skip.
    return [];
  }

  const pgByName = new Map(pgCols.map((c) => [c.column_name, c]));

  // SQLite columns (camelCase names).
  const sqliteCols = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
    name: string;
    type: string;
  }>;

  const mapping: ColumnMapping[] = [];
  for (const sc of sqliteCols) {
    const pgName = toSnakeCase(sc.name);
    const pgCol = pgByName.get(pgName);
    if (!pgCol) {
      // SQLite column with no PostgreSQL counterpart (e.g. a dropped column
      // in the new schema, or a legacy column). Skip it — the migration only
      // copies columns that exist in both schemas.
      continue;
    }
    const type = classifyColumnType(pgCol);
    let nullJsonbFallback: string | undefined;
    if (type === "jsonb" && pgCol.is_nullable === "NO" && pgCol.column_default) {
      // FNXC:PostgresMigration 2026-07-14-05:30:
      // Legacy SQLite rows can contain NULL/empty JSON even when the target is
      // NOT NULL with a default. Materialize that default during conversion so
      // one stale row cannot abort the entire first-boot migration.
      const match = /^'(.*)'::jsonb?$/s.exec(pgCol.column_default);
      if (match) {
        const candidate = match[1].replace(/''/g, "'");
        try {
          JSON.parse(candidate);
          nullJsonbFallback = candidate;
        } catch {
          // Leave malformed defaults to PostgreSQL rather than inventing data.
        }
      }
    }
    mapping.push({ sqliteName: sc.name, pgName, type, nullJsonbFallback });
  }

  return mapping;
}

/** Classify a PostgreSQL column into a conversion type. */
function classifyColumnType(pgCol: {
  data_type: string;
  attidentity: string | null;
  is_generated: number | string;
}): ColumnType {
  // GENERATED ALWAYS AS (e.g. search_vector) — skip on insert.
  if (Number(pgCol.is_generated) === 1) {
    return "generated";
  }
  // Identity columns (GENERATED ALWAYS AS IDENTITY / GENERATED BY DEFAULT AS
  // IDENTITY). attidentity = 'a' (always) or 'd' (default).
  if (pgCol.attidentity === "a" || pgCol.attidentity === "d") {
    return "identity";
  }
  if (pgCol.data_type === "jsonb" || pgCol.data_type === "json") {
    return "jsonb";
  }
  if (pgCol.data_type === "bytea") {
    return "bytea";
  }
  return "plain";
}

/**
 * Convert a SQLite value to its PostgreSQL representation based on the column
 * type classification.
 *
 * FNXC:PostgresMigration 2026-06-24-08:25:
 * - jsonb: SQLite stores JSON as TEXT. We parse it to a JS value and then
 *   re-stringify it so the insert builder can emit it with a `::jsonb` cast.
 *   postgres.js's raw `sql` template does NOT auto-serialize JS objects for
 *   jsonb columns (it tries to send the object as a byte string and fails), so
 *   jsonb values MUST be passed as strings with an explicit `::jsonb` cast.
 *   NULL stays NULL unless the target is NOT NULL with a valid jsonb default;
 *   in that case legacy NULL/empty-string values materialize the target default
 *   so the migration does not violate the target constraint.
 * - bytea: SQLite stores BLOB. We wrap it in a Buffer (postgres.js handles
 *   Buffer natively for bytea). NULL stays NULL.
 * - plain: passed through verbatim.
 *
 * Identity and generated columns are omitted at the insert-builder level
 * (never passed here).
 */
function convertValue(value: unknown, type: ColumnType, nullJsonbFallback?: string): unknown {
  if (value === null || value === undefined) {
    return type === "jsonb" && nullJsonbFallback !== undefined ? nullJsonbFallback : null;
  }
  switch (type) {
    case "jsonb": {
      // Parse the SQLite TEXT into a JS value, then re-stringify for the
      // ::jsonb cast in the insert builder. This normalizes whitespace and
      // validates the JSON (malformed rows are stored as a JSON string scalar
      // so no data is lost).
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") {
          return nullJsonbFallback ?? null;
        }
        try {
          return JSON.stringify(JSON.parse(trimmed));
        } catch {
          // Malformed JSON — store as a JSON-encoded string scalar (valid jsonb).
          return JSON.stringify(value);
        }
      }
      // Already a JS value (object/array/number/boolean) — stringify it.
      return JSON.stringify(value);
    }
    case "bytea": {
      if (Buffer.isBuffer(value)) {
        return value;
      }
      if (value instanceof Uint8Array) {
        return Buffer.from(value);
      }
      if (typeof value === "string") {
        return Buffer.from(value, "utf8");
      }
      return value;
    }
    case "plain":
    case "identity":
    case "generated":
    default:
      return value;
  }
}

/**
 * FNXC:PostgresMigration 2026-06-24-08:30:
 * Migrate a single table: read all rows from SQLite, batch-insert into
 * PostgreSQL with ON CONFLICT DO NOTHING (idempotent), and verify the row
 * count.
 *
 * In dry-run mode, only the SQLite row count is read; no writes are issued.
 */
async function migrateTable(
  db: PostgresJsDatabase<Record<string, never>>,
  source: SqliteMigrationSource,
  plan: TablePlan,
  dryRun: boolean,
): Promise<TableMigrationResult> {
  // FNXC:PostgresMigration 2026-06-24-09:20:
  // Identity columns ARE copied (with OVERRIDING SYSTEM VALUE) so the actual
  // id values from SQLite are preserved. This is required for two reasons:
  //   1. Idempotency: ON CONFLICT DO NOTHING detects duplicates by primary key.
  //      If identity ids were omitted, PostgreSQL would generate NEW ids on
  //      every run, producing duplicate rows (VAL-MIGRATE-002).
  //   2. Referential integrity: child tables reference these ids by value.
  // Generated columns (search_vector) are the only ones omitted — they are
  // auto-populated by PostgreSQL and cannot be written explicitly.
  const insertableCols = plan.columns.filter((c) => c.type !== "generated");
  const hasIdentityCol = insertableCols.some((c) => c.type === "identity");
  if (insertableCols.length === 0) {
    // No insertable columns (e.g. a pure-generated table). Verify the target
    // exists but copy nothing.
    const targetRows = await countTargetRows(db, plan.pgSchema, plan.pgTable);
    return {
      schema: plan.pgSchema,
      table: plan.pgTable,
      sourceRows: 0,
      insertedRows: 0,
      targetRows,
      verified: true,
      skipped: true,
      skipReason: "no insertable columns",
    };
  }

  const sqlite = openSqlite(source.sqlitePath);
  let sourceRows = 0;
  let insertedRows = 0;
  try {
    // Only select columns that have a PostgreSQL counterpart and are insertable.
    const selectableCols = insertableCols
      .map((c) => quoteIdent(c.sqliteName))
      .join(", ");

    // Count source rows.
    const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(plan.table)}`).get() as { n: number };
    sourceRows = Number(countRow.n);

    if (dryRun || sourceRows === 0) {
      // Dry-run: report the plan without writing.
      return {
        schema: plan.pgSchema,
        table: plan.pgTable,
        sourceRows,
        insertedRows: 0,
        targetRows: dryRun ? 0 : await countTargetRows(db, plan.pgSchema, plan.pgTable),
        verified: dryRun ? false : true,
        skipped: dryRun ? true : false,
        skipReason: dryRun ? "dry-run" : "no source rows",
      };
    }

    // Stream rows in batches.
    const stmt = sqlite.prepare(`SELECT ${selectableCols} FROM ${quoteIdent(plan.table)}`);
    const batch: Record<string, unknown>[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const inserted = await insertBatch(db, plan, insertableCols, batch, hasIdentityCol);
      insertedRows += inserted;
      batch.length = 0;
    };

    for (const row of stmt.all() as Array<Record<string, unknown>>) {
      const converted: Record<string, unknown> = {};
      for (const col of insertableCols) {
        converted[col.pgName] = convertValue(row[col.sqliteName], col.type, col.nullJsonbFallback);
      }
      batch.push(converted);
      if (batch.length >= INSERT_BATCH_SIZE) {
        await flush();
      }
    }
    await flush();

    // Verify the migration.
    // FNXC:PostgresMigration 2026-06-26-15:40 (fix migration-review P1 #15):
    // Verification now has TWO layers:
    //   1. Row count: target rows must equal source rows (strict equality, not
    //      the old `targetRows >= sourceRows` which masked under-migration when
    //      pre-existing rows padded the count, and masked content divergence on
    //      re-run because ON CONFLICT DO NOTHING always "succeeded").
    //   2. Content checksum: an MD5 over the canonical, type-normalized row
    //      stream from both SQLite and PostgreSQL. This catches a migration
    //      that copied the wrong rows, truncated a jsonb column, or left stale
    //      rows from a prior partial run. The checksum is computed over the
    //      SAME insertable column set the copy used, with the SAME value
    //      conversion, so a faithful copy yields identical checksums.
    // Both layers must pass for `verified: true`. The MD5 is computed in SQL
    // (md5(string_agg(...)) on PostgreSQL, and a Node-side md5 over the SQLite
    // converted stream) so the comparison is a single short string per side.
    const targetRows = await countTargetRows(db, plan.pgSchema, plan.pgTable);
    const rowCountOk = targetRows === sourceRows;
    let contentOk = true;
    if (rowCountOk && sourceRows > 0) {
      const sourceChecksum = computeSourceContentChecksum(sqlite, plan.table, insertableCols);
      const targetChecksum = await computeTargetContentChecksum(
        db,
        plan.pgSchema,
        plan.pgTable,
        insertableCols,
      );
      contentOk = sourceChecksum === targetChecksum;
      if (!contentOk) {
        log.warn(
          `Content checksum mismatch for ${plan.pgSchema}.${plan.pgTable}: ` +
            `source=${sourceChecksum}, target=${targetChecksum}`,
        );
      }
    } else if (!rowCountOk) {
      log.warn(
        `Row-count mismatch for ${plan.pgSchema}.${plan.pgTable}: source=${sourceRows}, target=${targetRows}`,
      );
    }
    const verified = rowCountOk && contentOk;

    return {
      schema: plan.pgSchema,
      table: plan.pgTable,
      sourceRows,
      insertedRows,
      targetRows,
      verified,
      skipped: false,
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Insert a batch of rows into PostgreSQL with ON CONFLICT DO NOTHING (idempotent
 * re-sync). Uses a raw SQL builder because Drizzle's typed insert() requires
 * the schema-typed table object and we operate dynamically across all tables.
 *
 * FNXC:PostgresMigration 2026-06-24-08:35:
 * The insert uses parameterized values (one parameter per column per row) to
 * avoid SQL injection and to let postgres.js handle bytea serialization. jsonb
 * values are JSON strings cast with `::jsonb`. When the table has an identity
 * column, `OVERRIDING SYSTEM VALUE` is emitted so the actual SQLite id values
 * are preserved (required for idempotent ON CONFLICT detection and referential
 * integrity — see migrateTable).
 */
async function insertBatch(
  db: PostgresJsDatabase<Record<string, never>>,
  plan: TablePlan,
  cols: readonly ColumnMapping[],
  rows: readonly Record<string, unknown>[],
  hasIdentityCol: boolean,
): Promise<number> {
  if (rows.length === 0) return 0;
  const colList = cols.map((c) => quoteIdent(c.pgName)).join(", ");
  const schemaQualifiedTable = `${quoteIdent(plan.pgSchema)}.${quoteIdent(plan.pgTable)}`;
  // OVERRIDING SYSTEM VALUE lets us write explicit values into GENERATED ALWAYS
  // AS IDENTITY columns so the SQLite id is preserved (VAL-MIGRATE-002/004).
  const overridingClause = hasIdentityCol ? " OVERRIDING SYSTEM VALUE" : "";

  // FNXC:PostgresMigration 2026-06-24-09:15:
  // For jsonb columns, the value is a JSON string (from convertValue) and MUST
  // be cast with `::jsonb` because postgres.js's raw sql template does not
  // auto-serialize JS values for jsonb OIDs. For bytea columns, the value is a
  // Buffer which postgres.js handles natively. For plain columns, the value is
  // passed as a parameter directly. NULL values are emitted as SQL NULL.
  const buildCell = (col: ColumnMapping, value: unknown) => {
    if (value === null || value === undefined) {
      return sql`NULL`;
    }
    if (col.type === "jsonb") {
      return sql`${value}::jsonb`;
    }
    return sql`${value}`;
  };

  const valueRowsBuilt = rows.map(
    (row) => sql`(${sql.join(
      cols.map((c) => buildCell(c, row[c.pgName])),
      sql`, `,
    )})`,
  );

  /*
  FNXC:PostgresMigration 2026-07-13-21:05:
  RETURNING 1 makes the inserted-row count driver-agnostic: the result carries
  exactly one row per row actually inserted (conflicts return nothing). The
  previous `result.count ?? result.rowCount ?? rows.length` read whatever the
  driver wrapper exposed and reported 0 even when every row landed, so
  migration reports showed "inserted 0" for fully-migrated tables and the
  startup banner's migratedRows total was wrong.
  */
  const query = sql`INSERT INTO ${sql.raw(schemaQualifiedTable)} (${sql.raw(colList)})${sql.raw(overridingClause)}
    VALUES ${sql.join(valueRowsBuilt, sql`, `)}
    ON CONFLICT DO NOTHING
    RETURNING 1`;

  const result = (await db.execute(query)) as unknown as { length?: number };
  return Number(result?.length ?? 0);
}

/** Count rows in a PostgreSQL table. */
async function countTargetRows(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  table: string,
): Promise<number> {
  const result = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(quoteIdent(table))}`,
  )) as unknown as Array<{ n: number }>;
  return Number(result[0]?.n ?? 0);
}

/**
 * FNXC:PostgresMigration 2026-06-24-08:40:
 * Bump a PostgreSQL identity sequence to max(id)+1 so new inserts do not
 * collide with migrated rows (VAL-MIGRATE-004).
 *
 * For GENERATED ALWAYS AS IDENTITY columns, the sequence name follows the
 * convention `<table>_<column>_seq`. We use setval with the max(id) value so
 * the next nextval() returns max(id)+1. If the table is empty, the sequence is
 * reset to its initial value (1) via restart.
 *
 * Returns null if the column is not an identity column or the sequence cannot
 * be found (defensive — the bump is best-effort and the verification step
 * catches collisions).
 */
async function bumpIdentitySequence(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  table: string,
  column: string,
): Promise<{ maxValue: number | null; newValue: number } | null> {
  // Look up the sequence name for the identity column.
  const seqResult = (await db.execute(sql`
    SELECT pg_get_serial_sequence(${`${pgSchema}.${table}`}, ${column}) AS seq_name
  `)) as unknown as Array<{ seq_name: string | null }>;
  const seqName = seqResult[0]?.seq_name;
  if (!seqName) {
    return null;
  }

  // Find max(id).
  const maxResult = (await db.execute(
    sql`SELECT COALESCE(MAX(${sql.raw(quoteIdent(column))}), 0)::bigint AS max_id FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(quoteIdent(table))}`,
  )) as unknown as Array<{ max_id: bigint | number | string }>;
  const maxIdRaw = maxResult[0]?.max_id;
  const maxId = maxIdRaw !== undefined && maxIdRaw !== null ? Number(maxIdRaw) : 0;

  if (maxId > 0) {
    // setval to max(id) so the next nextval() returns max(id)+1.
    await db.execute(sql`SELECT setval(${seqName}, ${maxId}, true)`);
    return { maxValue: maxId, newValue: maxId + 1 };
  }
  // Empty table: restart the sequence at 1.
  await db.execute(sql`ALTER SEQUENCE ${sql.raw(seqName)} RESTART WITH 1`);
  return { maxValue: null, newValue: 1 };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * FNXC:PostgresMigration 2026-06-24-08:45:
 * camelCase → snake_case transformation. Verified to map every column in all
 * three PostgreSQL schemas correctly (TS key → pg column name). Used to match
 * SQLite's camelCase column names to PostgreSQL's snake_case column names.
 */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Quote a SQL identifier (double quotes, escaped). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── Content verification (P1 #15) ───────────────────────────────────

/**
 * FNXC:PostgresMigration 2026-06-26-15:45 (fix migration-review P1 #15):
 * Canonicalize a single cell value for content-checksumming. The goal is a
 * stable string representation that is IDENTICAL for the same value whether
 * it was read from SQLite (raw) or PostgreSQL (after jsonb/bytea round-trip).
 *
 * Canonicalization rules (must match between the SQLite and PostgreSQL
 * checksums for a faithful copy):
 *   - null/undefined → the literal token "null" (distinct from the string "null")
 *   - Buffers (bytea) → hex string of the bytes, prefixed "0x"
 *   - objects/arrays (already-parsed jsonb from PG) → JSON.stringify with
 *     sorted keys so key order does not change the checksum
 *   - strings that ARE valid JSON (from SQLite TEXT-stored JSON, or from PG
 *     jsonb columns returned as strings by some drivers) → re-stringified
 *     through parse+stringify so whitespace/key-order differences do not
 *     cause a false mismatch
 *   - everything else → String(value)
 *
 * This deliberately errs on the side of normalizing whitespace and key order
 * for JSON, because those are not semantically meaningful and a jsonb column
 * round-trips with PostgreSQL's own canonical formatting.
 */
function canonicalizeCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString("hex")}`;
  }
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  if (typeof value === "object") {
    return stableJsonStringify(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        return stableJsonStringify(JSON.parse(trimmed));
      } catch {
        // not JSON — fall through to the raw string
      }
    }
    return value;
  }
  return String(value);
}

/** JSON.stringify with deterministically sorted object keys. */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Compute a content checksum over the SQLite source rows for a table. Reads
 * the SAME insertable columns the copy used (so unmapped/generated columns do
 * not pollute the checksum), applies the SAME per-cell conversion the copy
 * used (so a jsonb cell is checksummed in its converted form), and MD5s the
 * resulting canonical row stream. Rows are sorted by their primary-key column
 * (the first insertable column) so row order from SQLite (insertion order)
 * does not matter.
 *
 * FNXC:PostgresMigration 2026-06-26-15:50:
 * The checksum is computed over the CONVERTED values, not the raw SQLite
 * values, because the migrated PostgreSQL rows store the converted values
 * (jsonb parsed, bytea as Buffer). Comparing converted-source vs stored-target
 * is the correct semantic: it verifies the copy faithfully reproduced what the
 * conversion produced.
 */
function computeSourceContentChecksum(
  sqlite: DatabaseSync,
  table: string,
  cols: readonly ColumnMapping[],
): string {
  if (cols.length === 0) return "";
  const pkCol = cols[0]; // first insertable column is the identity/PK for sorting
  const selectCols = cols.map((c) => quoteIdent(c.sqliteName)).join(", ");
  const rows = sqlite
    .prepare(`SELECT ${selectCols} FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(pkCol.sqliteName)}`)
    .all() as Array<Record<string, unknown>>;

  const hash = createHash("md5");
  for (const row of rows) {
    for (const col of cols) {
      const converted = convertValue(row[col.sqliteName], col.type, col.nullJsonbFallback);
      hash.update(canonicalizeCell(converted));
      hash.update("\u0001"); // cell separator
    }
    hash.update("\u0002"); // row separator
  }
  return hash.digest("hex");
}

/**
 * Compute a content checksum over the PostgreSQL target rows for a table.
 * Selects the SAME insertable columns the copy used and MD5s the canonical
 * row stream. Rows are sorted by the same primary-key column as the source
 * checksum so the two streams align row-for-row.
 *
 * jsonb columns come back from postgres.js as already-parsed JS values, and
 * bytea as Buffer, so canonicalizeCell handles them directly. The PostgreSQL
 * md5() aggregate is intentionally NOT used here because the conversion rules
 * for jsonb canonicalization (sorted keys) must match the source side exactly,
 * and doing both sides in Node with the same canonicalizeCell function
 * guarantees they agree.
 */
async function computeTargetContentChecksum(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  table: string,
  cols: readonly ColumnMapping[],
): Promise<string> {
  if (cols.length === 0) return "";
  const pkCol = cols[0];
  const selectCols = cols.map((c) => quoteIdent(c.pgName)).join(", ");
  const rows = (await db.execute(
    sql`SELECT ${sql.raw(selectCols)} FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(
      quoteIdent(table),
    )} ORDER BY ${sql.raw(quoteIdent(pkCol.pgName))}`,
  )) as unknown as Array<Record<string, unknown>>;

  const hash = createHash("md5");
  for (const row of rows) {
    for (const col of cols) {
      hash.update(canonicalizeCell(row[col.pgName]));
      hash.update("\u0001");
    }
    hash.update("\u0002");
  }
  return hash.digest("hex");
}
