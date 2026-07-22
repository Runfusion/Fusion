/**
 * Cross-project distributed-task-id allocator PostgreSQL integration test.
 *
 * FNXC:ProjectTaskIdentity 2026-07-14-12:32:
 * Two projects sharing one PostgreSQL schema own independent task-ID allocators.
 * The same prefix and task ID may exist in each project without sharing floors,
 * reservations, tasks, or merge work.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import {
  createAsyncDistributedTaskIdAllocator,
  reconcileTaskIdStateAsync,
} from "../../task-store/async/async-allocator.js";
import type { DistributedTaskIdAllocator } from "../../tasks/distributed-task-id.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

const SHARED_PREFIX = "KB";

function uniqueDbName(): string {
  return `fusion_allocxp_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

// FNXC:PgTestAuthFix 2026-07-14-07:30:
// The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  connectionsA: PostgresConnections;
  connectionsB: PostgresConnections;
  layerA: AsyncDataLayer;
  layerB: AsyncDataLayer;
  allocatorA: DistributedTaskIdAllocator;
  allocatorB: DistributedTaskIdAllocator;
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
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  const connectionsA = await createConnectionSetFromUrl(backend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
    projectId: "proj_a",
    useRuntimeRole: true,
  });
  const connectionsB = await createConnectionSetFromUrl(backend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
    projectId: "proj_b",
    useRuntimeRole: true,
  });
  const layerA = createAsyncDataLayer(connectionsA, { projectId: "proj_a" });
  const layerB = createAsyncDataLayer(connectionsB, { projectId: "proj_b" });
  const allocatorA = createAsyncDistributedTaskIdAllocator(layerA);
  const allocatorB = createAsyncDistributedTaskIdAllocator(layerB);
  return { dbName, connectionsA, connectionsB, layerA, layerB, allocatorA, allocatorB };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await Promise.all([ctx.connectionsA.close(), ctx.connectionsB.close()]);
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
}

/** Insert a task row with the minted id under the given layer (project_id stamped). */
async function insertMintedTask(layer: AsyncDataLayer, id: string): Promise<void> {
  const now = new Date().toISOString();
  await insertTaskRow(
    layer,
    {
      id,
      description: "cross-project allocator test task",
      column: "todo",
      currentStep: 0,
      createdAt: now,
      updatedAt: now,
    },
    { lineageId: null },
  );
}

function suffix(taskId: string): number {
  return Number.parseInt(taskId.split("-")[1] ?? "", 10);
}

pgDescribe("cross-project distributed-task-id allocator (PostgreSQL)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("two projects sharing a prefix keep independent sequences and may reuse task ids", async () => {
    ctx = await setupCtx();
    const { allocatorA, allocatorB, layerA, layerB } = ctx;

    // Reconcile both on open (mirrors store-open). Both key on the same shared
    // prefix row, so this is idempotent.
    await reconcileTaskIdStateAsync(layerA);
    await reconcileTaskIdStateAsync(layerB);

    const reservedA = await allocatorA.reserveDistributedTaskId({ prefix: SHARED_PREFIX, nodeId: "node-a" });
    const reservedB = await allocatorB.reserveDistributedTaskId({ prefix: SHARED_PREFIX, nodeId: "node-b" });
    expect(reservedA.taskId).toBe(reservedB.taskId);
    await allocatorA.commitDistributedTaskIdReservation({ reservationId: reservedA.reservationId, nodeId: "node-a" });
    await allocatorB.commitDistributedTaskIdReservation({ reservationId: reservedB.reservationId, nodeId: "node-b" });
    await insertMintedTask(layerA, reservedA.taskId);
    await insertMintedTask(layerB, reservedB.taskId);

    const stateA = await layerA.db
      .select()
      .from(schema.project.distributedTaskIdState)
      .where(eq(schema.project.distributedTaskIdState.prefix, SHARED_PREFIX));
    const stateB = await layerB.db
      .select()
      .from(schema.project.distributedTaskIdState)
      .where(eq(schema.project.distributedTaskIdState.prefix, SHARED_PREFIX));
    expect(stateA).toHaveLength(1);
    expect(stateB).toHaveLength(1);
    expect(stateA[0]!.projectId).toBe("proj_a");
    expect(stateB[0]!.projectId).toBe("proj_b");

    const tasksA = await layerA.db
      .select({ id: schema.project.tasks.id, projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks);
    const tasksB = await layerB.db
      .select({ id: schema.project.tasks.id, projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks);
    expect(tasksA).toEqual([{ id: reservedA.taskId, projectId: "proj_a" }]);
    expect(tasksB).toEqual([{ id: reservedB.taskId, projectId: "proj_b" }]);
  });

  it("a sibling project's high suffix does not advance this project's floor", async () => {
    ctx = await setupCtx();
    const { allocatorA, allocatorB, layerA, layerB } = ctx;

    // Project B pre-populates a HIGH task id under the shared prefix, simulating
    // a sibling project that already advanced the id namespace far ahead.
    const highId = `${SHARED_PREFIX}-500`;
    await insertMintedTask(layerB, highId);

    // Project A sees only its own partition, so B's high suffix is irrelevant.
    await reconcileTaskIdStateAsync(layerA);
    const reserved = await allocatorA.reserveDistributedTaskId({
      prefix: SHARED_PREFIX,
      nodeId: "node-a",
    });
    expect(suffix(reserved.taskId)).toBeLessThan(500);

    await allocatorA.commitDistributedTaskIdReservation({
      reservationId: reserved.reservationId,
      nodeId: "node-a",
    });
    // Inserting under project A with the minted id does not collide with B's row.
    await insertMintedTask(layerA, reserved.taskId);

    // B continues from its own high-water mark.
    const reservedB = await allocatorB.reserveDistributedTaskId({
      prefix: SHARED_PREFIX,
      nodeId: "node-b",
    });
    expect(suffix(reservedB.taskId)).toBeGreaterThan(500);
  });
});
