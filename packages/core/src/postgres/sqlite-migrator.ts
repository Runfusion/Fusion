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
import { basename, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { applySchemaBaseline } from "./schema-applier.js";
import { acquireSqliteMigrationStateLock } from "./advisory-locks.js";
import {
  PROJECT_SCHEMA,
  CENTRAL_SCHEMA,
  ARCHIVE_SCHEMA,
} from "./schema/_shared.js";
import { createLogger } from "../logger.js";
import { getErrorMessage } from "../error-message.js";

const log = createLogger("sqlite-migrator");

/**
 * FNXC:PostgresMigrationSharedSingleton 2026-07-19-05:00:
 * A small set of project-schema tables intentionally have no project_id and are
 * shared across all projects in the PostgreSQL cluster. When two legacy SQLite
 * files use the same primary-key value (e.g. distributed_task_id_state.prefix),
 * a plain INSERT ... ON CONFLICT DO NOTHING discards the second file's row and
 * the content-verification subset check fails because the target row differs from
 * the source. These tables must instead merge conflicting rows using semantics
 * appropriate to each column. Only distributed_task_id_state is currently known
 * to need this treatment; any future shared singleton with overlapping keys can
 * register here.
 */
function isSharedSingletonTable(pgSchema: string, pgTable: string): boolean {
  return pgSchema === PROJECT_SCHEMA && pgTable === "distributed_task_id_state";
}

/**
 * FNXC:PostgresMigrationSharedSingleton 2026-07-19-05:05:
 * For distributed_task_id_state, the source SQLite files are per-project, but the
 * PostgreSQL target is a cluster-wide singleton keyed by prefix. The allocator
 * sequence floor (next_sequence) must be the maximum across all source files so
 * newly-created task IDs never reuse an already-issued number. The committed-cluster
 * counter and last-committed-task-id follow the row with the highest sequence.
 * updated_at is kept as the latest ISO timestamp. This merge is idempotent.
 */
function buildSharedSingletonConflictClause(pgSchema: string, pgTable: string, cols: readonly ColumnMapping[]): ReturnType<typeof sql.raw> {
  if (pgTable === "distributed_task_id_state") {
    const colSet = new Set(cols.map((c) => c.pgName));
    const prefix = quoteIdent("prefix");
    const projectId = quoteIdent("project_id");
    const tableName = quoteIdent("distributed_task_id_state");
    const parts: string[] = [];
    if (colSet.has("next_sequence")) {
      parts.push(`${quoteIdent("next_sequence")} = GREATEST(${tableName}.${quoteIdent("next_sequence")}, EXCLUDED.${quoteIdent("next_sequence")})`);
    }
    if (colSet.has("committed_cluster_task_count")) {
      parts.push(`${quoteIdent("committed_cluster_task_count")} = GREATEST(${tableName}.${quoteIdent("committed_cluster_task_count")}, EXCLUDED.${quoteIdent("committed_cluster_task_count")})`);
    }
    if (colSet.has("last_committed_task_id")) {
      parts.push(`${quoteIdent("last_committed_task_id")} = CASE WHEN EXCLUDED.${quoteIdent("next_sequence")} > ${tableName}.${quoteIdent("next_sequence")} THEN EXCLUDED.${quoteIdent("last_committed_task_id")} ELSE ${tableName}.${quoteIdent("last_committed_task_id")} END`);
    }
    if (colSet.has("updated_at")) {
      parts.push(`${quoteIdent("updated_at")} = GREATEST(${tableName}.${quoteIdent("updated_at")}, EXCLUDED.${quoteIdent("updated_at")})`);
    }
    return sql.raw(`ON CONFLICT (${projectId}, ${prefix}) DO UPDATE SET ${parts.join(", ")}`);
  }
  return sql.raw("ON CONFLICT DO NOTHING");
}

/**
 * FNXC:PostgresMigrationSharedSingleton 2026-07-19-05:10:
 * Verify a shared singleton table by dominance rather than exact row equality.
 * For each source row, the target must contain a row with the same primary key
 * and counter values that are at least as large as the source values. This lets
 * a later project migrate safely even when an earlier project already populated
 * the shared table with a higher sequence floor for the same prefix.
 *
 * FNXC:PostgresMigrationSharedSingleton 2026-07-19-08:40:
 * sourceRows come from raw SQLite `SELECT *` (PRAGMA camelCase columns:
 * nextSequence, committedClusterTaskCount). Target counters stay snake_case
 * from PostgreSQL. Reading snake_case on the source always fell back to 0 and
 * let a non-dominating target pass verification.
 *
 * FNXC:PostgresMigrationSharedSingleton 2026-07-19-09:50:
 * PK is (project_id, prefix). Scope the target lookup by partitionProjectId so
 * a higher next_sequence on another project's same prefix cannot make result[0]
 * pass while the migrating project's row is missing or lower. Fail closed when
 * the partition id is absent — prefix-only lookup is ambiguous under multi-project.
 */
async function verifySharedSingletonTable(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  pgTable: string,
  sourceRows: readonly Record<string, unknown>[],
  partitionProjectId: string | undefined,
): Promise<boolean> {
  if (pgTable !== "distributed_task_id_state") return false;
  if (typeof partitionProjectId !== "string" || partitionProjectId.length === 0) {
    log.warn(
      `Shared singleton ${pgSchema}.${pgTable} verification requires partitionProjectId ` +
      `(composite PK project_id, prefix); refusing prefix-only lookup`,
    );
    return false;
  }
  const schemaQualifiedTable = `${quoteIdent(pgSchema)}.${quoteIdent(pgTable)}`;
  for (const row of sourceRows) {
    const prefix = row.prefix;
    if (typeof prefix !== "string") continue;
    const result = (await db.execute(sql`
      SELECT
        ${sql.raw(quoteIdent("next_sequence"))} AS next_sequence,
        ${sql.raw(quoteIdent("committed_cluster_task_count"))} AS committed_cluster_task_count,
        ${sql.raw(quoteIdent("updated_at"))} AS updated_at
      FROM ${sql.raw(schemaQualifiedTable)}
      WHERE ${sql.raw(quoteIdent("project_id"))} = ${partitionProjectId}
        AND ${sql.raw(quoteIdent("prefix"))} = ${prefix}
    `)) as unknown as Array<{
      next_sequence: number | string;
      committed_cluster_task_count: number | string;
      updated_at: string;
    }>;
    if (result.length === 0) {
      log.warn(
        `Shared singleton ${pgSchema}.${pgTable} missing project_id=${partitionProjectId} prefix=${prefix}`,
      );
      return false;
    }
    const target = result[0];
    // Legacy SQLite schema uses camelCase; never prefer snake_case for source.
    const sourceNext = Number(row.nextSequence ?? 0);
    const targetNext = Number(target.next_sequence ?? 0);
    const sourceCount = Number(row.committedClusterTaskCount ?? 0);
    const targetCount = Number(target.committed_cluster_task_count ?? 0);
    if (targetNext < sourceNext || targetCount < sourceCount) {
      log.warn(
        `Shared singleton ${pgSchema}.${pgTable} project_id=${partitionProjectId} prefix=${prefix} does not dominate source: ` +
        `source=(nextSequence=${sourceNext}, count=${sourceCount}), target=(next_sequence=${targetNext}, count=${targetCount})`,
      );
      return false;
    }
  }
  return true;
}


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
  /** Canonical owner of project-local rows that move into central state tables. */
  readonly projectPath?: string;
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
    { sqlitePath: `${fusionDir}/fusion.db`, pgSchema: PROJECT_SCHEMA, projectPath: resolve(dirname(fusionDir)) },
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
  /** Preserve empty/whitespace source text only when required jsonb declares no default. */
  readonly preserveEmptyJsonbString: boolean;
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
  /** Bound project identity injected into partitioned PostgreSQL tables. */
  readonly partitionProjectId?: string;
  /** Why a source table has no target mapping, when it is intentionally disposable. */
  readonly allowedSkipReason?: string;
  /** Source columns that would otherwise be silently discarded. */
  readonly unmappedSourceColumns: readonly string[];
  /** Opaque legacy rows retained as tagged canonical JSON when typed DDL is unavailable. */
  readonly legacyPreservation?: {
    readonly sourceSchemaSql: string;
  };
}

const LEGACY_PRESERVATION_TARGETS = new Map<string, string>([
  ["mission_feature_evidence_links", "mission_feature_evidence_links"],
  ["agentLogEntries", "agent_log_entries_legacy"],
]);

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

