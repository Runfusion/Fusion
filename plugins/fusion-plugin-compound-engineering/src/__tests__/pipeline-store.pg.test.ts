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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  applySchemaBaseline,
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  postgresSchema,
  type AsyncDataLayer,
  type ResolvedBackend,
} from "@fusion/core";
import { CePipelineStore } from "../sync/pipeline-store.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE = process.env.FUSION_PG_TEST_SKIP !== "1";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

const PG_USER = process.env.USER ?? "postgres";

function adminExec(statement: string): void {
  // Single short psql DDL call (CREATE/DROP DATABASE can't run in a tx). This
  // is the same acceptable execSync use as core's data-layer.test.ts.
  execSync(
    `psql -h localhost -p 5432 -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

function uniqueDbName(): string {
  return `ce_pipeline_pg_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

interface TestCtx {
  readonly dbName: string;
  readonly layer: AsyncDataLayer;
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
  const layer = createAsyncDataLayer(connections);

  let closed = false;
  return {
    dbName,
    layer,
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

pgDescribe("CePipelineStore (PG backend mode)", () => {
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
