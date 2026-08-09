/**
 * FNXC:CodeOrganization 2026-08-03-12:45:
 * Pure pending-review log scan peeled from executor.ts (U4 Slice A).
 * Detects in-progress steps blocked on review request/verdict log patterns.
 */
import type { Task } from "@fusion/core";
import type { ReviewVerdict } from "../execution/reviewer.js";

export type PendingReviewBlockResult =
  | {
    blocked: true;
    reason:
      | "review-request-without-verdict"
      | "code-review-rethink-or-unavailable-outstanding"
      | "code-review-unavailable-blocking";
    stepIndex: number;
  }
  | { blocked: false };

export function detectPendingReviewBlock(
  task: Task,
  _codeReviewVerdicts: Map<number, ReviewVerdict>,
): PendingReviewBlockResult {
  const inProgressStepIndices: number[] = [];
  for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
    if (task.steps[stepIndex]?.status === "in-progress") {
      inProgressStepIndices.push(stepIndex);
    }
  }

  if (inProgressStepIndices.length === 0) {
    return { blocked: false };
  }

  const recentActions = (task.log ?? [])
    .slice(-30)
    .map((entry) => entry.action?.trim())
    .filter((action): action is string => Boolean(action));

  for (const stepIndex of inProgressStepIndices) {
    const stepDisplay = stepIndex;
    const codeRequest = `code review requested for Step ${stepDisplay}`;
    const planRequest = `plan review requested for Step ${stepDisplay}`;
    const codeVerdictPrefix = `code review Step ${stepDisplay}:`;
    const planVerdictPrefix = `plan review Step ${stepDisplay}:`;

    for (let i = recentActions.length - 1; i >= 0; i--) {
      const action = recentActions[i];
      if (!action) {
        continue;
      }

      if (action.startsWith(codeRequest) || action.startsWith(planRequest)) {
        return { blocked: true, reason: "review-request-without-verdict", stepIndex };
      }

      if (action.startsWith(`${codeVerdictPrefix} RETHINK`)) {
        return { blocked: true, reason: "code-review-rethink-or-unavailable-outstanding", stepIndex };
      }

      if (action.startsWith(`${codeVerdictPrefix} UNAVAILABLE`)
        && action.includes("blocking until reviewer returns a usable verdict")) {
        return { blocked: true, reason: "code-review-unavailable-blocking", stepIndex };
      }

      if (action.startsWith(codeVerdictPrefix) || action.startsWith(planVerdictPrefix)) {
        break;
      }
    }
  }

  return { blocked: false };
}
