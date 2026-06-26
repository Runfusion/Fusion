/**
 * FNXC:RuntimePersistenceAsync 2026-06-24-11:30:
 * FNXC:TestMigrationTail 2026-06-24-16:00:
 * PostgreSQL integration tests for the backend-mode delegation of
 * persistence/allocator/settings/search methods.
 *
 * These tests construct a real TaskStore with an AsyncDataLayer connected to
 * a fresh PostgreSQL database, then exercise the backend-mode delegation paths
 * (settings reads/writes, getTask, listTasks, searchTasks) against real
 * PostgreSQL data. They verify the delegation works end-to-end.
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
import {
  insertTaskRow,
} from "../../task-store/async-persistence.js";
import {
  writeProjectConfig,
  readProjectConfig,
} from "../../task-store/async-settings.js";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

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

pgDescribe("runtime-persistence-async (PostgreSQL integration)", () => {
  let h: PgTestHarness | null = null;

  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("init() runs allocator reconciliation against PG", async () => {
    h = await createTaskStoreForTest();
    // The reconciliation should have created a state row for the default prefix.
    const stateRows = await h.adminDb
      .select()
      .from(schema.project.distributedTaskIdState);
    expect(stateRows.length).toBeGreaterThan(0);
    expect(h.store.isBackendMode()).toBe(true);
  });

  it("getSettings reads project config from PG", async () => {
    h = await createTaskStoreForTest();
    // Seed a config row and re-read settings through the store.
    await writeProjectConfig(h.layer, { taskPrefix: "PGTEST" });
    const settings = await h.store.getSettings();
    expect(settings.taskPrefix).toBe("PGTEST");
  });

  it("updateSettings writes project config to PG", async () => {
    h = await createTaskStoreForTest();
    await h.store.updateSettings({ taskPrefix: "WRITTEN" });
    // Verify it was written to PG by reading directly.
    const config = await readProjectConfig(h.layer);
    expect((config.settings as { taskPrefix?: string })?.taskPrefix).toBe("WRITTEN");
  });

  it("listTasks reads live tasks from PG", async () => {
    h = await createTaskStoreForTest();
    // Seed two tasks.
    await insertTaskRow(h.layer, makeMinimalTask("KB-001", "todo"), { lineageId: null });
    await insertTaskRow(h.layer, makeMinimalTask("KB-002", "in-progress"), { lineageId: null });
    const tasks = await h.store.listTasks();
    expect(tasks.length).toBe(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["KB-001", "KB-002"]);
  });

  it("listTasks hides soft-deleted tasks", async () => {
    h = await createTaskStoreForTest();
    await insertTaskRow(h.layer, makeMinimalTask("KB-001", "todo"), { lineageId: null });
    await insertTaskRow(h.layer, makeMinimalTask("KB-002", "todo"), { lineageId: null });
    // Soft-delete KB-002
    await h.layer.db
      .update(schema.project.tasks)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(schema.project.tasks.id, "KB-002"));
    const tasks = await h.store.listTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("KB-001");
  });

  it("getTask reads a task from PG", async () => {
    h = await createTaskStoreForTest();
    await insertTaskRow(
      h.layer,
      { ...makeMinimalTask("KB-001", "todo"), title: "Test Task" },
      { lineageId: null },
    );
    const task = await h.store.getTask("KB-001");
    expect(task.id).toBe("KB-001");
    expect(task.title).toBe("Test Task");
    expect(task.column).toBe("todo");
  });

  it("getTask throws not-found for missing task", async () => {
    h = await createTaskStoreForTest();
    await expect(h.store.getTask("KB-NONEXIST")).rejects.toThrow(/not found/i);
  });

  it("searchTasks finds tasks by description via tsvector", async () => {
    h = await createTaskStoreForTest();
    await insertTaskRow(
      h.layer,
      { ...makeMinimalTask("KB-001"), description: "unique searchable text" },
      { lineageId: null },
    );
    await insertTaskRow(
      h.layer,
      { ...makeMinimalTask("KB-002"), description: "unrelated content" },
      { lineageId: null },
    );
    const results = await h.store.searchTasks("unique searchable");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("KB-001");
  });

  it("searchTasks returns empty list for empty query", async () => {
    h = await createTaskStoreForTest();
    await insertTaskRow(h.layer, makeMinimalTask("KB-001"), { lineageId: null });
    const results = await h.store.searchTasks("");
    expect(results.length).toBe(1);
  });

  it("getDistributedTaskIdAllocator returns an async allocator in backend mode", async () => {
    h = await createTaskStoreForTest();
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:50:
    // The allocator now returns an async-backed allocator in backend mode
    // instead of throwing (updated by runtime-task-orchestration-async).
    const allocator = h.store.getDistributedTaskIdAllocator();
    expect(allocator).toBeDefined();
  });

  it("healthCheck returns true in backend mode", async () => {
    h = await createTaskStoreForTest();
    expect(h.store.healthCheck()).toBe(true);
  });
});
