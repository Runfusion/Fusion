/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * resetMergeStateIfNeeded peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowResolvedColumns 2026-07-30-16:40 (executor):
 * Merge state is reset when a card leaves a lane where a merge could have been recorded — the REVIEW
 * and COMPLETE roles, not the two ids. On a renamed board neither comparison matched, so a card
 * re-entering execution carried STALE mergeDetails from its previous pass.
 *
 * `review` is not a trait: the role is carried by mergeOrchestration/mergeBlocker/humanReview, the same
 * five-flag set the dependency gates in this file use. Unioned with the legacy pair because
 * `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than throwing.
 */
import type { Task, TaskStore } from "@fusion/core";
import { columnsWithFlag, resolveWorkflowIrForTask } from "@fusion/core";

export type ResetMergeStateDeps = {
  store: TaskStore;
  cleanupMergeStateForReverification: (
    task: Task,
    logMessage: string,
    options?: { preserveVerificationFailureCount?: boolean },
  ) => Promise<Task>;
};

export async function resetMergeStateIfNeeded(
  deps: ResetMergeStateDeps,
  task: Task,
  from: Task["column"],
): Promise<Task> {
  const mergeBearingColumns = new Set<string>(["in-review", "done"]);
  try {
    const ir = await resolveWorkflowIrForTask(deps.store, task.id);
    if (ir) {
      for (const flag of ["complete", "mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
        for (const id of columnsWithFlag(ir, flag)) mergeBearingColumns.add(id);
      }
    }
  } catch { /* degraded: legacy pair only */ }
  if (!mergeBearingColumns.has(from)) {
    return task;
  }

  const hasMergeEvidence = Boolean(task.mergeDetails)
    || (task.mergeRetries ?? 0) > 0
    || (task.verificationFailureCount ?? 0) > 0
    || task.status === "merging"
    || task.status === "merging-pr"
    || task.status === "merging-fix";

  if (!hasMergeEvidence) {
    return task;
  }

  return deps.cleanupMergeStateForReverification(
    task,
    `Task returned to in-progress from ${from} column — resetting verification steps and merge state for re-verification`,
    {
      // Keep deterministic merge-verification bounce budget across remediation
      // cycles. Status may be cleared by intermediate paths, so the counter is
      // the canonical signal once a bounce has started.
      preserveVerificationFailureCount: (task.verificationFailureCount ?? 0) > 0,
    },
  );
}
