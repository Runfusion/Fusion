/**
 * Reconcile public.fusion_schema_migrations after a project/archive restore.
 *
 * FNXC:PostgresBackup 2026-09-04-05:45:
 * Paired dumps replace `project`, `archive`, and `central` only. Restoring an
 * older dump therefore drops later relations or ALTER columns while leaving the
 * current binary's versions in `public.fusion_schema_migrations`. Startup then
 * skips those migrations and TaskStore queries fail. After every project restore,
 * rewind numeric ledger rows from the earliest missing table OR column sentinel
 * and replay `applySchemaBaseline` so restored schemas and bookkeeping match.
 *
 * Unstamp and baseline replay share one transaction so a failed apply cannot
 * leave `public.fusion_schema_migrations` rewound while project/archive still
 * reflects the restored dump.
 *
 * FNXC:PostgresBackup 2026-09-04-05:12:
 * Postgres.js 3.4.9 defaults `ssl` to false and does not honor libpq `sslmode`
 * in the URL. Remote reconciliation connections must pass `ssl: "verify-full"`.
 * Loopback/embedded hosts keep SSL off because the bundled cluster has no TLS.
 */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { parsePgUrl } from "./pg-backup.js";
import {
  applySchemaBaseline,
  AI_MERGE_REVIEW_RECONCILIATION_VERSION,
  AGENT_ACTIVITY_EVENTS_VERSION,
  BULK_COMPLETION_REFUSAL_AT_VERSION,
  CHAT_SESSION_MEMORY_FOCUS_VERSION,
  CHAT_SESSION_PINS_VERSION,
  CHAT_SESSION_TAGS_VERSION,
  CONFIGURATION_REVISIONS_VERSION,
  EXECUTOR_ESCALATION_ATTEMPT_VERSION,
  EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
  GITHUB_CHECK_STATES_VERSION,
  IDEATION_SCHEMA_VERSION,
  IMPORT_TRANSLATION_CACHE_VERSION,
  LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION,
  MEMORY_RECALL_RECORDS_VERSION,
  MIGRATION_BOOKKEEPING_TABLE,
  MISSION_LINEAGE_STOP_VERSION,
  MISSION_TASK_PREFIX_VERSION,
  PATCHNODE_ENTRIES_VERSION,
  PLANNING_ACTIVE_TIMING_VERSION,
  REVIEW_CONVERGENCE_STAGE_VERSION,
  SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
  SESSION_CONTENTION_WAIT_STATE_VERSION,
  SPEC_LOCK_DRIFT_REPORT_VERSION,
  TASK_EXTERNAL_BLOCK_VERSION,
  TASK_LIFECYCLE_CONSUMERS_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
  TASK_MERGER_MODEL_LANE_VERSION,
  TASK_RECOMMENDATIONS_VERSION,
  TASK_REPOSITORY_SCOPE_VERSION,
  TASK_REQUIRE_PLAN_APPROVAL_VERSION,
  TASK_STEP_REPORTS_VERSION,
  UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION,
  WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
  WORKSPACE_COORDINATION_LEASES_SCHEMA_VERSION,
} from "./schema-applier.js";

export interface RestoreMigrationCatalog {
  relationExists(qualifiedName: string): Promise<boolean>;
  columnExists(qualifiedRelation: string, column: string): Promise<boolean>;
  applyRewindAndReplay(floor: string | null): Promise<void>;
}

export interface RestoredSchemaColumnSentinel {
  readonly relation: string;
  readonly column: string;
}

export interface RestoredSchemaRelationSentinel {
  readonly version: string;
  readonly relations?: readonly string[];
  readonly columns?: readonly RestoredSchemaColumnSentinel[];
}

const INITIAL_SCHEMA_VERSION = "0000";

function tasksColumn(column: string): RestoredSchemaColumnSentinel {
  return { relation: "project.tasks", column };
}

/**
 * Table and column sentinels used to detect a restored schema that is older
 * than the recorded ledger. Checked in version order; the first miss is the rewind floor.
 * Central-schema tables are excluded: project dumps do not replace `central`.
 * Column sentinels apply only when the parent relation exists, so a dump taken
 * after CREATE TABLE but before a later ALTER still rewinds that ALTER version.
 */
