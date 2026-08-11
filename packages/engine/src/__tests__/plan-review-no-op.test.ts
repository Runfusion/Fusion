import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import {
  BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
  PLAN_REVIEW_GROUP_ID,
  upsertWorkflowStepResult,
} from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";

function planReviewIr(withRoute = true): WorkflowIr {
  return {
    version: "v2",
    name: "plan-review-no-op-test",
    columns: [{ id: "todo", name: "Todo", traits: [] }, { id: "done", name: "Done", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: PLAN_REVIEW_GROUP_ID, kind: "optional-group", config: { name: "Plan Review", reviewKind: "plan", defaultOn: true, template: { nodes: [{ id: "review", kind: "prompt", config: { prompt: "review" } }], edges: [] } } },
      ...(withRoute ? [{ id: "plan-review-no-op", kind: "gate" as const, config: { workflowAction: "plan-review-no-op" } }] : []),
      { id: "execute", kind: "prompt", config: { prompt: "execute" } },
      { id: "plan-replan", kind: "prompt", config: { prompt: "replan" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: PLAN_REVIEW_GROUP_ID },
      { from: PLAN_REVIEW_GROUP_ID, to: "execute", condition: "success" },
      { from: PLAN_REVIEW_GROUP_ID, to: "plan-replan", condition: "failure" },
      ...(withRoute ? [{ from: PLAN_REVIEW_GROUP_ID, to: "plan-review-no-op", condition: "outcome:close-no-op" }, { from: "plan-review-no-op", to: "end", condition: "success" }] : []),
      { from: "execute", to: "end" }, { from: "plan-replan", to: "end" },
    ],
  };
}

const task = (): TaskDetail => ({ id: "FN-123", enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID] } as TaskDetail);
const close = { outcome: "success" as const, value: "CLOSE_NO_OP", contextPatch: { notes: "DUPLICATE: FN-1234 already covered" } };

