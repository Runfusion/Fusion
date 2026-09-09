import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

/*
FNXC:TaskLifecycleTools 2026-07-07-00:00:
Regression coverage for FN-7661: fn_task_delete exposes removeLineageReferences, so a task still
referenced as a lineage parent by another task is not permanently stuck even though the store's TaskHasLineageChildrenError message told callers to
pass that flag. These tests reproduce the original stuck-task symptom and assert it is gone via
the actual agent-facing tools.

FNXC:PostgresCutover 2026-07-08-00:00:
Ported from upstream's sqlite version: runs on the shared PG extension harness (the sqlite
TaskStore path is removed on this branch), seeds lineage via createTask's `source` provenance
input instead of raw sqlite UPDATEs, and reads forensic state via getTask({includeDeleted}).

FNXC:CliTests 2026-07-16-08:50:
FN-8102 keeps all delete lineage-parent rejection cases strict after tools switched from thrown
errors to structured MCP results: each case must assert both `isError` and the message.
*/
import type { TaskStore } from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-lineage-unlink");

pgDescribe("fn_task_delete removeLineageReferences plumbing", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function ctx() {
    return { cwd: h.rootDir() };
  }

  async function createParentAndChild(store: TaskStore, parentColumn: "todo" | "done" = "todo") {
    const parent = await store.createTask({ column: parentColumn, title: "parent", description: "parent" });
    const child = await store.createTask({
      column: "todo",
      title: "child",
      description: "child",
      source: { sourceType: "task_refine", sourceParentTaskId: parent.id },
    });
    return { parent, child: await store.getTask(child.id) };
  }

  it("fn_task_delete rejects a lineage parent when removeLineageReferences is omitted", async () => {
    const store = h.store();
    const { parent } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");

    const result = await tool.execute("call-5", { id: parent.id }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/still referenced as a lineage parent/);

    const row = await store.getTask(parent.id, { includeDeleted: true });
    expect(row.deletedAt).toBeUndefined();
  });

  it("fn_task_delete rejects a lineage parent when removeLineageReferences is explicitly false", async () => {
    const store = h.store();
    const { parent } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");

    const result = await tool.execute(
      "call-6",
      { id: parent.id, removeLineageReferences: false },
      undefined,
      undefined,
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/still referenced as a lineage parent/);
  });

  it("fn_task_delete with removeLineageReferences:true soft-deletes the parent and clears the child reference", async () => {
    const store = h.store();
    const { parent, child } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    const result = await tool.execute(
      "call-7",
      { id: parent.id, removeLineageReferences: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.content[0]?.text).toBe(`Deleted ${parent.id}`);
    const deleted = await store.getTask(parent.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();

    const updatedChild = await store.getTask(child.id);
    expect(updatedChild.sourceParentTaskId).toBeUndefined();
  });

  /*
  FNXC:DependencyIntegrity 2026-08-20-19:00:
  FN-075 covers the registered operator tool rather than reproducing the store test: an ordinary
  delete must preserve a dependent-bearing task unchanged, while the explicit retry delegates the
  atomic edge removal and replan fence to TaskStore.deleteTask.
  */
  it("fn_task_delete requires an explicit dependency cleanup retry and replans affected dependents", async () => {
    const store = h.store();
    const prerequisite = await store.createTask({ column: "todo", title: "prerequisite", description: "delete me" });
    const unrelated = await store.createTask({ column: "todo", title: "unrelated", description: "keep me" });
    const firstDependent = await store.createTask({
      column: "todo",
      title: "first dependent",
      description: "depends on two tasks",
      dependencies: [prerequisite.id, unrelated.id],
    });
    const secondDependent = await store.createTask({
      column: "todo",
      title: "second dependent",
      description: "depends only on the deleted task",
      dependencies: [prerequisite.id],
    });
    await store.updateTask(firstDependent.id, { status: "queued", blockedBy: prerequisite.id });
    const continuation = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${firstDependent.id}:continuation:0`,
      taskId: firstDependent.id,
      nodeId: "plan-review",
      kind: "task",
      state: "runnable",
      stableWorkflowRunId: `${firstDependent.id}:workflow`,
      continuationSequence: 0,
      waitReason: "planning",
      sourceColumn: "todo",
      targetColumn: "todo",
      irHash: "ir-v1",
    });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");

    for (const [callId, params] of [
      ["call-8-omitted", { id: prerequisite.id }],
      ["call-8-false", { id: prerequisite.id, removeDependencyReferences: false }],
    ] as const) {
      const refused = await tool.execute(callId, params, undefined, undefined, ctx());
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toMatch(/still referenced as a dependency/i);
      expect((await store.getTask(prerequisite.id, { includeDeleted: true })).deletedAt).toBeUndefined();
      expect((await store.getTask(firstDependent.id)).dependencies).toEqual([prerequisite.id, unrelated.id]);
      expect((await store.getTask(firstDependent.id)).blockedBy).toBe(prerequisite.id);
      expect((await store.getTask(firstDependent.id)).status).toBe("queued");
      expect((await store.getWorkflowWorkItem(continuation.id))?.state).toBe("runnable");
    }

    const deleted = await tool.execute(
      "call-8-forced",
      { id: prerequisite.id, removeDependencyReferences: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(deleted.content[0]?.text).toBe(`Deleted ${prerequisite.id}`);
    expect((await store.getTask(prerequisite.id, { includeDeleted: true })).deletedAt).toBeTruthy();

    const updatedFirst = await store.getTask(firstDependent.id);
    const updatedSecond = await store.getTask(secondDependent.id);
    expect(updatedFirst.dependencies).toEqual([unrelated.id]);
    expect(updatedSecond.dependencies).toEqual([]);
    expect(updatedFirst.blockedBy).toBeUndefined();
    expect(updatedFirst.status).toBe("needs-replan");
    expect(updatedSecond.status).toBe("needs-replan");
    expect((await store.getWorkflowWorkItem(continuation.id))?.state).toBe("cancelled");
  });

  it("fn_task_delete with no dependents behaves unchanged", async () => {
    const store = h.store();
    const task = await store.createTask({ column: "todo", title: "solo", description: "no dependents" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    const result = await tool.execute("call-9", { id: task.id }, undefined, undefined, ctx());

    expect(result.content[0]?.text).toBe(`Deleted ${task.id}`);
    const deleted = await store.getTask(task.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
  });
});
