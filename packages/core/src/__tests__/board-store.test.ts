// @vitest-environment node
//
// Company-model U1: BoardStore CRUD + delete-guard, and board→IR resolution
// through the workflow-IR resolver (a task with a boardId resolves the board's
// workflow IR; a task without one falls back to the legacy selection path).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { BoardHasTasksError } from "../board-store.js";
import { resolveWorkflowIrForTask } from "../workflow-ir-resolver.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

function customIr(name: string, cols: string[], entryId: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: cols.map((id) => ({
      id,
      name: id,
      traits: id === entryId ? [{ trait: "intake" }] : [],
    })),
    nodes: [
      { id: "start", kind: "start", column: entryId },
      { id: "work", kind: "prompt", column: cols[1] ?? entryId, config: { prompt: "do" } },
      { id: "end", kind: "end", column: cols[cols.length - 1] },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

describe("U1 BoardStore — CRUD", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("creates, reads, lists, and updates boards", () => {
    // The v114 migration seeds a default "Board 1" on init; clear it so this CRUD
    // test starts from an empty board set.
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`DELETE FROM boards`)
      .run();
    const boards = store.getBoardStore();
    const a = boards.createBoard({ name: "Alpha", workflowId: "builtin:coding" });
    expect(a.id).toBeTruthy();
    expect(a.name).toBe("Alpha");
    expect(a.workflowId).toBe("builtin:coding");
    expect(a.ordering).toBe(0);

    const b = boards.createBoard({ name: "Beta", workflowId: "builtin:quick-fix", description: "second" });
    expect(b.ordering).toBe(1);

    expect(boards.getBoard(a.id)?.name).toBe("Alpha");
    expect(boards.getBoard("nope")).toBeUndefined();

    const all = boards.listBoards(a.projectId);
    expect(all.map((x) => x.name)).toEqual(["Alpha", "Beta"]);

    const updated = boards.updateBoard(a.id, { name: "Alpha-2", description: "renamed" });
    expect(updated.name).toBe("Alpha-2");
    expect(updated.description).toBe("renamed");
    expect(boards.getBoard(a.id)?.name).toBe("Alpha-2");
  });

  it("rejects an empty name or workflowId on create", () => {
    const boards = store.getBoardStore();
    expect(() => boards.createBoard({ name: "  ", workflowId: "builtin:coding" })).toThrow(/name is required/);
    expect(() => boards.createBoard({ name: "X", workflowId: "" })).toThrow(/workflowId is required/);
  });
});

describe("U1 BoardStore — delete guard", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("deletes an empty board but refuses a board that still homes tasks", async () => {
    const boards = store.getBoardStore();
    const empty = boards.createBoard({ name: "Empty", workflowId: "builtin:coding" });
    // Deletes cleanly.
    expect(() => boards.deleteBoard(empty.id)).not.toThrow();
    expect(boards.getBoard(empty.id)).toBeUndefined();

    const occupied = boards.createBoard({ name: "Occupied", workflowId: "builtin:coding" });
    const task = await store.createTask({ description: "homed" });
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`UPDATE tasks SET boardId = ? WHERE id = ?`)
      .run(occupied.id, task.id);

    expect(boards.countTasks(occupied.id)).toBe(1);
    let caught: unknown;
    try {
      boards.deleteBoard(occupied.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoardHasTasksError);
    expect(boards.getBoard(occupied.id)).toBeDefined();

    // After re-homing (clearing the task's boardId) the delete succeeds.
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db
      .prepare(`UPDATE tasks SET boardId = NULL WHERE id = ?`)
      .run(task.id);
    expect(() => boards.deleteBoard(occupied.id)).not.toThrow();
    expect(boards.getBoard(occupied.id)).toBeUndefined();
  });
});

