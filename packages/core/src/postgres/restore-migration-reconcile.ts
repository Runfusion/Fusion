/**
 * Reconcile public.fusion_schema_migrations after a project/archive restore.
 *
 * FNXC:PostgresBackup 2026-09-04-05:59:
 * Paired dumps replace `project`, `archive`, and `central` only. Restoring an
 * older dump therefore drops later relations or ALTER columns while leaving the
 * current binary's versions in `public.fusion_schema_migrations`. Startup then
 * skips those migrations and TaskStore queries fail. After every project restore,
 * rewind numeric ledger rows from the earliest missing table OR ALTER column
 * sentinel — including credential-instance fields and `messages.archived` —
 * and replay `applySchemaBaseline` so restored schemas and bookkeeping match.
 *
 * FNXC:PostgresBackup 2026-09-04-06:22:
 * The catalog must include 0011 `owner_project_id` and similarly numbered early
 * project objects. 0000 already ships `chat_sessions.pinned_at`, so a dump from
 * 0010 makes the 0012 sentinel look present; without 0011 in the catalog the
 * floor jumps to a later miss and leaves 0011 stamped. Replay then skips the
 * domain column and todo/chat/research queries fail.
 *
 * FNXC:PostgresBackup 2026-09-04-07:51:
 * 0054 adds `project.agent_ratings.project_id`; 0000 still has no such column.
 * Without that sentinel a pre-0054 dump leaves 0054/0055 stamped and rating
 * reads/deletes fail. Rewinding from 0054 also unstamps 0055's partition repair.
 *
 * FNXC:PostgresBackup 2026-09-04-08:09:
 * 0006 already ADD COLUMNs `project_id` (NOT NULL, RLS, trigger) and rewrites
 * PKs that lack it. 0054/0055 are targeted repairs of the composite identity
 * `(project_id, id)` when the column landed but the PK stayed `(id)`. Column
 * presence is not enough; rewind must also match that primary key.
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
  AGENT_RATING_PROJECT_ISOLATION_VERSION,
  ANALYTICS_ISOLATION_SCHEMA_VERSION,
  AUTOMATION_ISOLATION_SCHEMA_VERSION,
  BULK_COMPLETION_REFUSAL_AT_VERSION,
  CHAT_SESSION_MEMORY_FOCUS_VERSION,
  CHAT_SESSION_PINS_VERSION,
  CHAT_SESSION_TAGS_VERSION,
  CONFIGURATION_REVISIONS_VERSION,
  CREDENTIAL_INSTANCE_SELECTION_VERSION,
  EXECUTOR_ESCALATION_ATTEMPT_VERSION,
  EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
  GITHUB_CHECK_STATES_VERSION,
  IDEATION_SCHEMA_VERSION,
  IMPORT_TRANSLATION_CACHE_VERSION,
  LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION,
  MEMORY_RECALL_RECORDS_VERSION,
  MESSAGE_ARCHIVE_SCHEMA_VERSION,
  MIGRATION_BOOKKEEPING_TABLE,
  MILESTONE_ASSERTION_PROVENANCE_VERSION,
  MISSION_FEATURE_SPEC_ALIGNMENT_VERSION,
  MISSION_LINEAGE_STOP_VERSION,
  MISSION_TASK_PREFIX_VERSION,
  MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION,
  MULTI_PROJECT_CUTOVER_SCHEMA_VERSION,
  MULTI_ROLE_WORKFLOW_AGENTS_VERSION,
  OWNER_PROJECT_ID_SPLIT_VERSION,
  PATCHNODE_ENTRIES_VERSION,
  PLANNING_ACTIVE_TIMING_VERSION,
  PROJECT_OWNERSHIP_SCHEMA_VERSION,
  QUEUED_EPISODE_SIGNATURE_VERSION,
  RESEARCH_FEATURE_PROVENANCE_VERSION,
  REVIEW_CONVERGENCE_STAGE_VERSION,
  SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
  SESSION_CONTENTION_WAIT_STATE_VERSION,
  SPEC_LOCK_DRIFT_REPORT_VERSION,
  SQLITE_SCHEMA_PARITY_VERSION,
  TASK_DECLARED_SYMBOLS_VERSION,
  TASK_EXTERNAL_BLOCK_VERSION,
  TASK_LIFECYCLE_CONSUMERS_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
  TASK_MERGER_MODEL_LANE_VERSION,
  TASK_PROPOSAL_CLAIM_VERSION,
  TASK_RECOMMENDATIONS_VERSION,
  TASK_REPOSITORY_SCOPE_VERSION,
  TASK_REQUIRE_PLAN_APPROVAL_VERSION,
  TASK_STEP_REPORTS_VERSION,
  TASK_WEDGE_NOTIFICATION_VERSION,
  UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION,
  VALIDATOR_INPUT_FINGERPRINT_VERSION,
  WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
  WORKFLOW_PRINCIPAL_FENCE_VERSION,
  WORKFLOW_TASK_CONTINUATIONS_VERSION,
  WORKSPACE_COORDINATION_LEASES_SCHEMA_VERSION,
} from "./schema-applier.js";

export interface RestoreMigrationCatalog {
  relationExists(qualifiedName: string): Promise<boolean>;
  columnExists(qualifiedRelation: string, column: string): Promise<boolean>;
  primaryKeyColumns(qualifiedRelation: string): Promise<readonly string[] | null>;
  applyRewindAndReplay(floor: string | null): Promise<void>;
}

export interface RestoredSchemaColumnSentinel {
  readonly relation: string;
  readonly column: string;
}

export interface RestoredSchemaPrimaryKeySentinel {
  readonly relation: string;
  readonly columns: readonly string[];
}

export interface RestoredSchemaRelationSentinel {
  readonly version: string;
  readonly relations?: readonly string[];
  readonly columns?: readonly RestoredSchemaColumnSentinel[];
  readonly primaryKeys?: readonly RestoredSchemaPrimaryKeySentinel[];
}

const INITIAL_SCHEMA_VERSION = "0000";

function tasksColumn(column: string): RestoredSchemaColumnSentinel {
  return { relation: "project.tasks", column };
}

/*
FNXC:PostgresBackup 2026-09-04-07:29:
DELIBERATE-LITERAL — `project.messages.archived` is the 0058 mailbox-archive SQL
column, not the board lifecycle lane. The census matches `column: "archived"` as a
query filter; this constant names the schema sentinel so restore rewind is not
counted as a task.column comparison.
*/
const MESSAGE_ARCHIVED_SQL_COLUMN = "archived";

