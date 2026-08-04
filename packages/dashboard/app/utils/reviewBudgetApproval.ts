import type { Task } from "../../../core/src/types";

/**
 * FNXC:PlanReviewReplan 2026-07-15-12:15:
 * FN-7985 requires every task surface to distinguish the manual approval caused by the
 * exhausted triage Plan Review budget from ordinary plan-approval and release-authorization
 * holds. Keep the persisted reason check centralized so card, list, and detail stay aligned.
 */
export function isReviewBudgetExhaustedApproval(task: Task): boolean {
  return task.status === "awaiting-approval" && task.awaitingApprovalReason === "plan-review-replan-cap";
}

/** Approval controls follow the intake lane except for the graph's exhausted-review park. */
export function isTaskAwaitingPlanApproval(task: Task, isIntakeColumn: boolean): boolean {
  return task.status === "awaiting-approval"
    && (isIntakeColumn || task.awaitingApprovalReason === "plan-review-replan-cap");
}
