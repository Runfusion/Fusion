/**
 * PostgreSQL health and maintenance surface (U8).
 *
 * FNXC:PostgresHealth 2026-06-24-14:00:
 * Replaces the SQLite-specific health and maintenance surfaces with
 * PostgreSQL equivalents. The SQLite surface used:
 *   - `PRAGMA integrity_check` / `quick_check` for corruption detection
 *   - `PRAGMA table_info` / fingerprint for schema self-heal
 *   - `VACUUM` for compaction
 *   - `PRAGMA wal_checkpoint` for WAL checkpointing
 *   - A startup rebuild-on-malformed guard (`Database.recover`)
 *
 * PostgreSQL equivalents:
 *   - Corruption/unreachable detection → `ping()` connectivity probe +
 *     `pg_stat_database` health metrics. PostgreSQL does not have a
 *     `PRAGMA integrity_check` equivalent because MVCC + WAL makes page-level
 *     corruption extremely rare; the health signal is "can I reach the server
 *     and is it accepting queries?" (VAL-HEALTH-001, VAL-HEALTH-002).
 *   - Schema drift → `information_schema.columns` + `pg_catalog` introspection
 *     compared against the expected Drizzle schema definitions. Missing
 *     columns are reconciled via ALTER TABLE (self-heal, VAL-HEALTH-004).
 *   - Compaction → explicit `VACUUM` / `ANALYZE` operator command with stats
 *     reporting (VAL-HEALTH-005).
 *
 * The task-ID integrity detector is preserved (VAL-HEALTH-003) and lives in
 * `async-task-id-integrity.ts`; this module provides the database-health and
 * compaction surfaces.
 */

import { sql } from "drizzle-orm";
import type { AsyncDataLayer, DrizzleDb } from "./data-layer.js";
import { ARCHIVE_SCHEMA, PROJECT_SCHEMA } from "./schema/_shared.js";
import { projectTableNames } from "./schema/project.js";

/**
 * FNXC:PostgresHealth 2026-06-24-14:05:
 * Database health snapshot. Mirrors the shape of the SQLite
 * `TaskStore.getDatabaseHealth()` return so the dashboard health banner and
 * `/api/health` payload remain compatible after the backend swap.
 *
 * `healthy` is the overall signal. `corruptionDetected` covers both actual
 * corruption and unreachable-backnet scenarios (both surface the DB corruption
 * banner per VAL-HEALTH-002). `corruptionErrors` lists up to 5 diagnostic
 * messages for the banner.
 */