function ownerProjectIdColumn(table: string): RestoredSchemaColumnSentinel {
  return { relation: `project.${table}`, column: "owner_project_id" };
}

/**
 * Tables that migration 0011 splits onto a nullable domain `owner_project_id`.
 * Checked independently so a 0010 dump that already has 0000 `pinned_at` still
 * unstamps 0011 when any of these columns is missing.
 */
const OWNER_PROJECT_ID_SPLIT_TABLES = [
  "research_runs",
  "experiment_sessions",
  "todo_lists",
  "eval_runs",
  "chat_sessions",
  "chat_rooms",
  "ai_sessions",
  "chat_token_usage",
  "project_insights",
  "project_insight_runs",
  "cli_sessions",
] as const;

/**
 * Table and column sentinels used to detect a restored schema that is older
 * than the recorded ledger. Checked in version order; the first miss is the rewind floor.
 * Central-schema tables are excluded: project dumps do not replace `central`.
 * Column sentinels apply only when the parent relation exists, so a dump taken
 * after CREATE TABLE but before a later ALTER still rewinds that ALTER version.
 * Primary-key sentinels apply the same parent-exists rule and compare column
 * order exactly.
 *
 * FNXC:PostgresBackup 2026-09-04-06:22:
 * Early numbered migrations that add project objects must appear here in
 * version order. Skipping 0011 (or 0001/0002/0003/0005/0006) lets a later
 * present sentinel become the floor and leaves the omitted version stamped.
 */
