/**
 * FNXC:RuntimeLifecycleAsync 2026-06-24-12:40:
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * PostgreSQL integration tests for the backend-mode delegation of
 * lifecycle/merge-coordination methods (runtime-lifecycle-async feature).
 *
 * These tests construct a real TaskStore with an AsyncDataLayer connected to
 * a fresh PostgreSQL database, then exercise the backend-mode delegation paths
 * for merge-queue operations (enqueue, acquire, release, recover, peek) and
 * the deleteTask lineage gate against real PostgreSQL data.
 *
 * Refactored to use the reusable createTaskStoreForTest() helper, which handles
 * the database lifecycle (CREATE/DROP DATABASE, schema baseline, connection pool)
 * and exposes the ready store + layer for direct row seeding.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { insertTaskRow } from "../../task-store/async-persistence.js";
import { writeProjectConfig } from "../../task-store/async-settings.js";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

/** Insert a task row directly via the async helper for test setup. */
async function seedTask(
  layer: AsyncDataLayer,
  id: string,
  column: string,
  priority = "normal",
): Promise<void> {
  await insertTaskRow(
    layer,
    {
      id,
      title: `Task ${id}`,
      description: `Description for ${id}`,
      column,
      priority,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: null,
    } as never,
    { lineageId: "test" },
  );
}

pgDescribe("runtime-lifecycle-async: merge-queue delegation (PostgreSQL)", () => {
  let h: PgTestHarness | null = null;
  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("peekMergeQueue returns entries ordered priority-first, FIFO within priority", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    // Seed tasks in-review and enqueue them.
    await seedTask(h.layer, "FN-1", "in-review", "normal");
    await seedTask(h.layer, "FN-2", "in-review", "urgent");
    await seedTask(h.layer, "FN-3", "in-review", "high");

    await h.store.enqueueMergeQueue("FN-1", { now: "2026-06-24T01:00:00Z" });
    await h.store.enqueueMergeQueue("FN-2", { now: "2026-06-24T02:00:00Z" });
    await h.store.enqueueMergeQueue("FN-3", { now: "2026-06-24T03:00:00Z" });

    const entries = await h.store.peekMergeQueue();
    expect(entries).toHaveLength(3);
    // Priority order: urgent (FN-2) > high (FN-3) > normal (FN-1).
    expect(entries[0].taskId).toBe("FN-2");
    expect(entries[1].taskId).toBe("FN-3");
    expect(entries[2].taskId).toBe("FN-1");
  });

  it("acquireMergeQueueLease acquires the highest-priority available entry", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-1", "in-review", "normal");
    await seedTask(h.layer, "FN-2", "in-review", "urgent");
    await h.store.enqueueMergeQueue("FN-1", { now: "2026-06-24T01:00:00Z" });
    await h.store.enqueueMergeQueue("FN-2", { now: "2026-06-24T02:00:00Z" });

    const lease = await h.store.acquireMergeQueueLease("worker-1", {
      leaseDurationMs: 60000,
      now: "2026-06-24T03:00:00Z",
    });
    expect(lease).not.toBeNull();
    expect(lease!.taskId).toBe("FN-2"); // urgent first
  });

  it("releaseMergeQueueLease with success deletes the queue row", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-1", "in-review", "normal");
    await h.store.enqueueMergeQueue("FN-1", { now: "2026-06-24T01:00:00Z" });

    const lease = await h.store.acquireMergeQueueLease("worker-1", {
      leaseDurationMs: 60000,
      now: "2026-06-24T02:00:00Z",
    });
    expect(lease).not.toBeNull();

    await h.store.releaseMergeQueueLease("FN-1", "worker-1", { kind: "success" });

    const entries = await h.store.peekMergeQueue();
    expect(entries).toHaveLength(0); // row deleted on success
  });

  it("releaseMergeQueueLease with failure increments attemptCount and retains row", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-1", "in-review", "normal");
    await h.store.enqueueMergeQueue("FN-1", { now: "2026-06-24T01:00:00Z" });

    const lease = await h.store.acquireMergeQueueLease("worker-1", {
      leaseDurationMs: 60000,
      now: "2026-06-24T02:00:00Z",
    });
    expect(lease).not.toBeNull();

    await h.store.releaseMergeQueueLease("FN-1", "worker-1", {
      kind: "failure",
      error: "merge conflict",
    });

    const entries = await h.store.peekMergeQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].attemptCount).toBe(1);
    expect(entries[0].leasedBy).toBeNull();
  });

  it("recoverExpiredMergeQueueLeases clears expired leases without incrementing attemptCount", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-1", "in-review", "normal");
    await h.store.enqueueMergeQueue("FN-1", { now: "2026-06-24T01:00:00Z" });

    // Acquire with a short lease, then recover after expiry.
    await h.store.acquireMergeQueueLease("worker-1", {
      leaseDurationMs: 1000,
      now: "2026-06-24T02:00:00Z",
    });

    const recovered = await h.store.recoverExpiredMergeQueueLeases("2026-06-24T03:00:00Z");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].taskId).toBe("FN-1");
    expect(recovered[0].leasedBy).toBeNull();
    // VAL-DATA-014: attemptCount NOT incremented on expiry recovery.
    expect(recovered[0].attemptCount).toBe(0);
  });
});

pgDescribe("runtime-lifecycle-async: deleteTask lineage gate (PostgreSQL)", () => {
  let h: PgTestHarness | null = null;
  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("deleteTask blocks when parent has live lineage children", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    // Seed parent and live child.
    await seedTask(h.layer, "FN-PARENT", "todo");
    await insertTaskRow(
      h.layer,
      {
        id: "FN-CHILD",
        title: "Child task",
        description: "Child",
        column: "todo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceParentTaskId: "FN-PARENT",
        status: null,
      } as never,
      { lineageId: "test" },
    );

    await expect(h.store.deleteTask("FN-PARENT")).rejects.toThrow(/lineage/i);
  });

  it("deleteTask succeeds when parent has no live children", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-SOLO", "todo");

    await h.store.deleteTask("FN-SOLO");
    // Verify the task is soft-deleted by re-reading from the DB.
    const { eq } = await import("drizzle-orm");
    const rows = await h.layer.db
      .select()
      .from((await import("../../postgres/schema/index.js")).project.tasks)
      .where(eq((await import("../../postgres/schema/index.js")).project.tasks.id, "FN-SOLO"));
    expect(rows.length).toBe(1);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("deleteTask succeeds with removeLineageReferences option", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_lifecycle" });
    await writeProjectConfig(h.layer, {
      taskPrefix: "TEST",
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: {},
    });

    await seedTask(h.layer, "FN-PARENT2", "todo");
    await insertTaskRow(
      h.layer,
      {
        id: "FN-CHILD2",
        title: "Child task",
        description: "Child",
        column: "todo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceParentTaskId: "FN-PARENT2",
        status: null,
      } as never,
      { lineageId: "test" },
    );

    await h.store.deleteTask("FN-PARENT2", { removeLineageReferences: true });
    // Verify the task is soft-deleted.
    const { eq } = await import("drizzle-orm");
    const schema = await import("../../postgres/schema/index.js");
    const rows = await h.layer.db
      .select()
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "FN-PARENT2"));
    expect(rows.length).toBe(1);
    expect(rows[0].deletedAt).not.toBeNull();
  });
});