describe("Plan Review CLOSE_NO_OP", () => {
  it("completes a valid duplicate close without execution or replan", async () => {
    const executed: string[] = [];
    const results: WorkflowStepResult[] = [];
    const complete = vi.fn(async () => true);
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { executed.push(node.id); return close; } },
      recordWorkflowStepResult: async (_id, result) => { results.push(result); },
      completePlanReviewNoOp: complete,
    });
    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());

    expect(result.outcome).toBe("success");
    expect(executed).toEqual(["review"]);
    expect(result.visitedNodeIds).toEqual(["start", PLAN_REVIEW_GROUP_ID, "plan-review::review", "plan-review-no-op"]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-123" }), {
      kind: "duplicate", reason: "FN-1234 already covered", canonicalId: "FN-1234",
    });
    expect(results.at(-1)).toMatchObject({ status: "passed", verdict: "CLOSE_NO_OP", notes: "DUPLICATE: FN-1234 already covered" });
  });

  it("takes the terminal close route in every executable built-in without implementation dispatch", async () => {
    const workflows = [
      { id: "builtin:coding" },
      { id: "builtin:stepwise-coding" },
      /*
       * FNXC:PlanReviewNoOp 2026-08-09-02:52:
       * The derived final-review topology is the catalog's builtin:coding IR. Load it
       * directly as a custom definition too, ratcheting the clone independently.
       */
      { id: "WF-stepwise-final", ir: BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR },
    ];
    for (const workflow of workflows) {
      const workflowId = workflow.id;
      const persisted: WorkflowStepResult[] = [];
      const complete = vi.fn(async () => true);
      const implementation = vi.fn(async () => ({ outcome: "success" as const }));
      const runner = new WorkflowGraphTaskRunner({
        store: {
          getTaskWorkflowSelection: () => ({ workflowId, stepIds: [PLAN_REVIEW_GROUP_ID] }),
          getTaskWorkflowSelectionAsync: async () => ({ workflowId, stepIds: [PLAN_REVIEW_GROUP_ID] }),
          getWorkflowDefinition: async () => workflow.ir ? ({ id: workflowId, ir: workflow.ir } as never) : undefined,
        },
        seams: {
          planning: async () => ({ outcome: "success" }),
          execute: implementation,
          review: async () => ({ outcome: "success" }),
          merge: async () => ({ outcome: "success" }),
          schedule: async () => ({ outcome: "success" }),
        },
        runCustomNode: async (node) => node.id === "plan-review-step"
          ? close
          : { outcome: "failure", value: `unexpected:${node.id}` },
        recordWorkflowStepResult: async (_taskId, stepResult) => { persisted.push(stepResult); },
        completePlanReviewNoOp: complete,
      });
      const result = await runner.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, PLAN_REVIEW_GROUP_ID);

      expect(result.disposition, workflowId).toBe("completed");
      expect(result.visitedNodeIds, workflowId).toContain("plan-review-no-op");
      expect(implementation, workflowId).not.toHaveBeenCalled();
      expect(complete, workflowId).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-123" }), {
        kind: "duplicate", reason: "FN-1234 already covered", canonicalId: "FN-1234",
      });
      expect(persisted.at(-1), workflowId).toMatchObject({
        status: "passed", verdict: "CLOSE_NO_OP", notes: "DUPLICATE: FN-1234 already covered",
      });
    }
  });

  it("holds invalid close notes without execution, replan, or completion", async () => {
    const executed: string[] = [];
    const complete = vi.fn(async () => true);
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async (node) => { executed.push(node.id); return { ...close, contextPatch: { notes: "already done" } }; } },
      completePlanReviewNoOp: complete,
    });
    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());
    expect(result.outcome).toBe("success");
    expect(result.suspended).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_GROUP_ID });
    expect(executed).toEqual(["review"]);
    expect(result.visitedNodeIds).toEqual(["start", PLAN_REVIEW_GROUP_ID, "plan-review::review"]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("holds a valid close when an authored workflow has no terminal route", async () => {
    const complete = vi.fn(async () => true);
    const results: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => close },
      recordWorkflowStepResult: async (_id, result) => { results.push(result); },
      completePlanReviewNoOp: complete,
    });
    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr(false));
    expect(result.outcome).toBe("success");
    expect(result.suspended).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_GROUP_ID });
    expect(result.visitedNodeIds).toEqual(["start", PLAN_REVIEW_GROUP_ID, "plan-review::review"]);
    expect(complete).not.toHaveBeenCalled();
    expect(results.at(-1)).toMatchObject({ status: "failed", verdict: "CLOSE_NO_OP", output: "Plan Review CLOSE_NO_OP terminal route unavailable." });
  });

  it("replaces passed close evidence and holds when terminalization fails", async () => {
    const results: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => close },
      recordWorkflowStepResult: async (_id, result) => { results.push(result); },
      completePlanReviewNoOp: async () => false,
    });
    const result = await executor.run(task(), { experimentalFeatures: { workflowGraphExecutor: true } }, planReviewIr());

    expect(result.suspended).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_GROUP_ID });
    expect(result.visitedNodeIds).toEqual(["start", PLAN_REVIEW_GROUP_ID, "plan-review::review", "plan-review-no-op"]);
    expect(results.at(-1)).toMatchObject({
      status: "failed",
      verdict: "CLOSE_NO_OP",
      notes: "DUPLICATE: FN-1234 already covered",
      output: "Plan Review CLOSE_NO_OP terminalization failed.",
    });
  });

  /*
   * FNXC:PlanReviewNoOp 2026-08-09-02:52:
   * A close can race an operator pause after the reviewer result is durable but before
   * the terminal action starts. Exercise the real runner → TaskExecutor completion
   * handoff so this fence cannot regress into a direct helper-only ordering test.
   */
  it("holds the real runner continuation when a pause wins after close evidence", async () => {
    const live = {
      id: "FN-123",
      title: "Duplicate task",
      column: "todo",
      steps: [],
      enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
      workflowStepResults: [],
    } as unknown as TaskDetail;
    const continuations: Array<Record<string, unknown>> = [];
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async () => live),
      getSettings: vi.fn(async () => ({ experimentalFeatures: { workflowGraphExecutor: true } })),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [PLAN_REVIEW_GROUP_ID] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [PLAN_REVIEW_GROUP_ID] })),
      updateTask: vi.fn(async (_taskId: string, patch: Record<string, unknown>) => {
        Object.assign(live, patch);
        return live;
      }),
      updateStep: vi.fn(),
      logEntry: vi.fn(),
      moveTask: vi.fn(),
      replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
        continuations.push(input);
        return { id: "held-close", ...input };
      }),
    };
    const taskExecutor = new TaskExecutor(store as never, "/tmp/plan-review-no-op-real-race");
    const recordResult = vi.fn(async (_taskId: string, result: WorkflowStepResult) => {
      live.workflowStepResults = upsertWorkflowStepResult(live.workflowStepResults, result);
      /* FNXC:PlanReviewNoOp 2026-08-09-02:52: Pause after durable evidence to prove the completion fence retains the review hold. */
      live.paused = true;
      live.userPaused = true;
    });
    const runner = new WorkflowGraphTaskRunner({
      store: store as never,
      seams: {
        planning: async () => ({ outcome: "success" }),
        execute: async () => ({ outcome: "success" }),
        review: async () => ({ outcome: "success" }),
        merge: async () => ({ outcome: "success" }),
        schedule: async () => ({ outcome: "success" }),
      },
      runCustomNode: vi.fn(async (node) => {
        expect(node.id).toBe("plan-review-step");
        return close;
      }),
      recordWorkflowStepResult: recordResult,
      completePlanReviewNoOp: (nodeTask, marker) => (taskExecutor as unknown as {
        completePlanReviewNoOp: (task: TaskDetail, parsedMarker: typeof marker) => Promise<boolean>;
      }).completePlanReviewNoOp(nodeTask, marker),
      holdPlanReviewNoOp: async (nodeTask, suspension) => {
        await (taskExecutor as unknown as {
          holdPlanReviewNoOpContinuation: (
            task: TaskDetail,
            heldSuspension: typeof suspension,
            continuation: undefined,
            runId: string,
          ) => Promise<unknown>;
        }).holdPlanReviewNoOpContinuation(nodeTask, suspension, undefined, "FN-123:builtin:coding");
      },
    });

    const result = await runner.run(live, { experimentalFeatures: { workflowGraphExecutor: true } }, PLAN_REVIEW_GROUP_ID);

    expect(result.disposition).toBe("suspended");
    expect(result.suspension).toMatchObject({ reason: "hold", nodeId: PLAN_REVIEW_GROUP_ID });
    expect(live).toMatchObject({ column: "todo", paused: true, userPaused: true });
    expect(live.workflowStepResults.at(-1)).toMatchObject({
      status: "failed",
      verdict: "CLOSE_NO_OP",
      notes: "DUPLICATE: FN-1234 already covered",
      output: "Plan Review CLOSE_NO_OP terminalization failed.",
    });
    expect(continuations.at(-1)).toMatchObject({
      nodeId: PLAN_REVIEW_GROUP_ID,
      state: "held",
      waitReason: "planning",
      blockedReason: "plan-review-close-terminalization-failed",
    });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("retains the held continuation when a user pause wins the close race", async () => {
    const pausedTask = {
      id: "FN-123",
      column: "todo",
      paused: true,
      userPaused: true,
    } as TaskDetail;
    const replace = vi.fn(async (input: Record<string, unknown>) => ({ id: "held-close", ...input }));
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async () => pausedTask),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] })),
      replaceActiveTaskWorkflowContinuation: replace,
    };
    const executor = new TaskExecutor(store as never, "/tmp/plan-review-no-op-race");

    const held = await (executor as unknown as {
      holdPlanReviewNoOpContinuation: (
        task: TaskDetail,
        suspension: { reason: "terminalization-failed"; nodeId: string; fromColumn: string; toColumn: string; irHash: string },
        continuation: undefined,
        runId: string,
      ) => Promise<{ state: string; waitReason: string; nodeId: string; taskId: string }>;
    }).holdPlanReviewNoOpContinuation(pausedTask, {
      reason: "terminalization-failed",
      nodeId: PLAN_REVIEW_GROUP_ID,
      fromColumn: "todo",
      toColumn: "todo",
      irHash: "test-ir",
    }, undefined, "FN-123:builtin:coding");

    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-123",
      nodeId: PLAN_REVIEW_GROUP_ID,
      state: "held",
      waitReason: "planning",
      blockedReason: "plan-review-close-terminalization-failed",
    }));
    expect(held).toMatchObject({ state: "held", waitReason: "planning" });
    expect(pausedTask).toMatchObject({ paused: true, userPaused: true });
  });
});
