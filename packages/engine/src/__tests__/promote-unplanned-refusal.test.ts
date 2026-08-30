/*
FNXC:WorkflowScheduling 2026-08-29-00:24:
FN-245 removes the operator waiver from explicit promotion. These cases cover
unplanned, approval-held, planned, capacity-limited, and external-event release
surfaces so no caller can push a card past planning or plan review.
*/
import { describe, expect, it, vi } from "vitest";
import { PLAN_REVIEW_GROUP_ID, type Task, type WorkflowIr } from "@fusion/core";
import { promoteHeldTask, releaseHeldTaskByEvent } from "../execution/hold-release.js";
import { createTaskPromoteTool } from "../agent-tools.js";

function workflow(
  release: "capacity" | "external-event" = "capacity",
  withPlanReview = false,
): WorkflowIr {
  return {
    version: "v2",
    name: "promote-refusal",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      ...(withPlanReview
        ? [{
            id: PLAN_REVIEW_GROUP_ID,
            name: "Plan Review",
            kind: "optional-group" as const,
            column: "todo",
            config: { defaultOn: true, template: { nodes: [], edges: [] } },
          }]
        : []),
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

/** A small store fixture with an explicit held-card state. */
function makeStore(
  taskOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const task = {
    id: "FN-1403",
    column: "todo",
    status: "needs-replan",
    ...taskOverrides,
  } as Task;
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: string,
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!await predicate(task)) return { task, moved: false };
    task.column = target;
    return { task, moved: true };
  });
  const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
    return task;
  });
  const recordRunAuditEvent = vi.fn(async () => ({}));
  const checkAndRecordUnplannedExecutionBlock = vi.fn(async () => true);
  const store = {
    task,
    getTask: async () => task,
    updateTask,
    moveTaskIf,
    recordRunAuditEvent,
    checkAndRecordUnplannedExecutionBlock,
    getTaskWorkflowSelection: () => ({ workflowId: "custom", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: workflow() }),
    ...overrides,
  };
  return store as typeof store & Record<string, unknown>;
}

describe("unplanned promote refusal", () => {
  it("refuses an unplanned replan card without mutating its planning evidence", async () => {
    const store = makeStore();

    const result = await promoteHeldTask(store as never, "FN-1403");

    expect(result).toEqual({ released: false, rejection: "unplanned-for-execution", toColumn: "in-progress" });
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(store.task.status).toBe("needs-replan");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-1403", { status: null });
    expect(store.task.workflowStepResults).toBeUndefined();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:promote-forced-unplanned" }),
    );
  });

  it("refuses a fully planned card that is awaiting approval", async () => {
    const store = makeStore({ status: "awaiting-approval" });

    const result = await promoteHeldTask(store as never, "FN-1403");

    expect(result).toEqual({ released: false, rejection: "capacity-exhausted-or-no-slot" });
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("still releases a fully planned card with available capacity", async () => {
    const store = makeStore({ status: undefined });

    const result = await promoteHeldTask(store as never, "FN-1403");

    expect(result).toEqual({ released: true, toColumn: "in-progress" });
    expect(result).not.toHaveProperty("forcedUnplanned");
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
  });

  it("keeps capacity reservation failures distinct for planned cards", async () => {
    const store = makeStore({ status: undefined });
    const reserveSlot = vi.fn(async () => null);

    const result = await promoteHeldTask(store as never, "FN-1403", { reserveSlot });

    expect(result).toEqual({ released: false, rejection: "capacity-exhausted-or-no-slot" });
    expect(reserveSlot).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("refuses an unplanned external-event release without moving the card", async () => {
    const store = makeStore({}, {
      getWorkflowDefinition: async () => ({ ir: workflow("external-event") }),
    });

    const result = await releaseHeldTaskByEvent(store as never, "FN-1403", "webhook");

    expect(result).toEqual({ released: false, rejection: "unplanned-for-execution", toColumn: "in-progress" });
    expect(store.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(store.task.status).toBe("needs-replan");
  });

  it("refuses manual promotion when a replan races the locked move", async () => {
    const store = makeStore({ status: undefined });
    const release = vi.fn();
    const reserveSlot = vi.fn(async () => {
      store.task.status = "needs-replan";
      return { release };
    });

    const result = await promoteHeldTask(store as never, "FN-1403", { reserveSlot });

    expect(result).toEqual({ released: false, rejection: "unplanned-for-execution", toColumn: "in-progress" });
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.task.column).toBe("todo");
    expect(store.task.status).toBe("needs-replan");
    expect(store.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses external-event release when Plan Review becomes pending before the locked move", async () => {
    const store = makeStore({
      status: undefined,
      workflowStepResults: [{
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        workflowStepName: "Plan Review",
        status: "passed",
      }],
    }, {
      getWorkflowDefinition: async () => ({ ir: workflow("external-event", true) }),
    });
    const release = vi.fn();
    const reserveSlot = vi.fn(async () => {
      store.task.workflowStepResults = [];
      return { release };
    });

    const result = await releaseHeldTaskByEvent(store as never, "FN-1403", "webhook", { reserveSlot });

    expect(result).toEqual({ released: false, rejection: "unplanned-for-execution", toColumn: "in-progress" });
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
    expect(store.task.column).toBe("todo");
    expect(store.task.workflowStepResults).toEqual([]);
    expect(store.checkAndRecordUnplannedExecutionBlock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("fn_task_promote refusal surface", () => {
  it("exposes only the task id parameter", () => {
    const store = makeStore();
    const tool = createTaskPromoteTool(store as never, "FN-1403");
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).not.toHaveProperty("force");
    expect(properties).toHaveProperty("task_id");
  });

  it("reports an unplanned task without an override hint", async () => {
    const store = makeStore();
    const tool = createTaskPromoteTool(store as never, "FN-1403");

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      released: false,
      rejection: "unplanned-for-execution",
    });
    expect(result.details).not.toHaveProperty("forcedUnplanned");
    expect(result.content[0]?.text).not.toContain("force");
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});
