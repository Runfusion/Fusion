import type { PrInfo, Task } from "@fusion/core";
import type { ColumnRoleFlags } from "./columnRoles";
import { isReviewColumnRole, isWipColumnRole } from "./columnRoles";

export function getTaskPrimaryPrInfo(task: Pick<Task, "prInfo" | "prInfos">): PrInfo | undefined {
  return task.prInfos?.[0] ?? task.prInfo;
}

/*
FNXC:TaskReview 2026-06-28-00:00:
The Address PR feedback affordance must render identically on the task card and Review tab. Gate it on one shared predicate so a linked primary PR with comments or CHANGES_REQUESTED is actionable, while no-PR and no-feedback states render no empty button shell.

FNXC:TaskReview 2026-06-28-16:39:
The button promises an AI session starts, so it must only render for task states the lifecycle route can actually start or wake. Restrict the launch affordance to in-review and in-progress tasks rather than letting terminal/todo cards add steering comments without active work.
*/
export function hasActionablePrFeedback(task: Pick<Task, "prInfo" | "prInfos">): boolean {
  const prInfo = getTaskPrimaryPrInfo(task);
  if (!prInfo) return false;
  return (prInfo.commentCount ?? 0) > 0 || prInfo.lastReviewDecision === "CHANGES_REQUESTED";
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-11:10 (#2744 review — greptile P1, a half-conversion I shipped):
The lane pair here is the SAME question TaskReviewTab and TaskCard ask, and converting only the callers
left this rejecting custom column ids. Measured consequence: on a renamed review or WIP lane a task with
actionable PR feedback but no loaded display items had the Address-PR-Feedback action stay hidden, because
the caller's role check passed and this returned false.

Optional flags, legacy ids as the documented fallback — so any caller without resolved flags is unchanged.
*/
export function canStartPrFeedbackAddressing(
  task: Pick<Task, "column" | "prInfo" | "prInfos">,
  columnFlags?: ColumnRoleFlags,
): boolean {
  return (isReviewColumnRole(columnFlags, task.column) || isWipColumnRole(columnFlags, task.column))
    && hasActionablePrFeedback(task);
}
