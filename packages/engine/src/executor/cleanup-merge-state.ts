/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * cleanupMergeStateForReverification peeled from TaskExecutor (U4).
 * Clears merge/status bookkeeping and reopens verification suffix steps for re-verification.
 */
import type { Task, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { isTaskWorkComplete } from "./task-predicates.js";
import { preservePreExecutionWorkflowStepResults } from "./workflow-step-satisfaction.js";

export type CleanupMergeStateDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  reopenLastStepForRevision: (
    taskId: string,
    task: Task,
  ) => Promise<{ index: number } | null | undefined | false | void>;
};

export async function cleanupMergeStateForReverification(
  deps: CleanupMergeStateDeps,
  task: Task,
  logMessage: string,
  options?: { preserveVerificationFailureCount?: boolean },
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

  const refreshedTask = await deps.store.getTask(task.id);
  const steps = refreshedTask.steps ?? [];
  if (steps.length > 0) {
    const allStepsComplete = isTaskWorkComplete(refreshedTask);
    if (allStepsComplete) {
      await deps.reopenLastStepForRevision(task.id, refreshedTask);
    } else {
      const resetIndexes = new Set<number>();
      for (let i = 0; i < steps.length; i++) {
        const name = steps[i].name.toLowerCase();
        if (/testing|verification/.test(name) || /documentation|delivery/.test(name)) {
          resetIndexes.add(i);
        }
      }

      if (resetIndexes.size === 0) {
        const reopened = await deps.reopenLastStepForRevision(task.id, refreshedTask);
        if (reopened && typeof reopened === "object" && "index" in reopened) {
          resetIndexes.add(reopened.index);
        }
      } else {
        for (const index of resetIndexes) {
          if (steps[index].status !== "pending") {
            await deps.store.updateStep(task.id, index, "pending");
          }
        }
        const earliestIndex = Math.min(...Array.from(resetIndexes));
        await deps.store.updateTask(task.id, { currentStep: earliestIndex });
      }
    }
  }

  await deps.store.logEntry(task.id, logMessage, undefined, deps.getRunContextFor(task.id));
  return deps.store.getTask(task.id);
}
