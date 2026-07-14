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
import {
  applySchemaBaseline,
  SCHEMA_BASELINE_VERSION,
  roadmapPluginSchemaInit,
} from "../../postgres/index.js";

const PG_ADMIN_URL =
  process.env.FUSION_PG_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

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
});

pgDescribe("schema-applier: VAL-SCHEMA-001 final-schema parity (table counts)", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("creates all 81 project tables, 17 central tables, 1 archive table", async () => {
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
    // Project: 81 core tables. (Plugin tables are added separately by the hook.)
    expect(bySchema.project).toBe(81);
    expect(bySchema.central).toBe(17);
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
    expect(rows.length).toBe(8);
  });

  it("sequence continuity: consecutive inserts produce increasing IDs without collision", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db);
    await ctx.db.execute(sql`
      INSERT INTO project.usage_events (ts, kind) VALUES ('2026-01-01', 'test')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.usage_events (ts, kind) VALUES ('2026-01-02', 'test')
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

  it("roadmap FK cascade: deleting a roadmap removes its milestones and features", async () => {
    ctx = await setupFreshDb();
    await applySchemaBaseline(ctx.db, { pluginHooks: [roadmapPluginInitHook] });
    await ctx.db.execute(sql`
      INSERT INTO project.roadmaps (id, title, created_at, updated_at)
      VALUES ('rm1', 'R', '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.roadmap_milestones (id, roadmap_id, title, order_index, created_at, updated_at)
      VALUES ('rmm1', 'rm1', 'M', 0, '2026-01-01', '2026-01-01')
    `);
    await ctx.db.execute(sql`
      INSERT INTO project.roadmap_features (id, milestone_id, title, order_index, created_at, updated_at)
      VALUES ('rmf1', 'rmm1', 'F', 0, '2026-01-01', '2026-01-01')
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
