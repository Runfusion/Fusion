import { describe, expect, it } from "vitest";
import { getRunningWorkflowStepLabel, getUnifiedTaskProgress } from "../taskProgress";

describe("review-gated progress", () => {
  const task = {
    steps: [{ name: "Implement", status: "done" as const }],
    enabledWorkflowSteps: ["verification", "code-review", "documentation-delivery"],
    workflowStepResults: [{ workflowStepId: "verification", workflowStepName: "Verification", phase: "pre-merge" as const, source: "optional-group" as const, status: "pending" as const, startedAt: "2026-08-23T00:00:00.000Z" }],
  };

  it("excludes review gates from implementation progress and orders them after steps in full progress", () => {
    expect(getUnifiedTaskProgress(task, { scope: "implementation" }).items.map((item) => item.name)).toEqual(["Implement"]);
    expect(getUnifiedTaskProgress(task).items.map((item) => item.name)).toEqual(["Implement", "Verification", "Code Review", "Documentation Delivery"]);
  });

  it("uses the persisted verification name for the running-gate badge", () => {
    expect(getRunningWorkflowStepLabel(task)).toBe("Verification");
  });
});

/*
FNXC:TaskCardWorkflowProgress 2026-08-24-19:30:
A review-column workflow (builtin:coding-ideas-v2) promotes Verification and Documentation &
Delivery from hidden checklist entries into first-class review-lane gates. Implementation scope
hides exactly those, so a board card or list row in the review lane must use the FULL pipeline or it
reports nothing for the stage the operator moved them there to watch.
*/
describe("review-lane gate visibility", () => {
  const task = {
    steps: [{ name: "Implement", status: "done" }],
    enabledWorkflowSteps: ["plan-review", "verification", "documentation-delivery", "code-review"],
    workflowStepResults: [
      { workflowStepId: "plan-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" },
      { workflowStepId: "verification", status: "passed", phase: "pre-merge" },
      { workflowStepId: "documentation-delivery", status: "in-progress", phase: "pre-merge" },
    ],
  } as never;

  it("hides the review gates from implementation scope", () => {
    const ids = getUnifiedTaskProgress(task, { scope: "implementation" }).items.map((item) => item.id);
    expect(ids).not.toContain("workflow-verification");
    expect(ids).not.toContain("workflow-documentation-delivery");
  });

  it("surfaces Verification and Documentation & Delivery in the full pipeline", () => {
    const ids = getUnifiedTaskProgress(task, { scope: "full" }).items.map((item) => item.id);
    expect(ids).toContain("workflow-verification");
    expect(ids).toContain("workflow-documentation-delivery");
    expect(ids).toContain("workflow-code-review");
  });
});
