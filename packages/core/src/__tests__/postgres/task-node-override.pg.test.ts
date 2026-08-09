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

  /*
  FNXC:NodeRouting 2026-08-09-05:08:
  Durable #3365 coverage proves the JSON/SQL round trip cannot retain a dispatch snapshot after a
  non-checked-out override change. The negative cases preserve lease-bound and explicit replacement
  routes; source-only replacement clears the old id rather than storing a half-stale snapshot.
  */
  describe("effective route invalidation", () => {
    async function createWithSnapshot() {
      const store = h.store();
      const task = await store.createTask({description: "effective route repro", nodeId: "node-old"});
      await store.updateTask(task.id, {
        effectiveNodeId: "node-old",
        effectiveNodeSource: "task-override",
      });
      return {store, task};
    }

    it("clears the persisted snapshot after changing a non-checked-out override", async () => {
      const {store, task} = await createWithSnapshot();
      await store.updateTask(task.id, {nodeId: "node-new"});

      const fetched = await store.getTask(task.id);
      expect(fetched.nodeId).toBe("node-new");
      expect(fetched.effectiveNodeId).toBeUndefined();
      expect(fetched.effectiveNodeSource).toBeUndefined();
    });

    it("preserves a snapshot for a task checked out when read", async () => {
      const {store, task} = await createWithSnapshot();
      await store.updateTask(task.id, {checkedOutBy: "agent-x"});
      await store.updateTask(task.id, {nodeId: "node-new"});

      const fetched = await store.getTask(task.id);
      expect(fetched.effectiveNodeId).toBe("node-old");
      expect(fetched.effectiveNodeSource).toBe("task-override");
    });

    it("preserves a route during combined reassignment after checkout is cleared mid-pass", async () => {
      const {store, task} = await createWithSnapshot();
      await store.updateTask(task.id, {assignedAgentId: "agent-x", checkedOutBy: "agent-x"});
      await store.updateTask(task.id, {assignedAgentId: "agent-y", nodeId: "node-new"});

      const fetched = await store.getTask(task.id);
      expect(fetched.checkedOutBy).toBeUndefined();
      expect(fetched.effectiveNodeId).toBe("node-old");
      expect(fetched.effectiveNodeSource).toBe("task-override");
    });

    it("honors a complete replacement and clears only the stale id for source-only replacement", async () => {
      const complete = await createWithSnapshot();
      await complete.store.updateTask(complete.task.id, {
        nodeId: "node-new", effectiveNodeId: "node-new", effectiveNodeSource: "task-override",
      });
      expect((await complete.store.getTask(complete.task.id)).effectiveNodeId).toBe("node-new");

      const sourceOnly = await createWithSnapshot();
      await sourceOnly.store.updateTask(sourceOnly.task.id, {nodeId: "node-new", effectiveNodeSource: "local"});
      const fetched = await sourceOnly.store.getTask(sourceOnly.task.id);
      expect(fetched.effectiveNodeId).toBeUndefined();
      expect(fetched.effectiveNodeSource).toBe("local");
    });
  });

  // FNXC:StateMachine 2026-07-07-12:00: Signature 2 (FN-7641) end-to-end regression through the
  // real store.updateTask surface (not just the pure guard) — nodeId='end' must finalize-on-proof
  // or error, never silently no-op, for both non-workflow and custom-workflow tasks.
  describe("nodeId='end' finalize-on-proof-or-error (FN-7641 Signature 2)", () => {
    it("REPRO: advances an in-review task with all steps done + merge proof to done instead of no-op", async () => {
      const store = h.store();
      const created = await store.createTask({ description: "NEXT-322 out-of-band merge repro" });
      await store.updateTask(created.id, { steps: [{ name: "Only step", status: "done" }] });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      await store.updateTask(created.id, { mergeDetails: { mergeConfirmed: true } });

      const updated = await store.updateTask(created.id, { nodeId: "end" });

      expect(updated.column).toBe("done");
      expect(updated.nodeId).toBe("end");
    });

    it("REPRO: rejects nodeId='end' with an explicit error when there is no merge proof (never a silent no-op)", async () => {
      const store = h.store();
      const created = await store.createTask({ description: "NEXT-340 no proof repro" });
      await store.updateTask(created.id, { steps: [{ name: "Only step", status: "done" }] });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");

      await expect(store.updateTask(created.id, { nodeId: "end" })).rejects.toThrow(
        "does not finalize a card by itself",
      );

      const unchanged = await store.getTask(created.id);
      expect(unchanged.column).toBe("in-review");
      expect(unchanged.nodeId).toBeUndefined();
    });

    it("advances a custom-workflow task (builtin:coding) with merge proof identically", async () => {
      const store = h.store();
      const created = await store.createTask({
        description: "custom workflow finalize repro",
        workflowId: "builtin:coding",
      });
      await store.updateTask(created.id, { steps: [{ name: "Only step", status: "done" }] });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      await store.updateTask(created.id, { mergeDetails: { mergeConfirmed: true } });

      const updated = await store.updateTask(created.id, { nodeId: "end" });

      expect(updated.column).toBe("done");
    });

    it("is a true no-op (no throw, stays done) when the task is already done", async () => {
      const store = h.store();
      const created = await store.createTask({ description: "already done repro" });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      await store.moveTask(created.id, "done");

      const updated = await store.updateTask(created.id, { nodeId: "end" });

      expect(updated.column).toBe("done");
      expect(updated.nodeId).toBe("end");
    });

    it("leaves the existing in-progress guard unchanged for a terminal nodeId with merge proof", async () => {
      const store = h.store();
      const created = await store.createTask({ description: "in-progress guard unaffected" });
      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.updateTask(created.id, { mergeDetails: { mergeConfirmed: true } });

      await expect(store.updateTask(created.id, { nodeId: "end" })).rejects.toThrow("in progress");
    });
  });
});