interface TableProgressCoordinates {
  readonly sourceSchema: SchemaName;
  readonly table: string;
  readonly tableIndex: number;
  readonly tableCount: number;
}

/** Structured status emitted to CLI callers during a potentially long migration. */
export type MigrationProgressEvent =
  | { readonly phase: "preparing-schema" }
  | {
      readonly phase: "scanning-source";
      readonly sourcePath: string;
      readonly sourceSchema: SchemaName;
      readonly sourceIndex: number;
      readonly sourceCount: number;
    }
  | { readonly phase: "copy-started"; readonly tableCount: number }
  | ({ readonly phase: "table-started" } & TableProgressCoordinates)
  | ({
      readonly phase: "table-progress";
      readonly processedRows: number;
      readonly sourceRows: number;
    } & TableProgressCoordinates)
  | ({
      readonly phase: "table-verifying";
      readonly sourceRows: number;
      readonly verificationStage: "target-count" | "source-content" | "target-content";
    } & TableProgressCoordinates)
  | ({
      readonly phase: "table-complete";
      readonly sourceRows: number;
      readonly insertedRows: number;
      readonly targetRows: number;
      readonly verified: boolean;
      readonly skipped: boolean;
      readonly skipReason?: string;
    } & TableProgressCoordinates)
  | {
      readonly phase: "copy-complete";
      readonly tableCount: number;
      readonly verifiedTables: number;
      readonly failedTables: number;
      readonly sequenceBumps: number;
    }
  | {
      readonly phase: "dry-run-complete";
      readonly tableCount: number;
      readonly sourceRows: number;
    }
  | { readonly phase: "failed"; readonly error: string }
  | {
      readonly phase: "failed";
      readonly tableCount: number;
      readonly verifiedTables: number;
      readonly failedTables: number;
    };

export type MigrationProgressPhase = MigrationProgressEvent["phase"];

function formatTableProgressPrefix(event: TableProgressCoordinates): string {
  return `[${event.tableIndex}/${event.tableCount}] ${event.sourceSchema}.${event.table}`;
}

/** Format a structured migration event for terminal output. */
export function formatMigrationProgress(event: MigrationProgressEvent): string {
  switch (event.phase) {
    case "preparing-schema":
      return "Preparing PostgreSQL schema…";
    case "scanning-source":
      return `Scanning source ${event.sourceIndex}/${event.sourceCount}: ${basename(event.sourcePath)} → ${event.sourceSchema}…`;
    case "copy-started":
      return `Found ${event.tableCount} tables. Copying and verifying data…`;
    case "table-started":
      return `${formatTableProgressPrefix(event)}: starting…`;
    case "table-progress": {
      const percent = Math.floor((event.processedRows / event.sourceRows) * 100);
      return `${formatTableProgressPrefix(event)}: processed ${event.processedRows.toLocaleString()}/${event.sourceRows.toLocaleString()} rows (${percent}%)`;
    }
    case "table-verifying": {
      const stage = {
        "target-count": "counting migrated rows",
        "source-content": "checksumming SQLite source",
        "target-content": "checksumming PostgreSQL target",
      }[event.verificationStage];
      return `${formatTableProgressPrefix(event)}: processed ${event.sourceRows.toLocaleString()} rows; ${stage}…`;
    }
    case "table-complete":
      if (event.skipped) return `${formatTableProgressPrefix(event)}: skipped — ${event.skipReason ?? "not required"}`;
      if (!event.verified) {
        return `${formatTableProgressPrefix(event)}: VERIFICATION FAILED — source=${event.sourceRows}, target=${event.targetRows}${event.skipReason ? ` (${event.skipReason})` : ""}`;
      }
      return `${formatTableProgressPrefix(event)}: verified — ${event.sourceRows.toLocaleString()} rows (${event.insertedRows.toLocaleString()} inserted)`;
    case "copy-complete":
      return `Copy and verification complete — ${event.verifiedTables}/${event.tableCount} tables verified; ${event.sequenceBumps} sequences updated. Finalizing migration…`;
    case "dry-run-complete":
      return `Dry run complete — ${event.tableCount} tables and ${event.sourceRows.toLocaleString()} source rows planned; no data written.`;
    case "failed":
      return "error" in event
        ? `FAILED — migration transaction rolled back: ${event.error}`
        : `FAILED — ${event.failedTables}/${event.tableCount} tables failed verification; migration will not be marked complete.`;
  }
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
  /** Project partition used when importing one project's legacy databases into a shared cluster. */
  readonly projectId?: string;
  /** Canonical filesystem path owning project-local plugin activation state. */
  readonly projectPath?: string;
  /** Durable identity used to serialize and record one project's cutover. */
  readonly migrationKey?: string;
  /** Leave a verified migration running until caller-side project stamping succeeds. */
  readonly deferCompletion?: boolean;
  /** Receives CLI-safe progress events; callback failures never abort migration. */
  readonly onProgress?: (event: MigrationProgressEvent) => void | Promise<void>;
}

function emitMigrationProgress(options: MigrationOptions, event: MigrationProgressEvent): void {
  try {
    const pending = options.onProgress?.(event);
    if (pending) {
      void pending.catch((error) => {
        log.warn(`Migration progress callback failed: ${getErrorMessage(error)}`);
      });
    }
  } catch (error) {
    log.warn(`Migration progress callback failed: ${getErrorMessage(error)}`);
  }
}

const SQLITE_MIGRATION_STATE_TABLE = "fusion_sqlite_migrations";
export const CENTRAL_SQLITE_MIGRATION_KEY = "central:legacy-sqlite";

async function ensureMigrationStateTable(db: PostgresJsDatabase<Record<string, never>>): Promise<void> {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS public.${SQLITE_MIGRATION_STATE_TABLE} (
    migration_key text PRIMARY KEY,
    project_id text,
    status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    last_error text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`));
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
        RETURN;
      END IF;

      ALTER TABLE public.${SQLITE_MIGRATION_STATE_TABLE} ENABLE ROW LEVEL SECURITY;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_policy
        WHERE polrelid = 'public.${SQLITE_MIGRATION_STATE_TABLE}'::regclass
          AND polname = 'fusion_sqlite_migrations_project_read'
      ) THEN
        CREATE POLICY fusion_sqlite_migrations_project_read
          ON public.${SQLITE_MIGRATION_STATE_TABLE}
          FOR SELECT
          TO fusion_runtime
          USING (
            current_setting('fusion.project_bypass', true) = 'on'
            OR project_id = NULLIF(current_setting('fusion.project_id', true), '')
          );
      END IF;

      GRANT SELECT ON public.${SQLITE_MIGRATION_STATE_TABLE} TO fusion_runtime;
    END $$;
  `));
}

export interface SqliteMigrationState {
  migrationKey: string;
  projectId: string | null;
  status: "running" | "complete" | "failed";
  lastError: string | null;
  updatedAt: Date | string;
}

/**
 * FNXC:MigrationStatusDashboard 2026-07-19-12:25:
 * Dashboard health reads the authoritative per-project cutover marker after
 * listen. A running or failed marker is never aged out here: progress ticks do
 * not update updated_at, and post-listen running means completion was missed.
 * Reads must not create the marker table: dashboard and startup connections can
 * use a runtime role that intentionally lacks CREATE permission in public.
 */
export async function getSqliteMigrationState(
  db: PostgresJsDatabase<Record<string, never>>,
  migrationKey: string,
): Promise<SqliteMigrationState | null> {
  const tableRows = (await db.execute(sql`
    SELECT to_regclass('public.${sql.raw(SQLITE_MIGRATION_STATE_TABLE)}') IS NOT NULL AS exists
  `)) as unknown as Array<{ exists: boolean }>;
  if (!tableRows[0]?.exists) return null;

  const rows = (await db.execute(sql`
    SELECT migration_key, project_id, status, last_error, updated_at
    FROM public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
    WHERE migration_key = ${migrationKey}
    LIMIT 1
  `)) as unknown as Array<{
    migration_key: string;
    project_id: string | null;
    status: "running" | "complete" | "failed";
    last_error: string | null;
    updated_at: Date | string;
  }>;
  const row = rows[0];
  return row
    ? {
        migrationKey: row.migration_key,
        projectId: row.project_id,
        status: row.status,
        lastError: row.last_error,
        updatedAt: row.updated_at,
      }
    : null;
}

