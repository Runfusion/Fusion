/**
 * TaskStore persistence/allocator/settings PostgreSQL integration tests (U12).
 *
 * FNXC:TaskStorePersistence 2026-06-24-16:00:
 * Integration tests proving the async persistence, allocator reconciliation,
 * and settings helpers round-trip correctly against a real PostgreSQL instance.
 * Each test creates a uniquely-named fresh database, applies the baseline
 * schema, and exercises the async helpers that the migrating TaskStore modules
 * consume.
 *
 * Coverage targets (the assertions U12 fulfills):
 *   VAL-DATA-005 — Soft-delete visibility: live readers hide deletedAt rows.
 *   VAL-DATA-006 — Forensic reads surface soft-deleted rows.
 *   VAL-DATA-007 — Allocator reconciliation bumps sequences on store open.
 *   VAL-DATA-008 — Soft-deleted/archived IDs stay reserved.
 *   VAL-DATA-009 — Create-class inserts are non-destructive.
 *   VAL-SCHEMA-004 — JSON columns round-trip as JSONB.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import {
  insertTaskRow,
  readTaskRow,
  readLiveTaskRows,
  countLiveTasks,
  softDeleteTaskRow,
  isTaskIdConflictError,
} from "../../task-store/async-persistence.js";
import {
  reconcileTaskIdStateAsync,
  computeNextSequenceFloor,
  getKnownPrefixes,
  parseTaskIdForAllocator,
} from "../../task-store/async-allocator.js";
import {
  readProjectConfig,
  readProjectSettings,
  writeProjectConfig,
  patchProjectSettings,
} from "../../task-store/async-settings.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_u12_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  testUrl: string;
  layer: AsyncDataLayer;
  adminSql: ReturnType<typeof postgres>;
  adminDb: ReturnType<typeof drizzle>;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  const schemaBackend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConnections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  const connections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections);

  const adminSql = postgres(testUrl, { max: 2, prepare: false, onnotice: () => {} });
  const adminDb = drizzle(adminSql);
  return { dbName, testUrl, layer, adminSql, adminDb };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.layer.close();
  } catch {
    // best-effort
  }
  try {
    await ctx.adminSql.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
}

/** A minimal task record with the NOT NULL columns filled. */
function makeMinimalTask(id: string, column = "todo"): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    description: "test task",
    column,
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
  };
}

