/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * Self-healing step-progress predicate peeled from self-healing.ts (U5 / wave19 Slice A).
 *
 * Distinct from `healing/restart-recovery-coordinator.hasStepProgress`: this counts any
 * non-pending step as progress (including statuses outside done/in-progress/skipped).
 * `autoRecoverWorktreeSessionStartFailure` depends on that broader definition.
 */
import type { Task } from "@fusion/core";

export function hasStepProgress(task: Task): boolean {
  return task.steps.some((step) => step.status !== "pending");
}

export function isTaskWorkComplete(task: Task): boolean {
  if (task.steps.length === 0) return false;
  return task.steps.every((step) => step.status === "done" || step.status === "skipped");
}

export function isNoTaskDoneFailure(task: Task): boolean {
  const error = task.error?.toLowerCase() ?? "";
  return error.includes("without calling fn_task_done") || error.includes("without calling task_done");
}
