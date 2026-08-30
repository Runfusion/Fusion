/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * cleanupMergeStateForReverification peeled from TaskExecutor (U4).
 * Clears merge/status bookkeeping and reopens verification suffix steps for re-verification.
 */
import type { Task, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { preservePreExecutionWorkflowStepResults } from "./workflow-step-satisfaction.js";

export type CleanupMergeStateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function cleanupMergeStateForReverification(
  deps: CleanupMergeStateDeps,
  task: Task,
  logMessage: string,
  options?: { preserveVerificationFailureCount?: boolean; stepReopenPolicy?: "reopen-trailing" | "none" },
): Promise<Task> {
  const preservedWorkflowStepResults = preservePreExecutionWorkflowStepResults(task);
  await deps.store.updateTask(task.id, {
    mergeDetails: null,
    mergeRetries: 0,
    status: null,
    error: null,
    verificationFailureCount: options?.preserveVerificationFailureCount ? task.verificationFailureCount ?? 0 : 0,
    workflowStepResults: preservedWorkflowStepResults,
  });

  /*
   * FNXC:WorkflowStepReopenAuthority 2026-08-23-08:51:
   * FN-180 makes sendTaskBackForFix the sole workflow-resolved replay authority. Cleanup only
   * clears stale merge bookkeeping: reopening here and again during the remediation bounce could
   * reopen two different steps from one rejection. The resolved policy still travels through each
   * caller to the send-back path, where `none` has a concrete no-reopen exit.
   */
  await deps.store.logEntry(task.id, logMessage, undefined, deps.getRunContextFor(task.id));
  return deps.store.getTask(task.id);
}