pgDescribe("U12 taskstore-persistence (PostgreSQL)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── VAL-DATA-009 / VAL-SCHEMA-004: create + JSON round-trip ───────────

  it("inserts a task and reads it back via async Drizzle (VAL-DATA-009)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-001"), { lineageId: null });

    const row = await readTaskRow(ctx.layer, "KB-001");
    expect(row).toBeDefined();
    expect(row!.id).toBe("KB-001");
    expect(row!.description).toBe("test task");
    expect(row!.column).toBe("todo");
  });

  it("round-trips JSON columns as JSONB with identical shape (VAL-SCHEMA-004)", async () => {
    ctx = await setupCtx();
    // The column descriptors read nested fields (e.g. task.tokenUsage.perModel),
    // so the task record carries the canonical Task shape for JSON-backed columns.
    const task = {
      ...makeMinimalTask("KB-002"),
      dependencies: ["KB-001", "FN-100"],
      steps: [{ id: "s1", name: "step one" }],
      customFields: { team: "infra", nested: { a: 1, b: [1, 2, 3] } },
      log: [{ timestamp: "2026-01-01T00:00:00Z", action: "created" }],
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        firstUsedAt: "2026-01-01T00:00:00Z",
        lastUsedAt: "2026-01-01T00:01:00Z",
        modelProvider: "anthropic",
        modelId: "claude",
        perModel: [{ provider: "anthropic", modelId: "claude", inputTokens: 10 }],
      },
    };
    await insertTaskRow(ctx.layer, task, { lineageId: null });

    const row = await readTaskRow(ctx.layer, "KB-002");
    expect(row).toBeDefined();
    // jsonb columns come back already-parsed as JS values
    expect(row!.dependencies).toEqual(["KB-001", "FN-100"]);
    expect(row!.steps).toEqual([{ id: "s1", name: "step one" }]);
    expect(row!.customFields).toEqual({ team: "infra", nested: { a: 1, b: [1, 2, 3] } });
    expect(row!.log).toEqual([{ timestamp: "2026-01-01T00:00:00Z", action: "created" }]);
    expect(row!.tokenUsagePerModel).toEqual([
      { provider: "anthropic", modelId: "claude", inputTokens: 10 },
    ]);

    // Verify the PostgreSQL column type is actually jsonb (not text).
    const colType = await ctx.adminDb.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'dependencies'
    `);
    expect(colType[0]?.data_type).toBe("jsonb");
  });

  it("create-class insert is non-destructive: duplicate id raises, existing row intact (VAL-DATA-009)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-010"), { lineageId: null });

    // A second insert with the same id must fail (primary-key violation), not
    // silently overwrite.
    let caught: unknown;
    try {
      await insertTaskRow(ctx.layer, makeMinimalTask("KB-010"), { lineageId: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isTaskIdConflictError(caught)).toBe(true);

    // The original row is unchanged.
    const row = await readTaskRow(ctx.layer, "KB-010");
    expect(row).toBeDefined();
    expect(row!.id).toBe("KB-010");
    // Row counts only ever increase on create paths — verify no duplicate.
    const count = await countLiveTasks(ctx.layer);
    expect(count).toBe(1);
  });

  // ── VAL-DATA-005 / VAL-DATA-006: soft-delete visibility ───────────────

  it("soft-deleted tasks are hidden from live readers (VAL-DATA-005)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-100", "todo"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-101", "todo"), { lineageId: null });

    // Both visible initially.
    expect(await countLiveTasks(ctx.layer)).toBe(2);
    let live = await readLiveTaskRows(ctx.layer);
    expect(live.map((r) => r.id).sort()).toEqual(["KB-100", "KB-101"]);

    // Soft-delete KB-100.
    const deletedAt = new Date().toISOString();
    await softDeleteTaskRow(ctx.layer, "KB-100", deletedAt);

    // Live readers no longer see it.
    expect(await countLiveTasks(ctx.layer)).toBe(1);
    live = await readLiveTaskRows(ctx.layer);
    expect(live.map((r) => r.id)).toEqual(["KB-101"]);

    // readTaskRow (live) returns undefined for the soft-deleted task.
    const hidden = await readTaskRow(ctx.layer, "KB-100");
    expect(hidden).toBeUndefined();
  });

  it("forensic reads surface soft-deleted rows (VAL-DATA-006)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-200", "todo"), { lineageId: null });
    const deletedAt = new Date().toISOString();
    await softDeleteTaskRow(ctx.layer, "KB-200", deletedAt);

    // Forensic read (includeDeleted) surfaces it.
    const forensic = await readTaskRow(ctx.layer, "KB-200", { includeDeleted: true });
    expect(forensic).toBeDefined();
    expect(forensic!.id).toBe("KB-200");
    expect(forensic!.deletedAt).toBe(deletedAt);
    expect(forensic!.column).toBe("archived");
  });

  // FNXC:TaskStoreForensicRead 2026-06-26-16:30:
  // VAL-CROSS-003 / VAL-DATA-006 — Regression test for the list-level forensic
  // surface. GET /api/tasks?includeDeleted=true wires includeDeleted through
  // listTasks → readLiveTaskRows. Without the wiring, soft-deleted tasks were
  // absent from the list response even when includeDeleted=true was passed.
  it("readLiveTaskRows surfaces soft-deleted rows when includeDeleted is set (VAL-CROSS-003)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-300", "todo"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-301", "todo"), { lineageId: null });
    const deletedAt = new Date().toISOString();
    await softDeleteTaskRow(ctx.layer, "KB-300", deletedAt);

    // Default (live reader): only KB-301 is visible.
    const live = await readLiveTaskRows(ctx.layer);
    expect(live.map((r) => r.id).sort()).toEqual(["KB-301"]);

    // Forensic list read: both rows surface, including the soft-deleted one.
    const forensic = await readLiveTaskRows(ctx.layer, { includeDeleted: true });
    expect(forensic.map((r) => r.id).sort()).toEqual(["KB-300", "KB-301"]);
    const deletedRow = forensic.find((r) => r.id === "KB-300");
    expect(deletedRow?.deletedAt).toBe(deletedAt);

    // The excludeLog projection must also honor includeDeleted.
    const forensicSlim = await readLiveTaskRows(ctx.layer, { excludeLog: true, includeDeleted: true });
    expect(forensicSlim.map((r) => r.id).sort()).toEqual(["KB-300", "KB-301"]);
  });

  // ── VAL-DATA-007 / VAL-DATA-008: allocator reconciliation ─────────────

  it("allocator reconciliation bumps sequences to max suffix on store open (VAL-DATA-007)", async () => {
    ctx = await setupCtx();
    // Seed a task with a high suffix, but leave the sequence at a low value.
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-050"), { lineageId: null });
    // Manually set the sequence to a low value (below the seeded suffix).
    await ctx.adminDb.execute(sql`
      INSERT INTO project.distributed_task_id_state (prefix, next_sequence, committed_cluster_task_count, updated_at)
      VALUES ('KB', 5, 0, ${new Date().toISOString()})
    `);

    const beforeFloor = await computeNextSequenceFloor(ctx.layer.db, "KB");
    // Floor must be at least 50 + 1 = 51 (the seeded suffix is the max in tasks).
    expect(beforeFloor).toBeGreaterThanOrEqual(51);

    // Reconcile bumps the stored sequence to the floor.
    const reconciled = await reconcileTaskIdStateAsync(ctx.layer);
    expect(reconciled).toContain("KB");

    const stateRows = await ctx.layer.db
      .select()
      .from(schema.project.distributedTaskIdState)
      .where(eq(schema.project.distributedTaskIdState.prefix, "KB"));
    expect(stateRows[0]?.nextSequence).toBeGreaterThanOrEqual(51);

    // Re-running reconciliation against the corrected state is a no-op.
    const reconciledAgain = await reconcileTaskIdStateAsync(ctx.layer);
    expect(reconciledAgain).not.toContain("KB");
  });

  it("soft-deleted IDs stay reserved (VAL-DATA-008)", async () => {
    ctx = await setupCtx();
    // Seed a soft-deleted task with a high suffix.
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-099", "todo"), { lineageId: null });
    await softDeleteTaskRow(ctx.layer, "KB-099", new Date().toISOString());

    // Reconcile must account for the soft-deleted id (no deleted_at filter).
    const floor = await computeNextSequenceFloor(ctx.layer.db, "KB");
    expect(floor).toBeGreaterThanOrEqual(100);

    // A new task created after reconciliation must not collide with KB-099.
    await reconcileTaskIdStateAsync(ctx.layer);
    const stateRows = await ctx.layer.db
      .select()
      .from(schema.project.distributedTaskIdState)
      .where(eq(schema.project.distributedTaskIdState.prefix, "KB"));
    const nextSequence = stateRows[0]?.nextSequence ?? 0;
    expect(nextSequence).toBeGreaterThanOrEqual(100);

    // The soft-deleted id's suffix (99) is below nextSequence, so it stays reserved.
    expect(parseTaskIdForAllocator("KB-099")!.sequence).toBeLessThan(nextSequence);
  });

  it("reconciliation accounts for archived-task IDs (VAL-DATA-008)", async () => {
    ctx = await setupCtx();
    // Seed an archived task row with a high suffix.
    await ctx.adminDb.execute(sql`
      INSERT INTO project.archived_tasks (id, data, archived_at)
      VALUES ('KB-200', ${JSON.stringify({ id: "KB-200" })}, ${new Date().toISOString()})
    `);

    const floor = await computeNextSequenceFloor(ctx.layer.db, "KB");
    expect(floor).toBeGreaterThanOrEqual(201);
  });

  it("reconciliation accounts for reservation IDs", async () => {
    ctx = await setupCtx();
    // Seed a reservation with a high sequence.
    const nowIso = new Date().toISOString();
    await ctx.adminDb.execute(sql`
      INSERT INTO project.distributed_task_id_state (prefix, next_sequence, committed_cluster_task_count, updated_at)
      VALUES ('KB', 1, 0, ${nowIso})
    `);
    await ctx.adminDb.execute(sql`
      INSERT INTO project.distributed_task_id_reservations
        (reservation_id, prefix, node_id, sequence, task_id, status, reason, expires_at, created_at, updated_at)
      VALUES ('res-1', 'KB', 'local', 300, 'KB-300', 'committed', NULL, ${nowIso}, ${nowIso}, ${nowIso})
    `);

    const floor = await computeNextSequenceFloor(ctx.layer.db, "KB");
    // Reservation high-water mark is 300 + 1 = 301.
    expect(floor).toBeGreaterThanOrEqual(301);
  });

  it("getKnownPrefixes discovers prefixes from tasks and archived tasks", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("ABC-001"), { lineageId: null });
    await ctx.adminDb.execute(sql`
      INSERT INTO project.archived_tasks (id, data, archived_at)
      VALUES ('XYZ-005', ${JSON.stringify({ id: "XYZ-005" })}, ${new Date().toISOString()})
    `);

    const prefixes = await getKnownPrefixes(ctx.layer.db);
    expect(prefixes.has("ABC")).toBe(true);
    expect(prefixes.has("XYZ")).toBe(true);
    // The configured default prefix is always known.
    expect(prefixes.has("KB")).toBe(true);
  });

  // ── Settings round-trip ───────────────────────────────────────────────

  it("settings read/update project round-trip (VAL-SCHEMA-004 jsonb)", async () => {
    ctx = await setupCtx();

    // Initially absent → default.
    let config = await readProjectConfig(ctx.layer);
    expect(config.settings).toBeNull();

    // Write project settings.
    const settings = {
      taskPrefix: "KB",
      maxConcurrent: 4,
      autoMerge: true,
      experimentalFeatures: { flags: ["a", "b"] },
    };
    await writeProjectConfig(ctx.layer, settings);

    // Read back — jsonb returns already-parsed with identical shape.
    config = await readProjectConfig(ctx.layer);
    expect(config.settings).toEqual(settings);
    expect(config.nextWorkflowStepId).toBe(1);

    // Fast-path settings read.
    const fast = await readProjectSettings(ctx.layer);
    expect(fast).toEqual(settings);
  });

  it("settings patch deep-merges into the existing row", async () => {
    ctx = await setupCtx();
    await writeProjectConfig(ctx.layer, { taskPrefix: "KB", maxConcurrent: 4 });

    await patchProjectSettings(ctx.layer, { autoMerge: true });

    const settings = await readProjectSettings(ctx.layer);
    expect(settings).toMatchObject({ taskPrefix: "KB", maxConcurrent: 4, autoMerge: true });
  });

  it("settings preserve nextWorkflowStepId across updates", async () => {
    ctx = await setupCtx();
    await writeProjectConfig(ctx.layer, { taskPrefix: "KB" }, { nextWorkflowStepId: 7 });

    // A subsequent write without the option preserves the prior value.
    await writeProjectConfig(ctx.layer, { taskPrefix: "KB", maxConcurrent: 2 });

    const config = await readProjectConfig(ctx.layer);
    expect(config.nextWorkflowStepId).toBe(7);
  });

  it("config row enforces per-project singleton via project_id PK", async () => {
    ctx = await setupCtx();
    // FNXC:MultiProjectIsolation 2026-07-11: config is now keyed per-project on
    // project_id (the PK). The old singleton CHECK (id = 1) was removed so multiple
    // projects can each have their own config row. A duplicate project_id must
    // still violate the PK constraint.
    await expect(
      ctx.adminDb.execute(sql`
        INSERT INTO project.config (project_id, settings) VALUES ('dup', '{}'::jsonb)
      `),
    ).resolves.toBeDefined();
    // Inserting a second row with the same project_id must violate the PK.
    await expect(
      ctx.adminDb.execute(sql`
        INSERT INTO project.config (project_id, settings) VALUES ('dup', '{}'::jsonb)
      `),
    ).rejects.toThrow();
  });
});