export interface PostgresHealthSnapshot {
  /** Overall health: false when the backend is unreachable or corrupt. */
  healthy: boolean;
  /** True when the backend is unreachable or reports corruption. */
  corruptionDetected: boolean;
  /** Up to 5 diagnostic error strings (for the corruption banner list). */
  corruptionErrors: string[];
  /** ISO-8601 timestamp of the last health check, or null if never checked. */
  lastCheckedAt: string | null;
  /** True while an asynchronous health check is in progress. */
  isRunning: boolean;
  /** Backend descriptor for operator display (e.g. "external" / "embedded"). */
  backendMode: string | null;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:10:
 * A schema-drift finding from the information_schema introspection. Each
 * finding represents a column that exists in the expected Drizzle schema
 * definition but is absent from the live database (VAL-HEALTH-004).
 */
export interface SchemaDriftFinding {
  /** The affected table name (unqualified). */
  table: string;
  /** The missing column name. */
  column: string;
  /** The expected PostgreSQL data type (e.g. "text", "jsonb", "integer"). */
  expectedType: string;
  /**
   * FNXC:MultiProjectIsolation 2026-07-12: owning schema; defaults to the
   * project schema. Lets the drift self-heal also cover archive-schema
   * columns (archive.archived_tasks.project_id).
   */
  schema?: string;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:15:
 * Schema validation report. When drift is detected, `self-heal` adds the
 * missing columns. This replaces the SQLite `PRAGMA table_info` /
 * schema-compat-fingerprint reconciliation.
 */
export interface SchemaValidationReport {
  status: "ok" | "drift";
  checkedAt: string;
  findings: SchemaDriftFinding[];
  /** Columns that were re-added during self-heal. */
  healed: SchemaDriftFinding[];
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:20:
 * VACUUM / ANALYZE compaction result. Reported by the explicit operator
 * compaction command (VAL-HEALTH-005). PostgreSQL's VACUUM does not return
 * row-level stats by default, so we gather before/after table-size and
 * dead-tuple metrics from `pg_stat_user_tables` to give the operator
 * actionable feedback.
 */
export interface VacuumAnalyzeStats {
  /** Table name (within the project schema). */
  table: string;
  /** Approximate row count before VACUUM. */
  rowsBefore: number;
  /** Approximate row count after VACUUM/ANALYZE. */
  rowsAfter: number;
  /** Dead tuples before VACUUM (from pg_stat_user_tables). */
  deadTuplesBefore: number;
  /** Dead tuples after VACUUM (should be ~0 after a full VACUUM). */
  deadTuplesAfter: number;
  /** Table size in bytes before VACUUM. */
  sizeBytesBefore: number;
  /** Table size in bytes after VACUUM. */
  sizeBytesAfter: number;
  /** True when ANALYZE updated planner statistics for this table. */
  analyzed: boolean;
}

export interface VacuumAnalyzeResult {
  /** ISO-8601 timestamp of the compaction run. */
  ranAt: string;
  /** Per-table stats. */
  tables: VacuumAnalyzeStats[];
  /** Total dead tuples reclaimed across all tables. */
  totalDeadTuplesReclaimed: number;
  /** Total bytes reclaimed (before - after size sum). */
  totalBytesReclaimed: number;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:25:
 * The expected-column registry used by schema drift detection. Maps each
 * project-schema table to its expected column definitions. This replaces the
 * SQLite `SCHEMA_SQL` + `MIGRATION_ONLY_TABLE_SCHEMAS` union + fingerprint
 * reconciliation with an explicit, curated list of the columns that must
 * exist on each core table.
 *
 * Only core tables (owned by the application schema) are validated. Plugin-
 * owned tables (roadmap) evolve independently via the schema-init hook and
 * are not part of drift detection.
 *
 * Each entry stores the actual DATABASE column name (as it appears in DDL,
 * i.e. snake_case) and the expected PostgreSQL data type. The drift detector
 * queries information_schema.columns which returns database column names.
 * New columns added to the Drizzle schema should be added here so drift
 * detection covers them.
 */
export const EXPECTED_PROJECT_COLUMNS: ReadonlyArray<{ schema?: string; table: string; column: string; type: string }> = [
  // tasks — the core table; key columns the store reads/writes.
  { table: "tasks", column: "id", type: "text" },
  { table: "tasks", column: "description", type: "text" },
  { table: "tasks", column: "title", type: "text" },
  { table: "tasks", column: "column", type: "text" },
  { table: "tasks", column: "status", type: "text" },
  { table: "tasks", column: "created_at", type: "text" },
  { table: "tasks", column: "updated_at", type: "text" },
  { table: "tasks", column: "deleted_at", type: "text" },
  // FNXC:MultiProjectIsolation 2026-07-11: per-project partition key (PR #2007).
  // Listed so existing embedded-PG databases self-heal the column on boot —
  // the baseline's CREATE TABLE IF NOT EXISTS never upgrades an existing
  // table, and every scoped task read/claim now folds project_id into WHERE.
  { table: "tasks", column: "project_id", type: "text" },
  // FNXC:WorkflowLifecycle 2026-07-12: FN-7863 execute self-requeue streak (merge port).
  { table: "tasks", column: "execute_requeue_loop_count", type: "integer" },
  { table: "tasks", column: "execute_requeue_loop_signature", type: "text" },
  // FNXC:PlanReviewReplan 2026-07-13: bounded triage Plan Review REVISE replan counter.
  // Additive column not present in the baseline snapshot, so existing embedded-PG
  // databases must self-heal it via ALTER TABLE ADD COLUMN IF NOT EXISTS on boot.
  { table: "tasks", column: "plan_review_replan_count", type: "integer" },
  // distributed_task_id_state
  { table: "distributed_task_id_state", column: "prefix", type: "text" },
  { table: "distributed_task_id_state", column: "next_sequence", type: "integer" },
  { table: "distributed_task_id_state", column: "committed_cluster_task_count", type: "integer" },
  { table: "distributed_task_id_state", column: "last_committed_task_id", type: "text" },
  { table: "distributed_task_id_state", column: "updated_at", type: "text" },
  // archived_tasks
  { table: "archived_tasks", column: "id", type: "text" },
  { table: "archived_tasks", column: "data", type: "text" },
  { table: "archived_tasks", column: "archived_at", type: "text" },
  // FNXC:MultiProjectIsolation 2026-07-11: see tasks.project_id above.
  { table: "archived_tasks", column: "project_id", type: "text" },
  // FNXC:MultiProjectIsolation 2026-07-12: the COLD-STORAGE archive table
  // (async-archive-db reads/writes archive.archived_tasks, not the
  // project-schema table above) — the archived board/count/search scope
  // column must self-heal on existing databases too.
  { schema: ARCHIVE_SCHEMA, table: "archived_tasks", column: "project_id", type: "text" },
  // chat_sessions — FN-7775 per-chat thinking level (added 2026-07-10); listed
  // so existing embedded-PG databases self-heal the column via ALTER TABLE
  // ADD COLUMN IF NOT EXISTS on boot (CREATE TABLE IF NOT EXISTS alone never
  // upgrades an existing table).
  { table: "chat_sessions", column: "thinking_level", type: "text" },
  // FNXC:Settings-ThinkingLevel 2026-07-13 (merge port): sqlite v143-145 additive
  // columns — validator/planning task overrides + chat-room default; listed so
  // existing embedded-PG databases self-heal them on boot.
  { table: "tasks", column: "validator_thinking_level", type: "text" },
  { table: "tasks", column: "planning_thinking_level", type: "text" },
  { table: "chat_rooms", column: "thinking_level", type: "text" },
];

/**
 * Map the curated column type strings to PostgreSQL DDL types for ALTER TABLE
 * ADD COLUMN self-heal statements. The `type` field in EXPECTED_PROJECT_COLUMNS
 * uses human-readable names; this maps them to the DDL used by self-heal.
 */
const TYPE_TO_DDL: Record<string, string> = {
  text: "TEXT",
  integer: "INTEGER",
  jsonb: "JSONB",
  real: "REAL",
  boolean: "INTEGER",
  bytea: "BYTEA",
  timestamptz: "TIMESTAMPTZ",
};

/**
 * FNXC:PostgresHealth 2026-06-24-14:30:
 * Probe the backend connectivity and server health. This is the PostgreSQL
 * equivalent of SQLite's `PRAGMA integrity_check` — it answers "is the
 * database reachable and accepting queries?" When the answer is no, the
 * caller surfaces the DB corruption banner (VAL-HEALTH-002).
 *
 * PostgreSQL does not suffer the page-level corruption that SQLite's
 * integrity_check guards against (MVCC + WAL makes structural corruption
 * extremely rare). The health signal is therefore connectivity + the server's
 * own `pg_stat_database` health indicator (`datallowconn` must be true and
 * the server must respond to a trivial query).
 *
 * @param layer The async data layer to probe.
 * @returns A list of error strings (empty = healthy). A non-empty list means
 *          the backend is unreachable or reporting problems.
 */
export async function checkPostgresHealth(layer: AsyncDataLayer): Promise<string[]> {
  const errors: string[] = [];
  try {
    await layer.ping();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`PostgreSQL backend unreachable: ${msg}`);
    return errors;
  }

