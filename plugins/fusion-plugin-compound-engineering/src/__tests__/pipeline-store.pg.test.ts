/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * PG integration test for CePipelineStore's async path (item 10).
 *
 * Exercises every *Async() sibling against a real backend-mode AsyncDataLayer.
 * The CE plugin tables (ce_pipeline_links, ce_pipeline_state, ce_pipeline_sync_queue)
 * must materialize via the cePluginSchemaInit hook registered in
 * DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS — the schema applier runs it when
 * applySchemaBaseline() is called below. If the hook is unwired, the first
 * insert throws 'relation "project.ce_pipeline_links" does not exist'.
 *
 * Self-contained: uses only the @fusion/core public surface plus a single psql
 * call for test-DB lifecycle (same pattern as core's data-layer.test.ts).
 * Auto-skipped when FUSION_PG_TEST_SKIP=1 or no PG at localhost:5432.
 */

import { execSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getTableColumns, sql } from "drizzle-orm";
import {
  applySchemaBaseline,
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  postgresSchema,
  type AsyncDataLayer,
  type ResolvedBackend,
} from "@fusion/core";
import { CePipelineStore } from "../sync/pipeline-store.js";
import {
  cePipelineLinks as localCePipelineLinks,
  cePipelineState as localCePipelineState,
  cePipelineSyncQueue as localCePipelineSyncQueue,
} from "../sync/pg-schema.js";
import { CeSessionStore, PlanHandoffClaimError } from "../session/session-store.js";
import {
  PG_AVAILABLE,
  pgDescribe,
} from "@fusion/test-utils/pg-test-harness";

/*
FNXC:PgTestAuthFix 2026-07-18-04:45:
Do not use process.env.USER for psql -U: on GitHub Actions USER is "runner" and
the service container only has POSTGRES_USER=postgres. Always admin via
FUSION_PG_TEST_URL_BASE (CI sets postgresql://postgres:postgres@localhost:5432).
*/
const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://postgres:postgres@localhost:5432";

function adminExec(statement: string): void {
  // Single short psql DDL call (CREATE/DROP DATABASE can't run in a tx). This
  // is the same acceptable execSync use as core's data-layer.test.ts.
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

function uniqueDbName(): string {
  return `ce_pipeline_pg_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

interface TestCtx {
  readonly dbName: string;
  readonly layer: AsyncDataLayer;
  readonly layerB: AsyncDataLayer;
  close(): Promise<void>;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist — ignore
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConnections = await createConnectionSetFromUrl(backend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  // This runs DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS (now including cePluginSchemaInit)
  // because the applier defaults to it.
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections, { projectId: "ce-project-a" });
  const layerB = createAsyncDataLayer(connections, { projectId: "ce-project-b" });

  let closed = false;
  return {
    dbName,
    layer,
    layerB,
    async close() {
      if (closed) return;
      closed = true;
      await connections.close().catch(() => undefined);
      try {
        adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort
      }
    },
  };
}

let ctx: TestCtx | null = null;

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  ctx = await setupCtx();
});

afterAll(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

it("keeps bundle-local CE Drizzle columns aligned with the canonical core schema", () => {
  /*
  FNXC:CompoundEngineeringSchema 2026-07-14-23:53:
  This contract is deliberately outside the PostgreSQL-gated suite: schema drift must fail in every test environment even when the published-bundle shim prevents importing canonical core table objects at runtime.
  */
  const columnSignature = (table: Parameters<typeof getTableColumns>[0]) =>
    Object.entries(getTableColumns(table)).map(([property, column]) => ({
      property,
      name: column.name,
      dataType: column.dataType,
      notNull: column.notNull,
    })).sort((a, b) => a.name.localeCompare(b.name));

  expect(columnSignature(localCePipelineLinks)).toEqual(columnSignature(postgresSchema.plugin.cePipelineLinks));
  expect(columnSignature(localCePipelineState)).toEqual(columnSignature(postgresSchema.plugin.cePipelineState));
  expect(columnSignature(localCePipelineSyncQueue)).toEqual(columnSignature(postgresSchema.plugin.cePipelineSyncQueue));
});

pgDescribe("CePipelineStore (PG backend mode)", () => {
  it("persists sessions and isolates identical lookups by bound project", async () => {
    const a = new CeSessionStore(null, ctx!.layer);
    const b = new CeSessionStore(null, ctx!.layerB);
    expect(await a.listAsync()).toEqual([]);
    expect(await b.listAsync()).toEqual([]);
    const created = await a.createAsync({ id: "shared-session", stage: "brainstorm" });
    await a.appendHistoryAsync(created.id, { role: "user", text: "hello", at: new Date().toISOString() });
    expect((await a.getAsync(created.id))?.conversationHistory[0]?.text).toBe("hello");
    expect(await b.getAsync(created.id)).toBeUndefined();
  });

  it("keeps terminal state and every history turn under concurrent liveness and history writes", async () => {
    const store = new CeSessionStore(null, ctx!.layer);
    const session = await store.createAsync({ id: "session-concurrency", stage: "brainstorm" });
    const turns = Array.from({ length: 12 }, (_, index) => ({
      role: "agent" as const,
      text: `turn-${index}`,
      at: new Date(1_700_000_000_000 + index).toISOString(),
    }));

    /*
     * FNXC:CompoundEngineeringConcurrency 2026-07-14-00:24:
     * Concurrent PostgreSQL history appends, terminal transitions, and heartbeat touches must compose without last-writer-wins loss. This regression exercises the real database so a read-modify-write implementation deterministically loses one or more independently appended turns.
     */
    await Promise.all([
      ...turns.map((turn) => store.appendHistoryAsync(session.id, turn)),
      store.updateAsync(session.id, { status: "completed" }),
      store.touchActivityAsync(session.id, Date.now() + 1000),
    ]);

    const settled = await store.getAsync(session.id);
    expect(settled?.status).toBe("completed");
    expect(settled?.conversationHistory.map((turn) => turn.text).sort()).toEqual(
      turns.map((turn) => turn.text).sort(),
    );
  });

  it("allows exactly one PostgreSQL Plan handoff claim under concurrent starts", async () => {
    const first = new CeSessionStore(null, ctx!.layer);
    const second = new CeSessionStore(null, ctx!.layer);
    const artifactPath = "/tmp/ce-concurrent-plan.md";
    const results = await Promise.allSettled([
      first.createWithPlanHandoffClaimAsync({ id: "plan-claim-a", stage: "plan" }, artifactPath),
      second.createWithPlanHandoffClaimAsync({ id: "plan-claim-b", stage: "plan" }, artifactPath),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(PlanHandoffClaimError);
    expect((await first.listAsync({ stage: "plan" })).filter((row) => row.artifactPath === artifactPath)).toHaveLength(1);
  });
  it("constructs in backend mode (asyncLayer wired, sync db null)", () => {
    const store = new CePipelineStore(null, ctx!.layer);
    expect(store.backendMode).toBe(true);
    // SQLite fallback path must still throw so callers can't silently hit the
    // wrong backend.
    expect(() => store.listByPipeline("p1")).toThrow(/backend mode/);
  });

  it("ce plugin tables materialized via cePluginSchemaInit", async () => {
    // If the schema-init hook didn't run, this query errors. The applier's
    // default (DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS) is what wires it.
    const rows = (await ctx!.layer.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'project'
        AND table_name IN ('ce_sessions', 'ce_pipeline_links', 'ce_pipeline_state', 'ce_pipeline_sync_queue')
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("ce_sessions");
    expect(names).toContain("ce_pipeline_links");
    expect(names).toContain("ce_pipeline_state");
    expect(names).toContain("ce_pipeline_sync_queue");
  });

  it("link CRUD round-trips through Drizzle in backend mode", async () => {
    const store = new CePipelineStore(null, ctx!.layer);
    const created = await store.createLinkAsync({
      taskId: "task-link-1",
      cePipelineId: "pipe-1",
      ceStageId: "work",
      ceArtifactPath: "/artifacts/work.md",
    });
    expect(created.id).toBeTruthy();
    expect(created.taskId).toBe("task-link-1");

    const byPipeline = await store.listByPipelineAsync("pipe-1");
    expect(byPipeline).toHaveLength(1);
    expect(byPipeline[0].id).toBe(created.id);

    const byTask = await store.findByTaskIdAsync("task-link-1");
    expect(byTask?.cePipelineId).toBe("pipe-1");
    expect(byTask?.ceStageId).toBe("work");
    expect(byTask?.ceArtifactPath).toBe("/artifacts/work.md");

    const miss = await store.findByTaskIdAsync("nonexistent-task");
    expect(miss).toBeUndefined();
  });

  it("isolates identical pipeline, task, and queue ids between two bound projects", async () => {
    const projectA = new CePipelineStore(null, ctx!.layer);
    const projectB = new CePipelineStore(null, ctx!.layerB);
    await projectA.createLinkAsync({ id: "shared-link", taskId: "shared-task", cePipelineId: "shared-pipeline", ceStageId: "work" });
    await projectB.createLinkAsync({ id: "shared-link", taskId: "shared-task", cePipelineId: "shared-pipeline", ceStageId: "review" });
    await projectA.upsertStateAsync({ cePipelineId: "shared-pipeline", currentStage: "work" });
    await projectB.upsertStateAsync({ cePipelineId: "shared-pipeline", currentStage: "review" });
    await projectA.enqueueSyncAsync({ id: "shared-queue", cePipelineId: "shared-pipeline", taskId: "shared-task", reason: "task_moved" });
    await projectB.enqueueSyncAsync({ id: "shared-queue", cePipelineId: "shared-pipeline", taskId: "shared-task", reason: "task_completed" });

    expect((await projectA.findByTaskIdAsync("shared-task"))?.ceStageId).toBe("work");
    expect((await projectB.findByTaskIdAsync("shared-task"))?.ceStageId).toBe("review");
    expect((await projectA.getStateAsync("shared-pipeline"))?.currentStage).toBe("work");
    expect((await projectB.getStateAsync("shared-pipeline"))?.currentStage).toBe("review");
    await projectB.markSyncProcessedAsync("shared-queue");
    expect((await projectA.listPendingSyncAsync()).some((entry) => entry.id === "shared-queue")).toBe(true);
    expect((await projectB.listPendingSyncAsync()).some((entry) => entry.id === "shared-queue")).toBe(false);
  });

  it("state upsert seeds then updates; listAllState sweeps all", async () => {
    const store = new CePipelineStore(null, ctx!.layer);
    const seeded = await store.upsertStateAsync({
      cePipelineId: "pipe-state-1",
      currentStage: "work",
      status: "running",
      lastArtifactPath: null,
    });
    expect(seeded.status).toBe("running");
    expect(seeded.currentStage).toBe("work");

    // Update path: status preserved when omitted.
    const updated = await store.upsertStateAsync({
      cePipelineId: "pipe-state-1",
      currentStage: "review",
      lastArtifactPath: "/artifacts/review.md",
    });
    expect(updated.currentStage).toBe("review");
    expect(updated.status).toBe("running");
    expect(updated.lastArtifactPath).toBe("/artifacts/review.md");

    const read = await store.getStateAsync("pipe-state-1");
    expect(read?.currentStage).toBe("review");

    const all = await store.listAllStateAsync();
    expect(all.some((s) => s.cePipelineId === "pipe-state-1")).toBe(true);
  });

  it("atomically preserves independently omitted state fields under concurrent upserts", async () => {
    const store = new CePipelineStore(null, ctx!.layer);
    await store.upsertStateAsync({
      cePipelineId: "pipe-state-concurrent",
      currentStage: "work",
      status: "running",
      lastArtifactPath: null,
    });

    await Promise.all([
      store.upsertStateAsync({
        cePipelineId: "pipe-state-concurrent",
        currentStage: "review",
        status: "awaiting_board",
      }),
      store.upsertStateAsync({
        cePipelineId: "pipe-state-concurrent",
        currentStage: "review",
        lastArtifactPath: "/artifacts/concurrent-review.md",
      }),
    ]);

    expect(await store.getStateAsync("pipe-state-concurrent")).toMatchObject({
      currentStage: "review",
      status: "awaiting_board",
      lastArtifactPath: "/artifacts/concurrent-review.md",
    });
  });

  it("transitionStateAsync advances status and stage", async () => {
    const store = new CePipelineStore(null, ctx!.layer);
    await store.upsertStateAsync({
      cePipelineId: "pipe-trans-1",
      currentStage: "work",
      status: "running",
    });
    const advanced = await store.transitionStateAsync("pipe-trans-1", {
      status: "awaiting_board",
    });
    expect(advanced?.status).toBe("awaiting_board");
    expect(advanced?.currentStage).toBe("work");

    // transitionState on an unknown pipeline returns undefined (caller seeds).
    const miss = await store.transitionStateAsync("no-such-pipeline", { status: "completed" });
    expect(miss).toBeUndefined();
  });

  it("sync queue enqueues, lists pending, marks processed", async () => {
    const store = new CePipelineStore(null, ctx!.layer);
    const entry = await store.enqueueSyncAsync({
      cePipelineId: "pipe-queue-1",
      taskId: "task-queue-1",
      reason: "task_moved",
      fromColumn: "todo",
      toColumn: "in-progress",
    });
    expect(entry.processedAt).toBeNull();

    const pending = await store.listPendingSyncAsync();
    expect(pending.some((e) => e.id === entry.id)).toBe(true);

    await store.markSyncProcessedAsync(entry.id);

    const pendingAfter = await store.listPendingSyncAsync();
    expect(pendingAfter.some((e) => e.id === entry.id)).toBe(false);

    // markSyncProcessed is idempotent: re-marking a drained entry is a no-op.
    await expect(store.markSyncProcessedAsync(entry.id)).resolves.toBeUndefined();
  });

  it("postgresSchema.plugin exposes the CE table shapes", () => {
    // Compile-time + runtime check that the schema namespace re-export lets
    // plugin code reach the table refs the async siblings use.
    expect(postgresSchema.plugin.cePipelineLinks).toBeTruthy();
    expect(postgresSchema.plugin.cePipelineState).toBeTruthy();
    expect(postgresSchema.plugin.cePipelineSyncQueue).toBeTruthy();
  });

  it("backendMode is false when no asyncLayer is provided (SQLite mode)", () => {
    const sqliteOnly = new CePipelineStore(null, null);
    expect(sqliteOnly.backendMode).toBe(false);
  });
});
