import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rm } from "node:fs/promises";

import { TaskStore } from "../store.js";
import { makeTmpDir } from "./store-test-helpers.js";
import type { Task } from "../types.js";

const liveColumns = new Set(["triage", "todo", "in-progress", "in-review", "done"]);

function cachedTask(store: TaskStore, taskId: string): Task | undefined {
  return (store as unknown as { taskCache: Map<string, Task> }).taskCache.get(taskId);
}

async function expectSingleLiveBoardEntry(store: TaskStore, taskId: string, expectedColumn: string) {
  const listed = await store.listTasks({ includeArchived: true, slim: true });
  const entries = listed.filter((task) => task.id === taskId && liveColumns.has(task.column));
  expect(entries.map((task) => task.column)).toEqual([expectedColumn]);
}

describe("TaskStore stale board entries after task moves", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir);
    await store.init();
    await store.watch();
  });

  afterEach(async () => {
    store.stopWatching();
    await store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("syncs taskCache after dependency-driven todo to triage re-specification moves", async () => {
    const dependency = await store.createTask({ description: "unresolved dependency", column: "todo" });
    const dependent = await store.createTask({
      title: "Shadcn-family themes: left sidebar must use the theme accent color",
      description: "dependent task",
      column: "todo",
    });
    (store as unknown as { taskCache: Map<string, Task> }).taskCache.set(dependent.id, { ...dependent });

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: dependency.id,
    });
    const persisted = await store.getTask(dependent.id);
    const cached = cachedTask(store, dependent.id);

    expect(updated.column).toBe("triage");
    expect(cached?.column).toBe("triage");
    expect(cached?.title).toBe(persisted.title);
    expect(cached?.title).toBe(updated.title);
    expect(persisted.column).toBe(cached?.column);
    await expectSingleLiveBoardEntry(store, dependent.id, "triage");
  });

  it("keeps one live board entry across dependency edits and triage/todo moves", async () => {
    const originalDependency = await store.createTask({ description: "original unresolved dependency", column: "todo" });
    const replacementDependency = await store.createTask({ description: "replacement unresolved dependency", column: "todo" });
    const doneDependency = await store.createTask({ description: "done dependency", column: "done" });
    const dependent = await store.createTask({ description: "dependent task", column: "todo" });
    (store as unknown as { taskCache: Map<string, Task> }).taskCache.set(dependent.id, { ...dependent });

    await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: originalDependency.id });
    expect(cachedTask(store, dependent.id)?.column).toBe("triage");
    await expectSingleLiveBoardEntry(store, dependent.id, "triage");

    await store.updateTaskDependencies(dependent.id, { operation: "remove", dependency: originalDependency.id });
    expect(cachedTask(store, dependent.id)?.dependencies).toEqual([]);
    await expectSingleLiveBoardEntry(store, dependent.id, "triage");

    await store.moveTask(dependent.id, "todo");
    expect(cachedTask(store, dependent.id)?.column).toBe("todo");
    await expectSingleLiveBoardEntry(store, dependent.id, "todo");

    await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: originalDependency.id });
    await store.updateTaskDependencies(dependent.id, {
      operation: "replace",
      from: originalDependency.id,
      to: replacementDependency.id,
    });
    expect(cachedTask(store, dependent.id)?.dependencies).toEqual([replacementDependency.id]);
    await expectSingleLiveBoardEntry(store, dependent.id, "triage");

    await store.updateTaskDependencies(dependent.id, { operation: "set", dependencies: [doneDependency.id] });
    expect(cachedTask(store, dependent.id)?.dependencies).toEqual([doneDependency.id]);
    await expectSingleLiveBoardEntry(store, dependent.id, "triage");

    await store.moveTask(dependent.id, "todo");
    expect(cachedTask(store, dependent.id)?.column).toBe("todo");
    await expectSingleLiveBoardEntry(store, dependent.id, "todo");
  });

  it("dedupes listTasks with active rows authoritative over archive snapshots", async () => {
    const task = await store.createTask({ title: "archived snapshot title", description: "duplicate source", column: "done" });
    await store.archiveTask(task.id, true);
    const entry = (store as any).archiveDb.get(task.id);
    expect(entry).toBeDefined();

    const restored = await (store as any).restoreFromArchive(entry);
    const active: Task = {
      ...restored,
      title: "active row title",
      column: "todo",
      updatedAt: new Date().toISOString(),
      columnMovedAt: new Date().toISOString(),
    };
    await (store as any).atomicWriteTaskJson((store as any).taskDir(task.id), active);

    const entries = (await store.listTasks({ includeArchived: true, slim: true })).filter((listed) => listed.id === task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ column: "todo", title: "active row title" });
  });

  it("preserves archived, soft-deleted, done, and orphan-reconcile list semantics", async () => {
    const archivedSource = await store.createTask({ description: "archive-only task", column: "done" });
    await store.archiveTask(archivedSource.id, true);
    const archivedEntries = (await store.listTasks({ includeArchived: true, slim: true })).filter((task) => task.id === archivedSource.id);
    expect(archivedEntries).toHaveLength(1);
    expect(archivedEntries[0].column).toBe("archived");

    const deleted = await store.createTask({ description: "soft deleted task", column: "todo" });
    await store.deleteTask(deleted.id);
    expect((await store.listTasks({ includeArchived: true, slim: true })).some((task) => task.id === deleted.id)).toBe(false);

    const done = await store.createTask({ description: "done task", column: "done" });
    await expectSingleLiveBoardEntry(store, done.id, "done");

    const orphan = await store.createTask({ description: "orphan task", column: "todo" });
    (store as any).db.prepare("DELETE FROM tasks WHERE id = ?").run(orphan.id);
    (store as any).taskCache.delete(orphan.id);
    const result = await store.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: true });
    expect(result.recovered).toContain(orphan.id);
    await expectSingleLiveBoardEntry(store, orphan.id, "todo");
  });
});