/** Return true only after a fully verified cutover records its durable marker. */
export async function isSqliteMigrationComplete(
  db: PostgresJsDatabase<Record<string, never>>,
  migrationKey: string,
): Promise<boolean> {
  return (await getSqliteMigrationState(db, migrationKey))?.status === "complete";
}

/** Mark caller-side stamping and verification complete for a durable cutover. */
export async function completeSqliteMigration(
  db: PostgresJsDatabase<Record<string, never>>,
  migrationKey: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
    SET status = 'complete', last_error = NULL, updated_at = now()
    WHERE migration_key = ${migrationKey}
  `);
}

/** Record a verified source independently of a project cutover marker. */
export async function recordSqliteMigrationComplete(
  db: PostgresJsDatabase<Record<string, never>>,
  migrationKey: string,
  projectId?: string,
): Promise<void> {
  await ensureMigrationStateTable(db);
  await db.execute(sql`
    INSERT INTO public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
      (migration_key, project_id, status, last_error, updated_at)
    VALUES (${migrationKey}, ${projectId ?? null}, 'complete', NULL, now())
    ON CONFLICT (migration_key) DO UPDATE
    SET project_id = EXCLUDED.project_id, status = 'complete', last_error = NULL, updated_at = now()
  `);
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
  const migrationKey = options.migrationKey ?? `project:${options.projectId ?? "unbound"}`;
  try {
    /*
    FNXC:PostgresMigrationSession 2026-07-14-00:05:
    Pin the complete cutover to one transaction-backed PostgreSQL session. Advisory locking, trigger deferral, copy, verification, and reset must not hop across connections when callers provide a multi-connection pool.
    */
    return await migrationDb.transaction(async (tx) => {
      const report = await migrateSqliteToPostgresOnSession(
        tx as unknown as PostgresJsDatabase<Record<string, never>>,
        sources,
        options,
      );
      if (options.dryRun === true) {
        /*
        FNXC:PostgresMigration 2026-07-14-23:47:
        A dry run may materialize the target schema inside its private transaction so column mapping can be planned against a pristine cluster, but the operator contract forbids any durable PostgreSQL change. Carry the completed report through a deliberate rollback instead of committing temporary DDL.
        */
        throw new DryRunRollback(report);
      }
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    const errorMessage = getErrorMessage(error);
    emitMigrationProgress(options, {
      phase: "failed",
      error: errorMessage,
    });
    if (options.dryRun !== true) {
      await migrationDb.transaction(async (tx) => {
        await acquireSqliteMigrationStateLock(tx);
        await ensureMigrationStateTable(tx);
        await tx.execute(sql`
          INSERT INTO public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
            (migration_key, project_id, status, last_error, updated_at)
          VALUES (${migrationKey}, ${options.projectId ?? null}, 'failed', ${errorMessage}, now())
          ON CONFLICT (migration_key) DO UPDATE
          SET project_id = EXCLUDED.project_id, status = 'failed', last_error = EXCLUDED.last_error, updated_at = now()
        `);
      });
    }
    throw error;
  }
}

class DryRunRollback extends Error {
  constructor(readonly report: MigrationReport) {
    super("SQLite migration dry run completed; rolling back target changes");
    this.name = "DryRunRollback";
  }
}

async function migrateSqliteToPostgresOnSession(
  migrationDb: PostgresJsDatabase<Record<string, never>>,
  sources: readonly SqliteMigrationSource[],
  options: MigrationOptions,
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;
  const migrationKey = options.migrationKey ?? `project:${options.projectId ?? "unbound"}`;
  emitMigrationProgress(options, { phase: "preparing-schema" });

  /*
   * FNXC:PostgresMigration 2026-07-14-00:05:
   * A failed cutover may already have copied rows. Serialize each project on
   * the migration connection and persist completion only after every table
   * verifies; startup can then retry idempotently instead of treating any
   * copied task as proof that the whole migration finished.
  */
  if (!dryRun) {
    await acquireSqliteMigrationStateLock(migrationDb);
    await ensureMigrationStateTable(migrationDb);
    /*
     * FNXC:PostgresMigrationSession 2026-07-14-00:14:
     * Hold project serialization through transaction commit. Releasing a
     * session lock before commit lets the next cutover block on the prior
     * transaction's migration-state row and can deadlock pooled callers.
     */
    await migrationDb.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${migrationKey}, 0))`);
    await migrationDb.execute(sql`
      INSERT INTO public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
        (migration_key, project_id, status, last_error, updated_at)
      VALUES (${migrationKey}, ${options.projectId ?? null}, 'running', NULL, now())
      ON CONFLICT (migration_key) DO UPDATE
      SET project_id = EXCLUDED.project_id, status = 'running', last_error = NULL, updated_at = now()
    `);
  }

  // 1. Apply the schema baseline (idempotent). A dry run creates it only inside
  //    the enclosing transaction, which is deliberately rolled back after the
  //    report is complete. If skipBaseline is set, assume it already exists.
  let appliedBaseline = false;
  try {
    if (!options.skipBaseline) {
      const result = await applySchemaBaseline(migrationDb);
      appliedBaseline = result.applied;
    }
  } catch (error) {
    if (!dryRun) {
      await migrationDb.execute(sql`
        UPDATE public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
        SET status = 'failed', last_error = ${getErrorMessage(error)}, updated_at = now()
        WHERE migration_key = ${migrationKey}
      `);
    }
    throw error;
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
          `${getErrorMessage(error)}. ` +
          `Tables will be copied in name order; FK violations may surface if order is wrong.`,
      );
    }
  }

  let copyError: unknown;
  try {
    const plannedSources: Array<{ source: SqliteMigrationSource; plan: readonly TablePlan[] }> = [];
    for (const [sourceOffset, source] of sources.entries()) {
      emitMigrationProgress(options, {
        phase: "scanning-source",
        sourcePath: source.sqlitePath,
        sourceSchema: source.pgSchema,
        sourceIndex: sourceOffset + 1,
        sourceCount: sources.length,
      });
      const plan = await buildMigrationPlan(migrationDb, source, options.projectId);
      plannedSources.push({ source, plan });
    }
    const tableCount = plannedSources.reduce((sum, planned) => sum + planned.plan.length, 0);
    emitMigrationProgress(options, { phase: "copy-started", tableCount });
    let tableIndex = 0;
    for (const { source, plan } of plannedSources) {
      for (const tablePlan of plan) {
        tableIndex += 1;
        const progressBase = {
          sourceSchema: source.pgSchema,
          table: tablePlan.pgTable,
          tableIndex,
          tableCount,
        } as const;
        emitMigrationProgress(options, { phase: "table-started", ...progressBase });
        const result = await migrateTable(
          migrationDb,
          source,
          tablePlan,
          dryRun,
          {
            onCopyProgress: (processedRows, sourceRows) => emitMigrationProgress(options, {
              phase: "table-progress",
              ...progressBase,
              processedRows,
              sourceRows,
            }),
            onVerifying: (verificationStage, sourceRows) => emitMigrationProgress(options, {
              phase: "table-verifying",
              ...progressBase,
              sourceRows,
              verificationStage,
            }),
          },
        );
        tableResults.push(result);
        emitMigrationProgress(options, {
          phase: "table-complete",
          ...progressBase,
          sourceRows: result.sourceRows,
          insertedRows: result.insertedRows,
          targetRows: result.targetRows,
          verified: result.verified,
          skipped: result.skipped,
          skipReason: result.skipReason,
        });

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
    if (!dryRun) {
      for (const source of sources) {
        if (source.pgSchema !== PROJECT_SCHEMA) continue;
        const projectPath = source.projectPath ?? options.projectPath;
        if (sqliteTableExists(source.sqlitePath, "plugins") && !projectPath) {
          throw new Error(`projectPath is required to migrate legacy plugin state from ${source.sqlitePath}`);
        }
        if (projectPath) {
          await migrateLegacyProjectPluginRowsOnSession(
            migrationDb,
            source.sqlitePath,
            projectPath,
          );
        }
      }
    }
  } catch (error) {
    copyError = error;
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

  if (copyError !== undefined) {
    if (!dryRun) {
      await migrationDb.execute(sql`
        UPDATE public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
        SET status = 'failed', last_error = ${copyError instanceof Error ? copyError.message : String(copyError)}, updated_at = now()
        WHERE migration_key = ${migrationKey}
      `);
    }
    throw copyError;
  }

  const report: MigrationReport = {
    dryRun,
    sources,
    tables: tableResults,
    sequenceBumps,
    appliedBaseline,
  };

  if (dryRun) {
    const sourceRows = tableResults.reduce((n, t) => n + t.sourceRows, 0);
    log.log(`[dry-run] Migration plan: ${tableResults.length} tables, ${sourceRows} source rows planned. No writes performed.`);
    emitMigrationProgress(options, {
      phase: "dry-run-complete",
      tableCount: tableResults.length,
      sourceRows,
    });
  } else {
    const ok = tableResults.filter((t) => t.verified).length;
    const bad = tableResults.length - ok;
    await migrationDb.execute(sql`
      UPDATE public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
      SET status = ${bad === 0 ? (options.deferCompletion ? "running" : "complete") : "failed"},
          last_error = ${bad === 0 ? null : `${bad} table(s) failed verification`},
          updated_at = now()
      WHERE migration_key = ${migrationKey}
    `);
    log.log(`Migration complete: ${ok}/${tableResults.length} tables verified (${bad} failed verification). ${sequenceBumps.length} sequences bumped.`);
    emitMigrationProgress(options, bad === 0 ? {
      phase: "copy-complete",
      tableCount: tableResults.length,
      verifiedTables: ok,
      failedTables: bad,
      sequenceBumps: sequenceBumps.length,
    } : {
      phase: "failed",
      tableCount: tableResults.length,
      verifiedTables: ok,
      failedTables: bad,
    });
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
  projectId?: string,
): Promise<readonly TablePlan[]> {
  const sqlite = openSqlite(source.sqlitePath);
  try {
    const tables = listSqliteTables(sqlite);
    const ftsVirtualTables = listFtsVirtualTables(sqlite);
    const targetColumnsByTable = await loadTargetColumnMetadata(db, source.pgSchema);
    const plans: TablePlan[] = [];
    for (const table of tables) {
      if (source.pgSchema === PROJECT_SCHEMA && table === "plugins") {
        /*
        FNXC:PluginLegacyMigration 2026-07-14-22:50:
        Legacy plugin rows combine cluster-global installation metadata with project-path enablement state. Redirect them to the central plugin registry instead of copying into unpartitioned project.plugins, where identical plugin IDs from two projects would collide and lose one project's enabled/state values.
        */
        plans.push({
          pgSchema: source.pgSchema,
          table,
          pgTable: table,
          columns: [],
          unmappedSourceColumns: [],
          allowedSkipReason: "redirected to central plugin registry and project state",
        });
        continue;
      }
      const legacyPreservationTarget = source.pgSchema === PROJECT_SCHEMA
        ? LEGACY_PRESERVATION_TARGETS.get(table)
        : undefined;
      if (legacyPreservationTarget) {
        /*
        FNXC:PostgresLegacyPreservation 2026-07-14-12:10:
        Some historical project tables reached operators without a durable typed PostgreSQL schema. Preserve every complete row as tagged canonical JSON under the registry-resolved project partition; never guess a cross-project identity or discard unknown columns.
        */
        if (!projectId) {
          throw new Error(`projectId is required to preserve legacy SQLite table ${table}`);
        }
        plans.push({
          pgSchema: source.pgSchema,
          table,
          pgTable: legacyPreservationTarget,
          columns: [],
          partitionProjectId: projectId,
          unmappedSourceColumns: [],
          legacyPreservation: { sourceSchemaSql: readSqliteTableSchema(sqlite, table) },
        });
        continue;
      }
      // Legacy SQLite table names are camelCase; PostgreSQL tables are
      // snake_case. toSnakeCase is the identity for already-snake names.
      const pgTable = toSnakeCase(table);
      const { columns: resolvedColumns, targetColumnNames, unmappedSourceColumns } = resolveColumnMapping(
        pgTable,
        table,
        sqlite,
        targetColumnsByTable,
      );
      /*
      FNXC:PostgresMultiProjectCutover 2026-07-14-11:46:
      Preserve task-document revision identities as provenance, not as the shared table primary key. Two SQLite files can both use id=1, while one file can also contain distinct rows with the same task/key/revision; map the local id into legacy_sqlite_id and let PostgreSQL generate its runtime id.
      */
      const cols = source.pgSchema === PROJECT_SCHEMA && pgTable === "task_document_revisions"
        ? resolvedColumns.map((column) => column.sqliteName === "id"
          ? { ...column, pgName: "legacy_sqlite_id", type: "plain" as const }
          : column)
        : resolvedColumns;
      /*
      FNXC:PostgresMigration 2026-07-14-08:52:
      A legacy per-project SQLite table can already contain a nullable projectId column while its existing rows still hold NULL. The registry identity resolved for this one-project-file cutover is authoritative whenever the PostgreSQL target is partitioned, so insertion and verification must override absent, NULL, or stale source project IDs instead of copying them into the required project_id partition.
      */
      const partitionProjectId =
        projectId &&
        source.pgSchema !== CENTRAL_SCHEMA &&
        targetColumnNames.has("project_id")
          ? projectId
          : undefined;
      if (cols.length === 0) {
        /*
        FNXC:PostgresMigration 2026-07-13-22:37:
        The migration report is the completeness contract for cutover. Preserve every SQLite table in the plan; only known SQLite bookkeeping and FTS5 implementation tables may be reported as intentional skips. Any other unmapped table must remain an unverified, non-skipped result so automated startup fails closed instead of silently abandoning data.
        */
        plans.push({
          pgSchema: source.pgSchema,
          table,
          pgTable,
          columns: cols,
          partitionProjectId,
          unmappedSourceColumns,
          allowedSkipReason: disposableSqliteTableReason(ftsVirtualTables, table),
        });
        continue;
      }
      plans.push({
        pgSchema: source.pgSchema,
        table,
        pgTable,
        columns: cols,
        partitionProjectId,
        unmappedSourceColumns,
      });
    }
    return plans;
  } finally {
    sqlite.close();
  }
}

function readSqliteTableSchema(db: DatabaseSync, table: string): string {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql?: string | null } | undefined;
  if (!row?.sql) {
    throw new Error(`Could not read SQLite schema for legacy table ${table}`);
  }
  return row.sql;
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
  // FNXC:LegacySqliteBoundary 2026-07-14-18:42: the cutover migrator reads legacy sources without checkpointing or modifying them.
  const db = new DatabaseSync(path, { readOnly: true });
  return db;
}

function sqliteTableExists(sqlitePath: string, table: string): boolean {
  if (!existsSync(sqlitePath)) return false;
  const db = openSqlite(sqlitePath);
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    ).get(table));
  } finally {
    db.close();
  }
}

interface LegacyProjectPluginMigrationRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  path: string;
  enabled: number | null;
  state: string | null;
  settings: string | null;
  settingsSchema: string | null;
  error: string | null;
  dependencies: string | null;
  aiScanOnLoad: number | null;
  lastSecurityScan: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeLegacyJson(value: string | null, fallback: string): string {
  if (value === null || value.trim() === "") return fallback;
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return fallback;
  }
}

/** Build the canonical, path-scoped migration key for retained plugin state. */
export function projectPluginSqliteMigrationKey(projectPath: string): string {
  return `project-plugins:${resolve(projectPath)}`;
}

/** Backfill the split PostgreSQL plugin model once from retained project SQLite. */
export async function migrateLegacyProjectPluginRows(
  db: PostgresJsDatabase<Record<string, never>>,
  sqlitePath: string,
  projectPath: string,
): Promise<void> {
  const migrationKey = projectPluginSqliteMigrationKey(projectPath);
  /*
  FNXC:PostgresMigration 2026-07-22-12:00:
  Plugin migration is independently terminal. Read its PostgreSQL marker before
  even probing retained fusion.db so completed backups cannot add startup I/O.
  The transaction repeats the check under its advisory lock for concurrent boot.
  */
  if (await isSqliteMigrationComplete(db, migrationKey)) return;
  await db.transaction(async (tx) => {
    await migrateLegacyProjectPluginRowsOnSession(
      tx as unknown as PostgresJsDatabase<Record<string, never>>,
      sqlitePath,
      projectPath,
    );
  });
}

