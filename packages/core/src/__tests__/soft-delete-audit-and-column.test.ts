import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("soft-delete audit + archived column (FN-5175)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("writes exactly one task:deleted run-audit row with explicit auditContext", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "in-review", description: "audit me" });

    await store.deleteTask(task.id, {
      auditContext: {
        agentId: "agent-explicit",
        runId: "run-explicit",
        sessionId: "session-explicit",
      },
    });

    const events = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:deleted" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      domain: "database",
      mutationType: "task:deleted",
      target: task.id,
      taskId: task.id,
      agentId: "agent-explicit",
      runId: "run-explicit",
      metadata: {
        previousColumn: "in-review",
        previousStatus: null,
        githubIssueAction: "auto",
        removeDependencyReferences: false,
        removeLineageReferences: false,
        sessionId: "session-explicit",
      },
    });
  });

  it("falls back to a synthetic delete runId and remains idempotent on re-delete", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", description: "synthetic delete" });

    await store.deleteTask(task.id);
    await store.deleteTask(task.id);

    const events = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:deleted" });
    expect(events).toHaveLength(1);
    expect(events[0]?.agentId).toBe("system");
    expect(events[0]?.runId).toMatch(/^synthetic-task-delete-/);
  });

  it("marks the tasks row archived without moving it into archivedTasks", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "in-progress", description: "archive the soft-deleted row" });

    await store.deleteTask(task.id);

    const row = (store as any).db.prepare('SELECT "column", deletedAt FROM tasks WHERE id = ?').get(task.id) as {
      column: string;
      deletedAt: string | null;
    };

    expect(row.column).toBe("archived");
    expect(typeof row.deletedAt).toBe("string");
    expect((store as any).archiveDb.get(task.id)).toBeUndefined();
  });

  it("keeps soft-deleted rows out of listTasks even when includeArchived is true", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "done", description: "hidden from listTasks" });

    await store.deleteTask(task.id);

    expect((await store.listTasks({ includeArchived: false })).map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ includeArchived: true })).map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ column: "archived", includeArchived: true })).map((entry) => entry.id)).not.toContain(task.id);
  });

  it("records githubIssueAction and option flags in audit metadata", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "triage", description: "metadata flags" });

    await store.deleteTask(task.id, {
      githubIssueAction: "delete",
      removeDependencyReferences: true,
      removeLineageReferences: true,
    });

    const [event] = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:deleted" });
    expect(event?.metadata).toMatchObject({
      previousColumn: "triage",
      githubIssueAction: "delete",
      removeDependencyReferences: true,
      removeLineageReferences: true,
    });
  });
});
