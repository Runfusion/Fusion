import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { TaskHasDependentsError, TaskHasLineageChildrenError } from "../store.js";

describe("TaskStore lineage child delete/archive guards", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  async function createParentAndChild(
    sourceType: "task_refine" | "task_duplicate" | "recovery" = "task_refine",
    parentColumn: "todo" | "done" = "todo"
  ) {
    const store = harness.store();
    const parent = await store.createTask({ column: parentColumn, title: "parent", description: "parent" });
    const child = await store.createTask({ column: "todo", title: "child", description: "child" });
    (store as any).db
      .prepare("UPDATE tasks SET sourceParentTaskId = ?, sourceType = ?, updatedAt = ? WHERE id = ?")
      .run(parent.id, sourceType, new Date().toISOString(), child.id);
    return { store, parent, child: await store.getTask(child.id) };
  }

  it("soft-delete with live lineage child throws", async () => {
    const { store, parent, child } = await createParentAndChild();
    await expect(store.deleteTask(parent.id)).rejects.toMatchObject({ taskId: parent.id, childIds: [child.id] });
  });

  it("soft-delete with removeLineageReferences rewrites child and emits", async () => {
    const { store, parent, child } = await createParentAndChild();
    const before = await store.getTask(child.id);
    const updated: string[] = [];
    const deleted: string[] = [];
    store.on("task:updated", (task) => updated.push(task.id));
    store.on("task:deleted", (task) => deleted.push(task.id));

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    const after = await store.getTask(child.id);
    expect(after.sourceParentTaskId).toBeUndefined();
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
    expect(updated).toEqual([child.id]);
    expect(deleted).toEqual([parent.id]);
  });

  it("dependency gate precedes lineage gate and both options together succeed", async () => {
    const { store, parent, child } = await createParentAndChild();
    const dependent = await store.createTask({ column: "todo", title: "dependent", description: "dependent", dependencies: [parent.id] });

    await expect(store.deleteTask(parent.id)).rejects.toBeInstanceOf(TaskHasDependentsError);
    await expect(store.deleteTask(parent.id, { removeDependencyReferences: true })).rejects.toBeInstanceOf(TaskHasLineageChildrenError);
    await store.deleteTask(parent.id, { removeDependencyReferences: true, removeLineageReferences: true });

    expect((await store.getTask(dependent.id)).dependencies).toEqual([]);
    expect((await store.getTask(child.id)).sourceParentTaskId).toBeUndefined();
  });

  it("soft-deleted children do not block parent deletion", async () => {
    const store = harness.store();
    const parent = await store.createTask({ column: "todo", title: "parent", description: "parent" });
    const child = await store.createTask({ column: "todo", title: "child", description: "child" });
    (store as any).db
      .prepare("UPDATE tasks SET sourceParentTaskId = ?, sourceType = ?, updatedAt = ? WHERE id = ?")
      .run(parent.id, "task_refine", new Date().toISOString(), child.id);

    await store.deleteTask(child.id);
    await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id });
  });

  it("archived children do not block soft-delete of parent", async () => {
    const { store, parent, child } = await createParentAndChild();
    (store as any).db.prepare("UPDATE tasks SET \"column\" = 'archived' WHERE id = ?").run(child.id);
    await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id });

    const parent2 = await store.createTask({ column: "todo", title: "parent-2", description: "parent-2" });
    const child2 = await store.createTask({ column: "done", title: "child-2", description: "child-2" });
    (store as any).db
      .prepare("UPDATE tasks SET sourceParentTaskId = ?, sourceType = ?, updatedAt = ? WHERE id = ?")
      .run(parent2.id, "task_refine", new Date().toISOString(), child2.id);
    await store.archiveTask(child2.id, true);
    await expect(store.deleteTask(parent2.id)).resolves.toMatchObject({ id: parent2.id });
  });

  it("archiveTask is gated and can rewrite lineage refs", async () => {
    const { store, parent, child } = await createParentAndChild("task_refine", "done");

    await expect(store.archiveTask(parent.id, true)).rejects.toBeInstanceOf(TaskHasLineageChildrenError);
    await store.archiveTask(parent.id, { cleanup: true, removeLineageReferences: true });

    expect((await store.getTask(child.id)).sourceParentTaskId).toBeUndefined();
    expect((store as any).db.prepare("SELECT id FROM tasks WHERE id = ?").get(parent.id)).toBeUndefined();
    expect((store as any).archiveDb.get(parent.id)?.id).toBe(parent.id);
  });

  it("archiveTask cleanup:false also rewrites lineage refs when opted-in", async () => {
    const { store, parent, child } = await createParentAndChild("task_refine", "done");
    const updated: string[] = [];
    const moved: string[] = [];
    store.on("task:updated", (task) => updated.push(task.id));
    store.on("task:moved", ({ task }) => moved.push(task.id));

    await store.archiveTask(parent.id, { cleanup: false, removeLineageReferences: true });

    expect((await store.getTask(child.id)).sourceParentTaskId).toBeUndefined();
    expect(updated).toEqual([child.id]);
    expect(moved).toContain(parent.id);
  });

  it("cleanupArchivedTasks tolerates dangling lineage pointers", async () => {
    const { store, parent, child } = await createParentAndChild("task_refine", "done");
    await store.archiveTask(parent.id, { cleanup: true, removeLineageReferences: true });
    (store as any).db.prepare("UPDATE tasks SET sourceParentTaskId = ? WHERE id = ?").run(parent.id, child.id);
    await expect(store.cleanupArchivedTasks()).resolves.toEqual([]);
  });

  it("re-delete of already soft-deleted parent is a no-op even with late lineage child (FN-5127)", async () => {
    const { store, parent } = await createParentAndChild();
    await store.deleteTask(parent.id, { removeLineageReferences: true });
    const before = (store as any).readTaskFromDb(parent.id, { includeDeleted: true });

    const lateChild = await store.createTask({ column: "todo", title: "late-child", description: "late-child" });
    (store as any).db
      .prepare("UPDATE tasks SET sourceParentTaskId = ?, sourceType = ?, updatedAt = ? WHERE id = ?")
      .run(parent.id, "task_refine", new Date().toISOString(), lateChild.id);

    const listener = vi.fn();
    store.on("task:deleted", listener);
    store.on("task:updated", listener);

    await expect(store.deleteTask(parent.id)).resolves.toMatchObject({ id: parent.id, deletedAt: before.deletedAt });
    const after = (store as any).readTaskFromDb(parent.id, { includeDeleted: true });
    expect(after?.deletedAt).toBe(before.deletedAt);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["task_refine", "task_duplicate", "recovery"] as const)("preserves sourceType %s when rewriting lineage child", async (sourceType) => {
    const { store, parent, child } = await createParentAndChild(sourceType);
    await store.deleteTask(parent.id, { removeLineageReferences: true });
    const updated = await store.getTask(child.id);
    expect(updated.sourceParentTaskId).toBeUndefined();
    expect(updated.sourceType).toBe(sourceType);
  });

  it("emits no events on lineage throw path", async () => {
    const { store, parent } = await createParentAndChild();
    const listener = vi.fn();
    store.on("task:updated", listener);
    store.on("task:deleted", listener);

    await expect(store.deleteTask(parent.id)).rejects.toBeInstanceOf(TaskHasLineageChildrenError);
    expect(listener).not.toHaveBeenCalled();
  });
});