async function migrateLegacyProjectPluginRowsOnSession(
  db: PostgresJsDatabase<Record<string, never>>,
  sqlitePath: string,
  projectPath: string,
): Promise<void> {
  const canonicalProjectPath = resolve(projectPath);
  const migrationKey = projectPluginSqliteMigrationKey(projectPath);
  await acquireSqliteMigrationStateLock(db);
  await ensureMigrationStateTable(db);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${migrationKey}, 0))`);
  const completed = await isSqliteMigrationComplete(db, migrationKey);
  /*
  FNXC:PluginLegacyMigration 2026-07-14-23:51:
  Retained SQLite is immutable cutover evidence, not a recurring authority. Once a project's plugin rows have been split into PostgreSQL install metadata and path-scoped state, a durable marker prevents later edits to fusion.db from changing live plugin behavior on restart.
  */
  if (completed) return;
  if (!sqliteTableExists(sqlitePath, "plugins")) return;
  const sqlite = openSqlite(sqlitePath);
  let rows: LegacyProjectPluginMigrationRow[];
  try {
    rows = sqlite.prepare(`SELECT * FROM plugins ORDER BY id`).all() as LegacyProjectPluginMigrationRow[];
  } finally {
    sqlite.close();
  }
  for (const row of rows) {
    const settings = normalizeLegacyJson(row.settings, "{}");
    const settingsSchema = row.settingsSchema == null ? null : normalizeLegacyJson(row.settingsSchema, "null");
    const dependencies = normalizeLegacyJson(row.dependencies, "[]");
    await db.execute(sql`
      INSERT INTO central.plugin_installs
        (id, name, version, description, author, homepage, path, settings, settings_schema,
         dependencies, ai_scan_on_load, last_security_scan, created_at, updated_at)
      VALUES
        (${row.id}, ${row.name}, ${row.version}, ${row.description}, ${row.author}, ${row.homepage},
         ${row.path}, ${settings}::jsonb, ${settingsSchema}::jsonb, ${dependencies}::jsonb,
         ${row.aiScanOnLoad ?? 0}, ${row.lastSecurityScan}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        description = EXCLUDED.description,
        author = EXCLUDED.author,
        homepage = EXCLUDED.homepage,
        path = EXCLUDED.path,
        settings = EXCLUDED.settings,
        settings_schema = EXCLUDED.settings_schema,
        dependencies = EXCLUDED.dependencies,
        ai_scan_on_load = EXCLUDED.ai_scan_on_load,
        last_security_scan = EXCLUDED.last_security_scan,
        updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > central.plugin_installs.updated_at
    `);
    await db.execute(sql`
      INSERT INTO central.project_plugin_states
        (project_path, plugin_id, enabled, state, error, created_at, updated_at)
      VALUES
        (${canonicalProjectPath}, ${row.id}, ${row.enabled ?? 1}, ${row.state ?? "installed"},
         ${row.error}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (project_path, plugin_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        state = EXCLUDED.state,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > central.project_plugin_states.updated_at
    `);
  }
  await db.execute(sql`
    INSERT INTO public.${sql.identifier(SQLITE_MIGRATION_STATE_TABLE)}
      (migration_key, project_id, status, last_error, updated_at)
    VALUES (${migrationKey}, NULL, 'complete', NULL, now())
    ON CONFLICT (migration_key) DO UPDATE
    SET status = 'complete', last_error = NULL, updated_at = now()
  `);
}

/** List every SQLite table so the migration report can account for all source data. */
function listSqliteTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; type: string }>;
  return rows.map((r) => r.name);
}

function listFtsVirtualTables(db: DatabaseSync): readonly string[] {
  return (db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND lower(sql) LIKE '%using fts5%'`)
    .all() as Array<{ name: string }>).map(({ name }) => name);
}

/** Return the narrow allowlisted reason for SQLite-owned or FTS5-owned tables. */
function disposableSqliteTableReason(virtualTables: readonly string[], table: string): string | undefined {
  if (table === "sqlite_sequence" || table.startsWith("sqlite_stat")) {
    return "SQLite internal bookkeeping table";
  }

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  tasks_fts and archived_tasks_fts contain derived search indexes, not the authoritative task records. PostgreSQL regenerates both surfaces from migrated task rows through generated tsvector columns, so the two canonical virtual tables and their shadows are intentional skips; extension-owned FTS tables still fail closed.
  */
  if (
    virtualTables.includes(table) &&
    (table === "tasks_fts" || table === "archived_tasks_fts")
  ) {
    return `FTS5 index replaced by PostgreSQL tsvector for ${table}`;
  }

  for (const name of virtualTables) {
    /*
    FNXC:PostgresMigration 2026-07-13-23:02:
    An FTS5 virtual table is a logical, user-visible data surface even though SQLite stores it through shadow tables. Only the implementation-owned shadow tables may be skipped; an unmapped virtual table must fail verification so search content cannot disappear during cutover.
    */
    if (
      table === `${name}_data` ||
      table === `${name}_idx` ||
      table === `${name}_content` ||
      table === `${name}_docsize` ||
      table === `${name}_config`
    ) {
      return `FTS5 implementation table for ${name}`;
    }
  }
  return undefined;
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
 * Returns an empty column list plus an empty target-column set when the table
 * does not exist in PostgreSQL. The target-column set also lets planning detect
 * a project_id partition without a second metadata query per table.
 */
interface PostgresColumnMetadata {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  attidentity: string | null;
  is_generated: number | string;
}

async function loadTargetColumnMetadata(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
): Promise<ReadonlyMap<string, readonly PostgresColumnMetadata[]>> {
  /*
  FNXC:PostgresMigration 2026-07-13-23:24:
  Migration planning must introspect a target schema once, not issue one or two catalog queries for every SQLite table. Group the verified 1:1 catalog rows by table and build each plan locally; this keeps startup cutover bounded as plugin tables grow.
  */
  const rows = (await db.execute(sql`
    SELECT
      c.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      a.attidentity,
      CASE WHEN a.attgenerated <> '' THEN 1 ELSE 0 END AS is_generated
    FROM information_schema.columns c
    JOIN pg_attribute a ON a.attname = c.column_name
    JOIN pg_class cls ON cls.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE c.table_schema = ${pgSchema}
      AND n.nspname = c.table_schema
      AND cls.relname = c.table_name
      AND a.attnum > 0
  `)) as unknown as Array<PostgresColumnMetadata & { table_name: string }>;
  const byTable = new Map<string, PostgresColumnMetadata[]>();
  for (const { table_name: tableName, ...column } of rows) {
    const columns = byTable.get(tableName) ?? [];
    columns.push(column);
    byTable.set(tableName, columns);
  }
  return byTable;
}

function resolveColumnMapping(
  pgTable: string,
  table: string,
  sqlite: DatabaseSync,
  targetColumnsByTable: ReadonlyMap<string, readonly PostgresColumnMetadata[]>,
): {
  columns: readonly ColumnMapping[];
  targetColumnNames: ReadonlySet<string>;
  unmappedSourceColumns: readonly string[];
} {
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
  // makes the join 1:1 per table and the data_type deterministic. Planning now
  // loads those verified rows once per schema and supplies this table's group,
  // avoiding repeated catalog queries without weakening the join invariant.
  const pgCols = targetColumnsByTable.get(pgTable) ?? [];

  if (pgCols.length === 0) {
    // No PostgreSQL table with this name — skip.
    return { columns: [], targetColumnNames: new Set(), unmappedSourceColumns: [] };
  }

  const pgByName = new Map(pgCols.map((c) => [c.column_name, c]));

  // SQLite columns (camelCase names).
  const sqliteCols = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
    name: string;
    type: string;
  }>;

  const mapping: ColumnMapping[] = [];
  const unmappedSourceColumns: string[] = [];
  for (const sc of sqliteCols) {
    /*
    FNXC:MultiProjectIsolation 2026-07-15-23:40:
    SQLite had no partition concept: a legacy `projectId` column is always the DOMAIN
    project field. Since migration 0011 split that domain field (`owner_project_id`)
    from the trigger/GUC-owned RLS partition (`project_id`), route the source value to
    `owner_project_id` whenever the target declares it. The partition still receives
    the registry-resolved project id through the existing unmapped-project_id insert
    path, so cutover preserves the source's domain value instead of coercing it away.
    */
    let pgName = toSnakeCase(sc.name);
    if (pgName === "project_id" && pgByName.has("owner_project_id")) {
      pgName = "owner_project_id";
    }
    const pgCol = pgByName.get(pgName);
    if (!pgCol) {
      /*
      FNXC:PostgresMigrationColumnCoverage 2026-07-14-12:10:
      Row-count and mapped-column checksums cannot detect a discarded source column. Record every unmatched source column so the table fails verification unless a future migration gives that column an explicit documented destination.
      */
      unmappedSourceColumns.push(sc.name);
      continue;
    }
    const type = classifyColumnType(pgCol);
    const hasJsonbDefault = type === "jsonb" && pgCol.column_default !== null;
    let nullJsonbFallback: string | undefined;
    if (type === "jsonb" && pgCol.is_nullable === "NO" && hasJsonbDefault) {
      // FNXC:PostgresMigration 2026-07-14-05:30:
      // Legacy SQLite rows can contain NULL/empty JSON even when the target is
      // NOT NULL with a default. Materialize that default during conversion so
      // one stale row cannot abort the entire first-boot migration.
      const match = /^'(.*)'::jsonb?$/s.exec(pgCol.column_default!);
      if (match) {
        const candidate = match[1].replace(/''/g, "'");
        try {
          JSON.parse(candidate);
          nullJsonbFallback = candidate;
        } catch {
          // Leave malformed defaults to PostgreSQL rather than inventing data.
        }
      }
      if (nullJsonbFallback === undefined) {
        /*
        FNXC:PostgresMigration 2026-07-14-10:43:
        A required jsonb column with a declared but unvalidated default is not equivalent to a default-free column. Fail the cutover closed instead of converting empty legacy text into a JSON string that silently overrides the target's intended default.
        */
        throw new Error(
          `Cannot migrate required jsonb column ${pgTable}.${pgName}: declared default could not be validated`,
        );
      }
    }
    const preserveEmptyJsonbString =
      type === "jsonb" && pgCol.is_nullable === "NO" && !hasJsonbDefault;
    mapping.push({ sqliteName: sc.name, pgName, type, nullJsonbFallback, preserveEmptyJsonbString });
  }

  return {
    columns: mapping,
    targetColumnNames: new Set(pgByName.keys()),
    unmappedSourceColumns,
  };
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

/*
FNXC:PostgresMigrationNulSanitize 2026-07-17-10:05 (moved to nul-sanitize.ts 2026-07-20):
PostgreSQL rejects U+0000 in text/varchar ("invalid byte sequence" / "\u0000 cannot be converted to text") and in json/jsonb ("unsupported Unicode escape sequence"), but SQLite TEXT stores it freely, so legacy databases can contain NUL bytes that abort the first-boot auto-migration. Strip U+0000 from every migrated string — plain text cells, string values and object keys inside JSON documents, and opaque legacy-preservation text cells — rather than failing the cutover. Sanitization happens inside convertValue/tagLegacyCell so the content-checksum verification (computeSourceCanonicalRows reuses convertValue) compares the sanitized source against the sanitized target and still passes.

stripNulChars/deepStripNulChars now live in ./nul-sanitize.js and are also
reused by the live chat/mailbox write paths (async-chat-store.ts,
async-message-store.ts), which can receive the same U+0000 byte from
unsanitized tool output at runtime, not just from legacy SQLite migration.
*/
import { stripNulChars, deepStripNulChars } from "./nul-sanitize.js";

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
 *   in that case legacy NULL values materialize the target default. Empty
 *   strings use that same default, or remain a JSON string scalar only when
 *   the required target declares no default. Declared defaults that cannot be
 *   validated fail the migration before conversion rather than becoming data.
 * - bytea: SQLite stores BLOB. We wrap it in a Buffer (postgres.js handles
 *   Buffer natively for bytea). NULL stays NULL.
 * - plain: passed through verbatim.
 *
 * Identity and generated columns are omitted at the insert-builder level
 * (never passed here).
 */
function convertValue(
  value: unknown,
  type: ColumnType,
  nullJsonbFallback?: string,
  preserveEmptyJsonbString = false,
): unknown {
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
          return nullJsonbFallback ?? (preserveEmptyJsonbString ? JSON.stringify(value) : null);
        }
        try {
          return JSON.stringify(deepStripNulChars(JSON.parse(trimmed)));
        } catch {
          // Malformed JSON — store as a JSON-encoded string scalar (valid jsonb).
          return JSON.stringify(stripNulChars(value));
        }
      }
      // Already a JS value (object/array/number/boolean) — stringify it.
      return JSON.stringify(deepStripNulChars(value));
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
      // PostgreSQL text/varchar rejects U+0000 outright; see NUL-sanitize note above.
      return typeof value === "string" ? stripNulChars(value) : value;
  }
}

