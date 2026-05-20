import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore soft delete of checked-out tasks", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("clears agents.taskId when deleting a checked-out task", async () => {
    harness.store().close();
    const store = new TaskStore(harness.rootDir(), harness.globalDir());
    await store.init();
    const agentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store });
    await agentStore.init();

    try {
      const task = await store.createTask({ description: "checked-out delete target" });
      const agent = await agentStore.createAgent({ name: "Lease Holder", role: "executor" });

      await store.updateTask(task.id, { assignedAgentId: agent.id });
      expect((await agentStore.getAgent(agent.id))?.taskId).toBe(task.id);

      await agentStore.checkoutTask(agent.id, task.id);
      expect((await store.getTask(task.id)).checkedOutBy).toBe(agent.id);

      const deletedEvents: string[] = [];
      store.on("task:deleted", (event) => deletedEvents.push(event.id));

      await store.deleteTask(task.id);

      expect((await agentStore.getAgent(agent.id))?.taskId).toBeUndefined();

      const row = (store as any).db.prepare(
        "SELECT taskId, json_extract(data, '$.taskId') AS jsonTaskId FROM agents WHERE id = ?",
      ).get(agent.id) as { taskId: string | null; jsonTaskId: string | null };
      expect(row.taskId).toBeNull();
      expect(row.jsonTaskId).toBeNull();
      expect(deletedEvents).toEqual([task.id]);
    } finally {
      agentStore.close();
      store.close();
    }
  });

  it("keeps checked-out soft-deleted rows invisible to live readers", async () => {
    harness.store().close();
    const store = new TaskStore(harness.rootDir(), harness.globalDir());
    await store.init();
    const agentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store });
    await agentStore.init();

    try {
      const task = await store.createTask({ description: "checked-out invisible row" });
      const agent = await agentStore.createAgent({ name: "Deleted Lease Holder", role: "executor" });

      await store.updateTask(task.id, { assignedAgentId: agent.id });
      await agentStore.checkoutTask(agent.id, task.id);

      await store.deleteTask(task.id);

      await expect(store.getTask(task.id)).rejects.toThrow(`Task ${task.id} not found`);
      expect((await store.listTasks()).map((entry) => entry.id)).not.toContain(task.id);

      const row = (store as any).db.prepare(
        "SELECT checkedOutBy, deletedAt FROM tasks WHERE id = ?",
      ).get(task.id) as { checkedOutBy: string | null; deletedAt: string | null };
      expect(row.checkedOutBy).toBe(agent.id);
      expect(typeof row.deletedAt).toBe("string");
    } finally {
      agentStore.close();
      store.close();
    }
  });
});