export const RESTORED_SCHEMA_RELATION_SENTINELS: readonly RestoredSchemaRelationSentinel[] = [
  { version: INITIAL_SCHEMA_VERSION, relations: ["project.tasks"] },
  { version: LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION, relations: ["project.boards"] },
  { version: SESSION_ADVISOR_ENABLED_SCHEMA_VERSION, columns: [tasksColumn("session_advisor_enabled")] },
  { version: IMPORT_TRANSLATION_CACHE_VERSION, relations: ["project.import_translation_cache"] },
  { version: CHAT_SESSION_PINS_VERSION, columns: [{ relation: "project.chat_sessions", column: "pinned_at" }] },
  { version: EXECUTOR_TOOL_FAILURE_RETRY_VERSION, columns: [tasksColumn("consecutive_tool_failure_retry_count")] },
  { version: EXECUTOR_ESCALATION_ATTEMPT_VERSION, columns: [tasksColumn("executor_escalation_attempted")] },
  { version: TASK_MERGER_MODEL_LANE_VERSION, columns: [tasksColumn("merger_model_id")] },
  { version: BULK_COMPLETION_REFUSAL_AT_VERSION, columns: [tasksColumn("bulk_completion_refusal_at")] },
  { version: CONFIGURATION_REVISIONS_VERSION, relations: ["project.configuration_revisions"] },
  { version: IDEATION_SCHEMA_VERSION, relations: ["project.ideation_sessions"] },
  { version: WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION, columns: [tasksColumn("workflow_ir_pin")] },
  { version: PLANNING_ACTIVE_TIMING_VERSION, columns: [tasksColumn("cumulative_planning_ms")] },
  { version: MISSION_LINEAGE_STOP_VERSION, relations: ["project.mission_lineage_stops"] },
  { version: CHAT_SESSION_TAGS_VERSION, relations: ["project.chat_tags"] },
  { version: MISSION_TASK_PREFIX_VERSION, columns: [{ relation: "project.missions", column: "task_prefix" }] },
  {
    version: TASK_LIFECYCLE_OUTBOX_VERSION,
    relations: ["project.task_lifecycle_events", "project.task_lifecycle_event_seq"],
  },
  {
    version: TASK_LIFECYCLE_CONSUMERS_VERSION,
    relations: ["project.task_lifecycle_consumer_registrations"],
  },
  { version: UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION, relations: ["project.unplanned_execution_blocks"] },
  { version: TASK_RECOMMENDATIONS_VERSION, columns: [tasksColumn("recommendations")] },
  { version: GITHUB_CHECK_STATES_VERSION, relations: ["project.github_check_states"] },
  { version: AGENT_ACTIVITY_EVENTS_VERSION, relations: ["project.agent_activity_events"] },
  { version: SPEC_LOCK_DRIFT_REPORT_VERSION, relations: ["project.spec_locks"] },
  { version: MEMORY_RECALL_RECORDS_VERSION, relations: ["project.memory_recall_records"] },
  {
    version: WORKSPACE_COORDINATION_LEASES_SCHEMA_VERSION,
    relations: ["project.workspace_coordination_leases"],
  },
  { version: AI_MERGE_REVIEW_RECONCILIATION_VERSION, columns: [tasksColumn("ai_merge_review_reconciliation")] },
  { version: TASK_REPOSITORY_SCOPE_VERSION, columns: [tasksColumn("repository_scope")] },
  { version: REVIEW_CONVERGENCE_STAGE_VERSION, columns: [tasksColumn("review_convergence_stage")] },
  { version: CHAT_SESSION_MEMORY_FOCUS_VERSION, columns: [{ relation: "project.chat_sessions", column: "memory_focus" }] },
  { version: SESSION_CONTENTION_WAIT_STATE_VERSION, columns: [tasksColumn("session_contention_wait_reason")] },
  { version: TASK_STEP_REPORTS_VERSION, columns: [tasksColumn("step_reports")] },
  { version: TASK_EXTERNAL_BLOCK_VERSION, columns: [tasksColumn("external_block")] },
  { version: TASK_REQUIRE_PLAN_APPROVAL_VERSION, columns: [tasksColumn("require_plan_approval")] },
  { version: PATCHNODE_ENTRIES_VERSION, relations: ["project.patchnode_entries"] },
];