type TaggedLegacyCell =
  | { readonly type: "null" }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "number"; readonly value: string }
  | { readonly type: "blob"; readonly value: string };

interface CanonicalLegacyRow {
  readonly hash: string;
  readonly json: string;
}

interface TableMigrationProgressCallbacks {
  readonly onCopyProgress?: (processedRows: number, sourceRows: number) => void;
  readonly onVerifying?: (
    stage: "target-count" | "source-content" | "target-content",
    sourceRows: number,
  ) => void;
}

function createQuarterProgressReporter(
  sourceRows: number,
  onCopyProgress?: (processedRows: number, sourceRows: number) => void,
): (processedRows: number) => void {
  let lastProgressQuarter = 0;
  return (processedRows) => {
    // The verifying and complete events represent the terminal 100% state.
    if (processedRows >= sourceRows) return;
    const progressQuarter = Math.floor((processedRows / sourceRows) * 4);
    if (progressQuarter > lastProgressQuarter) {
      lastProgressQuarter = progressQuarter;
      onCopyProgress?.(processedRows, sourceRows);
    }
  };
}

function tagLegacyCell(value: unknown): TaggedLegacyCell {
  if (value === null || value === undefined) return { type: "null" };
  if (Buffer.isBuffer(value)) {
    return { type: "blob", value: value.toString("base64") };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
  }
  // Legacy-preservation rows are stored as jsonb; jsonb rejects \u0000, so
  // opaque text cells get the same NUL sanitization as regular columns.
  return { type: "text", value: stripNulChars(String(value)) };
}

function canonicalizeLegacyRows(
  rows: readonly Record<string, unknown>[],
  occurrences = new Map<string, number>(),
): CanonicalLegacyRow[] {
  return rows.map((row) => {
    const tagged = Object.fromEntries(
      Object.keys(row).map((column) => [column, tagLegacyCell(row[column])]),
    );
    const json = stableJsonStringify(tagged);
    const occurrence = occurrences.get(json) ?? 0;
    occurrences.set(json, occurrence + 1);
    return {
      hash: createHash("sha256").update(json).update("\u0000").update(String(occurrence)).digest("hex"),
      json,
    };
  });
}

