// @vitest-environment node
/*
FNXC:WorkflowIrPin 2026-10-30-06:15:
approve-plan must not release a card that still carries the workflow IR pin of the run that
parked it. After a Plan Review REVISE enters `plan-replan`, subsequent replans (including
return comments or `spec/revise`) can reach `awaiting-approval` with `workflowIrPin*` still
naming `plan-replan` in the planning column (or, after a later return, an implementation node
such as `code-review-remediation` in `in-progress`). Approval resumes the graph through a fresh
Plan Review continuation, so the old pin is stale by definition; advanced-triage self-healing
and planner recovery read it and can resume the approved card at that old node instead.

REVERT CHECK: drop the three `workflowIrPin*: null` entries from the approval patch and the same-column
cases fail, because the released row still carries the pre-approval pin.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskDetail, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

/** Plan-in-place lineage: planning, Plan Review and its replan all run in `todo`. */
const PLAN_IN_PLACE_IR = {
  version: "v2",
  name: "plan-in-place",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "todo" },
    { id: "planning", kind: "prompt", column: "todo", config: { seam: "planning" } },
    { id: "plan-review", kind: "optional-group", column: "todo" },
    { id: "plan-replan", kind: "gate", column: "todo", config: { workflowAction: "plan-replan" } },
    { id: "execute", kind: "prompt", column: "in-progress" },
    { id: "code-review-remediation", kind: "gate", column: "in-progress", config: { workflowAction: "pre-merge-remediation" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "planning" },
    { from: "planning", to: "plan-review" },
    { from: "plan-review", to: "execute", condition: "success" },
    { from: "plan-review", to: "plan-replan", condition: "failure" },
    { from: "plan-replan", to: "plan-review", condition: "success", kind: "rework" },
    { from: "execute", to: "end" },
  ],
};

/**
 * FNXC:WorkflowIrPin 2026-10-30-08:40:
 * Split-column approval must clear the old pin before its move while retaining the hold.
 * A failed final release must remain blocked and allow a retry through fresh Plan Review.
 */
const SPLIT_PLANNING_IR = {
  ...PLAN_IN_PLACE_IR,
  name: "split-planning",
  columns: [
    { id: "triage", name: "Intake", traits: [{ trait: "intake" }] },
    ...PLAN_IN_PLACE_IR.columns.map((column) => column.id === "todo"
      ? { ...column, traits: [{ trait: "hold" }] }
      : column),
  ],
  nodes: PLAN_IN_PLACE_IR.nodes.map((node) => ["start", "planning", "plan-replan"].includes(node.id)
    ? { ...node, column: "triage" }
    : node),
};

const fixtureRoots: string[] = [];
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Row = TaskDetail & Record<string, unknown>;

function replannedTask(pin: { workflowIrPin: string; workflowIrPinNodeId: string; workflowIrPinColumnId: string }): Row {
  return {
    id: "FN-PIN-TEST",
    title: "Replanned after Plan Review REVISE",
    description: "",
    column: "todo",
    status: "awaiting-approval",
    awaitingApprovalReason: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-30T06:15:00.000Z",
    updatedAt: "2026-10-30T06:15:00.000Z",
    prompt: "# Replanned plan\n",
    ...pin,
  } as unknown as Row;
}

/** A store whose row actually absorbs each write, so the test sees what approval persisted. */
function createStore(initial: Row, options: { ir?: typeof PLAN_IN_PLACE_IR; failFirstRelease?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fusion-plan-approval-pin-"));
  fixtureRoots.push(root);
  mkdirSync(join(root, ".fusion", "tasks", initial.id), { recursive: true });
  writeFileSync(join(root, ".fusion", "tasks", initial.id, "PROMPT.md"), initial.prompt ?? "# Plan\n");

  let row: Row = structuredClone(initial);
  const writes: Row[] = [];
  const beforeMoves: Row[] = [];
  let failRelease = options.failFirstRelease;
  const apply = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    row = next as Row;
    writes.push(structuredClone(row));
    return structuredClone(row);
  };

  const store = {
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue(root),
    getTask: vi.fn(async () => structuredClone(row)),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      if (failRelease && patch.status === null) {
        failRelease = false;
        throw new Error("injected final approval write failure");
      }
      return apply(patch);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      beforeMoves.push(structuredClone(row));
      return apply({ column });
    }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => await fn()),
    lockCurrentPlanWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    reconcileSpecDriftWhilePlanningLocked: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
    seedStrandedPlanReviewContinuation: vi.fn().mockResolvedValue({ seeded: true, workItemId: "wi-plan-review" }),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-plan-in-place" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-plan-in-place", name: "Plan in place", ir: options.ir ?? PLAN_IN_PLACE_IR }),
    listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  return { store, current: () => row, writes, beforeMoves };
}

