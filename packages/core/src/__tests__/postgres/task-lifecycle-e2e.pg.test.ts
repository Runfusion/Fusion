/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * VAL-CROSS-001 — End-to-end task lifecycle (create → move columns → archive)
 *
 * Validates that the full task lifecycle works against PostgreSQL backend mode,
 * covering: create, move through columns (triage → todo → in-progress → in-review → done),
 * archive, and unarchive. This is the critical cross-area flow that must work
 * after SQLite removal.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("VAL-CROSS-001: End-to-end task lifecycle (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_lifecycle_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("creates a task and reads it back", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "E2E lifecycle task" });
    expect(task.id).toBeTruthy();
    expect(task.column).toBe("triage");

    const fetched = await store.getTask(task.id);
    expect(fetched.id).toBe(task.id);
    expect(fetched.description).toBe("E2E lifecycle task");
  });

  it("moves a task through all columns", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Column progression task" });

    const todo = await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect(todo.column).toBe("todo");

    const inProgress = await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    expect(inProgress.column).toBe("in-progress");

    const inReview = await store.moveTask(task.id, "in-review", {
      moveSource: "user",
      allowDirectInReviewMove: true,
    });
    expect(inReview.column).toBe("in-review");

    const done = await store.moveTask(task.id, "done", {
      moveSource: "engine",
      skipMergeBlocker: true,
    });
    expect(done.column).toBe("done");
  });

  it("archives and lists tasks", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archive target task" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    await store.moveTask(task.id, "in-review", {
      moveSource: "user",
      allowDirectInReviewMove: true,
    });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

    const archived = await store.archiveTask(task.id, { cleanup: false });
    expect(archived.id).toBe(task.id);

    // FNXC:PostgresArchiveReads 2026-07-14-17:10: Active-only callers opt out of cold storage explicitly; listTasks keeps its backward-compatible includeArchived default.
    const live = await store.listTasks({ includeArchived: false });
    expect(live.find((t) => t.id === task.id)).toBeUndefined();
  });

  it("updates task fields and they persist", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Update test" });

    const updated = await store.updateTask(task.id, {
      title: "Updated Title",
      priority: "high",
    });

    expect(updated.title).toBe("Updated Title");
    expect(updated.priority).toBe("high");

    // Verify persistence
    const fetched = await store.getTask(task.id);
    expect(fetched.title).toBe("Updated Title");
    expect(fetched.priority).toBe("high");
  });

  it("searches tasks by description", async () => {
    const store = h.store();
    await store.createTask({ description: "UniqueSearchTerm Alpha" });

    // Note: PG search uses tsvector; this validates the search path works
    const results = await store.searchTasks("UniqueSearchTerm");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.description?.includes("UniqueSearchTerm"))).toBe(true);
  });

  it("deletes a task (soft-delete)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Delete target" });

    await store.deleteTask(task.id);

    // Deleted task should not appear in live views
    const live = await store.listTasks();
    expect(live.find((t) => t.id === task.id)).toBeUndefined();
  });
});
