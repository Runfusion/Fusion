/**
 * PostgreSQL backend-mode CentralCore integration test
 * (migrate-central-core-to-postgres).
 *
 * FNXC:CentralCore 2026-06-26-14:00:
 * Integration tests proving CentralCore operates correctly in backend mode
 * (asyncLayer injected) against real PostgreSQL. Verifies the dual-path
 * delegation: when an AsyncDataLayer is provided, CentralCore does NOT
 * construct a SQLite CentralDatabase, and all methods (project registry, node
 * registry, project health, activity feed, global concurrency, mesh snapshots,
 * project/node path mappings) round-trip through the shared connection pool.
 *
 * This covers the load-bearing expected behaviors:
 *   - "CentralCore does not construct CentralDatabase when asyncLayer is provided"
 *   - "All CentralCore methods work in backend mode via PostgreSQL"
 *   - "Project registry, node registry, activity feed work against PG"
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralCore } from "../../central/central-core.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_cc_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  layer: AsyncDataLayer;
  central: CentralCore;
  globalDir: string;
  projectDirs: string[];
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    /* may not exist */
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({
    databaseUrl: testUrl,
    databaseMigrationUrl: testUrl,
  });
  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 3,
    connectTimeoutSeconds: 5,
  });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  // Pass an explicit temp global dir so resolveGlobalDir() does not throw under VITEST.
  const globalDir = mkdtempSync(join(tmpdir(), "kb-cc-pg-global-"));
  const central = new CentralCore(globalDir, { asyncLayer: layer });
  await central.init();
  return { dbName, layer, central, globalDir, projectDirs: [] };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.central.close();
  } catch {
    /* best-effort */
  }
  try {
    await ctx.layer.close();
  } catch {
    /* best-effort */
  }
  for (const dir of [...ctx.projectDirs, ctx.globalDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    /* best-effort */
  }
}

