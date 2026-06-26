/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of task-node-override.test.ts.
 *
 * Exercises nodeId persistence through create/update/read/list backend-mode
 * paths. The disk-reload test from the original file is omitted because PG
 * persistence lives in the database (a PG "reload" is just re-reading the
 * same DB, which the shared harness already validates via beforeEach resets).
 *
 * The original SQLite test remains until SQLite is fully removed; this PG twin
 * is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("task node override persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_node_override",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("creates a task with nodeId when provided", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task with node", nodeId: "node-abc" });
    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-abc");
  });

  it("leaves nodeId undefined when not provided", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task without node" });
    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("updates nodeId on an existing task", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task to update node" });
    await store.updateTask(created.id, { nodeId: "node-xyz" });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-xyz");
  });

  it("clears nodeId when updateTask sets null", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task to clear node", nodeId: "node-abc" });
    await store.updateTask(created.id, { nodeId: null });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("treats updateTask nodeId undefined as a no-op", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task to keep node", nodeId: "node-stable" });
    await store.updateTask(created.id, { nodeId: undefined });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBe("node-stable");
  });

  it("normalizes createTask nodeId null to undefined", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task with null node", nodeId: null });

    const fetched = await store.getTask(created.id);
    expect(fetched.nodeId).toBeUndefined();
  });

  it("updates nodeId without mutating other task fields", async () => {
    const store = h.store();
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
    const store = h.store();
    const first = await store.createTask({ description: "Node one", nodeId: "node-one" });
    const second = await store.createTask({ description: "Node two", nodeId: "node-two" });
    const third = await store.createTask({ description: "No node" });

    const tasks = await store.listTasks();

    expect(tasks.find((task) => task.id === first.id)?.nodeId).toBe("node-one");
    expect(tasks.find((task) => task.id === second.id)?.nodeId).toBe("node-two");
    expect(tasks.find((task) => task.id === third.id)?.nodeId).toBeUndefined();
  });

  it("persists different nodeId values independently across multiple tasks", async () => {
    const store = h.store();
    const first = await store.createTask({ description: "Node alpha", nodeId: "node-alpha" });
    const second = await store.createTask({ description: "Node beta", nodeId: "node-beta" });
    const third = await store.createTask({ description: "No override" });

    expect((await store.getTask(first.id)).nodeId).toBe("node-alpha");
    expect((await store.getTask(second.id)).nodeId).toBe("node-beta");
    expect((await store.getTask(third.id)).nodeId).toBeUndefined();
  });
});