async function migrateLegacyPreservationTable(
  db: PostgresJsDatabase<Record<string, never>>,
  source: SqliteMigrationSource,
  plan: TablePlan,
  dryRun: boolean,
  progress: TableMigrationProgressCallbacks,
): Promise<TableMigrationResult> {
  const projectId = plan.partitionProjectId;
  const legacyPreservation = plan.legacyPreservation;
  if (!projectId || !legacyPreservation) {
    throw new Error(`projectId is required to preserve legacy SQLite table ${plan.table}`);
  }
  const sqlite = openSqlite(source.sqlitePath);
  try {
    const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(plan.table)}`).get() as { n: number };
    const sourceRows = Number(countRow.n);
    if (dryRun) {
      return {
        schema: plan.pgSchema,
        table: plan.pgTable,
        sourceRows,
        insertedRows: 0,
        targetRows: 0,
        verified: false,
        skipped: true,
        skipReason: "dry-run",
      };
    }

    let insertedRows = 0;
    let contentOk = true;
    const occurrences = new Map<string, number>();
    const sourceColumnOrder = (sqlite.prepare(
      `PRAGMA table_info(${quoteIdent(plan.table)})`,
    ).all() as Array<{ name: string }>).map(({ name }) => quoteIdent(name)).join(", ");
    const reportCopyProgress = createQuarterProgressReporter(sourceRows, progress.onCopyProgress);
    for (let offset = 0; offset < sourceRows; offset += INSERT_BATCH_SIZE) {
      const rawBatch = sqlite.prepare(
        `SELECT * FROM ${quoteIdent(plan.table)} ORDER BY ${sourceColumnOrder} LIMIT ? OFFSET ?`,
      ).all(INSERT_BATCH_SIZE, offset) as Array<Record<string, unknown>>;
      const batch = canonicalizeLegacyRows(rawBatch, occurrences);
      const values = batch.map((row) => sql`(
        ${projectId},
        ${row.hash},
        ${row.json}::jsonb,
        ${legacyPreservation.sourceSchemaSql},
        now()
      )`);
      const inserted = await db.execute(sql`
        INSERT INTO ${sql.raw(quoteIdent(plan.pgSchema))}.${sql.raw(quoteIdent(plan.pgTable))}
          (project_id, legacy_row_hash, legacy_row, source_schema_sql, migrated_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (project_id, legacy_row_hash) DO NOTHING
        RETURNING 1
      `) as unknown as { length?: number };
      insertedRows += Number(inserted.length ?? 0);

      const targetBatch = await db.execute(sql`
        SELECT legacy_row_hash, legacy_row, source_schema_sql
        FROM ${sql.raw(quoteIdent(plan.pgSchema))}.${sql.raw(quoteIdent(plan.pgTable))}
        WHERE project_id = ${projectId}
          AND legacy_row_hash IN (${sql.join(batch.map((row) => sql`${row.hash}`), sql`, `)})
      `) as unknown as Array<{
        legacy_row_hash: string;
        legacy_row: unknown;
        source_schema_sql: string;
      }>;
      const expectedBatch = new Map(batch.map((row) => [row.hash, row.json]));
      contentOk = contentOk && targetBatch.length === batch.length && targetBatch.every((row) =>
        expectedBatch.get(row.legacy_row_hash) === canonicalizeCell(row.legacy_row) &&
        row.source_schema_sql === legacyPreservation.sourceSchemaSql,
      );
      const processedRows = Math.min(offset + rawBatch.length, sourceRows);
      reportCopyProgress(processedRows);
    }

    progress.onVerifying?.("target-count", sourceRows);
    const targetCountRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM ${sql.raw(quoteIdent(plan.pgSchema))}.${sql.raw(quoteIdent(plan.pgTable))}
      WHERE project_id = ${projectId}
    `) as unknown as Array<{ n: number }>;
    const targetRows = Number(targetCountRows[0]?.n ?? 0);
    const verified = targetRows === sourceRows && contentOk;
    if (!verified) {
      log.warn(
        `Opaque legacy verification mismatch for ${plan.pgSchema}.${plan.pgTable}: ` +
          `source=${sourceRows}, target=${targetRows}`,
      );
    }
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
  progress: TableMigrationProgressCallbacks = {},
): Promise<TableMigrationResult> {
  if (plan.legacyPreservation) {
    return migrateLegacyPreservationTable(db, source, plan, dryRun, progress);
  }
  if (plan.unmappedSourceColumns.length > 0) {
    const sqlite = openSqlite(source.sqlitePath);
    try {
      const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(plan.table)}`).get() as { n: number };
      return {
        schema: plan.pgSchema,
        table: plan.pgTable,
        sourceRows: Number(countRow.n),
        insertedRows: 0,
        targetRows: 0,
        verified: false,
        skipped: false,
        skipReason: `SQLite columns have no PostgreSQL counterpart: ${plan.unmappedSourceColumns.join(", ")}`,
      };
    } finally {
      sqlite.close();
    }
  }
  if (plan.columns.length === 0) {
    const sqlite = openSqlite(source.sqlitePath);
    try {
      const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(plan.table)}`).get() as { n: number };
      const allowedSkip = plan.allowedSkipReason !== undefined;
      return {
        schema: plan.pgSchema,
        table: plan.pgTable,
        sourceRows: Number(countRow.n),
        insertedRows: 0,
        targetRows: 0,
        verified: allowedSkip,
        skipped: allowedSkip,
        skipReason: plan.allowedSkipReason ?? "no PostgreSQL table or mappable columns",
      };
    } finally {
      sqlite.close();
    }
  }
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
    const targetRows = await countTargetRows(db, plan.pgSchema, plan.pgTable, plan.partitionProjectId);
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
        targetRows: dryRun ? 0 : await countTargetRows(db, plan.pgSchema, plan.pgTable, plan.partitionProjectId),
        verified: dryRun ? false : true,
        skipped: dryRun ? true : false,
        skipReason: dryRun ? "dry-run" : "no source rows",
      };
    }

    // Stream rows in batches.
    const stmt = sqlite.prepare(`SELECT ${selectableCols} FROM ${quoteIdent(plan.table)}`);
    const batch: Record<string, unknown>[] = [];
    let processedRows = 0;
    const reportCopyProgress = createQuarterProgressReporter(sourceRows, progress.onCopyProgress);
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const batchSize = batch.length;
      const inserted = await insertBatch(db, plan, insertableCols, batch, hasIdentityCol);
      insertedRows += inserted;
      processedRows += batchSize;
      batch.length = 0;
      reportCopyProgress(processedRows);
    };

    for (const row of stmt.all() as Array<Record<string, unknown>>) {
      const converted: Record<string, unknown> = {};
      for (const col of insertableCols) {
        converted[col.pgName] = convertValue(
          row[col.sqliteName],
          col.type,
          col.nullJsonbFallback,
          col.preserveEmptyJsonbString,
        );
      }
      batch.push(converted);
      if (batch.length >= INSERT_BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
    progress.onVerifying?.("target-count", sourceRows);

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
    const targetRows = await countTargetRows(db, plan.pgSchema, plan.pgTable, plan.partitionProjectId);
    /*
    FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
    A bound project imports into a shared PostgreSQL schema. Tables with a project_id column remain exact per-partition checks; intentionally cluster-shared project tables must instead prove the converted source multiset is contained in the accumulated target. A same-key/different-content conflict still fails because the exact source row is absent.
    */
    const verifiesSharedProjectTable =
      plan.pgSchema === PROJECT_SCHEMA && plan.partitionProjectId === undefined;
    const rowCountOk = verifiesSharedProjectTable
      ? targetRows >= sourceRows
      : targetRows === sourceRows;
    let contentOk = true;
    if (rowCountOk && sourceRows > 0) {
      progress.onVerifying?.("source-content", sourceRows);
      const sourceCanonicalRows = computeSourceCanonicalRows(
        sqlite, plan.table, insertableCols, plan.partitionProjectId,
      );
      progress.onVerifying?.("target-content", sourceRows);
      const targetCanonicalRows = await computeTargetCanonicalRows(
        db, plan.pgSchema, plan.pgTable, insertableCols, plan.partitionProjectId,
      );
      /*
      FNXC:PostgresMigrationSharedSingleton 2026-07-19-09:50:
      distributed_task_id_state always uses project-scoped dominance verification
      (GREATEST merge + composite PK). Other shared project tables keep multiset
      subset when unbound; partitioned tables keep exact checksums.
      */
      contentOk = isSharedSingletonTable(plan.pgSchema, plan.pgTable)
        ? await verifySharedSingletonTable(
            db, plan.pgSchema, plan.pgTable,
            sqlite.prepare(`SELECT * FROM ${quoteIdent(plan.table)}`).all() as Record<string, unknown>[],
            plan.partitionProjectId,
          )
        : verifiesSharedProjectTable
          ? isCanonicalMultisetSubset(sourceCanonicalRows, targetCanonicalRows)
          : checksumCanonicalRows(sourceCanonicalRows) === checksumCanonicalRows(targetCanonicalRows);
      if (!contentOk) {
        log.warn(
          `Content checksum mismatch for ${plan.pgSchema}.${plan.pgTable}: ` +
            `source=${checksumCanonicalRows(sourceCanonicalRows)}, target=${checksumCanonicalRows(targetCanonicalRows)}`,
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
  const hasMappedProjectId = cols.some((column) => column.pgName === "project_id");
  const colList = [
    ...cols.map((c) => quoteIdent(c.pgName)),
    ...(plan.partitionProjectId && !hasMappedProjectId ? [quoteIdent("project_id")] : []),
  ].join(", ");
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

  /*
  FNXC:PostgresMigrationRetry 2026-07-14-09:06:
  The former non-transactional migrator could commit a source row under its NULL or stale project_id before a later table aborted startup. On retry, re-key only a stale-partition row whose complete migrated column set still matches the SQLite source. If an identical authoritative composite-key row already exists, remove only its stale duplicate; updating globally keyed rows in place preserves dependent rows and avoids foreign-key cascades.
  */
  if (plan.partitionProjectId) {
    const repairRows = rows.map((row) => ({
      row,
      candidateOwners: Array.from(new Set([
        "__legacy_unscoped__",
        ...(hasMappedProjectId && typeof row.project_id === "string" && row.project_id !== plan.partitionProjectId
          ? [row.project_id]
          : []),
      ])),
    }));
    if (repairRows.length > 0) {
      const comparisonsFor = (
        alias: string,
        row: Readonly<Record<string, unknown>>,
      ) => cols
        .filter((column) => column.pgName !== "project_id")
        .map((column) => {
          const targetColumn = sql.raw(`${alias}.${quoteIdent(column.pgName)}`);
          return sql`${targetColumn} IS NOT DISTINCT FROM ${buildCell(column, row[column.pgName])}`;
        });
      const ownerSet = (owners: readonly string[]) => sql`(${sql.join(owners.map((owner) => sql`${owner}`), sql`, `)})`;
      const stalePredicates = repairRows.map(({ row, candidateOwners }) => sql`(
        target.project_id IN ${ownerSet(candidateOwners)}
        AND ${sql.join(comparisonsFor("target", row), sql` AND `)}
      )`);
      const duplicatePredicates = repairRows.map(({ row, candidateOwners }) => {
        const authoritativeComparisons = comparisonsFor("authoritative", row);
        return sql`(
          target.project_id IN ${ownerSet(candidateOwners)}
          AND ${sql.join(comparisonsFor("target", row), sql` AND `)}
          AND EXISTS (
            SELECT 1 FROM ${sql.raw(schemaQualifiedTable)} AS authoritative
            WHERE authoritative.project_id = ${plan.partitionProjectId}
              AND ${sql.join(authoritativeComparisons, sql` AND `)}
          )
        )`;
      });
      const removedDuplicates = (await db.execute(sql`
        DELETE FROM ${sql.raw(schemaQualifiedTable)} AS target
        WHERE ${sql.join(duplicatePredicates, sql` OR `)}
        RETURNING 1
      `)) as unknown as { length?: number };
      const rekeyed = (await db.execute(sql`
        UPDATE ${sql.raw(schemaQualifiedTable)} AS target
        SET project_id = ${plan.partitionProjectId}
        WHERE ${sql.join(stalePredicates, sql` OR `)}
        RETURNING 1
      `)) as unknown as { length?: number };
      const repairedCount = Number(removedDuplicates?.length ?? 0) + Number(rekeyed?.length ?? 0);
      if (repairedCount > 0) {
        log.log(
          `Reconciled ${repairedCount} stale partition row(s) in ${plan.pgSchema}.${plan.pgTable}`,
        );
      }
    }
  }

  const valueRowsBuilt = rows.map((row) => {
    const cells = cols.map((c) =>
      c.pgName === "project_id" && plan.partitionProjectId
        ? sql`${plan.partitionProjectId}`
        : buildCell(c, row[c.pgName]),
    );
    if (plan.partitionProjectId && !hasMappedProjectId) {
      cells.push(sql`${plan.partitionProjectId}`);
    }
    return sql`(${sql.join(cells, sql`, `)})`;
  });

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  The fresh PostgreSQL baseline seeds the two central singleton rows so a database without SQLite can boot. During SQLite cutover those defaults are placeholders: the legacy singleton is authoritative and must replace them instead of being discarded by ON CONFLICT DO NOTHING. No other table receives overwrite semantics.
  */
  const replacesCentralSeed =
    plan.pgSchema === CENTRAL_SCHEMA &&
    (plan.pgTable === "central_settings" || plan.pgTable === "global_concurrency");
  const isSharedSingleton = isSharedSingletonTable(plan.pgSchema, plan.pgTable);
  const conflictClause = replacesCentralSeed
    ? sql.raw(`ON CONFLICT (${quoteIdent("id")}) DO UPDATE SET ${cols
        .filter((column) => column.pgName !== "id")
        .map((column) => `${quoteIdent(column.pgName)} = EXCLUDED.${quoteIdent(column.pgName)}`)
        .join(", ")}`)
    : isSharedSingleton
      ? buildSharedSingletonConflictClause(plan.pgSchema, plan.pgTable, cols)
      : sql`ON CONFLICT DO NOTHING`;

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
    ${conflictClause}
    RETURNING 1`;

  const result = (await db.execute(query)) as unknown as { length?: number };
  return Number(result?.length ?? 0);
}

/** Count rows in a PostgreSQL table. */
async function countTargetRows(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  table: string,
  projectId?: string,
): Promise<number> {
  const result = (await db.execute(
    projectId
      ? sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(quoteIdent(table))} WHERE project_id = ${projectId}`
      : sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(quoteIdent(table))}`,
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

/** Canonicalize a converted source value as PostgreSQL will return it. */
function canonicalizeConvertedCell(value: unknown, type: ColumnType): string {
  if (type === "jsonb" && typeof value === "string") {
    try {
      return canonicalizeCell(JSON.parse(value));
    } catch {
      // Defensive fallback: convertValue normally guarantees valid JSON text.
    }
  }
  return canonicalizeCell(value);
}

/**
 * Compute a content checksum over the SQLite source rows for a table. Reads
 * the SAME insertable columns the copy used (so unmapped/generated columns do
 * not pollute the checksum), applies the SAME per-cell conversion the copy
 * used (so a jsonb cell is checksummed in its converted form), and MD5s the
 * resulting canonical row stream. Rows are sorted by every insertable column
 * so composite keys and duplicate leading values remain deterministic.
 *
 * FNXC:PostgresMigration 2026-06-26-15:50:
 * The checksum is computed over the CONVERTED values, not the raw SQLite
 * values, because the migrated PostgreSQL rows store the converted values
 * (jsonb parsed, bytea as Buffer). Comparing converted-source vs stored-target
 * is the correct semantic: it verifies the copy faithfully reproduced what the
 * conversion produced.
 */
function computeSourceCanonicalRows(
  sqlite: DatabaseSync,
  table: string,
  cols: readonly ColumnMapping[],
  partitionProjectId?: string,
): string[] {
  if (cols.length === 0) return [];
  const selectCols = cols.map((c) => quoteIdent(c.sqliteName)).join(", ");
  const rows = sqlite
    .prepare(`SELECT ${selectCols} FROM ${quoteIdent(table)}`)
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    let canonical = "";
    for (const col of cols) {
      const converted = col.pgName === "project_id" && partitionProjectId
        ? partitionProjectId
        : convertValue(
            row[col.sqliteName],
            col.type,
            col.nullJsonbFallback,
            col.preserveEmptyJsonbString,
          );
      canonical += `${canonicalizeConvertedCell(converted, col.type)}\u0001`;
    }
    return canonical;
  }).sort();
}

function checksumCanonicalRows(canonicalRows: readonly string[]): string {
  const hash = createHash("md5");
  for (const row of canonicalRows) {
    hash.update(row);
    hash.update("\u0002");
  }
  return hash.digest("hex");
}

function isCanonicalMultisetSubset(sourceRows: readonly string[], targetRows: readonly string[]): boolean {
  const targetCounts = new Map<string, number>();
  for (const row of targetRows) targetCounts.set(row, (targetCounts.get(row) ?? 0) + 1);
  for (const row of sourceRows) {
    const available = targetCounts.get(row) ?? 0;
    if (available === 0) return false;
    targetCounts.set(row, available - 1);
  }
  return true;
}

/**
 * Compute a content checksum over the PostgreSQL target rows for a table.
 * Selects the SAME insertable columns the copy used and MD5s the canonical
 * row stream. Rows use the same complete ordering as the source checksum.
 *
 * jsonb columns come back from postgres.js as already-parsed JS values, and
 * bytea as Buffer, so canonicalizeCell handles them directly. The PostgreSQL
 * md5() aggregate is intentionally NOT used here because the conversion rules
 * for jsonb canonicalization (sorted keys) must match the source side exactly,
 * and doing both sides in Node with the same canonicalizeCell function
 * guarantees they agree.
 */
async function computeTargetCanonicalRows(
  db: PostgresJsDatabase<Record<string, never>>,
  pgSchema: string,
  table: string,
  cols: readonly ColumnMapping[],
  projectId?: string,
): Promise<string[]> {
  if (cols.length === 0) return [];
  const selectCols = cols.map((c) => quoteIdent(c.pgName)).join(", ");
  const rows = (await db.execute(
    sql`SELECT ${sql.raw(selectCols)} FROM ${sql.raw(quoteIdent(pgSchema))}.${sql.raw(
      quoteIdent(table),
    )}${projectId ? sql` WHERE project_id = ${projectId}` : sql``}`,
  )) as unknown as Array<Record<string, unknown>>;

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  Content verification must not depend on database collation. SQLite BINARY and PostgreSQL locale collation can order identical mixed-case paths differently, so both sides canonicalize complete rows and sort those strings in Node before hashing.
  */
  return rows.map((row) => {
    let canonical = "";
    for (const col of cols) {
      canonical += `${canonicalizeCell(row[col.pgName])}\u0001`;
    }
    return canonical;
  }).sort();
}
