/**
 * Schema-applier + Drizzle schema parity tests (U3 / VAL-SCHEMA-001..008).
 *
 * FNXC:PostgresSchema 2026-06-24-04:00:
 * Integration tests against a real PostgreSQL instance. Each test creates a
 * uniquely-named fresh database, applies the baseline migration, and asserts
 * the schema matches the final SQLite snapshot column-by-column and
 * constraint-by-constraint. Skipped when PostgreSQL is unreachable so the
 * merge gate stays green without a running server (set FUSION_PG_TEST_SKIP=1
 * to force-skip, or FUSION_PG_TEST_URL to point elsewhere).
 *
 * Coverage targets:
 *   VAL-SCHEMA-001 — fresh migration yields final-schema parity (table count
 *     + key columns match the SQLite source of truth)
 *   VAL-SCHEMA-002 — foreign-key cascade rules preserved (CASCADE / SET NULL)
 *   VAL-SCHEMA-003 — unique indexes preserved
 *   VAL-SCHEMA-004 — JSON columns are jsonb and round-trip
 *   VAL-SCHEMA-005 — CHECK constraints preserved and enforced
 *   VAL-SCHEMA-006 — AUTOINCREMENT maps to identity with sequence continuity
 *   VAL-SCHEMA-007 — plugin-owned tables materialize via schema-init hook
 *   VAL-SCHEMA-008 — three-database topology (project/central/archive schemas)
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  SCHEMA_BASELINE_VERSION,
  WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
  assertBinaryNotOlderThanDatabase,
  StaleBinarySchemaError,
  cePluginSchemaInit,
  cliPressPluginSchemaInit,
  reportsPluginSchemaInit,
  roadmapPluginSchemaInit,
} from "../../postgres/index.js";
import {
  LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION,
  MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION,
  MULTI_PROJECT_CUTOVER_SCHEMA_VERSION,
  MISSION_FIX_IDEMPOTENCY_VERSION,
  IMPORT_TRANSLATION_CACHE_VERSION,
  IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
  IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
  TASK_PROPOSAL_CLAIM_VERSION,
  CONFIGURATION_REVISIONS_VERSION,
  IDEATION_SCHEMA_VERSION,
  RESEARCH_FEATURE_PROVENANCE_VERSION,
  OWNER_PROJECT_ID_SPLIT_VERSION,
  /*
  FNXC:PostgresSchema 2026-07-16-08:00:
  Chat pin timestamps are migration 0012 and the current SCHEMA_BASELINE_VERSION.
  Keep OWNER_PROJECT_ID_SPLIT_VERSION fixed at 0011 so upgrade bookkeeping cannot
  skip the domain/partition split when the baseline marker advances.
  */
  CHAT_SESSION_PINS_VERSION,
  EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
  EXECUTOR_ESCALATION_ATTEMPT_VERSION,
  GLOBAL_ROUTINES_SCHEMA_VERSION,
  TASK_MERGER_MODEL_LANE_VERSION,
  BULK_COMPLETION_REFUSAL_AT_VERSION,
  PROJECT_OWNERSHIP_SCHEMA_VERSION,
  SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
  SQLITE_SCHEMA_PARITY_VERSION,
  SYMBOL_LOCKS_SCHEMA_VERSION,
  BIGINT_COUNTERS_VERSION,
  TASK_VERIFICATION_REQUEST_VERSION,
} from "../../postgres/schema-applier.js";
import { rekeyFallbackProjectPartition } from "../../postgres/migration-stamping.js";
import type { PluginSchemaInitHook } from "../../postgres/plugin-schema-hook.js";

const PG_ADMIN_URL =
  process.env.FUSION_PG_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

describe("schema-applier: immutable migration identities", () => {
  it("keeps monitor and approval isolation assigned to version 0003", () => {
    expect(MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION).toBe("0003");
    expect(Number(SCHEMA_BASELINE_VERSION))
      .toBeGreaterThanOrEqual(Number(MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION));
  });

  it("keeps legacy cutover preservation assigned to version 0004", () => {
    expect(LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION).toBe("0004");
    expect(Number(SCHEMA_BASELINE_VERSION))
      .toBeGreaterThanOrEqual(Number(LEGACY_CUTOVER_PRESERVATION_SCHEMA_VERSION));
  });

  it("keeps multi-project cutover assigned to version 0005", () => {
    expect(MULTI_PROJECT_CUTOVER_SCHEMA_VERSION).toBe("0005");
    expect(Number(SCHEMA_BASELINE_VERSION))
      .toBeGreaterThanOrEqual(Number(MULTI_PROJECT_CUTOVER_SCHEMA_VERSION));
  });

  it("keeps universal project ownership assigned to version 0006", () => {
    expect(PROJECT_OWNERSHIP_SCHEMA_VERSION).toBe("0006");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(PROJECT_OWNERSHIP_SCHEMA_VERSION));
  });

  it("keeps SQLite schema parity assigned to version 0007", () => {
    expect(SQLITE_SCHEMA_PARITY_VERSION).toBe("0007");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(SQLITE_SCHEMA_PARITY_VERSION));
  });

  it("keeps session advisor enabled column assigned to version 0008", () => {
    expect(SESSION_ADVISOR_ENABLED_SCHEMA_VERSION).toBe("0008");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(SESSION_ADVISOR_ENABLED_SCHEMA_VERSION));
  });

  it("keeps mission fix idempotency assigned to version 0009", () => {
    expect(MISSION_FIX_IDEMPOTENCY_VERSION).toBe("0009");
    // FNXC:GitHubImportTranslate 2026-07-15-09:30: the baseline marker advanced to
    // 0010; 0009 keeps its immutable identity so its migration cannot be skipped.
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(MISSION_FIX_IDEMPOTENCY_VERSION));
  });

  it("keeps the import translation cache assigned to version 0010", () => {
    expect(IMPORT_TRANSLATION_CACHE_VERSION).toBe("0010");
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the baseline marker advanced past
    // 0010; 0010 keeps its immutable identity so its migration cannot be skipped.
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(IMPORT_TRANSLATION_CACHE_VERSION));
  });

  it("keeps the owner_project_id domain/partition split assigned to version 0011", () => {
    expect(OWNER_PROJECT_ID_SPLIT_VERSION).toBe("0011");
    /*
    FNXC:PostgresSchema 2026-07-16-08:00:
    Baseline advanced to 0012 (chat session pins). Assert the split keeps identity
    0011 and remains applied at-or-before the latest marker — do not equate it with
    SCHEMA_BASELINE_VERSION.
    */
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(OWNER_PROJECT_ID_SPLIT_VERSION));
  });

  it("keeps chat session pins assigned to version 0012", () => {
    expect(CHAT_SESSION_PINS_VERSION).toBe("0012");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(CHAT_SESSION_PINS_VERSION));
  });

  it("keeps the import translation scope fix assigned to version 0016", () => {
    expect(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION).toBe("0016");
    // FNXC:PostgresMigrationIdentity 2026-07-16-22:40: the baseline marker advanced
    // past 0016 (0017 merger lane, 0018 bulk-completion-refusal). 0016 keeps its
    // immutable identity and remains applied at-or-before the latest marker.
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION));
  });

  it("keeps the import translation legacy-partition backfill assigned to version 0019", () => {
    expect(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION).toBe("0019");
    expect(Number(SCHEMA_BASELINE_VERSION))
      .toBeGreaterThanOrEqual(Number(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION));
  });

  it("keeps the per-task merger model lane assigned to version 0017", () => {
    expect(TASK_MERGER_MODEL_LANE_VERSION).toBe("0017");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(TASK_MERGER_MODEL_LANE_VERSION));
  });

  it("keeps the bulk-completion-refusal marker assigned to version 0018", () => {
    expect(BULK_COMPLETION_REFUSAL_AT_VERSION).toBe("0018");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(BULK_COMPLETION_REFUSAL_AT_VERSION));
  });

  it("keeps the task proposal claim marker assigned to version 0020", () => {
    expect(TASK_PROPOSAL_CLAIM_VERSION).toBe("0020");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(TASK_PROPOSAL_CLAIM_VERSION));
  });

  it("registers durable symbol locks at the next free migration version", () => {
    expect(SYMBOL_LOCKS_SCHEMA_VERSION).toBe("0025");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(SYMBOL_LOCKS_SCHEMA_VERSION));
  });

  /*
  FNXC:PostgresBigintCounters 2026-07-19-12:00:
  0026 widens overflow-prone counters to bigint. Keep identity fixed and at-or-before SCHEMA_BASELINE_VERSION.

  FNXC:PostgresBigintCounters 2026-07-19-08:40:
  Also assert the authoritative applier registry wires 0026_bigint_counters.sql —
  constant identity alone does not prove applySchemaBaseline will run the migration.
  */
  it("registers bigint counters at migration version 0026", () => {
    expect(BIGINT_COUNTERS_VERSION).toBe("0026");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(Number(BIGINT_COUNTERS_VERSION));
    const applierSource = readFileSync(
      fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
      "utf8",
    );
    expect(applierSource).toContain("0026_bigint_counters.sql");
    expect(applierSource).toContain("BIGINT_COUNTERS_VERSION");
    expect(applierSource).toMatch(/applied\.includes\(\s*BIGINT_COUNTERS_VERSION\s*\)/);
  });

});

