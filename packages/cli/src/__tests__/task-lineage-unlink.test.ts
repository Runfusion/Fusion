import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

/*
FNXC:TaskLifecycleTools 2026-07-07-00:00:
Regression coverage for FN-7661: fn_task_archive / fn_task_delete previously never exposed
removeLineageReferences, so a task still referenced as a lineage parent by another task was
permanently stuck even though the store's TaskHasLineageChildrenError message told callers to
pass that flag. These tests reproduce the original stuck-task symptom and assert it is gone via
the actual agent-facing tools.

FNXC:PostgresCutover 2026-07-08-00:00:
Ported from upstream's sqlite version: runs on the shared PG extension harness (the sqlite
TaskStore path is removed on this branch), seeds lineage via createTask's `source` provenance
input instead of raw sqlite UPDATEs, and reads forensic state via getTask({includeDeleted}).

FNXC:CliTests 2026-07-16-08:50:
FN-8102 keeps all archive/delete lineage-parent rejection cases strict after tools switched from
thrown errors to structured MCP results: each case must assert both `isError` and the message.
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

pgDescribe("fn_task_archive / fn_task_delete removeLineageReferences plumbing", () => {
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

  it("fn_task_archive rejects a lineage parent when removeLineageReferences is omitted", async () => {
    const store = h.store();
    const { parent } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_archive");

    const result = await tool.execute("call-1", { id: parent.id }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/still referenced as a lineage parent/);

    const row = await store.getTask(parent.id, { includeDeleted: true });
    expect(row.column).not.toBe("archived");
  });

  it("fn_task_archive rejects a lineage parent when removeLineageReferences is explicitly false", async () => {
    const store = h.store();
    const { parent } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_archive");

    const result = await tool.execute(
      "call-2",
      { id: parent.id, removeLineageReferences: false },
      undefined,
      undefined,
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/still referenced as a lineage parent/);
  });

  it("fn_task_archive with removeLineageReferences:true archives the parent and clears the child reference", async () => {
    const store = h.store();
    const { parent, child } = await createParentAndChild(store);

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_archive");
    const result = await tool.execute(
      "call-3",
      { id: parent.id, removeLineageReferences: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.column).toBe("archived");

    const updatedChild = await store.getTask(child.id);
    expect(updatedChild.sourceParentTaskId).toBeUndefined();
  });

  it("fn_task_archive with no lineage children behaves unchanged and preserves cleanup default", async () => {
    const store = h.store();
    const task = await store.createTask({ column: "done", title: "solo", description: "no children" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_archive");
    const result = await tool.execute("call-4", { id: task.id }, undefined, undefined, ctx());

    expect(result.details.column).toBe("archived");
  });

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

  it("fn_task_delete with no lineage children behaves unchanged", async () => {
    const store = h.store();
    const task = await store.createTask({ column: "todo", title: "solo", description: "no children" });

    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_task_delete");
    const result = await tool.execute("call-8", { id: task.id }, undefined, undefined, ctx());

    expect(result.content[0]?.text).toBe(`Deleted ${task.id}`);
    const deleted = await store.getTask(task.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
  });
});
