import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskDeletedError } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("soft-delete QA boundary audit (FN-5124)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("re-delete is deterministic: repeated deletes are no-op and do not emit duplicate task:deleted", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", description: "redelete target" });

    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    await store.deleteTask(task.id);
    const firstDeletedAt = ((store as any).db.prepare("SELECT deletedAt FROM tasks WHERE id = ?").get(task.id) as { deletedAt: string | null })
      .deletedAt;

    await expect(store.deleteTask(task.id)).resolves.toMatchObject({ id: task.id, deletedAt: firstDeletedAt });

    const secondDeletedAt = ((store as any).db.prepare("SELECT deletedAt FROM tasks WHERE id = ?").get(task.id) as { deletedAt: string | null })
      .deletedAt;

    expect(firstDeletedAt).toBeTruthy();
    expect(secondDeletedAt).toBe(firstDeletedAt);
    expect(deletedEvents).toEqual([task.id]);
  });

  it("preserves dependents by default and rewrites blockedBy when removeDependencyReferences is true", async () => {
    const store = harness.store();
    const parent = await store.createTask({ column: "todo", title: "parent", description: "parent task" });
    const dependent = await store.createTask({ column: "todo", title: "dependent", description: "dependent task" });

    await store.updateTask(dependent.id, { dependencies: [parent.id] });

    await expect(store.deleteTask(parent.id)).rejects.toThrow(/depend/i);

    await store.deleteTask(parent.id, { removeDependencyReferences: true });

    const dependentAfter = await store.getTask(dependent.id);
    expect(dependentAfter.dependencies).not.toContain(parent.id);
    expect((store as any).findLiveDependents(parent.id)).toEqual([]);
  });

  it("refuses archiving a soft-deleted task and preserves the deleted row", async () => {
    const store = harness.store();
    const doneTask = await store.createTask({ column: "done", title: "done task", description: "done task description" });

    await store.deleteTask(doneTask.id);
    await expect(store.archiveTask(doneTask.id)).rejects.toBeInstanceOf(TaskDeletedError);

    const liveRow = (store as any).db.prepare("SELECT id, deletedAt FROM tasks WHERE id = ?").get(doneTask.id) as
      | { id: string; deletedAt: string | null }
      | undefined;

    expect(liveRow).toMatchObject({ id: doneTask.id });
    expect(typeof liveRow?.deletedAt).toBe("string");
    expect((store as any).archiveDb.get(doneTask.id)).toBeUndefined();
  });

  it.each(["todo", "in-progress", "in-review", "done", "triage"])(
    "keeps ID reservation after soft-delete (%s)",
    async (column) => {
      const store = harness.store();
      const task = await store.createTask({ column: column as any, title: `reserve-${column}`, description: `reserve ${column}` });

      await store.deleteTask(task.id);

      expect(() => (store as any).assertTaskIdAvailable(task.id)).toThrow(`Task ID already exists: ${task.id}`);
      expect((store as any).taskIdExistsAnywhere(task.id)).toBe(true);
    },
  );
});
