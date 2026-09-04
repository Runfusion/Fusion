import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR, FAST_LANE_STEP_NAME, type TaskDetail, type WorkflowIr, type WorkflowStepResult } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { createNoopLegacySeams, FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-252-fast-graph",
    title: "Fast graph walk",
    description: "Make a small change",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    ...overrides,
  } as TaskDetail;
}

function graph(): WorkflowIr {
  return {
    version: "v2",
    name: "fast-graph-test",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "Working", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "Review", traits: [{ trait: "merge-blocker" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "plan", kind: "prompt", column: "todo", config: { seam: "planning" } },
      { id: "plan-review", kind: "optional-group", column: "todo", config: { name: "Plan Review", defaultOn: true, template: { nodes: [{ id: "plan-review-step", kind: "prompt", config: { prompt: "review plan" } }], edges: [] } } },
      { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
      { id: "code-review", kind: "optional-group", column: "in-review", config: { name: "Code Review", defaultOn: true, template: { nodes: [{ id: "code-review-step", kind: "prompt", config: { prompt: "review code" } }], edges: [] } } },
      { id: "completion-summary", kind: "prompt", column: "in-review", config: { summaryTarget: "task", prompt: "summarize" } },
      { id: "end", kind: "end", column: "in-review" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "plan-review", condition: "success" },
      { from: "plan-review", to: "execute", condition: "success" },
      { from: "execute", to: "code-review", condition: "success" },
      { from: "code-review", to: "completion-summary", condition: "success" },
      { from: "completion-summary", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

describe("FN-252 fast graph route", () => {
  it("routes the persisted bypass actor through the shared core constant", async () => {
    const source = await readFile(new URL("../workflows/workflow-graph-executor.ts", import.meta.url), "utf8");
    expect(source).toContain("bypassedBy: FAST_MODE_BYPASS_ACTOR");
    expect(source).not.toContain('bypassedBy: "fast-mode"');
  });

  it("bypasses planning and enabled pre-merge groups while preserving execution and completion summary", async () => {
    const planning = vi.fn(async () => ({ outcome: "success" as const }));
    const execute = vi.fn(async () => ({ outcome: "success" as const }));
    const runCustomNode = vi.fn(async () => ({ outcome: "success" as const }));
    const results: WorkflowStepResult[] = [];
    const executor = new WorkflowGraphExecutor({
      seams: { ...createNoopLegacySeams(), planning, execute },
      runCustomNode,
      recordWorkflowStepResult: async (_taskId, result) => {
        results.push(result);
        return true;
      },
    });

    const result = await executor.run(task({ executionMode: "fast" }), {}, graph());

    expect(result.outcome).toBe("success");
    expect(planning).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(runCustomNode).toHaveBeenCalledTimes(1);
    expect(runCustomNode).toHaveBeenCalledWith(expect.objectContaining({ id: "completion-summary" }), expect.anything(), expect.anything());
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowStepId: "plan-review", status: "skipped", bypassedBy: "fast-mode", bypassedFromStatus: "absent" }),
      expect.objectContaining({ workflowStepId: "code-review", status: "skipped", bypassedBy: "fast-mode", bypassedFromStatus: "absent" }),
    ]));
  });

  it("walks the real stepwise built-in through one synthetic Fast occurrence before merge", async () => {
    const planning = vi.fn(async () => ({ outcome: "success" as const }));
    const merge = vi.fn(async () => ({ outcome: "success" as const }));
    const stepExecute = vi.fn(async (nodeTask: TaskDetail, context: Record<string, unknown>) => {
      const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as { stepIndex: number; deferDoneToReview?: boolean };
      if (active.deferDoneToReview !== true) nodeTask.steps[active.stepIndex]!.status = "done";
      return { outcome: "success" as const, value: "step-done" };
    });
    const readArtifact = vi.fn(async () => "# FN-252-fast-graph\n\nMake the button red");
    const results: WorkflowStepResult[] = [];
    const graphTask = task({ executionMode: "fast", prompt: "# FN-252-fast-graph\n\nMake the button red" });
    const executor = new WorkflowGraphExecutor({
      seams: { ...createNoopLegacySeams(), planning, merge, stepExecute },
      parseStepsDeps: {
        readArtifact,
        writeSteps: async (target, steps) => { target.steps = steps; },
      },
      runCustomNode: vi.fn(async () => ({ outcome: "success" as const })),
      recordWorkflowStepResult: async (_taskId, result) => {
        results.push(result);
        return true;
      },
    });

    const result = await executor.run(graphTask, {}, BUILTIN_STEPWISE_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    expect(planning).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
    expect(stepExecute).toHaveBeenCalledOnce();
    expect(merge).toHaveBeenCalledOnce();
    expect(graphTask.steps).toEqual([{ name: FAST_LANE_STEP_NAME, status: "done" }]);
    expect(result.visitedNodeIds).toContain("steps#0:step-execute");
    expect(results.filter((entry) => entry.status === "skipped" && entry.bypassedBy === "fast-mode")
      .map((entry) => entry.workflowStepId)).toEqual(expect.arrayContaining(["plan-review", "code-review"]));
  });

  it("keeps the equivalent standard graph on its normal planning and review path", async () => {
    const planning = vi.fn(async () => ({ outcome: "success" as const }));
    const execute = vi.fn(async () => ({ outcome: "success" as const }));
    const runCustomNode = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      seams: { ...createNoopLegacySeams(), planning, execute },
      runCustomNode,
    });

    await expect(executor.run(task({ executionMode: "standard" }), {}, graph())).resolves.toMatchObject({ outcome: "success" });
    expect(planning).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(runCustomNode.mock.calls.map(([node]) => node.id)).toEqual(expect.arrayContaining([
      "plan-review-step",
      "code-review-step",
      "completion-summary",
    ]));
  });
});