function approve(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return performRequest(app, "POST", "/api/tasks/FN-PIN-TEST/approve-plan");
}

function expectPinCleared(row: Record<string, unknown>) {
  expect(row.workflowIrPin).toBeUndefined();
  expect(row.workflowIrPinNodeId).toBeUndefined();
  expect(row.workflowIrPinColumnId).toBeUndefined();
}

describe("approve-plan clears the stale workflow IR pin of a replanned card", () => {
  it("clears a plan-replan pin and still hands off to a fresh Plan Review", async () => {
    const { store, current, writes } = createStore(replannedTask({
      workflowIrPin: "fixture-ir:42",
      workflowIrPinNodeId: "plan-replan",
      workflowIrPinColumnId: "todo",
    }));

    const response = await approve(store);

    expect(response.status).toBe(200);
    expect(current().status).toBeUndefined();
    expectPinCleared(current());
    // No persisted state ever released the hold while the stale pin was still on the row.
    for (const write of writes) {
      if (write.status !== "awaiting-approval") expectPinCleared(write);
    }
    // The handoff does not need the pin: it seeds Plan Review from the current IR.
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "FN-PIN-TEST", nodeId: "plan-review", state: "runnable" }),
    );
  });

  it("clears an implementation-node pin left by an earlier execution round", async () => {
    const { store, current, writes } = createStore(replannedTask({
      workflowIrPin: "fixture-ir:42",
      workflowIrPinNodeId: "code-review-remediation",
      workflowIrPinColumnId: "in-progress",
    }));

    const response = await approve(store);

    expect(response.status).toBe(200);
    expect(current().status).toBeUndefined();
    expect(current().column).toBe("todo");
    expectPinCleared(current());
    for (const write of writes) {
      if (write.status !== "awaiting-approval") expectPinCleared(write);
    }
  });

  it("clears every pin field before a cross-column move while retaining the approval hold", async () => {
    const initial = replannedTask({
      workflowIrPin: "fixture-ir:42",
      workflowIrPinNodeId: "plan-replan",
      workflowIrPinColumnId: "triage",
    });
    initial.column = "triage";
    const { store, current, writes, beforeMoves } = createStore(initial, { ir: SPLIT_PLANNING_IR });

    const response = await approve(store);

    expect(response.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-PIN-TEST", "todo", {
      preserveStatus: true,
      workflowMoveSource: "plan-approval",
    });
    expect(beforeMoves).toHaveLength(1);
    expect(beforeMoves[0]).toMatchObject({ column: "triage", status: "awaiting-approval" });
    expectPinCleared(beforeMoves[0]);
    expect(writes).toHaveLength(3);
    expect(writes[1]).toMatchObject({ column: "todo", status: "awaiting-approval" });
    for (const write of writes) expectPinCleared(write);
    expect(current().column).toBe("todo");
    expect(current().status).toBeUndefined();
    expectPinCleared(current());
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "FN-PIN-TEST", nodeId: "plan-review", state: "runnable" }),
    );
  });

  it("keeps a failed cross-column release blocked without a pin and safely retries approval", async () => {
    const initial = replannedTask({
      workflowIrPin: "fixture-ir:42",
      workflowIrPinNodeId: "code-review-remediation",
      workflowIrPinColumnId: "in-progress",
    });
    initial.column = "triage";
    const { store, current, writes, beforeMoves } = createStore(initial, {
      ir: SPLIT_PLANNING_IR,
      failFirstRelease: true,
    });

    const interrupted = await approve(store);

    expect(interrupted.status).toBe(500);
    expect(current()).toMatchObject({ column: "todo", status: "awaiting-approval" });
    expect(beforeMoves).toHaveLength(1);
    expect(beforeMoves[0]).toMatchObject({ column: "triage", status: "awaiting-approval" });
    expectPinCleared(beforeMoves[0]);
    expectPinCleared(current());
    expect(store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();

    const retried = await approve(store);

    expect(retried.status).toBe(200);
    expect(beforeMoves).toHaveLength(2);
    for (const beforeMove of beforeMoves) {
      expect(beforeMove.status).toBe("awaiting-approval");
      expectPinCleared(beforeMove);
    }
    for (const write of writes) expectPinCleared(write);
    expect(current().column).toBe("todo");
    expect(current().status).toBeUndefined();
    expectPinCleared(current());
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledTimes(1);
    expect(store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "FN-PIN-TEST", nodeId: "plan-review", state: "runnable" }),
    );
  });
});