describe("U1 board→IR resolution through the resolver", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  function rawDb(): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
    return (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  }

  it("a task with a boardId resolves the board's workflow IR (primary path)", async () => {
    const wf = await store.createWorkflowDefinition({
      name: "board-wf",
      ir: customIr("board-wf", ["intake", "build", "ship"], "intake"),
    });
    const board = store.getBoardStore().createBoard({ name: "Custom", workflowId: wf.id });
    const task = await store.createTask({ description: "boarded" });
    rawDb().prepare(`UPDATE tasks SET boardId = ? WHERE id = ?`).run(board.id, task.id);

    const ir = await resolveWorkflowIrForTask(store, task.id);
    expect(ir.name).toBe("board-wf");
    expect(ir.version === "v2" ? ir.columns.map((c) => c.id) : []).toEqual(["intake", "build", "ship"]);
  });

  it("a task without a boardId falls back to the legacy selection path", async () => {
    const wf = await store.createWorkflowDefinition({
      name: "legacy-wf",
      ir: customIr("legacy-wf", ["todo", "build", "done"], "todo"),
    });
    const task = await store.createTask({ description: "legacy" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    // No boardId → legacy task_workflow_selection resolves.
    expect(store.getTaskBoardId(task.id)).toBeUndefined();

    const ir = await resolveWorkflowIrForTask(store, task.id);
    expect(ir.name).toBe("legacy-wf");
  });

  it("a task with neither boardId nor selection resolves the builtin default", async () => {
    const task = await store.createTask({ description: "bare" });
    const ir = await resolveWorkflowIrForTask(store, task.id);
    expect(ir.name).toBe(BUILTIN_CODING_WORKFLOW_IR.name);
  });
});

describe("U5 Board.requirePlanApproval (R20 plan-approval hold)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  function rawDb(): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
    return (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  }

  it("persists requirePlanApproval through create/update and defaults to false", () => {
    const boards = store.getBoardStore();
    const off = boards.createBoard({ name: "Off", workflowId: "builtin:coding" });
    expect(off.requirePlanApproval).toBe(false);

    const on = boards.createBoard({ name: "On", workflowId: "builtin:coding", requirePlanApproval: true });
    expect(on.requirePlanApproval).toBe(true);
    expect(boards.getBoard(on.id)?.requirePlanApproval).toBe(true);

    const toggled = boards.updateBoard(off.id, { requirePlanApproval: true });
    expect(toggled.requirePlanApproval).toBe(true);
    expect(boards.getBoard(off.id)?.requirePlanApproval).toBe(true);

    // An update that omits the field leaves it unchanged.
    const renamed = boards.updateBoard(off.id, { name: "Off-renamed" });
    expect(renamed.requirePlanApproval).toBe(true);
  });

  it("getTaskBoardRequiresPlanApproval reflects the task's board (false without a board)", async () => {
    const boards = store.getBoardStore();
    const board = boards.createBoard({ name: "Hold", workflowId: "builtin:coding", requirePlanApproval: true });
    const task = await store.createTask({ description: "homed" });

    // No board yet → false.
    expect(store.getTaskBoardRequiresPlanApproval(task.id)).toBe(false);

    rawDb().prepare(`UPDATE tasks SET boardId = ? WHERE id = ?`).run(board.id, task.id);
    expect(store.getTaskBoardRequiresPlanApproval(task.id)).toBe(true);
  });

  it("approvePlanForTask releases a company todo hold to in-progress; rejects a non-parked task", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const task = await store.createTask({ description: "parked" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.updateTask(task.id, { status: "awaiting-approval" });

    const released = await store.approvePlanForTask(task.id);
    expect(released.column).toBe("in-progress");
    expect((await store.getTask(task.id)).status ?? null).toBeNull();

    // A task that is not awaiting approval is rejected.
    await expect(store.approvePlanForTask(task.id)).rejects.toThrow(/not awaiting plan approval/);
  });

  it("approvePlanForTask releases a legacy triage hold to todo", async () => {
    const task = await store.createTask({ description: "legacy-parked" });
    // Legacy flow parks in triage with the awaiting-approval marker.
    await store.updateTask(task.id, { status: "awaiting-approval" });
    expect((await store.getTask(task.id)).column).toBe("triage");

    const released = await store.approvePlanForTask(task.id);
    expect(released.column).toBe("todo");
  });
});
