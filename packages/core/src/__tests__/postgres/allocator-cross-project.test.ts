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

import { it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import {
  pgDescribe,
  createTaskStoreForTest,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import {
  createAsyncDistributedTaskIdAllocator,
  reconcileTaskIdStateAsync,
} from "../../task-store/async/async-allocator.js";
import type { DistributedTaskIdAllocator } from "../../tasks/distributed-task-id.js";

const SHARED_PREFIX = "KB";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated the per-test database creation off hand-rolled CREATE DATABASE +
applySchemaBaseline (~3-4s of DDL per test) onto the harness's template-cloned
`createTaskStoreForTest`. This file KEEPS a private database per test because it opens
its own pair of project-bound, RLS-enforced runtime-role connection sets against that
database — the cross-project isolation those connections provide is the subject, and
the harness database is only the substrate. The harness TaskStore's unbound init rows
live outside the proj_a/proj_b partitions, so the RLS-scoped reads never see them.
Every assertion is unchanged.
*/
interface TestCtx {
  baseTeardown: () => Promise<void>;
  connectionsA: PostgresConnections;
  connectionsB: PostgresConnections;
  layerA: AsyncDataLayer;
  layerB: AsyncDataLayer;
  allocatorA: DistributedTaskIdAllocator;
  allocatorB: DistributedTaskIdAllocator;
}

async function setupCtx(): Promise<TestCtx> {
  const base = await createTaskStoreForTest({
    prefix: "fusion_allocxp_test",
    copyFromGolden: true,
  });
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: base.testUrl,
    migrationUrl: base.testUrl,
    migrationUrlOverridden: false,
  };

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
  return { baseTeardown: base.teardown, connectionsA, connectionsB, layerA, layerB, allocatorA, allocatorB };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await Promise.all([ctx.connectionsA.close(), ctx.connectionsB.close()]);
  } catch {
    // best-effort
  }
  try {
    await ctx.baseTeardown();
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
