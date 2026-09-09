import { describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, type TaskDetail } from "@fusion/core";

import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";

function task(column: string, incomplete = true): TaskDetail {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    id: "FN-207",
    title: "Contain graph failure",
    description: "Keep remediation adjacent",
    column,
    dependencies: [],
    steps: [{ name: "Implement", status: incomplete ? "pending" : "done" }],
    currentStep: 0,
    log: [],
    status: "failed",
    error: "graph failed",
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
  } as TaskDetail;
}

function harness(row: TaskDetail, workflowId: string) {
  const store = {
    getTask: vi.fn(async () => row),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => getBuiltinWorkflow(id)),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(row, patch)),
    moveTask: vi.fn(async (_id: string, column: string, options?: object) => {
      row.column = column;
      return Object.assign(row, { moveOptions: options });
    }),
  };
  const deps = {
    store,
    getRunContextFor: () => undefined,
    resolveResumeLanes: vi.fn(async () => ({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
      wipDeclared: true,
    })),
    clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
    persistTokenUsage: vi.fn(async () => undefined),
    isRemediationGraphNode: vi.fn(async () => false),
  };
  return { store, deps };
}

describe("graph failure execution-resume containment", () => {
  it.each(["builtin:coding", "builtin:coding-ideas-v2"])(
    "keeps incomplete review work in review on %s without a REVISE handoff",
    async (workflowId) => {
      const row = task("in-review", true);
      const { store, deps } = harness(row, workflowId);

      await expect(routeGraphFailureToExecutionResume(
        deps as never,
        row,
        "steps#0:step-execute",
        "step-failed",
      )).resolves.toBe(false);

      expect(row.column).toBe("in-review");
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-207",
        expect.stringContaining("cannot move 'in-review' backward"),
        undefined,
        undefined,
      );
    },
  );

  it("does not issue a second move when incomplete merge work is already in WIP", async () => {
    const row = task("in-progress", true);
    const { store, deps } = harness(row, "builtin:coding-ideas-v2");

    await expect(routeGraphFailureToExecutionResume(
      deps as never,
      row,
      "merge",
      "implementation-incomplete",
    )).resolves.toBe(true);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(row.column).toBe("in-progress");
  });

  it("fails closed when the workflow declares no WIP lane", async () => {
    const row = task("review", true);
    const { store, deps } = harness(row, "custom:no-wip");
    deps.resolveResumeLanes.mockResolvedValue({
      hold: "planning",
      review: "review",
      wip: undefined,
      wipDeclared: false,
    } as never);

    await expect(routeGraphFailureToExecutionResume(
      deps as never,
      row,
      "steps#0:step-execute",
      "step-failed",
    )).resolves.toBe(false);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(row.column).toBe("review");
  });

  it("keeps a clean-handoff retry in review without a REVISE", async () => {
    const row = task("in-review", false);
    const { store, deps } = harness(row, "builtin:coding-ideas-v2");

    await expect(routeGraphFailureToExecutionResume(
      deps as never,
      row,
      "custom-review",
      "retry",
    )).resolves.toBe(false);

    expect(row.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