export async function detectRestoredSchemaRewindFloor(
  catalog: RestoreMigrationCatalog,
): Promise<string | null> {
  for (const sentinel of RESTORED_SCHEMA_RELATION_SENTINELS) {
    let missing = false;
    for (const relation of sentinel.relations ?? []) {
      if (await catalog.relationExists(relation)) continue;
      missing = true;
      break;
    }
    if (!missing) {
      for (const column of sentinel.columns ?? []) {
        if (!(await catalog.relationExists(column.relation))) continue;
        if (await catalog.columnExists(column.relation, column.column)) continue;
        missing = true;
        break;
      }
    }
    if (missing) return sentinel.version;
  }
  return null;
}

export async function reconcileRestoredSchemaMigrations(
  catalog: RestoreMigrationCatalog,
): Promise<{ rewoundFrom: string | null }> {
  const rewoundFrom = await detectRestoredSchemaRewindFloor(catalog);
  await catalog.applyRewindAndReplay(rewoundFrom);
  return { rewoundFrom };
}

function splitQualifiedRelation(qualifiedName: string): { schema: string; table: string } {
  const separator = qualifiedName.indexOf(".");
  if (separator <= 0) return { schema: "public", table: qualifiedName };
  return { schema: qualifiedName.slice(0, separator), table: qualifiedName.slice(separator + 1) };
}

function ensureBookkeepingSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

function deleteStampedFromSql(floor: number): string {
  return `
    DELETE FROM public.${MIGRATION_BOOKKEEPING_TABLE}
    WHERE version ~ '^[0-9]+$' AND CAST(version AS integer) >= ${floor}
  `;
}

export function createDrizzleRestoreMigrationCatalog(
  db: PostgresJsDatabase<Record<string, never>>,
): RestoreMigrationCatalog {
  return {
    async relationExists(qualifiedName) {
      const rows = (await db.execute(
        sql`SELECT to_regclass(${qualifiedName}) AS rel`,
      )) as unknown as Array<{ rel: string | null }>;
      return rows[0]?.rel != null;
    },
    async columnExists(qualifiedRelation, column) {
      const { schema, table } = splitQualifiedRelation(qualifiedRelation);
      const rows = (await db.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = ${schema}
            AND table_name = ${table}
            AND column_name = ${column}
        ) AS present
      `)) as unknown as Array<{ present: boolean }>;
      return rows[0]?.present === true;
    },
    async applyRewindAndReplay(floor) {
      /*
       * FNXC:PostgresBackup 2026-09-04-05:45:
       * Unstamp and applySchemaBaseline must share one transaction. Baseline
       * already opens a nested savepoint; if it throws, this outer transaction
       * rolls the DELETE back so restore rollback cannot observe a rewound ledger.
       */
      await db.transaction(async (tx) => {
        if (floor) {
          const parsedFloor = Number.parseInt(floor, 10);
          if (!Number.isFinite(parsedFloor)) {
            throw new Error(`Invalid migration version for restore rewind: ${floor}`);
          }
          await tx.execute(sql.raw(ensureBookkeepingSql()));
          await tx.execute(sql.raw(deleteStampedFromSql(parsedFloor)));
        }
        await applySchemaBaseline(tx);
      });
    },
  };
}

/**
 * FNXC:PostgresBackup 2026-09-04-05:12:
 * Embedded/loopback clusters have no TLS. Any other host is treated as remote
 * and must use certificate verification; postgres.js will not infer this from
 * a URL `sslmode` query parameter.
 */
export function reconciliationPostgresSsl(connectionString: string): false | "verify-full" {
  const host = (parsePgUrl(connectionString).host ?? "").toLowerCase();
  if (
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("/")
  ) {
    return false;
  }
  return "verify-full";
}

export async function reconcileRestoredSchemaMigrationsFromUrl(
  connectionString: string,
): Promise<{ rewoundFrom: string | null }> {
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    ssl: reconciliationPostgresSsl(connectionString),
  });
  try {
    const db = drizzle(client);
    return await reconcileRestoredSchemaMigrations(createDrizzleRestoreMigrationCatalog(db));
  } finally {
    await client.end({ timeout: 5 });
  }
}
