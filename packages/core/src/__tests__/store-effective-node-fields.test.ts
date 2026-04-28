import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-effective-node-fields-"));
}

describe("effective node routing fields persistence", () => {
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

  it("persists effective node fields through create/update/read and clear cycle", async () => {
    const created = await store.createTask({ description: "task for effective node fields" });

    await store.updateTask(created.id, {
      effectiveNodeId: "node-abc",
      effectiveNodeSource: "project-default",
    });

    const withRouting = await store.getTask(created.id);
    expect(withRouting.effectiveNodeId).toBe("node-abc");
    expect(withRouting.effectiveNodeSource).toBe("project-default");

    await store.updateTask(created.id, {
      effectiveNodeId: null,
      effectiveNodeSource: null,
    });

    const cleared = await store.getTask(created.id);
    expect(cleared.effectiveNodeId).toBeUndefined();
    expect(cleared.effectiveNodeSource).toBeUndefined();
  });

  it("persists defaultNodeId in project settings through save/load", async () => {
    await store.updateSettings({ defaultNodeId: "node-default-1" });
    const settings = await store.getSettings();
    expect(settings.defaultNodeId).toBe("node-default-1");
  });

  it("defaults defaultNodeId to undefined in fresh project settings", async () => {
    const settings = await store.getSettings();
    expect(settings.defaultNodeId).toBeUndefined();
  });
});
