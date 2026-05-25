import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore deleteTask blocker residue rewrite (FN-5566)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("clears dependencies + blockedBy + status and appends auto-unblocked log when blocker is referenced by both", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const dependent = await store.createTask({ column: "todo", description: "dependent", dependencies: [blocker.id] });
    await store.updateTask(dependent.id, { blockedBy: blocker.id, status: "queued" });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const updated = await store.getTask(dependent.id);

    expect(updated.dependencies).not.toContain(blocker.id);
    expect(updated.blockedBy).toBeUndefined();
    expect(updated.status).toBeUndefined();
    expect(updated.log.some((entry) => entry.action === `Auto-unblocked: blocker ${blocker.id} was soft-deleted`)).toBe(true);
  });

  it("clears blockedBy-only residue while preserving dependencies", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const other = await store.createTask({ column: "todo", description: "other" });
    const dependent = await store.createTask({ column: "todo", description: "dependent", dependencies: [other.id] });
    await store.updateTask(dependent.id, { blockedBy: blocker.id, status: "queued" });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const updated = await store.getTask(dependent.id);

    expect(updated.dependencies).toEqual([other.id]);
    expect(updated.blockedBy).toBeUndefined();
    expect(updated.status).toBeUndefined();
    expect(updated.log.some((entry) => entry.action === `Auto-unblocked: blocker ${blocker.id} was soft-deleted`)).toBe(true);
  });

  it("filters dependency without adding auto-unblocked log when blockedBy is already null", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const dependent = await store.createTask({ column: "todo", description: "dependent", dependencies: [blocker.id] });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const updated = await store.getTask(dependent.id);

    expect(updated.dependencies).toEqual([]);
    expect(updated.blockedBy).toBeUndefined();
    expect(updated.log.some((entry) => entry.action === `Auto-unblocked: blocker ${blocker.id} was soft-deleted`)).toBe(false);
  });

  it("leaves unrelated tasks untouched", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const unrelated = await store.createTask({ column: "todo", description: "unrelated", dependencies: [] });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const after = await store.getTask(unrelated.id);

    expect(after.blockedBy).toBeUndefined();
    expect(after.dependencies).toEqual([]);
    expect(after.log.some((entry) => entry.action.includes("Auto-unblocked"))).toBe(false);
  });

  it("never rewrites already soft-deleted dependents", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const dependent = await store.createTask({ column: "todo", description: "dependent", dependencies: [blocker.id] });
    await store.updateTask(dependent.id, { blockedBy: blocker.id, status: "queued" });

    await store.deleteTask(dependent.id);
    const deletedDependentBefore = await store.getTask(dependent.id, { includeDeleted: true });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const deletedDependentAfter = await store.getTask(dependent.id, { includeDeleted: true });

    expect(deletedDependentAfter.updatedAt).toBe(deletedDependentBefore.updatedAt);
    expect(deletedDependentAfter.blockedBy).toBe(blocker.id);
  });

  it("is idempotent and does not emit extra dependent updates on re-delete", async () => {
    const store = harness.store();
    const blocker = await store.createTask({ column: "todo", description: "blocker" });
    const dependent = await store.createTask({ column: "todo", description: "dependent", dependencies: [blocker.id] });
    await store.updateTask(dependent.id, { blockedBy: blocker.id, status: "queued" });

    const updatedEvents: string[] = [];
    store.on("task:updated", (task) => {
      if (task.id === dependent.id) updatedEvents.push(task.id);
    });

    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const afterFirst = await store.getTask(dependent.id);
    await store.deleteTask(blocker.id, { removeDependencyReferences: true });
    const afterSecond = await store.getTask(dependent.id);

    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
  });
});