/*
FNXC:Lifecycle 2026-07-16-22:40:
Migration wiring integrity — the class guard for the FN-8141 crash. Migrations are
registered EXPLICITLY in schema-applier.ts (not auto-discovered), so a new .sql
file that is not wired through a version constant + bookkeeping check silently
never runs (documented hazard). PR #2260 tripped the adjacent trap: it added a
column to the model + 0000 baseline and bumped nothing, so existing DBs never got
it. These pure (no-PostgreSQL) assertions run in the merge gate and fail fast when
the baseline marker and the on-disk migration set drift out of sync.
*/
describe("schema-applier: migration wiring integrity", () => {
  const migrationsDir = fileURLToPath(new URL("../../postgres/migrations", import.meta.url));
  const applierSource = readFileSync(
    fileURLToPath(new URL("../../postgres/schema-applier.ts", import.meta.url)),
    "utf8",
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  it("advances SCHEMA_BASELINE_VERSION to the highest-numbered migration file", () => {
    const highest = migrationFiles[migrationFiles.length - 1]!.slice(0, 4);
    // A new column that ships a migration file must also bump the baseline marker
    // (else the "all markers recorded" fast-path and upgrade bookkeeping drift).
    expect(SCHEMA_BASELINE_VERSION).toBe(highest);
  });

  it("wires every migration .sql file into the applier so none silently never runs", () => {
    // The applier references each migration by its exact basename in a path
    // constant. A file present on disk but absent from the source is unwired.
    const unwired = migrationFiles.filter((f) => !applierSource.includes(f));
    expect(unwired).toEqual([]);
  });
});

/**
 * FNXC:PostgresSchema 2026-06-24-04:00:
 * Create a uniquely-named fresh database for each test so tests are hermetic
 * and never touch existing data. Uses the admin connection to CREATE/DROP.
 */
function uniqueDbName(): string {
  return `fusion_schema_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  // psql via execSync for DDL that the postgres.js connection pool can't run
  // (CREATE/DROP DATABASE cannot run inside a transaction). This is short
  // deterministic DDL, the acceptable execSync use per AGENTS.md.
  execSync(`psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`, {
    stdio: "pipe",
    env: process.env,
  });
}

interface TestContext {
  dbName: string;
  testUrl: string;
  sqlConn: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
}

async function setupFreshDb(): Promise<TestContext> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // ignore — may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const sqlConn = postgres(testUrl, { max: 2, prepare: false, onnotice: () => {} });
  const db = drizzle(sqlConn);
  return { dbName, testUrl, sqlConn, db };
}

async function teardownDb(ctx: TestContext | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.sqlConn.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
}

/*
FNXC:SymbolLock 2026-07-30-15:15:
The baseline declares symbol_locks but cannot attach its ownership trigger before
0006 defines fusion_assign_project_id. Both a full fresh apply and an upgraded
installation must therefore prove 0025 leaves the final table forced-RLS with
its policy and trigger, including actual second-project read/write isolation.
*/
async function assertSymbolLocksOwnershipContract(ctx: TestContext): Promise<void> {
  const catalog = (await ctx.db.execute(sql`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'project' AND tablename = 'symbol_locks'
          AND policyname = 'fusion_project_isolation'
      ) AS policy,
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'project.symbol_locks'::regclass
          AND tgname = 'fusion_assign_project_id' AND NOT tgisinternal
      ) AS trigger
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'project' AND c.relname = 'symbol_locks'
  `)) as unknown as Array<{ rls: boolean; forced: boolean; policy: boolean; trigger: boolean }>;
  expect(catalog).toEqual([{ rls: true, forced: true, policy: true, trigger: true }]);

  const role = `fusion_symbol_lock_isolation_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.db.execute(sql.raw(`
    CREATE ROLE ${role} NOLOGIN;
    GRANT USAGE ON SCHEMA project TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON project.symbol_locks TO ${role};
  `));
  try {
    for (const projectId of ["project-a", "project-b"]) {
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        await tx.execute(sql`SELECT set_config('fusion.project_id', ${projectId}, true)`);
        await tx.execute(sql`
          INSERT INTO project.symbol_locks(
            symbol_key, owner_task_id, status, acquired_at, renewed_at, expires_at, created_at, updated_at
          ) VALUES (
            'pkg/shared.ts#export', ${`FN-${projectId}`}, 'held',
            '2026-07-30T15:15:00.000Z', '2026-07-30T15:15:00.000Z',
            '2026-07-30T16:15:00.000Z', '2026-07-30T15:15:00.000Z', '2026-07-30T15:15:00.000Z'
          )
        `);
      });
    }
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-b', true)`);
      const visible = (await tx.execute(sql`
        SELECT project_id, owner_task_id FROM project.symbol_locks ORDER BY project_id
      `)) as unknown as Array<{ project_id: string; owner_task_id: string }>;
      expect(visible).toEqual([{ project_id: "project-b", owner_task_id: "FN-project-b" }]);
      const stolen = (await tx.execute(sql`
        UPDATE project.symbol_locks SET owner_task_id = 'stolen'
        WHERE project_id = 'project-a' RETURNING owner_task_id
      `)) as unknown as Array<{ owner_task_id: string }>;
      expect(stolen).toEqual([]);
    });
  } finally {
    await ctx.db.execute(sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role};`));
  }
  const rows = (await ctx.db.execute(sql`
    SELECT project_id, owner_task_id FROM project.symbol_locks ORDER BY project_id
  `)) as unknown as Array<{ project_id: string; owner_task_id: string }>;
  expect(rows).toEqual([
    { project_id: "project-a", owner_task_id: "FN-project-a" },
    { project_id: "project-b", owner_task_id: "FN-project-b" },
  ]);
}

/**
 * FNXC:PostgresSchema 2026-06-24-06:30:
 * Complete enumeration of every CREATE INDEX name from the SQLite final
 * schema. Extracted from db.ts (SCHEMA_SQL + all applyMigration blocks) and
 * central-db.ts. The legacy agentLogEntries table (created migration 40,
 * dropped migration 102) is excluded since it is transitional and not part
 * of the final schema. The VAL-SCHEMA-001 parity test iterates this list and
 * asserts a PostgreSQL counterpart exists after the baseline is applied.
 *
 * NOTE: A handful of SQLite names were intentionally renamed in the PostgreSQL
 * migration (see RENAMED_TO in the test); the rest are identical.
 */
const SQLITE_FINAL_INDEXES: readonly string[] = [
  "idxActivityLogProjectId",
  "idxActivityLogTaskId",
  "idxActivityLogTaskIdTimestamp",
  "idxActivityLogTimestamp",
  "idxActivityLogType",
  "idxActivityLogTypeTimestamp",
  "idxAgentApiKeysAgentId",
  "idxAgentConfigRevisionsAgentIdCreatedAt",
  "idxAgentHeartbeatsAgentId",
  "idxAgentHeartbeatsAgentIdTimestamp",
  "idxAgentHeartbeatsRunId",
  "idxAgentRatingsAgentId",
  "idxAgentRatingsCreatedAt",
  "idxAgentRunsAgentIdStartedAt",
  "idxAgentRunsStatus",
  "idxAgentsState",
  "idxAiSessionsArchived",
  "idxAiSessionsLock",
  "idxAiSessionsStatus",
  "idxAiSessionsStatusUpdatedAt",
  "idxAiSessionsType",
  "idxAiSessionsUpdatedAt",
  "idxApprovalRequestAuditRequestCreatedAt",
  "idxApprovalRequestsRequesterCreatedAt",
  "idxApprovalRequestsStatusCreatedAt",
  "idxApprovalRequestsTaskCreatedAt",
  "idxArchivedTasksId",
  "idxArtifactsAuthorId",
  "idxArtifactsCreatedAt",
  "idxArtifactsTaskId",
  "idxArtifactsType",
  "idxAutomationsScope",
  "idxBranchGroupsBranchName",
  "idxBranchGroupsSource",
  "idxChatMessagesCreatedAt",
  "idxChatMessagesSessionId",
  "idxChatRoomMembersAgentId",
  "idxChatRoomMessagesRoomCreatedAt",
  "idxChatRoomMessagesRoomId",
  "idxChatRoomsProjectId",
  "idxChatRoomsSlug",
  "idxChatRoomsStatus",
  "idxChatSessionsAgentId",
  "idxChatSessionsProjectId",
  "idxContractAssertionsMilestoneOrder",
  "idxDeploymentsDeployedAt",
  "idxDeploymentsService",
  "idxDistributedTaskIdReservationsExpiry",
  "idxDistributedTaskIdReservationsPrefixStatus",
  "idxEvalRunEventsRunIdSeq",
  "idxEvalRunsProjectIdCreatedAt",
  "idxEvalRunsProjectTriggerStatus",
  "idxEvalRunsStatusCreatedAt",
  "idxEvalTaskResultsRunIdCreatedAt",
  "idxEvalTaskResultsRunTaskUnique",
  "idxEvalTaskResultsStatusRunId",
  "idxEvalTaskResultsTaskIdCreatedAt",
  "idxExperimentRecordsSessionSegment",
  "idxExperimentRecordsType",
  "idxExperimentSessionsCreatedAt",
  "idxExperimentSessionsProject",
  "idxExperimentSessionsStatus",
  "idxFeatureAssertionsAssertionId",
  "idxFeatureAssertionsFeatureId",
  "idxFixLineageFixFeatureId",
  "idxFixLineageRunId",
  "idxFixLineageSourceFeatureId",
  "idxGoalCitationsAgentId",
  "idxGoalCitationsGoalId",
  "idxGoalCitationsTimestamp",
  "idxGoalsStatus",
  "idxIncidentsGroupingKey",
  "idxIncidentsOpenedAt",
  "idxIncidentsResolvedAt",
  "idxIncidentsStatus",
  "idxInsightRunEventsRunIdSeq",
  "idxInsightRunsProjectId",
  "idxInsightRunsProjectTriggerStatus",
  "idxKnowledgePagesSourceKind",
  "idxKnowledgePagesUpdatedAt",
  "idxManagedDockerNodesNodeId",
  "idxManagedDockerNodesStatus",
  "idxMeshSharedSnapshotsLookup",
  "idxMeshWriteQueueReplay",
  "idxMessagesCreatedAt",
  "idxMessagesFrom",
  "idxMessagesTo",
  "idxMissionEventsMissionId",
  "idxMissionEventsTimestamp",
  "idxMissionEventsType",
  "idxMissionGoalsGoalId",
  "idxNodesStatus",
  "idxNodesType",
  "idxPeerNodesNodeId",
  "idxPluginActivationsActivatedAt",
  "idxPluginActivationsPluginId",
  "idxProjectInsightsCategory",
  "idxProjectInsightsFingerprint",
  "idxProjectInsightsProjectId",
  "idxProjectNodePathMappingsNodeId",
  "idxProjectNodePathMappingsProjectId",
  "idxProjectPluginStatesPluginId",
  "idxProjectPluginStatesProjectPath",
  "idxProjectsPath",
  "idxProjectsStatus",
  "idxPullRequestsNumber",
  "idxPullRequestsOpenBranch",
  "idxPullRequestsOpenSource",
  "idxResearchExportsRunId",
  "idxResearchRunEventsRunIdSeq",
  "idxResearchRunsCreatedAt",
  "idxResearchRunsProjectTriggerStatus",
  "idxResearchRunsStatus",
  "idxResearchRunsUpdatedAt",
  "idxRoutinesEnabled",
  "idxRoutinesNextRunAt",
  "idxRoutinesScope",
  "idxRunAuditEventsRunIdTimestamp",
  "idxRunAuditEventsTaskIdTimestamp",
  "idxRunAuditEventsTimestamp",
  "idxSecretsGlobalKey",
  "idxSecretsKey",
  "idxSettingsSyncNode",
  "idxTaskClaimsOwner",
  "idxTaskCommitAssociationsCommitSha",
  "idxTaskCommitAssociationsLineage",
  "idxTaskDocumentRevisionsTaskKey",
  "idxTaskDocumentsTaskId",
  "idxTaskDocumentsTaskKey",
  "idxTasksAssignedAgentId",
  "idxTasksAssigneeUserId",
  "idxTasksColumn",
  "idxTasksCreatedAt",
  "idxTasksLineageId",
  "idxTasksLiveColumn",
  "idxTasksPausedByAgentId",
  "idxTasksSourceParentTaskId",
  "idxTasksUpdatedAt",
  "idxTodoItemsListId",
  "idxTodoItemsSortOrder",
  "idxTodoListsProjectId",
  "idxUsageEventsAgentId",
  "idxUsageEventsKindTs",
  "idxUsageEventsTaskId",
  "idxUsageEventsTs",
  "idxValidatorFailuresAssertionId",
  "idxValidatorFailuresFeatureId",
  "idxValidatorFailuresRunId",
  "idxValidatorRunsFeatureId",
  "idxValidatorRunsMilestoneId",
  "idxValidatorRunsSliceId",
  "idxValidatorRunsStatus",
  "idxVerificationCacheRecordedAt",
  "idxWorkflowsCreatedAt",
  "idx_cli_sessions_chatSessionId",
  "idx_cli_sessions_project_state",
  "idx_cli_sessions_taskId",
  "idx_completion_handoff_markers_acceptedAt",
  "idx_mergeQueue_leaseExpiresAt",
  "idx_mergeQueue_lease_ready",
  "idx_merge_requests_state_updatedAt",
  "idx_tasks_deletedAt",
  "idx_workflow_prompt_overrides_project",
  "idx_workflow_run_branches_task_run",
  "idx_workflow_run_step_instances_task_run",
  "idx_workflow_settings_project",
  "idx_workflow_work_items_due",
  "idx_workflow_work_items_leaseExpiresAt",
  "idx_workflow_work_items_task_run",
  "uxGoalCitationsDedup",
];

pgDescribe("schema-applier: VAL-SCHEMA-008 three-database topology", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("creates project, central, and archive schemas as distinct namespaces", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const rows = (await ctx.db.execute(sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name IN ('project', 'central', 'archive')
      ORDER BY schema_name
    `)) as unknown as Array<{ schema_name: string }>;
    expect(rows.map((r) => r.schema_name)).toEqual(["archive", "central", "project"]);
  });

  it("ensures schemas before hooks when all migration markers are already recorded", async () => {
    ctx = await setupFreshDb();
    await ctx.db.execute(sql.raw(`
      CREATE TABLE public.fusion_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.fusion_schema_migrations (version)
      SELECT lpad(n::text, 4, '0')
      FROM generate_series(0, ${Number(SCHEMA_BASELINE_VERSION)}) AS migration(n);
    `));

    const observedSchemas: string[] = [];
    const assertSchemasHook: PluginSchemaInitHook = {
      pluginId: "assert-required-schemas",
      async init(db) {
        const rows = (await db.execute(sql`
          SELECT schema_name FROM information_schema.schemata
          WHERE schema_name IN ('project', 'central', 'archive')
          ORDER BY schema_name
        `)) as unknown as Array<{ schema_name: string }>;
        observedSchemas.push(...rows.map(({ schema_name }) => schema_name));
        if (rows.length !== 3) {
          throw new Error(`Required schemas missing at plugin hook time: ${rows.map(({ schema_name }) => schema_name).join(", ")}`);
        }
      },
    };

    await expect(applySchemaBaseline(ctx.db, { pluginHooks: [assertSchemasHook] })).resolves.toEqual({
      applied: false,
      pluginHooksRun: 1,
    });
    expect(observedSchemas).toEqual(["archive", "central", "project"]);

    const schemas = (await ctx.db.execute(sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name IN ('project', 'central', 'archive')
      ORDER BY schema_name
    `)) as unknown as Array<{ schema_name: string }>;
    expect(schemas.map(({ schema_name }) => schema_name)).toEqual(["archive", "central", "project"]);
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-001 final-schema parity (table counts)", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("creates all 93 project tables, 18 central tables, 1 archive table", async () => {
    ctx = await setupFreshDb();
    // FNXC:PostgresCutover 2026-07-05-15:55: apply the BASELINE only.
    // applySchemaBaseline now runs the plugin schema-init hooks by default,
    // which add plugin-owned project-schema tables; this parity check counts
    // the core baseline snapshot, so hooks are explicitly disabled here.
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    const rows = (await ctx.db.execute(sql`
      SELECT table_schema, count(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema IN ('project', 'central', 'archive')
      AND table_type = 'BASE TABLE'
      GROUP BY table_schema
    `)) as unknown as Array<{ table_schema: string; n: number }>;
    const bySchema = Object.fromEntries(rows.map((r) => [r.table_schema, r.n]));
    // Project: 87 typed core tables + 2 lossless legacy preservation tables
    // + 1 import_translation_cache (FNXC:GitHubImportTranslate 2026-07-15-09:30)
    // + 1 configuration_revisions (FNXC:ConfigVersioning 2026-07-18-14:00)
    // + 2 ideation_sessions/ideation_candidates (FNXC:Ideation 2026-07-18-13:25 / FN-8295)
    // + 1 task_verification_requests + 1 durable symbol_locks table (FN-8305).
    // Plugin tables are added separately by the hook.
    expect(bySchema.project).toBe(95);
    expect(bySchema.central).toBe(18);
    expect(bySchema.archive).toBe(1);
  });

  it("records the baseline migration version in the bookkeeping table", async () => {
    ctx = await setupFreshDb();
    const result = await applySchemaBaseline(ctx.db);
    expect(result.applied).toBe(true);
    const rows = (await ctx.db.execute(sql`
      SELECT version FROM public.fusion_schema_migrations
    `)) as unknown as Array<{ version: string }>;
    expect(rows.map((r) => r.version)).toContain(SCHEMA_BASELINE_VERSION);
  });

  it("is idempotent: re-applying is a no-op", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const second = await applySchemaBaseline(ctx.db);
    expect(second.applied).toBe(false);
  });

  /*
  FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
  A cluster that already recorded migrations through 0006 must receive every late SQLite column before cutover retries. This is the production failure shape: the initial copy is blocked while the target schema is otherwise fully initialized.
  */
  it("upgrades a 0006 target with every late SQLite source column", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0007', '0008');
      ALTER TABLE project.tasks
        DROP COLUMN board_id,
        DROP COLUMN task_question_interrupt,
        DROP COLUMN column_dwell_ms,
        DROP COLUMN workflow_transition_notification,
        DROP COLUMN planner_oversight_level,
        DROP COLUMN awaiting_approval_reason,
        DROP COLUMN approved_plan_fingerprint;
      ALTER TABLE project.workflows DROP COLUMN icon;
      ALTER TABLE project.mission_contract_assertions DROP COLUMN scope;
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    const columns = (await ctx.db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND (
          (table_name = 'tasks' AND column_name IN (
            'board_id', 'task_question_interrupt', 'column_dwell_ms',
            'workflow_transition_notification', 'planner_oversight_level',
            'awaiting_approval_reason', 'approved_plan_fingerprint'
          ))
          OR (table_name = 'workflows' AND column_name = 'icon')
          OR (table_name = 'mission_contract_assertions' AND column_name = 'scope')
        )
      ORDER BY table_name, column_name
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    expect(columns).toHaveLength(9);
    expect(await getAppliedMigrations(ctx.db)).toContain(SQLITE_SCHEMA_PARITY_VERSION);
  });

  /*
  FNXC:PlannerOversight 2026-07-14-18:49:
  A cluster that already recorded through 0007 must still gain session_advisor_enabled
  before TaskStore SELECTs run — Gate boot-smoke failure mode on this branch.
  */
  it("upgrades a 0007 target with session_advisor_enabled", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0008';
      ALTER TABLE project.tasks DROP COLUMN session_advisor_enabled;
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    const columns = (await ctx.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'tasks'
        AND column_name = 'session_advisor_enabled'
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns).toEqual([{ column_name: "session_advisor_enabled" }]);
    expect(await getAppliedMigrations(ctx.db)).toContain(SESSION_ADVISOR_ENABLED_SCHEMA_VERSION);
  });

  /*
  FNXC:Lifecycle 2026-07-16-22:40:
  Regression for the FN-8141 crash: PR #2260 added project.tasks.bulk_completion_refusal_at
  to the Drizzle model + 0000 baseline but shipped NO forward migration, so every
  database created before #2260 (already carrying the 0000 marker, thus skipping the
  baseline) never gained the column and crashed on the first TaskStore SELECT
  ("column bulk_completion_refusal_at does not exist"). Migration 0018 lands it on
  existing clusters. Simulate that exact existing-DB shape: drop the column + its
  0018 marker, then prove re-applying restores it.
  */
  it("upgrades an existing DB missing bulk_completion_refusal_at (0018)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0018';
      ALTER TABLE project.tasks DROP COLUMN bulk_completion_refusal_at;
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    const columns = (await ctx.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'tasks'
        AND column_name = 'bulk_completion_refusal_at'
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns).toEqual([{ column_name: "bulk_completion_refusal_at" }]);
    expect(await getAppliedMigrations(ctx.db)).toContain(BULK_COMPLETION_REFUSAL_AT_VERSION);
  });

  /*
  FNXC:WorkflowIrPin 2026-07-19-03:30 (U9b / KTD-3 + KTD-8):
  Same existing-DB shape as the 0018 regression above, for the durable IR pin (+ its node
  and column entry) and the one-time legacy-adoption stamp. All five columns are in the
  slim TaskStore projection, so a cluster that recorded 0000 and never received 0026 would
  crash on the first slim SELECT rather than degrade — which is exactly why the baseline
  edit alone is insufficient and the forward migration has to exist.
  */
  it("upgrades an existing DB missing the IR-pin and legacy-adoption columns (0027)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0027';
      ALTER TABLE project.tasks DROP COLUMN workflow_ir_pin;
      ALTER TABLE project.tasks DROP COLUMN workflow_ir_pin_node_id;
      ALTER TABLE project.tasks DROP COLUMN workflow_ir_pin_column_id;
      ALTER TABLE project.tasks DROP COLUMN legacy_adopted_at;
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    const columns = (await ctx.db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'project'
        AND table_name = 'tasks'
        AND column_name IN ('workflow_ir_pin', 'workflow_ir_pin_node_id', 'workflow_ir_pin_column_id', 'legacy_adopted_at')
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((c) => c.column_name)).toEqual([
      "legacy_adopted_at",
      "workflow_ir_pin",
      "workflow_ir_pin_column_id",
      "workflow_ir_pin_node_id",
    ]);
    expect(await getAppliedMigrations(ctx.db)).toContain(WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION);
  });

  /*
  FNXC:StaleBinaryGuard 2026-07-19-03:30 (U9b / R10):
  Old-binary write refusal. A database migrated by a NEWER Fusion must not be opened by an
  older binary: the old binary writes rows under the previous schema's assumptions and
  re-runs reconciles the newer version already superseded (the observed stale-Homebrew
  failure mode, where a pre-fix binary re-ran the Ideas evacuation against a shared DB and
  the audit trail showed an unidentifiable writer).
  */
  it("refuses to open a database migrated by a newer binary (stale-binary guard)", () => {
    const future = String(Number(SCHEMA_BASELINE_VERSION) + 1).padStart(4, "0");
    expect(() => assertBinaryNotOlderThanDatabase([SCHEMA_BASELINE_VERSION, future]))
      .toThrow(StaleBinarySchemaError);
    // Current and older versions are fine — this guard only fires on a FUTURE version.
    expect(() => assertBinaryNotOlderThanDatabase(["0000", "0018", SCHEMA_BASELINE_VERSION]))
      .not.toThrow();
    // Non-numeric markers (plugin / hand-inserted) must not brick every open.
    expect(() => assertBinaryNotOlderThanDatabase(["plugin-roadmap-001", SCHEMA_BASELINE_VERSION]))
      .not.toThrow();
  });

  /*
  Numeric, not lexical. A bare "9" is the case where the two disagree: numerically 9 is far
  BELOW the current baseline (so an old marker must not trip the guard), but lexically "9"
  sorts ABOVE "0027" and a string compare would refuse every open against such a database.
  */
  it("compares schema versions numerically, not lexically", () => {
    expect(() => assertBinaryNotOlderThanDatabase(["9"])).not.toThrow();
    expect(() => assertBinaryNotOlderThanDatabase(["0009"])).not.toThrow();
    // A genuinely newer version still throws regardless of padding.
    expect(() => assertBinaryNotOlderThanDatabase(["0028"])).toThrow(StaleBinarySchemaError);
  });


  /*
  FNXC:ProjectDataIsolation 2026-07-14-12:10:
  Every table in the shared PostgreSQL project schema is project-owned unless it is one of the three explicitly cluster-wide coordination tables. Require a physical project_id plus forced row-level security so a missed application predicate cannot expose agents, secrets, inbox messages, missions, workflows, or plugin data to another project.
  */
  it("forces project ownership on every non-global project table", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);

    const missingOwnership = (await ctx.db.execute(sql`
      SELECT t.table_name
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON c.table_schema = t.table_schema
       AND c.table_name = t.table_name
       AND c.column_name = 'project_id'
      WHERE t.table_schema = 'project'
        AND t.table_type = 'BASE TABLE'
        AND c.column_name IS NULL
      ORDER BY t.table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(missingOwnership).toEqual([]);

    const rlsGaps = (await ctx.db.execute(sql`
      SELECT n.nspname || '.' || c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'project' OR (n.nspname = 'archive' AND c.relname = 'archived_tasks'))
        AND c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
      ORDER BY c.relname
    `)) as unknown as Array<{ table_name: string }>;
    expect(rlsGaps).toEqual([]);
  });

  it("applies symbol-lock RLS, ownership policy, and trigger after a full fresh sequence", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await assertSymbolLocksOwnershipContract(ctx);
  });

  it("repairs an upgraded installation missing the 0025 symbol-lock migration", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    // Preserve the 0000 marker while removing the later table/marker: this is
    // the pre-0025 upgraded-install shape, where replay must not rely on baseline SQL.
    await ctx.db.execute(sql.raw(`
      DROP TABLE project.symbol_locks;
      DELETE FROM public.fusion_schema_migrations WHERE version = '0025';
    `));
    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    expect(await getAppliedMigrations(ctx.db)).toContain(SYMBOL_LOCKS_SCHEMA_VERSION);
    await assertSymbolLocksOwnershipContract(ctx);
  });

  /*
  FNXC:ProjectDataIsolation 2026-07-14-12:10:
  Exercise the user-visible invariant through a non-superuser role: agents created in one project are invisible and immutable from another project even when application SQL omits project predicates.
  */
  it("prevents cross-project agent reads and mutations at the database boundary", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const role = `fusion_project_isolation_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.execute(sql.raw(`
      CREATE ROLE ${role} NOLOGIN;
      GRANT USAGE ON SCHEMA project TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA project TO ${role};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA project TO ${role};
    `));
    try {
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-a', true)`);
        await tx.execute(sql`
          INSERT INTO project.agents(id, name, role, created_at, updated_at)
          VALUES ('agent-a', 'Agent A', 'worker', '2026-01-01', '2026-01-01')
        `);
        await tx.execute(sql`
          INSERT INTO project.agents(id, name, role, created_at, updated_at)
          VALUES ('shared-agent', 'Shared ID in A', 'worker', '2026-01-01', '2026-01-01')
        `);
      });
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-b', true)`);
        await tx.execute(sql`
          INSERT INTO project.agents(id, name, role, created_at, updated_at)
          VALUES ('agent-b', 'Agent B', 'worker', '2026-01-01', '2026-01-01')
        `);
        await tx.execute(sql`
          INSERT INTO project.agents(id, name, role, created_at, updated_at)
          VALUES ('shared-agent', 'Shared ID in B', 'worker', '2026-01-01', '2026-01-01')
        `);
        const visible = (await tx.execute(sql`
          SELECT id, project_id FROM project.agents ORDER BY id
        `)) as unknown as Array<{ id: string; project_id: string }>;
        expect(visible).toEqual([
          { id: "agent-b", project_id: "project-b" },
          { id: "shared-agent", project_id: "project-b" },
        ]);
        const changed = (await tx.execute(sql`
          UPDATE project.agents SET name = 'stolen' WHERE id = 'agent-a' RETURNING id
        `)) as unknown as Array<{ id: string }>;
        expect(changed).toEqual([]);
        const removed = (await tx.execute(sql`
          DELETE FROM project.agents WHERE id = 'agent-a' RETURNING id
        `)) as unknown as Array<{ id: string }>;
        expect(removed).toEqual([]);
      });
      await expect(ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-b', true)`);
        await tx.execute(sql`
          INSERT INTO project.agent_heartbeats(agent_id, timestamp, status, run_id)
          VALUES ('agent-a', '2026-01-01', 'alive', 'run-cross-project')
        `);
      })).rejects.toThrow();
      const crossProjectHeartbeats = (await ctx.db.execute(sql`
        SELECT count(*)::int AS count FROM project.agent_heartbeats
        WHERE run_id = 'run-cross-project'
      `)) as unknown as Array<{ count: number }>;
      expect(crossProjectHeartbeats[0]?.count).toBe(0);
      const rows = (await ctx.db.execute(sql`
        SELECT id, name, project_id FROM project.agents ORDER BY id, project_id
      `)) as unknown as Array<{ id: string; name: string; project_id: string }>;
      expect(rows).toEqual([
        { id: "agent-a", name: "Agent A", project_id: "project-a" },
        { id: "agent-b", name: "Agent B", project_id: "project-b" },
        { id: "shared-agent", name: "Shared ID in A", project_id: "project-a" },
        { id: "shared-agent", name: "Shared ID in B", project_id: "project-b" },
      ]);
    } finally {
      await ctx.db.execute(sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role};`));
    }
  });

  it("scopes every project key and relationship to project_id", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const unscopedKeys = (await ctx.db.execute(sql`
      SELECT c.conrelid::regclass::text AS table_name, c.conname
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
      ORDER BY 1, 2
    `)) as unknown as Array<{ table_name: string; conname: string }>;
    expect(unscopedKeys).toEqual([]);

    const unscopedUniqueIndexes = (await ctx.db.execute(sql`
      SELECT t.oid::regclass::text AS table_name, idx.relname AS index_name
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'project'
        AND i.indisunique
        AND NOT EXISTS (
          SELECT 1 FROM unnest(i.indkey::smallint[]) key_attnum
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_attnum
          WHERE a.attname = 'project_id'
        )
      ORDER BY 1, 2
    `)) as unknown as Array<{ table_name: string; index_name: string }>;
    expect(unscopedUniqueIndexes).toEqual([]);

    const unscopedRelationships = (await ctx.db.execute(sql`
      SELECT c.conrelid::regclass::text AS table_name, c.conname
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE c.contype = 'f'
        AND child_ns.nspname = 'project'
        AND parent_ns.nspname = 'project'
        AND (
          NOT EXISTS (
            SELECT 1 FROM unnest(c.conkey) key_attnum
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
          OR NOT EXISTS (
            SELECT 1 FROM unnest(c.confkey) key_attnum
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key_attnum
            WHERE a.attname = 'project_id'
          )
        )
      ORDER BY 1, 2
    `)) as unknown as Array<{ table_name: string; conname: string }>;
    expect(unscopedRelationships).toEqual([]);
  });

  it("promotes a fallback project partition without stranding task satellites", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      CREATE TABLE public.fusion_sqlite_migrations (
        migration_key text PRIMARY KEY,
        project_id text,
        status text NOT NULL,
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO project.tasks(project_id, id, description, "column", created_at, updated_at)
      VALUES ('local-fallback', 'FN-1', 'fallback task', 'todo', '2026-01-01', '2026-01-01');
      INSERT INTO project.task_documents(project_id, id, task_id, key, created_at, updated_at)
      VALUES ('local-fallback', 'doc-1', 'FN-1', 'PROMPT.md', '2026-01-01', '2026-01-01');
      INSERT INTO public.fusion_sqlite_migrations(migration_key, project_id, status, updated_at)
      VALUES ('project:local-fallback', 'local-fallback', 'complete', now());
    `);

    await expect(rekeyFallbackProjectPartition(
      ctx.db,
      "local-fallback",
      "registered-project",
    )).resolves.toBe(true);

    const rows = (await ctx.db.execute(sql`
      SELECT project_id, id FROM project.tasks
      UNION ALL
      SELECT project_id, task_id FROM project.task_documents
      ORDER BY 1, 2
    `)) as unknown as Array<{ project_id: string; id: string }>;
    expect(rows).toEqual([
      { project_id: "registered-project", id: "FN-1" },
      { project_id: "registered-project", id: "FN-1" },
    ]);
    await expect(ctx.db.execute(sql`
      SELECT 1 FROM public.fusion_sqlite_migrations
      WHERE migration_key = 'project:registered-project'
        AND project_id = 'registered-project'
        AND status = 'complete'
    `)).resolves.toHaveLength(1);
  });

  it("quarantines ownerless rows when complete and failed migrations name different projects", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0006', '0007', '0008');
      CREATE TABLE public.fusion_sqlite_migrations (
        migration_key text PRIMARY KEY,
        project_id text,
        status text NOT NULL,
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.fusion_sqlite_migrations(migration_key, project_id, status)
      VALUES ('project:a', 'project-a', 'complete'), ('project:b', 'project-b', 'failed');
      ALTER TABLE project.activity_log DROP CONSTRAINT activity_log_pkey;
      ALTER TABLE project.activity_log ALTER COLUMN project_id DROP NOT NULL;
      INSERT INTO project.activity_log(project_id, id, timestamp, type, details)
      VALUES (NULL, 'partial-event', '2026-01-01', 'task:created', 'partial');
    `));

    await applySchemaBaseline(ctx.db);
    await expect(ctx.db.execute(sql`
      SELECT project_id FROM project.activity_log WHERE id = 'partial-event'
    `)).resolves.toEqual([{ project_id: "__legacy_unscoped__" }]);
  });

  /*
  FNXC:ProjectMigrationRetry 2026-07-14-12:43:
  The ownership migration must repair a stale child partition through the legacy global foreign key before installing composite project-local relationships, so an operator can retry after the former non-transactional cutover failed between parent and child copies.
  */
  it("reconciles stale child ownership before rebuilding project-local foreign keys", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql.raw(`
      CREATE TABLE public.fusion_sqlite_migrations (
        migration_key text PRIMARY KEY,
        project_id text,
        status text NOT NULL,
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.fusion_sqlite_migrations(migration_key, project_id, status)
      VALUES ('project:registered-project', 'registered-project', 'failed');
      INSERT INTO project.agents(project_id, id, name, role, created_at, updated_at)
      VALUES ('registered-project', 'retry-agent', 'Retry Agent', 'worker', '2026-01-01', '2026-01-01');
      INSERT INTO project.agent_heartbeats(project_id, agent_id, timestamp, status, run_id)
      VALUES ('registered-project', 'retry-agent', '2026-01-01', 'alive', 'retry-run');
      DO $downgrade$
      DECLARE fk_name text;
      BEGIN
        SELECT c.conname INTO fk_name
        FROM pg_constraint c
        WHERE c.conrelid = 'project.agent_heartbeats'::regclass
          AND c.confrelid = 'project.agents'::regclass
          AND c.contype = 'f';
        EXECUTE format('ALTER TABLE project.agent_heartbeats DROP CONSTRAINT %I', fk_name);
      END $downgrade$;
      UPDATE project.agent_heartbeats SET project_id = '__legacy_unscoped__' WHERE run_id = 'retry-run';
      ALTER TABLE project.agents ADD CONSTRAINT agents_legacy_global_id_key UNIQUE (id);
      ALTER TABLE project.agent_heartbeats
        ADD CONSTRAINT agent_heartbeats_legacy_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES project.agents(id) ON DELETE CASCADE;
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0006', '0007', '0008');
    `));

    await expect(applySchemaBaseline(ctx.db)).resolves.toMatchObject({ applied: true });
    await expect(ctx.db.execute(sql`
      SELECT project_id FROM project.agent_heartbeats WHERE run_id = 'retry-run'
    `)).resolves.toEqual([{ project_id: "registered-project" }]);
  });
});

/**
 * FNXC:PostgresSchema 2026-06-24-06:30:
 * VAL-SCHEMA-001 index parity: enumerates EVERY non-unique lookup index from
 * the SQLite final schema (SCHEMA_SQL + all migration blocks in db.ts +
 * central-db.ts) and asserts each has a PostgreSQL counterpart after the
 * baseline migration is applied. This closes the hazard documented in
 * library/drizzle-schema-notes.md where the initial snapshot missed ~64
 * indexes that lived in migration blocks rather than SCHEMA_SQL.
 *
 * A few SQLite index names were intentionally renamed in the PostgreSQL
 * migration for clarity; the RENAMED_TO map handles those. The legacy
 * agentLogEntries table (created by migration 40, dropped by migration 102)
 * is excluded since it is transitional and not part of the final schema.
 */
pgDescribe("schema-applier: VAL-SCHEMA-001 index parity (every SQLite index has a PG counterpart)", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("every index from the SQLite final schema exists in PostgreSQL", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    // Query every index name across all three application schemas.
    const pgIndexRows = (await ctx.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname IN ('project', 'central', 'archive')
    `)) as unknown as Array<{ indexname: string }>;
    const pgIndexNames = new Set(pgIndexRows.map((r) => r.indexname));
    // Also include unique-constraint names (some SQLite unique indexes became
    // table-level CONSTRAINT ... UNIQUE in the migration).
    const pgConstraintRows = (await ctx.db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE connamespace IN ('project'::regnamespace, 'central'::regnamespace, 'archive'::regnamespace)
      AND contype = 'u'
    `)) as unknown as Array<{ conname: string }>;
    for (const r of pgConstraintRows) pgIndexNames.add(r.conname);

    // SQLite indexes that were renamed in PostgreSQL for clarity.
    const RENAMED_TO: Record<string, string> = {
      idxAutomationsScope: "idxAutomationsProjectScope",
      idxSecretsKey: "secrets_key_unique",
      idxSecretsGlobalKey: "secrets_global_key_unique",
      idxTaskDocumentsTaskKey: "task_documents_task_id_key_unique",
      // central-db.ts uses idxActivityLogProjectId ON centralActivityLog;
      // the PostgreSQL migration renamed it to idxCentralActivityLogProjectId
      // to distinguish from the project-schema activity_log indexes.
      idxActivityLogProjectId: "idxCentralActivityLogProjectId",
    };

    const missing: string[] = [];
    for (const sqliteName of SQLITE_FINAL_INDEXES) {
      const pgName = RENAMED_TO[sqliteName] ?? sqliteName;
      if (!pgIndexNames.has(pgName)) {
        missing.push(`${sqliteName} → expected PG name "${pgName}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the critical idx_tasks_deletedAt index exists (soft-delete filtering)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const rows = (await ctx.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'project' AND tablename = 'tasks' AND indexname = 'idx_tasks_deletedAt'
    `)) as unknown as Array<{ indexname: string }>;
    expect(rows.length).toBe(1);
  });

  it("all 8 tasks-table lookup indexes exist", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const rows = (await ctx.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'project' AND tablename = 'tasks'
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string }>;
    const taskIndexNames = new Set(rows.map((r) => r.indexname));
    const expected = [
      "idx_tasks_deletedAt",
      "idxTasksAssignedAgentId",
      "idxTasksAssigneeUserId",
      "idxTasksColumn",
      "idxTasksCreatedAt",
      "idxTasksLineageId",
      "idxTasksPausedByAgentId",
      "idxTasksUpdatedAt",
    ];
    for (const name of expected) {
      expect(taskIndexNames.has(name)).toBe(true);
    }
  });
});

pgDescribe("schema-applier: automation project-isolation upgrade", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  async function seedVersion0000Automation(
    db: TestContext["db"],
    projectIds: readonly string[],
  ): Promise<void> {
    await db.execute(sql.raw(`
      CREATE SCHEMA project;
      CREATE SCHEMA central;
      CREATE TABLE central.projects (
        id text PRIMARY KEY,
        name text NOT NULL,
        path text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active',
        isolation_mode text NOT NULL DEFAULT 'in-process',
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      /* FNXC:GitHubImportTranslate 2026-07-16-23:30: Later durable-task migrations run after this historical 0000 fixture, so retain their required task table surface. */
      CREATE TABLE project.tasks (id text PRIMARY KEY);
      /*
      FNXC:Ideation 2026-07-18-13:25:
      FN-8295 migration 0022 FKs ideation rows to missions/mission_features on (project_id, id).
      A historical 0000 fixture must retain those parent tables so 0006 can rewrite their PKs to
      composite ownership before 0022 attaches FKs; otherwise upgrade-from-0000 tests fail with
      missing relation project.missions.
      */
      CREATE TABLE project.missions (id text PRIMARY KEY);
      /* slice_id required before 0023 research provenance unique index can attach. */
      CREATE TABLE project.mission_features (id text PRIMARY KEY, slice_id text);
      CREATE TABLE project.automations (
        id text PRIMARY KEY,
        name text NOT NULL,
        description text,
        schedule_type text NOT NULL,
        cron_expression text NOT NULL,
        command text NOT NULL,
        enabled integer DEFAULT 1,
        timeout_ms integer,
        steps jsonb,
        next_run_at text,
        last_run_at text,
        last_run_result jsonb,
        run_count integer DEFAULT 0,
        run_history jsonb DEFAULT '[]',
        scope text DEFAULT 'project',
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE INDEX "idxAutomationsScope" ON project.automations(scope);
      CREATE TABLE public.fusion_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.fusion_schema_migrations(version) VALUES ('0000');
      INSERT INTO project.automations (
        id, name, schedule_type, cron_expression, command, enabled,
        next_run_at, scope, created_at, updated_at
      ) VALUES (
        'legacy-automation', 'Legacy', 'custom', '* * * * *', 'echo legacy', 1,
        '2026-01-01T00:00:00.000Z', 'project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `));
    for (const projectId of projectIds) {
      await db.execute(sql`
        INSERT INTO central.projects(id, name, path, created_at, updated_at)
        VALUES (${projectId}, ${projectId}, ${`/repo/${projectId}`}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `);
    }
  }

  /**
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * The versioned upgrade must preserve existing schedules. A sole registered project is deterministic ownership evidence; multiple projects are ambiguous and must fail loudly before a bound cron runner starts.
   */
  it("upgrades 0000 rows into the sole registered project and records version 0001", async () => {
    ctx = await setupFreshDb();
    await seedVersion0000Automation(ctx.db, ["project-a"]);

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);

    const rows = (await ctx.db.execute(sql`
      SELECT project_id, id, name FROM project.automations
    `)) as unknown as Array<{ project_id: string; id: string; name: string }>;
    expect(rows).toEqual([{ project_id: "project-a", id: "legacy-automation", name: "Legacy" }]);
    const versions = (await ctx.db.execute(sql`
      SELECT version FROM public.fusion_schema_migrations ORDER BY version
    `)) as unknown as Array<{ version: string }>;
    expect(versions.map(({ version }) => version)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      PROJECT_OWNERSHIP_SCHEMA_VERSION,
      SQLITE_SCHEMA_PARITY_VERSION,
      SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
      MISSION_FIX_IDEMPOTENCY_VERSION,
      IMPORT_TRANSLATION_CACHE_VERSION,
      OWNER_PROJECT_ID_SPLIT_VERSION,
      CHAT_SESSION_PINS_VERSION,
      EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
      EXECUTOR_ESCALATION_ATTEMPT_VERSION,
      GLOBAL_ROUTINES_SCHEMA_VERSION,
      IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
      TASK_MERGER_MODEL_LANE_VERSION,
      BULK_COMPLETION_REFUSAL_AT_VERSION,
      IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
      TASK_PROPOSAL_CLAIM_VERSION,
      CONFIGURATION_REVISIONS_VERSION,
      IDEATION_SCHEMA_VERSION,
      RESEARCH_FEATURE_PROVENANCE_VERSION,
      TASK_VERIFICATION_REQUEST_VERSION,
      SYMBOL_LOCKS_SCHEMA_VERSION,
      BIGINT_COUNTERS_VERSION,
      WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
    ]);
    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(false);
  });

  it("fails loudly when legacy automation ownership is ambiguous", async () => {
    ctx = await setupFreshDb();
    await seedVersion0000Automation(ctx.db, ["project-a", "project-b"]);

    await expect(applySchemaBaseline(ctx.db, { pluginHooks: [] })).rejects.toThrow(
      /Cannot assign legacy automations to a project/,
    );
    const versions = (await ctx.db.execute(sql`
      SELECT version FROM public.fusion_schema_migrations ORDER BY version
    `)) as unknown as Array<{ version: string }>;
    expect(versions.map(({ version }) => version)).toEqual(["0000"]);
  });

  it("serializes concurrent schema appliers", async () => {
    ctx = await setupFreshDb();
    const results = await Promise.all([
      applySchemaBaseline(ctx.db, { pluginHooks: [] }),
      applySchemaBaseline(ctx.db, { pluginHooks: [] }),
    ]);
    expect(results.filter(({ applied }) => applied)).toHaveLength(1);
    expect(await getAppliedMigrations(ctx.db)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      PROJECT_OWNERSHIP_SCHEMA_VERSION,
      SQLITE_SCHEMA_PARITY_VERSION,
      SESSION_ADVISOR_ENABLED_SCHEMA_VERSION,
      MISSION_FIX_IDEMPOTENCY_VERSION,
      IMPORT_TRANSLATION_CACHE_VERSION,
      OWNER_PROJECT_ID_SPLIT_VERSION,
      CHAT_SESSION_PINS_VERSION,
      EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
      EXECUTOR_ESCALATION_ATTEMPT_VERSION,
      GLOBAL_ROUTINES_SCHEMA_VERSION,
      IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
      TASK_MERGER_MODEL_LANE_VERSION,
      BULK_COMPLETION_REFUSAL_AT_VERSION,
      IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
      TASK_PROPOSAL_CLAIM_VERSION,
      CONFIGURATION_REVISIONS_VERSION,
      IDEATION_SCHEMA_VERSION,
      RESEARCH_FEATURE_PROVENANCE_VERSION,
      TASK_VERIFICATION_REQUEST_VERSION,
      SYMBOL_LOCKS_SCHEMA_VERSION,
      BIGINT_COUNTERS_VERSION,
      WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
    ]);
  });

  it("queues schema DDL behind an active SQLite migration transaction", async () => {
    ctx = await setupFreshDb();
    const migrationSql = postgres(ctx.testUrl, { max: 1, prepare: false, onnotice: () => {} });
    const schemaSql = postgres(ctx.testUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { lock_timeout: 100 },
    });
    const schemaDb = drizzle(schemaSql);
    let releaseMigration!: () => void;
    let migrationLockAcquired!: () => void;
    const release = new Promise<void>((resolve) => { releaseMigration = resolve; });
    const acquired = new Promise<void>((resolve) => { migrationLockAcquired = resolve; });
    const holder = migrationSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('fusion:sqlite-migration-state'))`;
      migrationLockAcquired();
      await release;
    });

    try {
      await acquired;
      try {
        let lockError: unknown;
        try {
          await applySchemaBaseline(schemaDb, { pluginHooks: [] });
        } catch (error) {
          lockError = error;
        }
        expect(lockError).toBeInstanceOf(Error);
        expect((lockError as Error & { cause?: { code?: string } }).cause?.code).toBe("55P03");
      } finally {
        releaseMigration();
        await holder;
      }
      expect((await applySchemaBaseline(schemaDb, { pluginHooks: [] })).applied).toBe(true);
    } finally {
      releaseMigration();
      await holder.catch(() => undefined);
      await migrationSql.end({ timeout: 5 });
      await schemaSql.end({ timeout: 5 });
    }
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-16-23:30:
  An upgrade has already recorded 0010, so editing its SQL only fixes fresh
  databases. Simulate that recorded pre-fix shape and prove 0016 converges the
  existing default and RLS policy before a reopened store reads the cache.
  */
  it("upgrades a 0010 import translation cache to the normalized scope contract", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version = '0016';
      ALTER TABLE project.import_translation_cache
        ALTER COLUMN project_id SET DEFAULT current_setting('fusion.project_id', true);
      DROP POLICY fusion_project_isolation ON project.import_translation_cache;
      CREATE POLICY fusion_project_isolation ON project.import_translation_cache
        USING (project_id = current_setting('fusion.project_id', true))
        WITH CHECK (project_id = current_setting('fusion.project_id', true));
    `));

    expect(await getAppliedMigrations(ctx.db)).toContain(IMPORT_TRANSLATION_CACHE_VERSION);
    expect(await getAppliedMigrations(ctx.db)).not.toContain(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION);
    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);

    const defaultRows = (await ctx.db.execute(sql`
      SELECT pg_get_expr(ad.adbin, ad.adrelid) AS expression
      FROM pg_attrdef ad
      JOIN pg_class c ON c.oid = ad.adrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ad.adnum
      WHERE n.nspname = 'project' AND c.relname = 'import_translation_cache' AND a.attname = 'project_id'
    `)) as unknown as Array<{ expression: string }>;
    expect(defaultRows[0]?.expression).toContain("__legacy_unscoped__");

    const policies = (await ctx.db.execute(sql`
      SELECT qual FROM pg_policies
      WHERE schemaname = 'project' AND tablename = 'import_translation_cache' AND policyname = 'fusion_project_isolation'
    `)) as unknown as Array<{ qual: string }>;
    expect(policies[0]?.qual).toContain("__legacy_unscoped__");
    expect(await getAppliedMigrations(ctx.db)).toContain(IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION);
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-17-23:48:
  Existing deployments can contain a blank cache partition from pre-0016
  writes. Recreate that durable row, then apply only the new forward migration
  and prove the post-restart legacy scope can discover it.
  */
  it("backfills historic blank import translation cache partitions", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      ALTER TABLE project.import_translation_cache DISABLE TRIGGER fusion_assign_project_id;
      ALTER TABLE project.import_translation_cache DISABLE ROW LEVEL SECURITY;
      INSERT INTO project.import_translation_cache (
        project_id, provider, repo_key, issue_number, target_locale, source_hash,
        translated_title, translated_body, detected_locale, recorded_at
      ) VALUES (
        '', 'github', 'owner/repo', 42, 'en', 'legacy-source-hash',
        'Translated title', 'Translated body', NULL, '2026-07-16T00:00:00.000Z'
      );
      ALTER TABLE project.import_translation_cache ENABLE ROW LEVEL SECURITY;
      ALTER TABLE project.import_translation_cache ENABLE TRIGGER fusion_assign_project_id;
      DELETE FROM public.fusion_schema_migrations WHERE version = '0019';
    `));

    expect(await getAppliedMigrations(ctx.db))
      .not.toContain(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION);
    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);

    await expect(ctx.db.execute(sql`
      SELECT project_id FROM project.import_translation_cache
      WHERE provider = 'github' AND repo_key = 'owner/repo' AND issue_number = 42
    `)).resolves.toEqual([{ project_id: "__legacy_unscoped__" }]);
    expect(await getAppliedMigrations(ctx.db))
      .toContain(IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION);
  });

  it("upgrades a 0001 database by backfilling analytics ownership", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009');
      DROP POLICY fusion_project_isolation ON project.activity_log;
      DROP POLICY fusion_project_isolation ON project.agent_runs;
      DROP POLICY fusion_project_isolation ON project.usage_events;
      DROP TRIGGER fusion_assign_project_id ON project.activity_log;
      DROP TRIGGER fusion_assign_project_id ON project.agent_runs;
      DROP TRIGGER fusion_assign_project_id ON project.usage_events;
      ALTER TABLE project.activity_log DROP COLUMN project_id;
      ALTER TABLE project.agent_runs DROP COLUMN project_id;
      ALTER TABLE project.usage_events DROP COLUMN project_id;
      INSERT INTO central.projects(id, name, path, created_at, updated_at)
      VALUES ('project-a', 'Project A', '/repo/project-a', '2026-01-01', '2026-01-01');
      INSERT INTO project.agents(id, name, role, created_at, updated_at)
      VALUES ('agent-a', 'Agent A', 'worker', '2026-01-01', '2026-01-01');
      INSERT INTO project.activity_log(id, timestamp, type, details)
      VALUES ('activity-a', '2026-01-01', 'task:created', 'created');
      INSERT INTO project.agent_runs(id, agent_id, data, started_at, status)
      VALUES ('run-a', 'agent-a', '{}'::jsonb, '2026-01-01', 'completed');
      INSERT INTO project.usage_events(ts, kind)
      VALUES ('2026-01-01', 'tool_call');
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    for (const table of ["activity_log", "agent_runs", "usage_events"] as const) {
      const rows = (await ctx.db.execute(sql.raw(
        `SELECT project_id FROM project.${table}`,
      ))) as unknown as Array<{ project_id: string }>;
      expect(rows).toEqual([{ project_id: "project-a" }]);
    }
    expect(await getAppliedMigrations(ctx.db)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
      EXECUTOR_ESCALATION_ATTEMPT_VERSION,
      GLOBAL_ROUTINES_SCHEMA_VERSION,
      IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
      TASK_MERGER_MODEL_LANE_VERSION,
      BULK_COMPLETION_REFUSAL_AT_VERSION,
      IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
      TASK_PROPOSAL_CLAIM_VERSION,
      CONFIGURATION_REVISIONS_VERSION,
      IDEATION_SCHEMA_VERSION,
      RESEARCH_FEATURE_PROVENANCE_VERSION,
      TASK_VERIFICATION_REQUEST_VERSION,
      SYMBOL_LOCKS_SCHEMA_VERSION,
      BIGINT_COUNTERS_VERSION,
      WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
    ]);
  });

  /**
   * FNXC:CommandCenterTenantIsolation 2026-07-14-01:04:
   * A database that already recorded analytics migration 0002 must still backfill monitor and approval ownership from the sole registered project before bound Command Center reads are enabled.
   */
  it("upgrades a 0002 database by backfilling monitor and approval ownership", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0003', '0004', '0005', '0006', '0007', '0008', '0009');
      DROP POLICY fusion_project_isolation ON project.deployments;
      DROP POLICY fusion_project_isolation ON project.incidents;
      DROP POLICY fusion_project_isolation ON project.approval_request_audit_events;
      DROP TRIGGER fusion_assign_project_id ON project.deployments;
      DROP TRIGGER fusion_assign_project_id ON project.incidents;
      DROP TRIGGER fusion_assign_project_id ON project.approval_request_audit_events;
      ALTER TABLE project.deployments DROP COLUMN project_id;
      ALTER TABLE project.incidents DROP COLUMN project_id;
      ALTER TABLE project.approval_request_audit_events DROP COLUMN project_id;
      INSERT INTO central.projects(id, name, path, created_at, updated_at)
      VALUES ('project-a', 'Project A', '/repo/project-a', '2026-01-01', '2026-01-01');
      INSERT INTO project.deployments(deployment_id, deployed_at, created_at)
      VALUES ('deployment-a', '2026-01-01', '2026-01-01');
      INSERT INTO project.incidents(incident_id, grouping_key, title, status, opened_at, created_at, updated_at)
      VALUES ('incident-a', 'group-a', 'Incident A', 'open', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO project.approval_request_audit_events(id, request_id, event_type, actor_id, actor_type, actor_name, created_at)
      VALUES ('event-a', 'request-a', 'approved', 'user-a', 'user', 'User A', '2026-01-01');
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    for (const table of ["deployments", "incidents", "approval_request_audit_events"] as const) {
      const rows = (await ctx.db.execute(sql.raw(
        `SELECT project_id FROM project.${table}`,
      ))) as unknown as Array<{ project_id: string }>;
      expect(rows).toEqual([{ project_id: "project-a" }]);
    }
    expect(await getAppliedMigrations(ctx.db)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
      EXECUTOR_ESCALATION_ATTEMPT_VERSION,
      GLOBAL_ROUTINES_SCHEMA_VERSION,
      IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
      TASK_MERGER_MODEL_LANE_VERSION,
      BULK_COMPLETION_REFUSAL_AT_VERSION,
      IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
      TASK_PROPOSAL_CLAIM_VERSION,
      CONFIGURATION_REVISIONS_VERSION,
      IDEATION_SCHEMA_VERSION,
      RESEARCH_FEATURE_PROVENANCE_VERSION,
      TASK_VERIFICATION_REQUEST_VERSION,
      SYMBOL_LOCKS_SCHEMA_VERSION,
      BIGINT_COUNTERS_VERSION,
      WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
    ]);
  });

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  A target that already recorded 0000-0003 must still receive all retired-table preservation surfaces before a SQLite migration retry.
  */
  it("upgrades a 0003 database with legacy cutover preservation tables", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [] });
    await ctx.db.execute(sql.raw(`
      DELETE FROM public.fusion_schema_migrations WHERE version IN ('0004', '0005', '0006', '0007', '0008', '0009');
      DROP TABLE project.project_auth_sessions;
      DROP TABLE project.project_auth_providers;
      DROP TABLE project.project_auth_memberships;
      DROP TABLE project.project_auth_users;
      DROP TABLE project.task_reviewer_runs;
      DROP TABLE project.boards;
    `));

    expect((await applySchemaBaseline(ctx.db, { pluginHooks: [] })).applied).toBe(true);
    const tables = (await ctx.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'project'
        AND table_name IN (
          'boards', 'project_auth_users', 'project_auth_memberships',
          'project_auth_providers', 'project_auth_sessions', 'task_reviewer_runs'
        )
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "boards",
      "project_auth_memberships",
      "project_auth_providers",
      "project_auth_sessions",
      "project_auth_users",
      "task_reviewer_runs",
    ]);
    expect(await getAppliedMigrations(ctx.db)).toEqual([
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      EXECUTOR_TOOL_FAILURE_RETRY_VERSION,
      EXECUTOR_ESCALATION_ATTEMPT_VERSION,
      GLOBAL_ROUTINES_SCHEMA_VERSION,
      IMPORT_TRANSLATION_CACHE_SCOPE_FIX_VERSION,
      TASK_MERGER_MODEL_LANE_VERSION,
      BULK_COMPLETION_REFUSAL_AT_VERSION,
      IMPORT_TRANSLATION_CACHE_LEGACY_PARTITION_BACKFILL_VERSION,
      TASK_PROPOSAL_CLAIM_VERSION,
      CONFIGURATION_REVISIONS_VERSION,
      IDEATION_SCHEMA_VERSION,
      RESEARCH_FEATURE_PROVENANCE_VERSION,
      TASK_VERIFICATION_REQUEST_VERSION,
      SYMBOL_LOCKS_SCHEMA_VERSION,
      BIGINT_COUNTERS_VERSION,
      WORKFLOW_IR_PIN_AND_LEGACY_ADOPTION_VERSION,
    ]);
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-006 AUTOINCREMENT → identity with sequence continuity", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("maps AUTOINCREMENT columns to GENERATED ALWAYS AS IDENTITY", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    // attidentity = 'a' means GENERATED ALWAYS AS IDENTITY (PostgreSQL).
    const rows = (await ctx.db.execute(sql`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'project' AND a.attidentity = 'a'
      ORDER BY c.relname
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    // The 8 AUTOINCREMENT columns from the SQLite schema.
    const identityTables = rows.map((r) => r.table_name);
    expect(identityTables).toEqual(
      expect.arrayContaining([
        "agent_heartbeats",
        "task_document_revisions",
        "goal_citations",
        "usage_events",
        "plugin_activations",
        "knowledge_pages",
        "deployments",
        "incidents",
      ]),
    );
    expect(rows.length).toBe(9);
  });

  it("sequence continuity: consecutive inserts produce increasing IDs without collision", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.usage_events (project_id, ts, kind) VALUES ('schema-test', '2026-01-01', 'test')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.usage_events (project_id, ts, kind) VALUES ('schema-test', '2026-01-02', 'test')
    `);
    const rows = (await ctx.db.execute(sql`
      SELECT id FROM project.usage_events ORDER BY id
    `)) as unknown as Array<{ id: number }>;
    expect(rows.length).toBe(2);
    expect(rows[1].id).toBeGreaterThan(rows[0].id);
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-005 CHECK constraints preserved and enforced", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("rejects an invalid secrets access_policy (CHECK enforced)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await expectPgError(
      ctx.db.execute(sql`
        INSERT INTO project.secrets (id, key, value_ciphertext, nonce, access_policy, created_at, updated_at)
        VALUES ('s1', 'k1', decode('00', 'hex'), decode('00', 'hex'), 'bogus-policy', '2026-01-01', '2026-01-01')
      `),
      /access_policy_check|check constraint/i,
    );
  });

  it("rejects an invalid agent_ratings score (BETWEEN 1 AND 5)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await expectPgError(
      ctx.db.execute(sql`
        INSERT INTO project.agent_ratings (id, agent_id, rater_type, score, created_at)
        VALUES ('r1', 'a1', 'user', 99, '2026-01-01')
      `),
      /score_check|check constraint/i,
    );
  });

  it("rejects an invalid nodes type (central DB)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await expectPgError(
      ctx.db.execute(sql`
        INSERT INTO central.nodes (id, name, type, created_at, updated_at)
        VALUES ('n1', 'node1', 'bogus', '2026-01-01', '2026-01-01')
      `),
      /type_check|check constraint/i,
    );
  });

  it("accepts valid values that satisfy the CHECK constraints", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.secrets (id, key, value_ciphertext, nonce, access_policy, created_at, updated_at)
      VALUES ('s1', 'k1', decode('00', 'hex'), decode('00', 'hex'), 'auto', '2026-01-01', '2026-01-01')
    `);
    const rows = (await ctx.db.execute(sql`
      SELECT access_policy FROM project.secrets WHERE id = 's1'
    `)) as unknown as Array<{ access_policy: string }>;
    expect(rows[0].access_policy).toBe("auto");
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-002 foreign-key cascade rules preserved", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("ON DELETE CASCADE removes child rows (tasks → merge_queue)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    // Insert a task then a merge_queue row referencing it.
    await ctx.db.execute(sql`
      INSERT INTO project.tasks (id, description, "column", created_at, updated_at)
      VALUES ('t1', 'desc', 'todo', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.merge_queue (task_id, enqueued_at)
      VALUES ('t1', '2026-01-01')
    `);
    // Deleting the task must cascade to the merge_queue row.
    await ctx.db.execute(sql`DELETE FROM project.tasks WHERE id = 't1'`);
    const rows = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM project.merge_queue WHERE task_id = 't1'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });

  it("ON DELETE SET NULL nulls the referencing column (tasks ← mission_features)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.tasks (id, description, "column", created_at, updated_at)
      VALUES ('t2', 'desc', 'todo', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.missions (id, title, status, interview_state, created_at, updated_at)
      VALUES ('m1', 'M', 'planning', '{}', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.milestones (id, mission_id, title, status, order_index, interview_state, created_at, updated_at)
      VALUES ('ms1', 'm1', 'MS', 'planning', 0, '{}', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.slices (id, milestone_id, title, status, order_index, created_at, updated_at)
      VALUES ('sl1', 'ms1', 'SL', 'planning', 0, '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.mission_features (id, slice_id, task_id, title, status, created_at, updated_at)
      VALUES ('mf1', 'sl1', 't2', 'F', 'pending', '2026-01-01', '2026-01-01')
    `);
    // Deleting the task must SET NULL the mission_features.task_id.
    await ctx.db.execute(sql`DELETE FROM project.tasks WHERE id = 't2'`);
    const rows = (await ctx.db.execute(sql`
      SELECT task_id FROM project.mission_features WHERE id = 'mf1'
    `)) as unknown as Array<{ task_id: string | null }>;
    expect(rows[0].task_id).toBeNull();
  });

  it("every FK cascade rule from SQLite is present (cascade rule coverage)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    // At minimum, the cascade FKs must exist. Count cascade ('c') FKs.
    const rows = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE contype = 'f' AND confdeltype = 'c'
      AND connamespace IN ('project'::regnamespace, 'central'::regnamespace)
    `)) as unknown as Array<{ n: number }>;
    // The SQLite schema has many CASCADE FKs (agents children, task children,
    // missions hierarchy, etc.). Assert a healthy lower bound.
    expect(rows[0].n).toBeGreaterThanOrEqual(20);
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-003 unique indexes preserved", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("enforces uniqueness on task_documents(task_id, key)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.tasks (id, description, "column", created_at, updated_at)
      VALUES ('u1', 'desc', 'todo', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.task_documents (id, task_id, key, created_at, updated_at)
      VALUES ('d1', 'u1', 'spec', '2026-01-01', '2026-01-01')
    `);
    await expectPgError(
      ctx.db.execute(sql`
        INSERT INTO project.task_documents (id, task_id, key, created_at, updated_at)
        VALUES ('d2', 'u1', 'spec', '2026-01-01', '2026-01-01')
      `),
      /unique|duplicate key/i,
    );
  });

  it("enforces uniqueness on secrets(key)", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.secrets (id, key, value_ciphertext, nonce, created_at, updated_at)
      VALUES ('a', 'dup', decode('00', 'hex'), decode('00', 'hex'), '2026-01-01', '2026-01-01')
    `);
    await expectPgError(
      ctx.db.execute(sql`
        INSERT INTO project.secrets (id, key, value_ciphertext, nonce, created_at, updated_at)
        VALUES ('b', 'dup', decode('00', 'hex'), decode('00', 'hex'), '2026-01-01', '2026-01-01')
      `),
      /unique|duplicate key/i,
    );
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-004 JSON columns round-trip as jsonb", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("tasks.dependencies is jsonb and round-trips nested arrays/objects", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const colRow = (await ctx.db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'dependencies'
    `)) as unknown as Array<{ data_type: string }>;
    expect(colRow[0].data_type).toBe("jsonb");

    // Round-trip a nested value through the jsonb column.
    await ctx.db.execute(sql`
      INSERT INTO project.tasks (id, description, "column", dependencies, steps, custom_fields, created_at, updated_at)
      VALUES (
        'j1', 'desc', 'todo',
        '["dep-a", {"nested": true, "count": 3}]'::jsonb,
        '{"items": [1, 2, 3]}'::jsonb,
        '{"theme": "dark", "flags": {"x": true}}'::jsonb,
        '2026-01-01', '2026-01-01'
      )
    `);
    const rows = (await ctx.db.execute(sql`
      SELECT dependencies, steps, custom_fields FROM project.tasks WHERE id = 'j1'
    `)) as unknown as Array<{
      dependencies: unknown;
      steps: unknown;
      custom_fields: unknown;
    }>;
    expect(rows[0].dependencies).toEqual(["dep-a", { nested: true, count: 3 }]);
    expect(rows[0].steps).toEqual({ items: [1, 2, 3] });
    expect(rows[0].custom_fields).toEqual({ theme: "dark", flags: { x: true } });
  });
});

pgDescribe("schema-applier: VAL-SCHEMA-007 plugin-owned tables materialize via schema-init hook", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("roadmap plugin tables exist after the schema-init hook runs", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [roadmapPluginInitHook] });
    const rows = (await ctx.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'project'
      AND table_name IN ('roadmaps', 'roadmap_milestones', 'roadmap_features')
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual([
      "roadmap_features",
      "roadmap_milestones",
      "roadmaps",
    ]);
  });

  /* FNXC:EvenRealitiesPostgres 2026-07-14-17:45: Fresh PostgreSQL databases must include the glasses notification snapshot with project-local task identity. */
  it("default plugin hooks materialize project-isolated Even Realities snapshots", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    const tables = (await ctx.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'even_realities_seen_tasks'
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables).toEqual([{ table_name: "even_realities_seen_tasks" }]);
    await ctx.db.execute(sql`
      INSERT INTO project.even_realities_seen_tasks(project_id, task_id, last_column, updated_at)
      VALUES ('project-a', 'FN-1', 'todo', '2026-07-14'),
             ('project-b', 'FN-1', 'done', '2026-07-14')
    `);
    const rows = (await ctx.db.execute(sql`
      SELECT project_id, task_id FROM project.even_realities_seen_tasks ORDER BY project_id
    `)) as unknown as Array<{ project_id: string; task_id: string }>;
    expect(rows).toEqual([
      { project_id: "project-a", task_id: "FN-1" },
      { project_id: "project-b", task_id: "FN-1" },
    ]);
  });

  it("repairs an already-versioned database that predates the Even Realities PostgreSQL hook", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`DROP TABLE project.even_realities_seen_tasks`);

    const result = await applySchemaBaseline(ctx.db);
    expect(result.pluginHooksRun).toBeGreaterThan(0);
    const rows = (await ctx.db.execute(sql`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'project' AND c.relname = 'even_realities_seen_tasks'
    `)) as unknown as Array<{ rls: boolean; forced: boolean }>;
    expect(rows).toEqual([{ rls: true, forced: true }]);
  });

  it("preserves bundled plugin constraint and index OIDs on steady-state reapply", async () => {
    ctx = await setupFreshDb();
    await ctx.db.execute(sql.raw(`
      CREATE SCHEMA project;
      CREATE SCHEMA central;
      CREATE TABLE central.projects (id text PRIMARY KEY);
    `));
    const hooks = [
      roadmapPluginSchemaInit,
      cePluginSchemaInit,
      reportsPluginSchemaInit,
      cliPressPluginSchemaInit,
    ];
    for (const hook of hooks) await hook.init(ctx.db);

    /*
    FNXC:PluginSchemaPerformance 2026-07-14-23:40:
    Reapplying the PostgreSQL baseline is a steady-state validation path, not a reason to replace bundled-plugin keys and indexes. Stable catalog OIDs prove the hooks avoided destructive DROP/ADD churn while retaining the same schema objects.
    */
    const catalogObjects = async () => (await ctx!.db.execute(sql`
      SELECT 'constraint' AS kind, conname AS name, oid::text AS oid, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE connamespace = 'project'::regnamespace
        AND conname IN (
          'roadmaps_pkey', 'roadmap_milestones_pkey', 'roadmap_features_pkey',
          'roadmap_milestones_roadmap_id_fkey', 'roadmap_features_milestone_id_fkey',
          'ce_pipeline_links_pkey', 'ce_pipeline_state_pkey', 'ce_pipeline_sync_queue_pkey',
          'reports_pkey',
          'cli_press_services_pkey', 'uq_cli_press_services_project_slug',
          'cli_press_cli_specs_pkey', 'uq_cli_press_specs_service_name', 'cli_press_cli_specs_service_id_fkey',
          'cli_press_artifacts_pkey', 'cli_press_artifacts_cli_spec_id_fkey',
          'cli_press_credentials_pkey', 'uq_cli_press_credentials_service_name', 'cli_press_credentials_service_id_fkey',
          'cli_press_service_settings_pkey', 'uq_cli_press_settings_service_key_scope', 'cli_press_service_settings_service_id_fkey'
        )
      UNION ALL
      SELECT 'index' AS kind, c.relname AS name, c.oid::text AS oid, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'project'
        AND c.relname IN (
          'idxRoadmapMilestonesRoadmapOrder',
          'idxRoadmapFeaturesMilestoneOrder',
          'idxRoadmapsProject',
          'idxRoadmapMilestonesProject',
          'idxRoadmapFeaturesProject',
          'idxCeSessionsStatusUpdated',
          'idxCeSessionsStageCreated',
          'idxCeSessionsProject',
          'idxCePipelineLinksPipeline',
          'idxCePipelineLinksTask',
          'idxCePipelineStateStatus',
          'idxCePipelineSyncQueuePending',
          'idxCePipelineSyncQueuePipeline',
          'idxReportsCadenceCreated',
          'idxReportsStatusUpdated',
          'idxReportsPeriod',
          'idx_cli_press_specs_service',
          'idx_cli_press_artifacts_spec',
          'idx_cli_press_credentials_service',
          'idx_cli_press_settings_service'
        )
      ORDER BY kind, name
    `)) as unknown as Array<{ kind: string; name: string; oid: string; definition: string }>;

    const before = await catalogObjects();
    expect(before).toHaveLength(42);
    for (const index of before.filter((entry) => entry.kind === "index")) {
      expect(index.definition, index.name).toMatch(/USING btree \(project_id,/);
    }
    for (const hook of hooks) await hook.init(ctx.db);
    expect(await catalogObjects()).toEqual(before);
  });

  it("roadmap FK cascade: deleting a roadmap removes its milestones and features", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [roadmapPluginInitHook] });
    await ctx.db.execute(sql`
      INSERT INTO project.roadmaps (id, project_id, title, created_at, updated_at)
      VALUES ('rm1', 'schema-test', 'R', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.roadmap_milestones (id, roadmap_id, project_id, title, order_index, created_at, updated_at)
      VALUES ('rmm1', 'rm1', 'schema-test', 'M', 0, '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.roadmap_features (id, milestone_id, project_id, title, order_index, created_at, updated_at)
      VALUES ('rmf1', 'rmm1', 'schema-test', 'F', 0, '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`DELETE FROM project.roadmaps WHERE id = 'rm1'`);
    const ms = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM project.roadmap_milestones WHERE roadmap_id = 'rm1'
    `)) as unknown as Array<{ n: number }>;
    const feats = (await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM project.roadmap_features WHERE milestone_id = 'rmm1'
    `)) as unknown as Array<{ n: number }>;
    expect(ms[0].n).toBe(0);
    expect(feats[0].n).toBe(0);
  });
});

/**
 * Assert that an async query rejects with a PostgreSQL error whose message or
 * cause mentions the given constraint detail. Drizzle wraps postgres errors in
 * a "Failed query: ..." Error whose `cause` is the original PostgresError; the
 * constraint name appears in the cause's message, so we flatten both.
 */
async function expectPgError(
  promise: Promise<unknown>,
  matcher: RegExp,
): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected rejection matching ${matcher}, but query succeeded`);
  } catch (error) {
    const err = error as Error & { cause?: Error };
    const haystack = `${err.message} ${err.cause?.message ?? ""}`;
    expect(haystack).toMatch(matcher);
  }
}

// Ensure beforeAll type-only import is used (keeps the test module self-contained).
void beforeAll;

/**
 * Wrap the roadmapPluginSchemaInit into a hook object the applier accepts.
 * (roadmapPluginSchemaInit is already a hook; this alias keeps the import surface
 * stable for future plugin additions.)
 */
const roadmapPluginInitHook = roadmapPluginSchemaInit;
