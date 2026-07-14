/**
 * Cross-project distributed-task-id allocator PostgreSQL integration test.
 *
 * FNXC:CentralProjectIdentity 2026-07-13-22:40:
 * Locks in the global-task-id invariant on the shared embedded-PG cluster: two
 * per-project TaskStores (bound to different projectIds, "proj_a" / "proj_b")
 * over ONE database + ONE `project` schema, both configured with the SAME task
 * prefix, MUST draw from a single shared per-prefix sequence and never mint a
 * duplicate task id.
 *
 * Why this matters (see async-allocator.ts computeNextSequenceFloor and the
 * schema note on distributed_task_id_state): `tasks.id` is a global PRIMARY KEY
 * shared by every project, so the per-prefix sequence in
 * `distributed_task_id_state` (keyed on prefix only, no project_id) is what
 * guarantees two projects using the same prefix never collide. The allocator's
 * high-water scans are unscoped (prefix only) so the shared sequence advances
 * past every project's max suffix. This test proves:
 *   1. Interleaved reservations across the two project-bound layers yield ids
 *      that are all UNIQUE and STRICTLY INCREASING per the shared sequence.
 *   2. Inserting a task under each project (project_id stamped respectively)
 *      with its minted id causes NO tasks.id primary-key violation.
 *   3. reserve → commit works for both layers against the shared state row.
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
import { insertTaskRow } from "../../task-store/async-persistence.js";
import {
  createAsyncDistributedTaskIdAllocator,
  reconcileTaskIdStateAsync,
} from "../../task-store/async-allocator.js";
import type { DistributedTaskIdAllocator } from "../../distributed-task-id.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

const SHARED_PREFIX = "KB";

function uniqueDbName(): string {
  return `fusion_allocxp_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  connections: PostgresConnections;
  /** One raw connection set; two logical layers differ only by bound projectId. */
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

  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  // Two project-bound layers over the SAME shared database + `project` schema.
  const layerA = createAsyncDataLayer(connections, { projectId: "proj_a" });
  const layerB = createAsyncDataLayer(connections, { projectId: "proj_b" });
  const allocatorA = createAsyncDistributedTaskIdAllocator(layerA);
  const allocatorB = createAsyncDistributedTaskIdAllocator(layerB);
  return { dbName, connections, layerA, layerB, allocatorA, allocatorB };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.connections.close();
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

  it("two projects sharing a prefix draw unique, strictly-increasing ids from ONE shared sequence", async () => {
    ctx = await setupCtx();
    const { allocatorA, allocatorB, layerA, layerB } = ctx;

    // Reconcile both on open (mirrors store-open). Both key on the same shared
    // prefix row, so this is idempotent.
    await reconcileTaskIdStateAsync(layerA);
    await reconcileTaskIdStateAsync(layerB);

    const minted: { taskId: string; project: "a" | "b" }[] = [];

    // Interleave a realistic number of reserve→commit allocations, alternating
    // between the two project-bound allocators. Each uses the REAL allocator
    // entry points (reserve + commit).
    const ROUNDS = 12;
    for (let i = 0; i < ROUNDS; i++) {
      const useA = i % 2 === 0;
      const allocator = useA ? allocatorA : allocatorB;
      const nodeId = useA ? "node-a" : "node-b";

      const reserved = await allocator.reserveDistributedTaskId({
        prefix: SHARED_PREFIX,
        nodeId,
      });
      const committed = await allocator.commitDistributedTaskIdReservation({
        reservationId: reserved.reservationId,
        nodeId,
      });
      expect(committed.taskId).toBe(reserved.taskId);

      // Insert the task under the respective project so project_id is stamped.
      await insertMintedTask(useA ? layerA : layerB, committed.taskId);
      minted.push({ taskId: committed.taskId, project: useA ? "a" : "b" });
    }

    // 1. All minted ids are unique (no cross-project duplicate).
    const ids = minted.map((m) => m.taskId);
    expect(new Set(ids).size).toBe(ids.length);

    // 2. Suffixes are strictly increasing per the shared sequence (interleaving
    //    the two projects does not reset or fork the counter).
    const suffixes = ids.map(suffix);
    for (let i = 1; i < suffixes.length; i++) {
      expect(suffixes[i]).toBeGreaterThan(suffixes[i - 1]!);
    }

    // 3. Both projects contributed ids (the interleave actually alternated).
    expect(minted.some((m) => m.project === "a")).toBe(true);
    expect(minted.some((m) => m.project === "b")).toBe(true);

    // 4. Exactly one shared state row for the prefix; next_sequence is past the
    //    global max suffix.
    const stateRows = await layerA.db
      .select()
      .from(schema.project.distributedTaskIdState)
      .where(eq(schema.project.distributedTaskIdState.prefix, SHARED_PREFIX));
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0]!.nextSequence).toBeGreaterThan(Math.max(...suffixes));

    // 5. Tasks landed under BOTH project_ids with NO tasks.id PK violation
    //    (proven by the inserts above succeeding). Verify the stamping.
    const allTasks = await layerA.db
      .select({ id: schema.project.tasks.id, projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks);
    expect(allTasks).toHaveLength(ROUNDS);
    const byProject = new Map(allTasks.map((t) => [t.id, t.projectId]));
    for (const m of minted) {
      expect(byProject.get(m.taskId)).toBe(m.project === "a" ? "proj_a" : "proj_b");
    }
  });

  it("a project's floor cannot mint an id below a sibling project's existing max suffix", async () => {
    ctx = await setupCtx();
    const { allocatorA, allocatorB, layerA, layerB } = ctx;

    // Project B pre-populates a HIGH task id under the shared prefix, simulating
    // a sibling project that already advanced the id namespace far ahead.
    const highId = `${SHARED_PREFIX}-500`;
    await insertMintedTask(layerB, highId);

    // Project A opens/reconciles and reserves. Its floor scan is GLOBAL, so it
    // must jump PAST B's max (500), never reuse an id <= 500.
    await reconcileTaskIdStateAsync(layerA);
    const reserved = await allocatorA.reserveDistributedTaskId({
      prefix: SHARED_PREFIX,
      nodeId: "node-a",
    });
    expect(suffix(reserved.taskId)).toBeGreaterThan(500);

    await allocatorA.commitDistributedTaskIdReservation({
      reservationId: reserved.reservationId,
      nodeId: "node-a",
    });
    // Inserting under project A with the minted id does not collide with B's row.
    await insertMintedTask(layerA, reserved.taskId);

    // And B, allocating next, continues strictly above A's id (shared counter).
    const reservedB = await allocatorB.reserveDistributedTaskId({
      prefix: SHARED_PREFIX,
      nodeId: "node-b",
    });
    expect(suffix(reservedB.taskId)).toBeGreaterThan(suffix(reserved.taskId));
  });
});
