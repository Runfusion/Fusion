import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:WorkflowRemediation 2026-06-29-16:18:
Review-gate remediation must be visible in the workflow graph instead of living only in executor fallback branches. These prompt nodes are graph-owned lifecycle policy: Plan Review failure routes to an automatic replan handoff, while Code Review and Browser Verification failures route to implementation remediation handoffs. The engine still enforces the handoff mechanics and budgets.
*/

export const PLAN_REPLAN_NODE_ID = "plan-replan";
export const BROWSER_VERIFICATION_REMEDIATION_NODE_ID = "browser-verification-remediation";
export const CODE_REVIEW_REMEDIATION_NODE_ID = "code-review-remediation";

export function planReplanNode(column = "triage"): WorkflowIrNode {
  return {
    id: PLAN_REPLAN_NODE_ID,
    kind: "prompt",
    column,
    config: {
      name: "Plan Replan",
      workflowAction: "plan-replan",
      forWorkflowStepId: "plan-review",
      toolMode: "readonly",
    },
  };
}

export function browserVerificationRemediationNode(column = "in-progress"): WorkflowIrNode {
  return {
    id: BROWSER_VERIFICATION_REMEDIATION_NODE_ID,
    kind: "prompt",
    column,
    config: {
      name: "Browser Verification Remediation",
      workflowAction: "pre-merge-remediation",
      forWorkflowStepId: "browser-verification",
      toolMode: "coding",
    },
  };
}

export function codeReviewRemediationNode(column = "in-progress"): WorkflowIrNode {
  return {
    id: CODE_REVIEW_REMEDIATION_NODE_ID,
    kind: "prompt",
    column,
    config: {
      name: "Code Review Remediation",
      workflowAction: "pre-merge-remediation",
      forWorkflowStepId: "code-review",
      toolMode: "coding",
    },
  };
}
