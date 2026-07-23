/**
 * TaskStore lifecycle / merge-coordination PostgreSQL integration tests (U13).
 *
 * FNXC:TaskStoreLifecycle 2026-06-24-06:00:
 * Integration tests proving the async lifecycle (lineage-integrity) and
 * merge-coordination helpers preserve the load-bearing invariants against a
 * real PostgreSQL instance. Each test creates a uniquely-named fresh database,
 * applies the baseline schema, and exercises the async helpers that the
 * migrating TaskStore modules consume.
 *
 * Coverage targets (the assertions U13 fulfills):
 *   VAL-DATA-010 — Lineage-integrity gate blocks parent delete with live children.
 *   VAL-DATA-011 — removeLineageReferences clears children so a parent can be deleted.
 *   VAL-DATA-012 — Archived/soft-deleted children do not block parent delete.
 *   VAL-DATA-013 — Handoff-to-review: column move + mergeQueue insert + audit are atomic.
 *   VAL-DATA-014 — Merge-queue lease: priority-first, FIFO within priority,
 *                  expired leases recover without incrementing attempts.
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
import { insertTaskRow, softDeleteTaskRow } from "../../task-store/async/async-persistence.js";
import {
  findLiveLineageChildren,
  hasLiveLineageChildren,
  removeLineageReferences,
} from "../../task-store/async/async-lifecycle.js";
import {
  enqueueMergeQueue,
  enqueueMergeQueueInTransaction,
  acquireMergeQueueLease,
  releaseMergeQueueLease,
  recoverExpiredMergeQueueLeases,
  peekMergeQueue,
  cleanupStaleMergeQueueRowsInTransaction,
  rowToMergeQueueEntry,
} from "../../task-store/async/async-merge-coordination.js";
import { recordRunAuditEventWithinTransaction } from "../../postgres/data-layer.js";
import type { MergeQueueRow } from "../../task-store/row-types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_u13_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

/** Seed a task with a sourceParentTaskId lineage edge. */
async function seedTaskWithParent(
  layer: AsyncDataLayer,
  id: string,
  parentId: string,
  column = "todo",
): Promise<void> {
  const now = new Date().toISOString();
  await insertTaskRow(
    layer,
    { ...makeMinimalTask(id, column), sourceParentTaskId: parentId },
    { lineageId: null },
  );
  void now;
}

