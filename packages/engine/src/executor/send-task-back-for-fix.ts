/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * sendTaskBackForFix peeled from TaskExecutor (U4).
 * Verification/review failure bounce: comment, inject PROMPT failure section, reopen steps, schedule rerun.
 *
 * FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
 * Remediation reuses the live external checkout path and must not persist it as task.worktree.
 */
import type { Task, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";

export type SendTaskBackForFixDeps = {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  injectWorkflowStepFailureInstructions: (
    task: Task,
    failureFeedback: string,
    stepName: string,
    retry: { attempt: number; max?: number },
  ) => Promise<void>;
  reopenLastStepForRevision: (
    taskId: string,
    task: Task,
  ) => Promise<unknown>;
  scheduleWorkflowRerun: (
    taskId: string,
    worktreePath: string,
    message: string,
    preserveResumeState: boolean,
    persistWorktreePath?: boolean,
  ) => void;
  maxWorkflowStepRetries: number;
};

export async function sendTaskBackForFix(
  deps: SendTaskBackForFixDeps,
  task: Task,
  worktreePath: string,
  failureFeedback: string,
  stepName: string,
  reason: string,
  preserveResumeState: boolean = true,
  mergeVerificationFailure: boolean = false,
  retryPresentation?: { attempt: number; max?: number },
): Promise<void> {
  const taskId = task.id;
  deps.clearCompletedTaskWatchdog(taskId);
  const { task: authoritativeRemediationTask, route: externalExecutionRoute } =
    await resolveAuthoritativeExternalExecutionRoute(deps.store, task);
  if (externalExecutionRoute.configured && !externalExecutionRoute.valid) {
    throw new Error(`Persisted external execution checkout is invalid: ${externalExecutionRoute.reason ?? "unknown error"}`);
  }
  /*
  FNXC:ExternalExecutionCheckout 2026-08-10-01:06:
  Remediation must fail closed unless a configured persisted route resolves to a concrete checkout path.
  Never turn malformed operator-owned routing into an empty managed-worktree path.
  */
  if (externalExecutionRoute.configured && !externalExecutionRoute.checkoutPath) {
    throw new Error("Persisted external execution checkout is invalid: checkoutPath is missing");
  }
  const remediationWorktreePath = externalExecutionRoute.configured
    ? externalExecutionRoute.checkoutPath!
    : worktreePath;

  // 1. Add a task comment explaining the failure
  await deps.store.addTaskComment(
    taskId,
    `${reason}. The failing workflow step was "${stepName}". ` +
    `Feedback:\n${failureFeedback}\n\n` +
    `Please fix the issues so the verification can pass on the next attempt.`,
    "agent",
  );

  // 2. Log an entry explaining the task was sent back
  await deps.store.logEntry(
    taskId,
    `${reason} — moved back to in-progress for remediation`,
  );

  /*
   * FNXC:CodeReviewRetryBudget 2026-07-22-00:00:
   * A graph-owned Code Review REVISE is not a workflow-step hard-failure retry.
   * Preserve its resolved per-step budget in PROMPT.md: unset Code Review policy
   * is unlimited, while an explicit finite value (including zero at the gate)
   * remains operator-visible. The execute requeue progress-signature guard, not
   * this display, remains the safety boundary for unchanged remediation loops.
   */
  await deps.injectWorkflowStepFailureInstructions(
    authoritativeRemediationTask,
    failureFeedback,
    stepName,
    retryPresentation ?? { attempt: deps.maxWorkflowStepRetries, max: deps.maxWorkflowStepRetries },
  );

  // 4. Re-open only the last step for a single in-place fix pass. Earlier
  // done steps stay done so the executor doesn't redo finished work.
  const updatedTask = await deps.store.getTask(taskId);
  await deps.reopenLastStepForRevision(taskId, updatedTask);

  // 5. Clear error/status/session fields and reset workflow step retries.
  //    FNXC:ReviewLeniency 2026-07-02-02:10: prior terminal failure results
  //    (incl. optional gate nodes like code-review) are cleared by the rerun
  //    bounce AFTER the task leaves the mergeable in-review column (see
  //    clearTerminalStepFailuresForRetry), NOT here — clearing them while the
  //    task is still in-review would drop the merge blocker during the async
  //    bounce window and let a concurrent auto-merge sweep merge an
  //    empty-`steps` graph-native task with the gate failure unaddressed.
  await deps.store.updateTask(taskId, {
    status: mergeVerificationFailure ? "merging-fix" : null,
    error: null,
    sessionFile: null,
    workflowStepRetries: 0,
  });

  // 6. Schedule the move after the guard unwinds (per guard-unwind requirement)
  deps.scheduleWorkflowRerun(
    taskId,
    remediationWorktreePath,
    `${taskId}: sent back to in-progress for remediation`,
    preserveResumeState,
    !externalExecutionRoute.configured,
  );
}