export const RESTORED_SCHEMA_RELATION_SENTINELS: readonly RestoredSchemaRelationSentinel[] = [
  {
    version: INITIAL_SCHEMA_VERSION,
    relations: [
      "project.tasks",
      "project.messages",
      "project.chat_sessions",
      "project.missions",
      "project.mission_features",
      "project.mission_contract_assertions",
      "project.workflow_work_items",
      "project.agents",
      "project.automations",
      "project.activity_log",
      "project.deployments",
      "project.__meta",
      "project.task_document_revisions",
      "project.todo_lists",
      "project.research_runs",
      "project.eval_runs",
      "project.experiment_sessions",
      "project.chat_rooms",
      "project.ai_sessions",
      "project.chat_token_usage",
      "project.project_insights",
      "project.project_insight_runs",
      "project.cli_sessions",
      "project.agent_ratings",
    ],
  },
  { version: AUTOMATION_ISOLATION_SCHEMA_VERSION, columns: [{ relation: "project.automations", column: "project_id" }] },
  { version: ANALYTICS_ISOLATION_SCHEMA_VERSION, columns: [{ relation: "project.activity_log", column: "project_id" }] },
  { version: MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION, columns: [{ relation: "project.deployments", column: "project_id" }] },
  { version: LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION, relations: ["project.boards"] },
  {
    version: MULTI_PROJECT_CUTOVER_SCHEMA_VERSION,
    columns: [
      { relation: "project.__meta", column: "project_id" },
      { relation: "project.task_document_revisions", column: "legacy_sqlite_id" },
    ],
  },
  { version: PROJECT_OWNERSHIP_SCHEMA_VERSION, relations: ["project.mission_feature_evidence_links"] },
  { version: SQLITE_SCHEMA_PARITY_VERSION, columns: [tasksColumn("board_id")] },
  { version: SESSION_ADVISOR_ENABLED_SCHEMA_VERSION, columns: [tasksColumn("session_advisor_enabled")] },
  { version: IMPORT_TRANSLATION_CACHE_VERSION, relations: ["project.import_translation_cache"] },
  {
    version: OWNER_PROJECT_ID_SPLIT_VERSION,
    columns: OWNER_PROJECT_ID_SPLIT_TABLES.map(ownerProjectIdColumn),
  },
  { version: CHAT_SESSION_PINS_VERSION, columns: [{ relation: "project.chat_sessions", column: "pinned_at" }] },
  { version: EXECUTOR_TOOL_FAILURE_RETRY_VERSION, columns: [tasksColumn("consecutive_tool_failure_retry_count")] },
  { version: EXECUTOR_ESCALATION_ATTEMPT_VERSION, columns: [tasksColumn("executor_escalation_attempted")] },
  { version: TASK_MERGER_MODEL_LANE_VERSION, columns: [tasksColumn("merger_model_id")] },
  { version: BULK_COMPLETION_REFUSAL_AT_VERSION, columns: [tasksColumn("bulk_completion_refusal_at")] },
  { version: TASK_PROPOSAL_CLAIM_VERSION, columns: [tasksColumn("proposal_claim_id")] },
  { version: CONFIGURATION_REVISIONS_VERSION, relations: ["project.configuration_revisions"] },
  { version: IDEATION_SCHEMA_VERSION, relations: ["project.ideation_sessions"] },
  { version: RESEARCH_FEATURE_PROVENANCE_VERSION, columns: [{ relation: "project.mission_features", column: "research_run_id" }] },
  { version: WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION, columns: [tasksColumn("workflow_ir_pin")] },
  { version: TASK_DECLARED_SYMBOLS_VERSION, columns: [tasksColumn("declared_symbols")] },
  { version: PLANNING_ACTIVE_TIMING_VERSION, columns: [tasksColumn("cumulative_planning_ms")] },
  { version: WORKFLOW_TASK_CONTINUATIONS_VERSION, columns: [{ relation: "project.workflow_work_items", column: "stable_workflow_run_id" }] },
  { version: TASK_WEDGE_NOTIFICATION_VERSION, columns: [tasksColumn("wedge_notification")] },
  { version: MILESTONE_ASSERTION_PROVENANCE_VERSION, columns: [{ relation: "project.mission_contract_assertions", column: "origin" }] },
  {
    version: MISSION_LINEAGE_STOP_VERSION,
    relations: ["project.mission_lineage_stops"],
    columns: [{ relation: "project.mission_features", column: "implementation_stop_reason" }],
  },
  { version: CHAT_SESSION_TAGS_VERSION, relations: ["project.chat_tags"] },
  { version: MISSION_TASK_PREFIX_VERSION, columns: [{ relation: "project.missions", column: "task_prefix" }] },
  { version: CREDENTIAL_INSTANCE_SELECTION_VERSION, columns: [tasksColumn("credential_instance_id")] },
  {
    version: TASK_LIFECYCLE_OUTBOX_VERSION,
    relations: ["project.task_lifecycle_events", "project.task_lifecycle_event_seq"],
  },
  {
    version: TASK_LIFECYCLE_CONSUMERS_VERSION,
    relations: ["project.task_lifecycle_consumer_registrations"],
  },
  { version: VALIDATOR_INPUT_FINGERPRINT_VERSION, columns: [{ relation: "project.mission_features", column: "validation_budget_fingerprint" }] },
  { version: UNPLANNED_EXECUTION_BLOCK_DEDUPE_VERSION, relations: ["project.unplanned_execution_blocks"] },
  { version: QUEUED_EPISODE_SIGNATURE_VERSION, columns: [tasksColumn("queued_log_episode_signature")] },
  { version: MULTI_ROLE_WORKFLOW_AGENTS_VERSION, columns: [{ relation: "project.agents", column: "roles" }] },
  { version: WORKFLOW_PRINCIPAL_FENCE_VERSION, columns: [{ relation: "project.workflow_work_items", column: "principal_agent_id" }] },
  { version: TASK_RECOMMENDATIONS_VERSION, columns: [tasksColumn("recommendations")] },
  { version: GITHUB_CHECK_STATES_VERSION, relations: ["project.github_check_states"] },
  { version: AGENT_ACTIVITY_EVENTS_VERSION, relations: ["project.agent_activity_events"] },
  { version: SPEC_LOCK_DRIFT_REPORT_VERSION, relations: ["project.spec_locks"] },
  { version: MEMORY_RECALL_RECORDS_VERSION, relations: ["project.memory_recall_records"] },
  { version: MISSION_FEATURE_SPEC_ALIGNMENT_VERSION, columns: [{ relation: "project.mission_features", column: "spec_alignment" }] },
  {
    version: AGENT_RATING_PROJECT_ISOLATION_VERSION,
    columns: [{ relation: "project.agent_ratings", column: "project_id" }],
    primaryKeys: [{ relation: "project.agent_ratings", columns: ["project_id", "id"] }],
  },
  { version: MESSAGE_ARCHIVE_SCHEMA_VERSION, columns: [{ relation: "project.messages", column: MESSAGE_ARCHIVED_SQL_COLUMN }] },
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
    if (!missing) {
      for (const primaryKey of sentinel.primaryKeys ?? []) {
        if (!(await catalog.relationExists(primaryKey.relation))) continue;
        const actual = await catalog.primaryKeyColumns(primaryKey.relation);
        if (sameOrderedColumns(actual, primaryKey.columns)) continue;
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

function sameOrderedColumns(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return actual != null
    && actual.length === expected.length
    && actual.every((name, index) => name === expected[index]);
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
    async primaryKeyColumns(qualifiedRelation) {
      /*
       * FNXC:PostgresBackup 2026-09-04-08:09:
       * Probe the live primary key in key order via pg_constraint/pg_attribute.
       * Schema and table names are bound parameters, never concatenated. A
       * missing relation or constraint returns null so rewind treats the
       * 0054/0055 identity repair as unapplied.
       */
      const { schema, table } = splitQualifiedRelation(qualifiedRelation);
      const rows = (await db.execute(sql`
        SELECT a.attname AS attname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinal) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key_column.attnum
        WHERE nsp.nspname = ${schema}
          AND rel.relname = ${table}
          AND con.contype = 'p'
        ORDER BY key_column.ordinal
      `)) as unknown as Array<{ attname: string }>;
      if (rows.length === 0) return null;
      return rows.map((row) => row.attname);
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
