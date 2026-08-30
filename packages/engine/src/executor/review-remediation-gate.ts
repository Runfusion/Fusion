import type { RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";

export type ReviewRemediationGate = "Code Review" | "Verification";

/*
FNXC:ReviewGatedRemediation 2026-08-28-12:16:
Review remediation gate identity follows the same structural-signal rule as the review seal. A custom node such as the reported `code-review-step` remains Code Review when `reviewKind` is `code`; deterministic verification likewise follows `workflowAction` instead of requiring a built-in node id.
*/
export function resolveReviewRemediationGate(
  info: Pick<RequestPreMergeOptionalStepFixInfo, "nodeId" | "reviewKind" | "workflowAction">,
): ReviewRemediationGate | undefined {
  if (info.nodeId === "code-review" || info.reviewKind === "code") return "Code Review";
  if (info.nodeId === "verification" || info.workflowAction === "deterministic-verification") return "Verification";
  return undefined;
}
