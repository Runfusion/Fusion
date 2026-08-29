/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:30:
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * PostgreSQL integration tests for the backend-mode delegation of task
 * orchestration methods (createTask, updateTask, moveTask, handoffToReview,
 * archiveTask, getDistributedTaskIdAllocator).
 *
 * Refactored to use the reusable createTaskStoreForTest() helper, eliminating
 * the per-test database lifecycle boilerplate.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { writeProjectConfig } from "../../task-store/async/async-settings.js";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

pgDescribe("runtime-task-orchestration-async (PostgreSQL integration)", () => {
  let h: PgTestHarness | null = null;

  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("getDistributedTaskIdAllocator returns async allocator in backend mode", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    const allocator = h.store.getDistributedTaskIdAllocator();
    expect(allocator).toBeDefined();
    expect(typeof allocator.reserveDistributedTaskId).toBe("function");

    // Verify the allocator can actually reserve an ID against PG.
    const reservation = await allocator.reserveDistributedTaskId({
      prefix: "KB",
      nodeId: "test-node",
    });
    expect(reservation.taskId).toMatch(/^KB-\d+$/);
    expect(reservation.reservationId).toBeDefined();
  });

  it("createTask creates a task against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    const task = await h.store.createTask({
      description: "PG createTask test",
      title: "PG Test",
    });

    expect(task.id).toMatch(/^[A-Z]+-\d+$/);
    expect(task.description).toBe("PG createTask test");
    expect(task.title).toBe("PG Test");

    // Verify the task was actually persisted to PG.
    const rows = await h.adminDb
      .select()
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(rows.length).toBe(1);
    expect(rows[0].description).toBe("PG createTask test");
  });

  it("updateTask updates a task against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    const task = await h.store.createTask({
      description: "Original",
      title: "Original",
    });

    const updated = await h.store.updateTask(task.id, { title: "Updated Title" });
    expect(updated.title).toBe("Updated Title");

    // Verify the update was persisted to PG.
    const rows = await h.adminDb
      .select({ title: schema.project.tasks.title })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(rows[0].title).toBe("Updated Title");
  });

  it("moveTask moves a task between columns against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    const task = await h.store.createTask({
      description: "Move test",
      title: "Move",
      column: "todo",
    });

    const moved = await h.store.moveTask(task.id, "in-progress");
    expect(moved.column).toBe("in-progress");

    // Verify the column was persisted to PG.
    const rows = await h.adminDb
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(rows[0].column).toBe("in-progress");
  });

  it("handoffToReview enqueues into merge queue against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    const task = await h.store.createTask({
      description: "Handoff test",
      title: "Handoff",
      column: "in-progress",
    });

    const handedOff = await h.store.handoffToReview(task.id, {
      evidence: { runId: "test-run", agentId: "test-agent", reason: "test" },
    });
    expect(handedOff.column).toBe("in-review");

    // Verify the task is in the merge queue (handoff invariant).
    const queueRows = await h.adminDb
      .select()
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, task.id));
    expect(queueRows.length).toBe(1);
  });

  it("archiveTask archives a task against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    const task = await h.store.createTask({
      description: "Archive test",
      title: "Archive",
      column: "done",
    });

    const archived = await h.store.archiveTask(task.id);
    expect(archived.column).toBe("archived");

    // Verify the task row was soft-deleted (deletedAt set, column = archived).
    const rows = await h.adminDb
      .select({
        column: schema.project.tasks.column,
        deletedAt: schema.project.tasks.deletedAt,
      })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(rows[0].column).toBe("archived");
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("full lifecycle: create → update → move → handoff → archive against PostgreSQL", async () => {
    h = await createTaskStoreForTest({ prefix: "rt_orch" });
    await writeProjectConfig(h.layer, { taskPrefix: "KB" });

    // Create
    const task = await h.store.createTask({
      description: "Lifecycle test",
      title: "Lifecycle",
      column: "todo",
    });

    // Update
    const updated = await h.store.updateTask(task.id, { priority: "high" });
    expect(updated.priority).toBe("high");

    // Move to in-progress
    const inProgress = await h.store.moveTask(task.id, "in-progress");
    expect(inProgress.column).toBe("in-progress");

    // Handoff to review
    const inReview = await h.store.handoffToReview(task.id, {
      evidence: { runId: "lifecycle-run", agentId: "lifecycle-agent", reason: "done" },
    });
    expect(inReview.column).toBe("in-review");

    // Move to done (out of review)
    const done = await h.store.moveTask(task.id, "done", { skipMergeBlocker: true });
    expect(done.column).toBe("done");

    // Archive
    const archived = await h.store.archiveTask(task.id);
    expect(archived.column).toBe("archived");
  });
});
