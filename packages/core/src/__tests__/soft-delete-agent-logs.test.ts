import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore soft-delete agent log clearing (FN-5143)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("deletes pre-existing persisted agent logs on soft-delete", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "entry-1", "text");
    await store.appendAgentLog(task.id, "entry-2", "text");
    await store.appendAgentLog(task.id, "entry-3", "text");
    await store.getAgentLogs(task.id);

    const before = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(task.id) as { count: number };
    expect(before.count).toBe(3);

    await store.deleteTask(task.id);

    const after = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(task.id) as { count: number };
    expect(after.count).toBe(0);
    await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
    await expect(store.getAgentLogCount(task.id)).resolves.toBe(0);
  });

  it("discards buffered unflushed entries when task is soft-deleted", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "buffered-only", "text");
    await store.deleteTask(task.id);

    const rows = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(task.id) as { count: number };
    expect(rows.count).toBe(0);
    await expect(store.getAgentLogs(task.id)).resolves.toEqual([]);
  });

  it("keeps idempotent re-delete as a no-op for agent logs", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();

    await store.appendAgentLog(task.id, "first", "text");
    await store.getAgentLogs(task.id);
    await store.deleteTask(task.id);

    const firstDeleteCount = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(task.id) as { count: number };
    expect(firstDeleteCount.count).toBe(0);

    const rowBefore = (store as any).db
      .prepare('SELECT deletedAt, updatedAt, "column" FROM tasks WHERE id = ?')
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null; column: string | null };

    await expect(store.deleteTask(task.id)).resolves.toMatchObject({ id: task.id });

    const rowAfter = (store as any).db
      .prepare('SELECT deletedAt, updatedAt, "column" FROM tasks WHERE id = ?')
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null; column: string | null };
    expect(rowAfter.deletedAt).toBe(rowBefore.deletedAt);
    expect(rowAfter.updatedAt).toBe(rowBefore.updatedAt);
    expect(rowAfter.column).toBe("archived");

    const secondDeleteCount = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(task.id) as { count: number };
    expect(secondDeleteCount.count).toBe(0);
  });

  it("clears only the soft-deleted parent logs when removing lineage references", async () => {
    const store = harness.store();
    const parent = await store.createTask({ description: "parent" });
    const child = await store.createTask({ description: "child", sourceTaskId: parent.id, sourceParentTaskId: parent.id });

    await store.appendAgentLog(parent.id, "parent-log", "text");
    await store.appendAgentLog(child.id, "child-log", "text");
    await store.getAgentLogs(parent.id);
    await store.getAgentLogs(child.id);

    const childBefore = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(child.id) as { count: number };
    expect(childBefore.count).toBe(1);

    await store.deleteTask(parent.id, { removeLineageReferences: true });

    const parentAfter = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(parent.id) as { count: number };
    const childAfter = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(child.id) as { count: number };
    expect(parentAfter.count).toBe(0);
    expect(childAfter.count).toBe(1);
  });

  it("does not affect other tasks' agent logs", async () => {
    const store = harness.store();
    const first = await harness.createTestTask();
    const second = await harness.createTestTask();

    await store.appendAgentLog(first.id, "first-log", "text");
    await store.appendAgentLog(second.id, "second-log", "text");
    await store.getAgentLogs(first.id);
    await store.getAgentLogs(second.id);

    await store.deleteTask(first.id);

    const firstAfter = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(first.id) as { count: number };
    const secondAfter = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?")
      .get(second.id) as { count: number };
    expect(firstAfter.count).toBe(0);
    expect(secondAfter.count).toBe(1);
  });

  it("emits task:deleted only after agent logs are cleared", async () => {
    const store = harness.store();
    const task = await harness.createTestTask();
    await store.appendAgentLog(task.id, "event-order", "text");
    await store.getAgentLogs(task.id);

    const seenCounts: number[] = [];
    store.once("task:deleted", async (deletedTask) => {
      seenCounts.push(await store.getAgentLogCount(deletedTask.id));
    });

    await store.deleteTask(task.id);
    expect(seenCounts).toEqual([0]);
  });
});