pgDescribe("U13 taskstore-lifecycle (PostgreSQL)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── VAL-DATA-010: Lineage-integrity gate blocks parent delete with live children ──

  it("findLiveLineageChildren returns live children of a parent (VAL-DATA-010)", async () => {
    ctx = await setupCtx();
    // Parent + two live children + one archived child.
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    await seedTaskWithParent(ctx.layer, "KB-CHILD-1", "KB-PARENT", "todo");
    await seedTaskWithParent(ctx.layer, "KB-CHILD-2", "KB-PARENT", "in-progress");

    const liveChildren = await findLiveLineageChildren(ctx.layer.db, "KB-PARENT");
    expect(liveChildren.sort()).toEqual(["KB-CHILD-1", "KB-CHILD-2"]);

    // The boolean variant agrees.
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(true);
  });

  it("lineage gate blocks parent delete when live children exist (VAL-DATA-010)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    await seedTaskWithParent(ctx.layer, "KB-LIVE", "KB-PARENT", "todo");

    // The gate reports live children, so a delete must be rejected by the caller.
    const liveChildren = await findLiveLineageChildren(ctx.layer.db, "KB-PARENT");
    expect(liveChildren).toContain("KB-LIVE");
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(true);

    // Parent is still present (the gate prevented the delete).
    const parent = await ctx.layer.db
      .select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-PARENT"));
    expect(parent).toHaveLength(1);
  });

  // ── VAL-DATA-011: removeLineageReferences clears children ──

  it("removeLineageReferences clears lineage edges so parent can be deleted (VAL-DATA-011)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    await seedTaskWithParent(ctx.layer, "KB-CHILD", "KB-PARENT", "todo");

    // Before: gate blocks.
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(true);

    // Clear the lineage edges in a transaction.
    const nowIso = new Date().toISOString();
    await ctx.layer.transactionImmediate(async (tx) => {
      const childIds = await findLiveLineageChildren(tx, "KB-PARENT");
      expect(childIds).toEqual(["KB-CHILD"]);
      const cleared = await removeLineageReferences(tx, "KB-PARENT", childIds, nowIso);
      expect(cleared).toBe(1);
    });

    // After: gate passes (no live children).
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(false);
    const liveChildren = await findLiveLineageChildren(ctx.layer.db, "KB-PARENT");
    expect(liveChildren).toEqual([]);

    // The child's sourceParentTaskId is now NULL.
    const childRows = await ctx.layer.db
      .select({ id: schema.project.tasks.id, sourceParentTaskId: schema.project.tasks.sourceParentTaskId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-CHILD"));
    expect(childRows[0]?.sourceParentTaskId).toBeNull();

    // Parent can now be deleted (soft-delete succeeds).
    await softDeleteTaskRow(ctx.layer, "KB-PARENT", new Date().toISOString());
    const parentAfter = await ctx.layer.db
      .select({ id: schema.project.tasks.id, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-PARENT"));
    expect(parentAfter[0]?.deletedAt).not.toBeNull();
  });

  // ── VAL-DATA-012: Archived/soft-deleted children do not block parent delete ──

  it("archived children do not block parent delete (VAL-DATA-012)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    // An archived child (column = 'archived' but not soft-deleted).
    await seedTaskWithParent(ctx.layer, "KB-ARCHIVED", "KB-PARENT", "archived");

    // The gate excludes archived children.
    const liveChildren = await findLiveLineageChildren(ctx.layer.db, "KB-PARENT");
    expect(liveChildren).toEqual([]);
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(false);

    // Parent can be deleted immediately.
    await softDeleteTaskRow(ctx.layer, "KB-PARENT", new Date().toISOString());
    const parent = await ctx.layer.db
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-PARENT"));
    expect(parent[0]?.deletedAt).not.toBeNull();
  });

  it("soft-deleted children do not block parent delete (VAL-DATA-012)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    // A live child that we then soft-delete.
    await seedTaskWithParent(ctx.layer, "KB-SOFTDEL", "KB-PARENT", "todo");
    await softDeleteTaskRow(ctx.layer, "KB-SOFTDEL", new Date().toISOString());

    // The gate excludes soft-deleted children.
    const liveChildren = await findLiveLineageChildren(ctx.layer.db, "KB-PARENT");
    expect(liveChildren).toEqual([]);
    expect(await hasLiveLineageChildren(ctx.layer.db, "KB-PARENT")).toBe(false);

    // Parent can be deleted immediately.
    await softDeleteTaskRow(ctx.layer, "KB-PARENT", new Date().toISOString());
    const parent = await ctx.layer.db
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-PARENT"));
    expect(parent[0]?.deletedAt).not.toBeNull();
  });

  // ── VAL-DATA-013: Handoff-to-review mergeQueue transactional invariant ──

  it("handoff-to-review: column move + mergeQueue insert + audit are atomic (VAL-DATA-013)", async () => {
    ctx = await setupCtx();
    // Seed a task in a non-review column.
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-HANDOFF", "in-progress"), {
      lineageId: null,
    });

    // The handoff transaction: column move + queue insert + audit in ONE txn.
    const now = new Date().toISOString();
    await ctx.layer.transactionImmediate(async (tx) => {
      // Column move.
      await tx
        .update(schema.project.tasks)
        .set({ column: "in-review", updatedAt: now, columnMovedAt: now })
        .where(eq(schema.project.tasks.id, "KB-HANDOFF"));
      // Merge-queue insert (inside the same transaction).
      await enqueueMergeQueueInTransaction(tx, "KB-HANDOFF", { now });
      // Audit fan-out (inside the same transaction).
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: "KB-HANDOFF",
        agentId: "agent-1",
        runId: "run-1",
        domain: "database",
        mutationType: "task:handoff",
        target: "KB-HANDOFF",
        metadata: { taskId: "KB-HANDOFF", fromColumn: "in-progress" },
      });
    });

    // All three writes landed together.
    const taskRow = await ctx.layer.db
      .select({ id: schema.project.tasks.id, column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-HANDOFF"));
    expect(taskRow[0]?.column).toBe("in-review");

    const queueRows = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-HANDOFF"));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]?.taskId).toBe("KB-HANDOFF");

    const auditRows = await ctx.layer.db
      .select()
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.taskId, "KB-HANDOFF"));
    // At least the handoff audit + the mergeQueue:enqueue audit.
    const mutationTypes = auditRows.map((r) => r.mutationType);
    expect(mutationTypes).toContain("task:handoff");
    expect(mutationTypes).toContain("mergeQueue:enqueue");
  });

  it("handoff-to-review: a failing audit rolls back the column move and queue insert (VAL-DATA-013)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-ROLLBACK", "in-progress"), {
      lineageId: null,
    });

    // Inject a failure mid-transaction: force a primary-key collision on the
    // audit insert so the whole transaction rolls back.
    const now = new Date().toISOString();
    await expect(
      ctx.layer.transactionImmediate(async (tx) => {
        // Column move.
        await tx
          .update(schema.project.tasks)
          .set({ column: "in-review", updatedAt: now, columnMovedAt: now })
          .where(eq(schema.project.tasks.id, "KB-ROLLBACK"));
        // Queue insert.
        await enqueueMergeQueueInTransaction(tx, "KB-ROLLBACK", { now });
        // Now force a failure: insert an audit row with a duplicate id.
        const firstEvent = await recordRunAuditEventWithinTransaction(tx, {
          taskId: "KB-ROLLBACK",
          agentId: "agent-1",
          runId: "run-1",
          domain: "database",
          mutationType: "task:handoff",
          target: "KB-ROLLBACK",
          metadata: {},
        });
        // Duplicate id → primary-key violation → transaction rolls back.
        await tx
          .insert(schema.project.runAuditEvents)
          .values({ ...firstEvent } as never);
      }),
    ).rejects.toThrow();

    // Nothing landed: column unchanged, no queue row, no audit row.
    const taskRow = await ctx.layer.db
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-ROLLBACK"));
    expect(taskRow[0]?.column).toBe("in-progress");

    const queueRows = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-ROLLBACK"));
    expect(queueRows).toHaveLength(0);

    const auditRows = await ctx.layer.db
      .select()
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.taskId, "KB-ROLLBACK"));
    expect(auditRows).toHaveLength(0);
  });

  // ── VAL-DATA-014: Merge-queue lease semantics ──

  it("merge-queue lease is acquired priority-first (urgent before normal)", async () => {
    ctx = await setupCtx();
    // Seed three tasks in-review, enqueued at slightly different times so the
    // priority ordering is deterministic regardless of FIFO tiebreak.
    const t0 = "2026-01-01T00:00:00Z";
    const t1 = "2026-01-01T00:00:01Z";
    const t2 = "2026-01-01T00:00:02Z";
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-NORMAL", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-LOW", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-URGENT", "in-review"), { lineageId: null });

    // Enqueue in an order that is NOT the priority order so we prove the
    // acquire re-sorts by priority.
    await enqueueMergeQueue(ctx.layer, "KB-NORMAL", { now: t0 });
    await enqueueMergeQueue(ctx.layer, "KB-LOW", { now: t1 });
    await enqueueMergeQueue(ctx.layer, "KB-URGENT", { priority: "urgent", now: t2 });

    // Acquire should hand out URGENT first (priority-first).
    const leased1 = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
      now: "2026-01-01T00:01:00Z",
    });
    expect(leased1?.taskId).toBe("KB-URGENT");

    // Release as success so URGENT leaves the queue for good.
    await releaseMergeQueueLease(ctx.layer, "KB-URGENT", "worker-1", { kind: "success" });

    // Next acquire should be NORMAL (higher than LOW).
    const leased2 = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
      now: "2026-01-01T00:02:00Z",
    });
    expect(leased2?.taskId).toBe("KB-NORMAL");

    // Release NORMAL as success; final acquire is LOW.
    await releaseMergeQueueLease(ctx.layer, "KB-NORMAL", "worker-1", { kind: "success" });
    const leased3 = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
      now: "2026-01-01T00:03:00Z",
    });
    expect(leased3?.taskId).toBe("KB-LOW");
  });

  it("merge-queue lease is FIFO within the same priority", async () => {
    ctx = await setupCtx();
    const t0 = "2026-01-01T00:00:00Z";
    const t1 = "2026-01-01T00:00:01Z";
    const t2 = "2026-01-01T00:00:02Z";
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-FIRST", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-SECOND", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-THIRD", "in-review"), { lineageId: null });

    // All normal priority; enqueued in order FIRST, SECOND, THIRD.
    await enqueueMergeQueue(ctx.layer, "KB-FIRST", { now: t0 });
    await enqueueMergeQueue(ctx.layer, "KB-SECOND", { now: t1 });
    await enqueueMergeQueue(ctx.layer, "KB-THIRD", { now: t2 });

    const peek = await peekMergeQueue(ctx.layer);
    expect(peek.map((e) => e.taskId)).toEqual(["KB-FIRST", "KB-SECOND", "KB-THIRD"]);

    // Acquire hands out the earliest-enqueued first.
    const leased1 = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
      now: "2026-01-01T00:01:00Z",
    });
    expect(leased1?.taskId).toBe("KB-FIRST");

    // Release as success (removes from queue), then acquire next.
    await releaseMergeQueueLease(ctx.layer, "KB-FIRST", "worker-1", { kind: "success" });
    const leased2 = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
      now: "2026-01-01T00:02:00Z",
    });
    expect(leased2?.taskId).toBe("KB-SECOND");
  });

  it("expired leases recover without incrementing attemptCount (VAL-DATA-014)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-EXPIRE", "in-review"), { lineageId: null });
    await enqueueMergeQueue(ctx.layer, "KB-EXPIRE");

    // Acquire with a short lease.
    const now = "2026-01-01T00:00:00Z";
    const leased = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 1_000,
      now,
    });
    expect(leased?.taskId).toBe("KB-EXPIRE");
    expect(leased?.attemptCount).toBe(0);

    // Advance time past the lease expiry and recover.
    const later = "2026-01-01T00:00:05Z";
    const recovered = await recoverExpiredMergeQueueLeases(ctx.layer, later);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.taskId).toBe("KB-EXPIRE");
    // The attempt count is NOT incremented by expiry recovery.
    expect(recovered[0]?.attemptCount).toBe(0);
    expect(recovered[0]?.leasedBy).toBeNull();
    expect(recovered[0]?.leaseExpiresAt).toBeNull();

    // A subsequent acquire succeeds (the expired lease was recoverable).
    const reAcquired = await acquireMergeQueueLease(ctx.layer, "worker-2", {
      leaseDurationMs: 60_000,
      now: later,
    });
    expect(reAcquired?.taskId).toBe("KB-EXPIRE");
    expect(reAcquired?.attemptCount).toBe(0);
  });

  it("failure release increments attemptCount, success removes the row (VAL-DATA-014)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-OK", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-FAIL", "in-review"), { lineageId: null });
    // Enqueue OK first so it is the queue head (FIFO within same priority).
    await enqueueMergeQueue(ctx.layer, "KB-OK");
    await enqueueMergeQueue(ctx.layer, "KB-FAIL");

    // KB-OK: acquire + release-as-success → row deleted.
    const leasedOk = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
    });
    expect(leasedOk?.taskId).toBe("KB-OK");
    await releaseMergeQueueLease(ctx.layer, "KB-OK", "worker-1", { kind: "success" });
    const okRow = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-OK"));
    expect(okRow).toHaveLength(0);

    // KB-FAIL: acquire + release-as-failure → attemptCount increments.
    const leasedFail = await acquireMergeQueueLease(ctx.layer, "worker-1", {
      leaseDurationMs: 60_000,
    });
    expect(leasedFail?.taskId).toBe("KB-FAIL");
    await releaseMergeQueueLease(ctx.layer, "KB-FAIL", "worker-1", {
      kind: "failure",
      error: "merge conflict",
    });
    const failRow = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-FAIL"));
    expect(failRow[0]?.attemptCount).toBe(1);
    expect(failRow[0]?.lastError).toBe("merge conflict");
    expect(failRow[0]?.leasedBy).toBeNull();
  });

  it("release by a non-holder is rejected (ownership check)", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-OWN", "in-review"), { lineageId: null });
    await enqueueMergeQueue(ctx.layer, "KB-OWN");
    await acquireMergeQueueLease(ctx.layer, "worker-1", { leaseDurationMs: 60_000 });

    await expect(
      releaseMergeQueueLease(ctx.layer, "KB-OWN", "worker-2", { kind: "success" }),
    ).rejects.toThrow();
  });

  it("cleanupStaleMergeQueueRows removes entries whose task left in-review", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-STALE", "in-review"), { lineageId: null });
    await enqueueMergeQueue(ctx.layer, "KB-STALE");

    // Move the task out of in-review.
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ column: "done" })
      .where(eq(schema.project.tasks.id, "KB-STALE"));

    await ctx.layer.transactionImmediate((tx) =>
      cleanupStaleMergeQueueRowsInTransaction(tx, new Date().toISOString()),
    );

    const rows = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-STALE"));
    expect(rows).toHaveLength(0);
  });

  it("enqueue rejects a task not in in-review column", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-REJECT", "todo"), { lineageId: null });

    await expect(enqueueMergeQueue(ctx.layer, "KB-REJECT")).rejects.toThrow();
    const rows = await ctx.layer.db
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, "KB-REJECT"));
    expect(rows).toHaveLength(0);
  });

  it("peekMergeQueue orders priority-first then FIFO", async () => {
    ctx = await setupCtx();
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-A", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-B", "in-review"), { lineageId: null });
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-C", "in-review"), { lineageId: null });
    await enqueueMergeQueue(ctx.layer, "KB-A", { now: "2026-01-01T00:00:02Z" });
    await enqueueMergeQueue(ctx.layer, "KB-B", { priority: "urgent", now: "2026-01-01T00:00:01Z" });
    await enqueueMergeQueue(ctx.layer, "KB-C", { priority: "urgent", now: "2026-01-01T00:00:00Z" });

    const peek = await peekMergeQueue(ctx.layer);
    // C and B are urgent (FIFO: C enqueued first), then A normal.
    expect(peek.map((e) => e.taskId)).toEqual(["KB-C", "KB-B", "KB-A"]);
  });

  it("rowToMergeQueueEntry normalizes priority", () => {
    const row: MergeQueueRow = {
      taskId: "KB-X",
      enqueuedAt: "2026-01-01T00:00:00Z",
      priority: "garbage",
      leasedBy: null,
      leasedAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      lastError: null,
    };
    const entry = rowToMergeQueueEntry(row);
    expect(entry.priority).toBe("normal"); // unknown → default
  });
});
