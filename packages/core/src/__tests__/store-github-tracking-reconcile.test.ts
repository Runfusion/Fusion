import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-github-reconcile-test-"));
}

describe("TaskStore.listTasksForGithubTrackingReconcile", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("returns soft-deleted and archived tasks with github tracking", async () => {
    const softDeleted = await store.createTask({ description: "soft deleted" });
    await store.updateGithubTracking(softDeleted.id, { enabled: true });
    await store.deleteTask(softDeleted.id);

    const archivedDone = await store.createTask({ description: "archived done" });
    await store.updateGithubTracking(archivedDone.id, { enabled: true });
    await store.moveTask(archivedDone.id, "todo");
    await store.moveTask(archivedDone.id, "in-progress");
    await store.moveTask(archivedDone.id, "in-review");
    await store.moveTask(archivedDone.id, "done");
    await store.archiveTask(archivedDone.id);

    const archivedTodo = await store.createTask({ description: "archived todo" });
    await store.updateGithubTracking(archivedTodo.id, { enabled: true });
    await store.moveTask(archivedTodo.id, "todo");
    await store.moveTask(archivedTodo.id, "in-progress");
    await store.moveTask(archivedTodo.id, "in-review");
    await store.moveTask(archivedTodo.id, "done");
    await store.archiveTask(archivedTodo.id);

    const archivedTodoEntry = (store as unknown as {
      archiveDb: { get: (id: string) => { executionCompletedAt?: string } | undefined; upsert: (entry: Record<string, unknown>) => void };
    }).archiveDb.get(archivedTodo.id);
    if (archivedTodoEntry) {
      (store as unknown as {
        archiveDb: { upsert: (entry: Record<string, unknown>) => void };
      }).archiveDb.upsert({ ...archivedTodoEntry, executionCompletedAt: undefined });
    }

    const activeTracked = await store.createTask({ description: "active tracked" });
    await store.updateGithubTracking(activeTracked.id, { enabled: true });

    const softDeletedWithoutTracking = await store.createTask({ description: "soft deleted no tracking" });
    await store.deleteTask(softDeletedWithoutTracking.id);

    const tasks = await store.listTasksForGithubTrackingReconcile();
    const byId = new Map(tasks.map((task) => [task.id, task]));

    expect(byId.has(softDeleted.id)).toBe(true);
    expect(byId.has(archivedDone.id)).toBe(true);
    expect(byId.has(archivedTodo.id)).toBe(true);

    expect(byId.get(archivedDone.id)?.executionCompletedAt).toBeTruthy();
    expect(byId.get(archivedTodo.id)?.executionCompletedAt).toBeFalsy();

    expect(byId.has(activeTracked.id)).toBe(false);
    expect(byId.has(softDeletedWithoutTracking.id)).toBe(false);
  });

  it("returns empty results when nothing matches", async () => {
    const task = await store.createTask({ description: "no tracking" });
    await store.moveTask(task.id, "todo");

    const tasks = await store.listTasksForGithubTrackingReconcile();
    expect(tasks).toEqual([]);
  });
});
