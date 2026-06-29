import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "./builtin-stepwise-coding-workflow-ir.js";
import { planReviewOptionalGroupNode } from "./builtin-plan-review-group.js";

function cloneWorkflowIr(ir: WorkflowIr): WorkflowIr {
  return JSON.parse(JSON.stringify(ir)) as WorkflowIr;
}

/*
FNXC:WorkflowBuiltins 2026-06-28-23:09:
Operators need graph-owned step execution without per-step AI review. This built-in preserves the per-step-review workflow's parse-steps and sequential foreach model, then runs the normal end-of-task browser/code-review/final-review/merge suffix after all planned steps finish.

FNXC:WorkflowBuiltins 2026-06-28-23:29:
The new default Coding workflow should have only one review surface at the end, controlled by the `code-review` optional step. Keep the optional group default-on/toggleable, remove the mandatory final `review` seam from this derived graph, and route approved or disabled code review directly into the merge gate.

FNXC:WorkflowBuiltins 2026-06-28-23:29:
Plan Review is also an optional step, but it runs before execution rather than at the end. Insert the `plan-review` group between `plan` and `parse` so a task can review PROMPT.md before planned steps become executable work.
*/
const RAW_BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR: WorkflowIr = (() => {
  const ir = cloneWorkflowIr(BUILTIN_STEPWISE_CODING_WORKFLOW_IR);
  ir.name = "builtin-stepwise-final-review-coding";

  const foreach = ir.nodes.find((node) => node.id === "steps" && node.kind === "foreach");
  const template = foreach?.config?.template as
    | {
        nodes?: Array<{ id: string; kind: string; config?: Record<string, unknown> }>;
        edges?: Array<{ from: string; to: string; condition?: string; kind?: string }>;
      }
    | undefined;
  if (!template?.nodes || !template.edges) {
    throw new Error("stepwise final-review built-in requires the stepwise foreach template");
  }

  const planIndex = ir.nodes.findIndex((node) => node.id === "plan");
  if (planIndex < 0) {
    throw new Error("stepwise final-review built-in requires a plan node");
  }
  if (!ir.nodes.some((node) => node.id === "plan-review")) {
    ir.nodes.splice(planIndex + 1, 0, planReviewOptionalGroupNode("in-progress"));
  }

  template.nodes = template.nodes.filter((node) => node.id !== "step-review");
  template.edges = [
    { from: "step-execute", to: "step-done", condition: "success" },
  ];

  ir.nodes = ir.nodes.filter((node) => node.id !== "rework-hold");
  ir.nodes = ir.nodes.filter((node) => node.id !== "review");
  ir.edges = ir.edges.filter(
    (edge) => edge.from !== "rework-hold" && edge.to !== "rework-hold" && edge.from !== "review" && edge.to !== "review",
  );
  ir.edges = ir.edges.filter((edge) => !(edge.from === "plan" && edge.to === "parse"));
  if (!ir.edges.some((edge) => edge.from === "plan" && edge.to === "plan-review")) {
    ir.edges.push({ from: "plan", to: "plan-review", condition: "success" });
  }
  if (!ir.edges.some((edge) => edge.from === "plan-review" && edge.to === "parse")) {
    ir.edges.push({ from: "plan-review", to: "parse", condition: "success" });
  }
  if (!ir.edges.some((edge) => edge.from === "plan-review" && edge.to === "end" && edge.condition === "failure")) {
    ir.edges.push({ from: "plan-review", to: "end", condition: "failure" });
  }
  if (!ir.edges.some((edge) => edge.from === "code-review" && edge.to === "merge-gate" && edge.condition === "success")) {
    ir.edges.push({ from: "code-review", to: "merge-gate", condition: "success" });
  }

  return ir;
})();

export const BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR = parseWorkflowIr(
  RAW_BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
);
