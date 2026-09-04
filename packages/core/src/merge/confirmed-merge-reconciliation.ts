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

FNXC:ConfirmedMergeFinalization 2026-08-28-11:05:
A failed status cannot block post-merge finalization because all consumers establish durable merge
or landing proof before calling this helper: the shared finalizer uses hasDurableMergeProof, the
project-engine fast path verifies mergeConfirmed reachability, and self-healing proves the landed
commit. getTaskHardMergeBlocker already neutralizes failed for the same FN-9193 failure shape. This
is not a laundering path: keeping proven-landed work out of completion cannot un-merge it and only
leaves a permanently failed board card; every independent operator and planning status still blocks.
*/
export function getPostMergeFinalizeBlocker(task: Pick<Task, "status" | "error">): string | undefined {
  const status = clearMergeConfirmedTransientStatus(task.status);
  if (status && status !== "failed" && BLOCKING_TASK_STATUSES.has(status)) {
    return task.error ? `task is marked '${status}': ${task.error}` : `task is marked '${status}'`;
  }
  return undefined;
}

export function planConfirmedMergeChecklistReconciliation(
  task: Pick<Task, "steps" | "workflowStepResults">,
): ConfirmedMergeChecklistReconciliation {
  /*
  FNXC:ConfirmedMergeFinalization 2026-09-01-05:49:
  `steps` is typed non-optional, but a row can still reach here without it — an older row, a partial
  projection, a store path that does not populate it. This function runs on the merge-CONFIRMED
  fast path, i.e. after the work has already landed, so a TypeError here abandons the finalize and
  leaves a merged task un-finalized. Tolerating the absence costs nothing; asserting the type does
  not make the row real. Measured: a task whose row carried no `steps` threw
  "Cannot read properties of undefined (reading 'map')" and the landed merge never finalized.
  */
  return {
    skippedStepIndexes: (task.steps ?? [])
      .map((step, index) => step.status === "pending" || step.status === "in-progress" ? index : -1)
      .filter((index) => index >= 0),
    reconciledWorkflowStepIds: (task.workflowStepResults ?? [])
      .filter((result: WorkflowStepResult) => result.status === "pending")
      .map((result) => result.workflowStepId),
  };
}
