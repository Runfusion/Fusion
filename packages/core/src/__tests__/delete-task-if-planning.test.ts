import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { TaskHasLineageChildrenError, TaskSelfDeleteError } from "../task-store/errors.js";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskDeletion 2026-07-29-18:35:
FN-8361 verifies conditional deletion through the real supported TaskStore
storage path. SQLite runtime support was removed (VAL-REMOVAL-005), so this
uses the PostgreSQL harness instead of a hand-built delete-helper mock.
*/
pgDescribe("deleteTaskIf live storage path", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_delete_task_if" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("soft-deletes only after its live predicate passes", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "conditional delete" });
    const result = await store.deleteTaskIf(task.id, (live) => live.column === "triage");

    expect(result.deleted).toBe(true);
    expect(result.task).toMatchObject({ column: "archived" });
    expect(result.task.deletedAt).toBeTruthy();
  });

  it("leaves false predicates and advanced stale candidates untouched", async () => {
    const store = harness.store();
    const falseTask = await store.createTask({ description: "false conditional delete" });
    expect((await store.deleteTaskIf(falseTask.id, () => false)).deleted).toBe(false);
    expect((await store.getTask(falseTask.id))?.deletedAt).toBeFalsy();

    const staleTask = await store.createTask({ description: "advanced conditional delete" });
    await store.getTask(staleTask.id); // Caller captured a stale triage candidate.
    await store.moveTask(staleTask.id, "todo");
    const stale = await store.deleteTaskIf(staleTask.id, (live) => live.column === "triage");
    expect(stale).toMatchObject({ deleted: false, task: { column: "todo" } });
    expect(await store.getTask(staleTask.id)).toMatchObject({ column: "todo", deletedAt: undefined });
  });

  it("preserves self-delete and lineage lifecycle guards", async () => {
    const store = harness.store();
    const self = await store.createTask({ description: "self delete guard" });
    await expect(store.deleteTaskIf(self.id, () => true, {
      auditContext: { taskId: self.id, agentId: "agent", runId: "run" },
    })).rejects.toBeInstanceOf(TaskSelfDeleteError);

    const lineageParent = await store.createTask({ description: "lineage parent" });
    await store.createTask({
      description: "lineage child",
      source: { sourceType: "task_duplicate", sourceParentTaskId: lineageParent.id },
    });
    await expect(store.deleteTaskIf(lineageParent.id, () => true)).rejects.toBeInstanceOf(TaskHasLineageChildrenError);
  });
});
