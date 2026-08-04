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

/**
 * FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
 * Approval controls normally belong to intake, but an exhausted Plan Review remains in the
 * graph node's review column. Keep that persisted-reason exception shared by card and detail
 * surfaces so a split-column workflow never renders a hold without its operator controls.
 */
export function isTaskAwaitingPlanApproval(task: Task, isIntakeColumn: boolean): boolean {
  return task.status === "awaiting-approval"
    && (isIntakeColumn || task.awaitingApprovalReason === "plan-review-replan-cap");
}
