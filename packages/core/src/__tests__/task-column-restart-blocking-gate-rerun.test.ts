import { describe, expect, it } from "vitest";
import { evaluatePreMergeApprovals, getTaskMergeBlocker, planTaskColumnRestart, type Task, type WorkflowIr, type WorkflowStepResult } from "@fusion/core";

const ir: WorkflowIr = {
  version: "v2", name: "blocking-gate-retry",
  columns: [
    { id: "hold", name: "Hold", traits: [{ trait: "hold" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
  ],
  nodes: [
    { id: "plan-review", kind: "optional-group", column: "hold", config: { phase: "pre-merge", defaultOn: true, template: { nodes: [], edges: [] } } },
    { id: "implementation", kind: "prompt", column: "hold" },
    { id: "code-review", kind: "optional-group", column: "review", config: { phase: "pre-merge", defaultOn: true, template: { nodes: [], edges: [] } } },
    { id: "post", kind: "optional-group", column: "review", config: { phase: "post-merge", defaultOn: true, template: { nodes: [], edges: [] } } },
  ], edges: [],
};

function task(results: WorkflowStepResult[] = []): Task {
  return { id: "FN-9289", description: "retry", column: "review", steps: [], currentStep: 0, dependencies: [], enabledWorkflowSteps: ["plan-review", "code-review"], workflowStepResults: results } as Task;
}
function restart(subject: Task) {
  const result = planTaskColumnRestart({ task: subject, ir, entryNode: { id: "code-review", column: "review" }, now: "2026-09-12T22:54:00.000Z" });
  if (result.kind !== "restart") throw new Error("expected restart");
  return result;
}

describe("review Retry blocking required gate recovery", () => {
  it.each(["failed", "pending"] as const)("discards earlier required %s evidence but preserves the review column", (status) => {
    const result = restart(task([{ workflowStepId: "plan-review", status }, { workflowStepId: "implementation", status: "passed" }]));
    expect(result.scope).toBe("review");
    expect(result.columnId).toBe("review");
    expect(result.entryNodeId).toBe("code-review");
    expect(result.discardedWorkflowStepIds).toContain("plan-review");
    expect(result.patch.workflowStepResults).toEqual([expect.objectContaining({ workflowStepId: "implementation" })]);
  });

  it("retains passed, skipped, bypassed, non-enabled and post-merge evidence", () => {
    const result = restart(task([
      { workflowStepId: "plan-review", status: "passed" },
      { workflowStepId: "plan-review", status: "failed", bypassedBy: "operator" },
      { workflowStepId: "other", status: "failed" },
      { workflowStepId: "post", status: "failed", phase: "post-merge" },
    ]));
    expect(result.discardedWorkflowStepIds).not.toContain("plan-review");
    expect(result.patch.workflowStepResults).toHaveLength(3);
  });

  it("leaves the merge door closed until a fresh approval exists", () => {
    const result = restart(task([{ workflowStepId: "plan-review", status: "failed" }]));
    const after = { ...task(), ...result.patch, column: "in-review", paused: false } as Task;
    const required = new Set(["plan-review"]);
    expect(evaluatePreMergeApprovals(after, { requiredPreMergeStepIds: required })[0]?.state).toBe("missing");
    expect(getTaskMergeBlocker(after, { requiredPreMergeStepIds: required })).toBeTruthy();
    after.workflowStepResults = [{ workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" }];
    expect(getTaskMergeBlocker(after, { requiredPreMergeStepIds: required })).toBeUndefined();
  });
});
