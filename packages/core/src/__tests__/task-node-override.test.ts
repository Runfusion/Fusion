import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-task-node-override-"));
}

describe("task node override persistence", () => {
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
    store.stopWatching();
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("creates a task with nodeId when provided", async () => {
    const created = await store.createTask({ description: "Task with node", nodeId: "node-abc" });
    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-abc");
  });

  it("leaves nodeId undefined when not provided", async () => {
    const created = await store.createTask({ description: "Task without node" });
    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("updates nodeId on an existing task", async () => {
    const created = await store.createTask({ description: "Task to update node" });
    await store.updateTask(created.id, { nodeId: "node-xyz" });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-xyz");
  });

  it("clears nodeId when updateTask sets null", async () => {
    const created = await store.createTask({ description: "Task to clear node", nodeId: "node-abc" });
    await store.updateTask(created.id, { nodeId: null });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("treats updateTask nodeId undefined as a no-op", async () => {
    const created = await store.createTask({ description: "Task to keep node", nodeId: "node-stable" });
    await store.updateTask(created.id, { nodeId: undefined });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-stable");
  });

  it("normalizes createTask nodeId null to undefined", async () => {
    const created = await store.createTask({ description: "Task with null node", nodeId: null });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("persists nodeId across store reload", async () => {
    const diskRoot = makeTmpDir();
    const diskGlobal = makeTmpDir();

    const firstStore = new TaskStore(diskRoot, diskGlobal);
    await firstStore.init();
    const created = await firstStore.createTask({ description: "Disk-backed node task", nodeId: "node-persist" });
    firstStore.close();

    const reloadedStore = new TaskStore(diskRoot, diskGlobal);
    await reloadedStore.init();
    const fetched = await reloadedStore.getTask(created.id);
    expect(fetched.nodeId).toBe("node-persist");
    reloadedStore.close();

    await rm(diskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(diskGlobal, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("updates nodeId without mutating other task fields", async () => {
    const created = await store.createTask({
      description: "Task with multiple fields",
      nodeId: "node-a",
      priority: "high",
      modelProvider: "anthropic",
    });

    await store.updateTask(created.id, { nodeId: "node-b" });
    const fetched = await store.getTask(created.id);

    expect(fetched.nodeId).toBe("node-b");
    expect(fetched.priority).toBe("high");
    expect(fetched.modelProvider).toBe("anthropic");
  });

  it("returns nodeId values via listTasks", async () => {
    const first = await store.createTask({ description: "Node one", nodeId: "node-one" });
    const second = await store.createTask({ description: "Node two", nodeId: "node-two" });
    const third = await store.createTask({ description: "No node" });

    const tasks = await store.listTasks();

    expect(tasks.find((task) => task.id === first.id)?.nodeId).toBe("node-one");
    expect(tasks.find((task) => task.id === second.id)?.nodeId).toBe("node-two");
    expect(tasks.find((task) => task.id === third.id)?.nodeId).toBeUndefined();
  });

  it("persists different nodeId values independently across multiple tasks", async () => {
    const first = await store.createTask({ description: "Node alpha", nodeId: "node-alpha" });
    const second = await store.createTask({ description: "Node beta", nodeId: "node-beta" });
    const third = await store.createTask({ description: "No override" });

    expect((await store.getTask(first.id)).nodeId).toBe("node-alpha");
    expect((await store.getTask(second.id)).nodeId).toBe("node-beta");
    expect((await store.getTask(third.id)).nodeId).toBeUndefined();
  });
});
