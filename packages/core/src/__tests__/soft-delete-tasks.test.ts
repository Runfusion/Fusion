import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { createDistributedTaskIdAllocator, reconcileTaskIdState } from "../distributed-task-id.js";

describe("TaskStore soft delete", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("soft-deletes rows, keeps task directory, and emits task:deleted", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();
    const taskDir = join(harness.rootDir(), ".fusion", "tasks", task.id);

    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    await store.deleteTask(task.id);

    await expect(store.getTask(task.id)).rejects.toThrow(`Task ${task.id} not found`);
    const row = (store as any).db.prepare("SELECT deletedAt FROM tasks WHERE id = ?").get(task.id) as { deletedAt: string | null };
    expect(typeof row.deletedAt).toBe("string");
    expect(existsSync(taskDir)).toBe(true);
    expect(deletedEvents).toContain(task.id);
  });

  it("excludes soft-deleted tasks from live readers, list filters, modified feeds, and FTS search", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "Soft delete me", description: "keyword-needle description" });

    const before = await store.searchTasks("keyword-needle");
    expect(before.map((entry) => entry.id)).toContain(task.id);

    await store.deleteTask(task.id);

    const listed = await store.listTasks();
    expect(listed.map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ column: "todo" })).map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ includeArchived: true })).map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ column: "archived", includeArchived: true })).map((entry) => entry.id)).not.toContain(task.id);

    const modified = await store.listTasksModifiedSince("1970-01-01T00:00:00.000Z", 100, { includeArchived: true });
    expect(modified.tasks.map((entry) => entry.id)).not.toContain(task.id);

    const after = await store.searchTasks("keyword-needle");
    expect(after.map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.searchTasks(task.id)).map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.searchTasks("Soft delete me")).map((entry) => entry.id)).not.toContain(task.id);
  });

  it("allows deleting parent after dependent is soft-deleted", async () => {
    const store = harness.store();
    const parent = await store.createTask({ column: "todo", title: "parent", description: "parent description" });
    const dependent = await store.createTask({ column: "todo", title: "dependent", description: "dependent description" });
    await store.updateTask(dependent.id, { dependencies: [parent.id] });

    await store.deleteTask(dependent.id);
    await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id });
  });

  it("emits task:deleted exactly once from watcher polling after soft delete", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "watcher delete task" });
    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    await store.listTasks();
    await store.deleteTask(task.id);

    await (store as any).checkForChanges();
    const afterFirstPoll = deletedEvents.length;
    await (store as any).checkForChanges();

    expect(afterFirstPoll).toBeGreaterThanOrEqual(1);
    expect(deletedEvents.length).toBe(afterFirstPoll);
  });

  it("keeps soft-deleted ids reserved and non-archived", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "reserved id task" });

    await store.deleteTask(task.id);

    expect(() => (store as any).assertTaskIdAvailable(task.id)).toThrow();
    expect((store as any).taskIdExistsAnywhere(task.id)).toBe(true);
    expect((store as any).isTaskArchived(task.id)).toBe(false);

    const prefix = task.id.split("-")[0];
    reconcileTaskIdState((store as any).db);
    const allocator = createDistributedTaskIdAllocator((store as any).db);
    const state = await allocator.getDistributedTaskIdState({ prefix });
    expect(state.nextSequence).toBeGreaterThan(1);
  });

  it("archiveTask still hard-deletes from active tasks table", async () => {
    const store = harness.store();
    const doneTask = await store.createTask({ column: "done", description: "archive me" });

    await store.archiveTask(doneTask.id);

    const row = (store as any).db
      .prepare('SELECT id, deletedAt FROM tasks WHERE id = ?')
      .get(doneTask.id) as { id: string; deletedAt: string | null } | undefined;
    expect(row).toBeUndefined();

    expect((store as any).archiveDb.get(doneTask.id)?.id).toBe(doneTask.id);
  });

  it("unlinks mission feature task references when task is soft-deleted", async () => {
    const store = harness.store();
    const unlinkFeatureFromTask = vi.fn();
    (store as any).missionStore = {
      getFeatureByTaskId: () => ({ id: "F-001" }),
      unlinkFeatureFromTask,
    };

    const task = await store.createTask({ description: "linked task" });
    await store.deleteTask(task.id);

    expect(unlinkFeatureFromTask).toHaveBeenCalledWith("F-001");
  });
});
