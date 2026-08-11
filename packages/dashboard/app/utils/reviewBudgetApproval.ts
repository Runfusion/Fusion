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

/*
FNXC:TaskCardPromote 2026-08-11-09:09:
FN-8950 mirrors `isPlanReviewSatisfied`, `isWorkflowOptionalGroupEnabled`, and
`isTaskBlockedOnApproval` here because core's plan-approval module imports `node:crypto` at
module top and must not enter the browser bundle. The default-on fallback is load-bearing:
an absent enabled-steps array means the built-in default-on plan-review gate applies, rather
than that the gate is disabled. The contract test below prevents this deliberate duplication
from drifting.

`isTaskBlockedOnApprovalHold` intentionally has no column argument. Unlike the intake-gated
approval-control predicate above, the server refuses both approval-hold shapes on every column.
*/
export function isPlanReviewGateUnsatisfied(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults">,
  options?: { defaultOn?: boolean },
): boolean {
  const enabled = Array.isArray(task.enabledWorkflowSteps)
    ? task.enabledWorkflowSteps.includes("plan-review")
    : (options?.defaultOn ?? true);
  if (!enabled) return false;

  return !task.workflowStepResults?.some((result) => {
    if (result.workflowStepId !== "plan-review" || result.supersededAt != null) return false;
    if (result.status === "passed") return true;
    return result.status === "skipped"
      && (result.bypassedFromStatus === "failed" || result.bypassedFromStatus === "advisory_failure")
      && result.bypassedFromVerdict === "REVISE"
      && typeof result.bypassedBy === "string"
      && result.bypassedBy.trim().length > 0
      && typeof result.bypassedAt === "string"
      && result.bypassedAt.trim().length > 0
      && typeof result.bypassReason === "string"
      && result.bypassReason.trim().length > 0;
  });
}

export function isTaskBlockedOnApprovalHold(
  task: Pick<Task, "paused" | "pausedReason" | "status">,
): boolean {
  return (task.paused === true && task.pausedReason === "awaiting-approval")
    || task.status === "awaiting-approval";
}

/*
FNXC:PromoteVisibility 2026-08-11-20:38:
useTasks owns freshness. TaskCard consumes a present verdict verbatim for exact server parity; absent
or expired payloads retain FN-8950's conservative fallback rather than inventing a second authority.
*/
export function resolvePromoteSuppressed(task: Pick<Task, "releaseGate">, fallback: boolean): boolean {
  return task.releaseGate?.promoteBlocked ?? fallback;
}
