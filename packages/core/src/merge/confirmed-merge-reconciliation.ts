import type { Task, WorkflowStepResult } from "../types.js";
import { BLOCKING_TASK_STATUSES, clearMergeConfirmedTransientStatus } from "./task-merge.js";

export type ConfirmedMergeChecklistReconciliation = {
  skippedStepIndexes: number[];
  reconciledWorkflowStepIds: string[];
};

/*
FNXC:ConfirmedMergeFinalization 2026-08-23-07:42:
FN-180 requires a confirmed integration merge to finalize even when a concurrent
review bounce left a stale checklist. Post-merge checks deliberately exclude
steps and review verdicts; only independent task blocking states may defer.
*/
export function getPostMergeFinalizeBlocker(task: Pick<Task, "status" | "error">): string | undefined {
  const status = clearMergeConfirmedTransientStatus(task.status);
  if (status && BLOCKING_TASK_STATUSES.has(status)) {
    return task.error ? `task is marked '${status}': ${task.error}` : `task is marked '${status}'`;
  }
  return undefined;
}

export function planConfirmedMergeChecklistReconciliation(
  task: Pick<Task, "steps" | "workflowStepResults">,
): ConfirmedMergeChecklistReconciliation {
  return {
    skippedStepIndexes: task.steps
      .map((step, index) => step.status === "pending" || step.status === "in-progress" ? index : -1)
      .filter((index) => index >= 0),
    reconciledWorkflowStepIds: (task.workflowStepResults ?? [])
      .filter((result: WorkflowStepResult) => result.status === "pending")
      .map((result) => result.workflowStepId),
  };
}