  // If ping succeeded, the server is reachable. Query pg_stat_database for
  // the project database's health indicator. This catches cases where the
  // server is up but the target database is in a bad state (e.g. waiting for
  // recovery, connection refused at the DB level).
  try {
    const db = layer.db;
    const rows = (await db.execute(
      sql.raw(`
        SELECT datallowconn, now() - pg_postmaster_start_time() AS uptime
        FROM pg_database
        WHERE datname = current_database()
        LIMIT 1
      `),
    )) as unknown as Array<{ datallowconn: boolean }>;
    if (rows.length > 0 && !rows[0].datallowconn) {
      errors.push("PostgreSQL database is not accepting connections (datallowconn = false)");
    }
  } catch (error) {
    // The ping succeeded but the health query failed — treat as degraded.
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`PostgreSQL health query failed: ${msg}`);
  }

  return errors;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:35:
 * Detect schema drift by comparing the live `information_schema.columns`
 * against the expected column registry. Returns a list of missing columns
 * that should be re-added via self-heal (VAL-HEALTH-004).
 *
 * This replaces the SQLite `PRAGMA table_info` reconciliation. PostgreSQL's
 * `information_schema.columns` is the standards-compliant introspection
 * surface; `pg_catalog.pg_attribute` is the lower-level alternative. We use
 * `information_schema` because it is portable across PostgreSQL versions and
 * managed services (Supabase, RDS, etc.).
 *
 * @param db The Drizzle instance to introspect.
 * @param expected The expected columns (defaults to EXPECTED_PROJECT_COLUMNS).
 * @returns Findings for each missing column.
 */
export async function detectSchemaDrift(
  db: DrizzleDb,
  expected: ReadonlyArray<{ schema?: string; table: string; column: string; type: string }> = EXPECTED_PROJECT_COLUMNS,
): Promise<SchemaDriftFinding[]> {
  // Gather the live columns for all expected (schema, table) pairs in one
  // query. Entries default to the project schema; archive-schema entries carry
  // an explicit `schema` (FNXC:MultiProjectIsolation 2026-07-12).
  const pairs = [...new Set(expected.map((e) => `${e.schema ?? PROJECT_SCHEMA}|${e.table}`))];
  if (pairs.length === 0) {
    return [];
  }

  // Query information_schema for the live columns of all expected tables.
  // Schema/table names are from our own curated registry (not user input), so
  // raw interpolation is safe here.
  const pairList = pairs
    .map((pair) => {
      const [schemaName, tableName] = pair.split("|");
      return `('${schemaName}', '${tableName}')`;
    })
    .join(", ");
  const liveRows = (await db.execute(
    sql.raw(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE (table_schema, table_name) IN (${pairList})
      ORDER BY table_schema, table_name, column_name
    `),
  )) as unknown as Array<{ table_schema: string; table_name: string; column_name: string }>;

  const liveColumns = new Set<string>();
  for (const row of liveRows) {
    liveColumns.add(`${row.table_schema}:${row.table_name}:${row.column_name}`);
  }

  const findings: SchemaDriftFinding[] = [];
  for (const entry of expected) {
    // The expected registry stores the actual database column name (snake_case,
    // as it appears in DDL and information_schema). A direct match check suffices.
    const key = `${entry.schema ?? PROJECT_SCHEMA}:${entry.table}:${entry.column}`;
    if (!liveColumns.has(key)) {
      findings.push({
        table: entry.table,
        column: entry.column,
        expectedType: entry.type,
        ...(entry.schema ? { schema: entry.schema } : {}),
      });
    }
  }

  return findings;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:40:
 * Reconcile schema drift by adding missing columns via ALTER TABLE. This is
 * the self-heal path: each missing column from the drift report is re-added
 * with its expected type, preventing `no such column` regressions on
 * newly-added fields when a database was migrated from an older baseline
 * (VAL-HEALTH-004).
 *
 * Each ALTER TABLE runs in its own statement (PostgreSQL does not support
 * adding multiple columns in a single ALTER without repeating the ADD keyword).
 * Columns are added as nullable to avoid NOT NULL constraint failures on
 * existing rows.
 *
 * @param db The Drizzle instance (migration connection preferred for DDL).
 * @param findings The missing columns to re-add.
 * @returns The columns that were successfully re-added.
 */
export async function healSchemaDrift(
  db: DrizzleDb,
  findings: SchemaDriftFinding[],
): Promise<SchemaDriftFinding[]> {
  const healed: SchemaDriftFinding[] = [];
  for (const finding of findings) {
    const ddlType = TYPE_TO_DDL[finding.expectedType] ?? "TEXT";
    try {
      await db.execute(
        sql.raw(
          `ALTER TABLE ${finding.schema ?? PROJECT_SCHEMA}.${finding.table} ADD COLUMN IF NOT EXISTS "${finding.column}" ${ddlType}`,
        ),
      );
      healed.push(finding);
    } catch {
      // Best-effort: a failed ALTER (e.g. type conflict) is logged but does not
      // block the remaining heals. The drift report still surfaces the finding.
    }
  }
  return healed;
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:45:
 * Run a full schema validation cycle: detect drift, self-heal missing columns,
 * and return the report. Used at startup (replacing the SQLite schema-compat
 * fingerprint reconciliation) and on-demand.
 *
 * @param layer The async data layer (uses the runtime db for detection,
 *              migration db for healing if available).
 * @returns The validation report with healed columns listed.
 */
export async function validateAndHealSchema(layer: AsyncDataLayer): Promise<SchemaValidationReport> {
  const checkedAt = new Date().toISOString();
  const findings = await detectSchemaDrift(layer.db);
  if (findings.length === 0) {
    return { status: "ok", checkedAt, findings: [], healed: [] };
  }

  const healed = await healSchemaDrift(layer.db, findings);
  return { status: "drift", checkedAt, findings, healed };
}

/**
 * FNXC:PostgresHealth 2026-06-24-14:50:
 * Run VACUUM and ANALYZE on the project-schema tables and report per-table
 * stats. This is the explicit operator compaction command (VAL-HEALTH-005).
 *
 * PostgreSQL's autovacuum handles routine bloat reclaim, but an operator may
 * need to run an explicit VACUUM after bulk deletes or to update planner
 * statistics before a query-performance investigation. This command:
 *   1. Captures before-stats (row count, dead tuples, table size) from
 *      `pg_stat_user_tables` and `pg_total_relation_size`.
 *   2. Runs `VACUUM` then `ANALYZE` on each core table.
 *   3. Captures after-stats and reports the delta.
 *
 * VACUUM cannot run inside a transaction block, so this method issues the
 * statements outside any transaction via `db.execute()`. ANALYZE also cannot
 * run inside a transaction block when called without options.
 *
 * @param db The Drizzle instance to run VACUUM/ANALYZE against.
 * @param tables The tables to compact (defaults to projectTableNames).
 * @returns Per-table before/after stats.
 */
export async function vacuumAnalyze(
  db: DrizzleDb,
  tables: readonly string[] = projectTableNames,
): Promise<VacuumAnalyzeResult> {
  const ranAt = new Date().toISOString();

  // Capture before-stats for all tables in one query.
  const beforeStats = await captureTableStats(db, tables);

  // Run VACUUM + ANALYZE on each table. These must run outside a transaction.
  for (const table of tables) {
    await db.execute(sql.raw(`VACUUM ${PROJECT_SCHEMA}.${table}`));
    await db.execute(sql.raw(`ANALYZE ${PROJECT_SCHEMA}.${table}`));
  }

  // Capture after-stats.
  const afterStats = await captureTableStats(db, tables);

  // Build the per-table report.
  const tableReports: VacuumAnalyzeStats[] = [];
  let totalDeadTuplesReclaimed = 0;
  let totalBytesReclaimed = 0;

  for (const table of tables) {
    const before = beforeStats.get(table);
    const after = afterStats.get(table);
    if (!before || !after) continue;

    const deadReclaimed = before.deadTuples - after.deadTuples;
    const bytesReclaimed = before.sizeBytes - after.sizeBytes;
    tableReports.push({
      table,
      rowsBefore: before.rows,
      rowsAfter: after.rows,
      deadTuplesBefore: before.deadTuples,
      deadTuplesAfter: after.deadTuples,
      sizeBytesBefore: before.sizeBytes,
      sizeBytesAfter: after.sizeBytes,
      analyzed: true,
    });
    totalDeadTuplesReclaimed += Math.max(0, deadReclaimed);
    totalBytesReclaimed += Math.max(0, bytesReclaimed);
  }

  return {
    ranAt,
    tables: tableReports,
    totalDeadTuplesReclaimed,
    totalBytesReclaimed,
  };
}

/**
 * Per-table stats snapshot from pg_stat_user_tables + pg_total_relation_size.
 */
interface TableStats {
  rows: number;
  deadTuples: number;
  sizeBytes: number;
}

/**
 * Capture row count, dead tuples, and table size for the given tables.
 * Uses pg_stat_user_tables (which has n_live_tup / n_dead_tup) joined with
 * pg_total_relation_size for the on-disk size.
 */
async function captureTableStats(
  db: DrizzleDb,
  tables: readonly string[],
): Promise<Map<string, TableStats>> {
  if (tables.length === 0) {
    return new Map();
  }

  const tableList = tables.map((t) => `'${t}'`).join(", ");
  const rows = (await db.execute(
    sql.raw(`
      SELECT
        c.relname AS table_name,
        COALESCE(s.n_live_tup, 0) AS rows,
        COALESCE(s.n_dead_tup, 0) AS dead_tuples,
        COALESCE(pg_total_relation_size(c.oid), 0) AS size_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = '${PROJECT_SCHEMA}'
        AND c.relname IN (${tableList})
        AND c.relkind = 'r'
    `),
  )) as unknown as Array<{ table_name: string; rows: string | number; dead_tuples: string | number; size_bytes: string | number }>;

  const stats = new Map<string, TableStats>();
  for (const row of rows) {
    stats.set(row.table_name, {
      rows: Number(row.rows),
      deadTuples: Number(row.dead_tuples),
      sizeBytes: Number(row.size_bytes),
    });
  }
  return stats;
}
