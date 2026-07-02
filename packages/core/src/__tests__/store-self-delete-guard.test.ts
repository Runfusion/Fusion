import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskSelfDeleteError } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore.deleteTask self-delete guard (FN-7411)", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("rejects when the audit context task is the deletion target before mutation or audit", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "self", description: "do not delete self", column: "in-progress" });

    await expect(
      store.deleteTask(task.id, {
        auditContext: {
          agentId: "agent-test",
          runId: "run-test",
          taskId: task.id,
        },
      }),
    ).rejects.toMatchObject({
      name: "TaskSelfDeleteError",
      code: "TASK_SELF_DELETE",
      taskId: task.id,
      message: `Task ${task.id} cannot delete itself`,
    } satisfies Partial<TaskSelfDeleteError>);

    const row = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as { deletedAt?: string };
    expect(row.deletedAt).toBeUndefined();
    expect(store.getRunAuditEvents({ taskId: task.id, mutationType: "task:deleted" })).toHaveLength(0);
  });

  it("allows a task-bound caller to delete a different task", async () => {
    const store = harness.store();
    const caller = await store.createTask({ title: "caller", description: "current task", column: "in-progress" });
    const target = await store.createTask({ title: "target", description: "cleanup target", column: "todo" });

    await expect(
      store.deleteTask(target.id, {
        auditContext: {
          agentId: "agent-test",
          runId: "run-test",
          taskId: caller.id,
        },
      }),
    ).resolves.toMatchObject({ id: target.id });

    const deleted = (store as any).readTaskFromDb(target.id, { includeDeleted: true }) as { deletedAt?: string };
    expect(deleted.deletedAt).toBeTruthy();
    expect(store.getRunAuditEvents({ taskId: target.id, mutationType: "task:deleted" })).toHaveLength(1);
  });
});