function makeProjectDir(ctx: TestCtx, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kb-cc-pg-${name}-`));
  ctx.projectDirs.push(dir);
  return dir;
}

pgDescribe("CentralCore backend mode (PostgreSQL)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("reports backendMode=true and does not construct SQLite CentralDatabase", async () => {
    ctx = await setupCtx();
    expect(ctx.central.backendMode).toBe(true);
    // getDatabasePath returns the logical global dir in backend mode (no SQLite file).
    expect(ctx.central.getDatabasePath()).not.toMatch(/fusion-central\.db$/);
  });

  it("bootstraps a default local node on init", async () => {
    ctx = await setupCtx();
    const nodes = await ctx.central.listNodes();
    const localNodes = nodes.filter((n) => n.type === "local");
    expect(localNodes.length).toBe(1);
    expect(localNodes[0].name).toBe("local");
  });

  it("registers, reads, and lists a project through PostgreSQL", async () => {
    ctx = await setupCtx();
    const projectPath = makeProjectDir(ctx, "alpha");
    const created = await ctx.central.registerProject({
      name: "Alpha",
      path: projectPath,
      isolationMode: "in-process",
    });
    expect(created.id).toMatch(/^proj_[a-f0-9]{16}$/);

    const byId = await ctx.central.getProject(created.id);
    expect(byId?.name).toBe("Alpha");
    expect(byId?.path).toBe(projectPath);

    const byPath = await ctx.central.getProjectByPath(projectPath);
    expect(byPath?.id).toBe(created.id);

    const listed = await ctx.central.listProjects();
    expect(listed.some((p) => p.id === created.id)).toBe(true);

    // Project health row is created alongside.
    const health = await ctx.central.getProjectHealth(created.id);
    expect(health?.projectId).toBe(created.id);
    expect(health?.status).toBe("initializing");
  });

  it("updates a project and reconciles stale statuses", async () => {
    ctx = await setupCtx();
    const projectPath = makeProjectDir(ctx, "beta");
    const created = await ctx.central.registerProject({
      name: "Beta",
      path: projectPath,
    });
    const updated = await ctx.central.updateProject(created.id, {
      status: "active",
    });
    expect(updated.status).toBe("active");

    // Force a stale row, then reconcile.
    await ctx.central.updateProject(created.id, { status: "initializing" });
    const reconciled = await ctx.central.reconcileProjectStatuses();
    expect(reconciled.some((r) => r.projectId === created.id)).toBe(true);
    const after = await ctx.central.getProject(created.id);
    expect(after?.status).toBe("active");
  });

  it("registers and updates a node through PostgreSQL", async () => {
    ctx = await setupCtx();
    const node = await ctx.central.registerNode({
      name: "remote-1",
      type: "remote",
      url: "http://remote-host:4040",
      apiKey: "secret",
      maxConcurrent: 3,
    });
    expect(node.type).toBe("remote");
    expect(node.maxConcurrent).toBe(3);

    const fetched = await ctx.central.getNode(node.id);
    expect(fetched?.name).toBe("remote-1");

    const byName = await ctx.central.getNodeByName("remote-1");
    expect(byName?.id).toBe(node.id);

    const updated = await ctx.central.updateNode(node.id, { status: "online" });
    expect(updated.status).toBe("online");
  });

  it("logs and reads activity through PostgreSQL", async () => {
    ctx = await setupCtx();
    const projectPath = makeProjectDir(ctx, "gamma");
    const project = await ctx.central.registerProject({
      name: "Gamma",
      path: projectPath,
    });
    const entry = await ctx.central.logActivity({
      type: "task:created",
      timestamp: new Date().toISOString(),
      projectId: project.id,
      projectName: project.name,
      details: "Task KB-001 created",
      metadata: { kind: "creation" },
    });
    expect(entry.id).toBeTruthy();

    const recent = await ctx.central.getRecentActivity({ limit: 10 });
    expect(recent.some((e) => e.id === entry.id)).toBe(true);

    const count = await ctx.central.getActivityCount(project.id);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("manages global concurrency state through PostgreSQL", async () => {
    ctx = await setupCtx();
    const initial = await ctx.central.getGlobalConcurrencyState();
    expect(initial.globalMaxConcurrent).toBeGreaterThanOrEqual(1);

    const updated = await ctx.central.updateGlobalConcurrency({
      globalMaxConcurrent: 6,
    });
    expect(updated.globalMaxConcurrent).toBe(6);

    const reread = await ctx.central.getGlobalConcurrencyState();
    expect(reread.globalMaxConcurrent).toBe(6);
  });

  it("acquires and releases a global concurrency slot atomically", async () => {
    ctx = await setupCtx();
    const projectPath = makeProjectDir(ctx, "delta");
    const project = await ctx.central.registerProject({
      name: "Delta",
      path: projectPath,
    });
    await ctx.central.updateGlobalConcurrency({ globalMaxConcurrent: 1, currentlyActive: 0, queuedCount: 0 });

    const acquired = await ctx.central.acquireGlobalSlot(project.id);
    expect(acquired).toBe(true);

    // At limit now — second acquire should queue.
    const queued = await ctx.central.acquireGlobalSlot(project.id);
    expect(queued).toBe(false);

    await ctx.central.releaseGlobalSlot(project.id);
    const state = await ctx.central.getGlobalConcurrencyState();
    expect(state.currentlyActive).toBe(0);
  });

  it("records project-node path mappings through PostgreSQL", async () => {
    ctx = await setupCtx();
    const projectPath = makeProjectDir(ctx, "epsilon");
    const project = await ctx.central.registerProject({
      name: "Epsilon",
      path: projectPath,
    });
    const nodes = await ctx.central.listNodes();
    const localNode = nodes.find((n) => n.type === "local")!;

    // registerProject already creates the local-node mapping (insertProjectRow
    // transaction), so fetch it and verify it round-tripped through PostgreSQL.
    const fetched = await ctx.central.getProjectNodePathMapping(project.id, localNode.id);
    expect(fetched?.path).toBe(projectPath);

    const listed = await ctx.central.listProjectNodePathMappings({ projectId: project.id });
    expect(listed.some((m) => m.nodeId === localNode.id)).toBe(true);
  });

  it("records and reads a mesh snapshot through PostgreSQL", async () => {
    ctx = await setupCtx();
    const nodes = await ctx.central.listNodes();
    const localNode = nodes.find((n) => n.type === "local")!;
    // project_id is part of the composite PRIMARY KEY and therefore NOT NULL
    // under PostgreSQL (unlike SQLite's lax NULL-in-PK). Use a sentinel value
    // for the global scope, matching the production mesh contract.
    const record = await ctx.central.recordMeshSnapshot({
      nodeId: localNode.id,
      projectId: "__global__",
      scope: "test-scope",
      payload: { hello: "world" },
      snapshotVersion: "v1",
      capturedAt: new Date().toISOString(),
    });
    expect(record.scope).toBe("test-scope");

    const fetched = await ctx.central.getLatestMeshSnapshot({
      nodeId: localNode.id,
      projectId: "__global__",
      scope: "test-scope",
    });
    expect(fetched?.payload).toMatchObject({ hello: "world" });
  });

  it("attachBackendLayer transitions a legacy CentralCore into backend mode", async () => {
    ctx = await setupCtx();
    // Create a fresh legacy CentralCore (no asyncLayer) then attach the layer.
    const legacy = new CentralCore(ctx.globalDir);
    expect(legacy.backendMode).toBe(false);
    await legacy.attachBackendLayer(ctx.layer);
    expect(legacy.backendMode).toBe(true);
    // It should now read the same bootstrapped local node.
    const nodes = await legacy.listNodes();
    expect(nodes.some((n) => n.type === "local")).toBe(true);
    await legacy.close();
  });
});
