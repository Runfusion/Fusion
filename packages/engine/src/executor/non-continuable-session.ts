/**
 * FNXC:CodeOrganization 2026-08-03-17:40:
 * handleNonContinuableSessionError + handleNonContinuableSessionRetry peeled from TaskExecutor (U4).
 * Post-done non-continuable session suppression and fresh-session recovery retry budget.
 */
import type { Task, TaskStore } from "@fusion/core";
import { isNonContinuableSessionError } from "../errors/transient-error-detector.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { isTaskAlreadyCompleteForNonContinuableSession } from "./completion-predicates.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type NonContinuableSessionDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string) => Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  signalTaskComplete: (task: Task) => void;
  handoffTaskToReview: (task: Task, reason: string) => Promise<unknown>;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
};

export async function handleNonContinuableSessionError(
  deps: NonContinuableSessionDeps,
  task: Task,
  taskDone: boolean,
  errorMessage: string,
): Promise<boolean> {
  if (!isNonContinuableSessionError(errorMessage)) {
    return false;
  }

  const liveTask = await deps.store.getTask(task.id);
  const nonContinuableLanes = await deps.resolveResumeLanes(task.id);
  if (!liveTask || !isTaskAlreadyCompleteForNonContinuableSession(liveTask, taskDone, nonContinuableLanes.review)) {
    return false;
  }

  const diagnosticMessage = "Post-done session continuation suppressed — session not continuable (last role assistant); task work already complete, leaving clean in-review";
  executorLog.warn(`${task.id} ${diagnosticMessage}`);
  await deps.store.logEntry(task.id, diagnosticMessage, errorMessage, deps.getRunContextFor(task.id));

  if (liveTask.status === "failed" || liveTask.error) {
    await deps.store.updateTask(task.id, { status: null, error: null });
  }

  await deps.persistTokenUsage(task.id);

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2703 review — greptile P1, and it is the same split
  I have been fixing all day, in code I wrote an hour earlier):
  ONE SNAPSHOT. The eligibility check above already resolved this task's lanes
  (`nonContinuableLanes`), and this branch resolved them AGAIN. A workflow selection or review-column
  edit between the two makes eligibility accept the card on the old board while this branch reads the new
  one — the card is then handed to `handoffTaskToReview`, reprocessing a row already in review.

  Writing the second resolution was not carelessness about the rule; it is that the rule is invisible at
  the call site. That is the argument for the structural ratchet in
  `executor-graph-failure-lanes-resolved.test.ts` rather than for trying harder.
  */
  if (liveTask.column === nonContinuableLanes.review) {
    deps.clearCompletedTaskWatchdog(task.id);
    deps.signalTaskComplete(liveTask);
    return true;
  }

  const refreshedTask = await deps.store.getTask(task.id);
  await deps.handoffTaskToReview(refreshedTask ?? liveTask, "post-done-noncontinuable");
  deps.clearCompletedTaskWatchdog(task.id);
  deps.signalTaskComplete(refreshedTask ?? liveTask);
  return true;
}

export async function handleNonContinuableSessionRetry(
  deps: NonContinuableSessionDeps,
  task: Task,
  errorMessage: string,
): Promise<boolean> {
  if (!isNonContinuableSessionError(errorMessage)) {
    return false;
  }

  const liveTask = await deps.store.getTask(task.id);
  if (!liveTask) {
    return false;
  }

  const decision = computeRecoveryDecision({
    recoveryRetryCount: liveTask.recoveryRetryCount,
    nextRecoveryAt: liveTask.nextRecoveryAt,
  });

  if (decision.shouldRetry) {
    const attempt = decision.nextState.recoveryRetryCount;
    const delay = formatDelay(decision.delayMs);
    executorLog.warn(`⚡ ${task.id} non-continuable session — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
    await deps.store.logEntry(task.id, `Non-continuable session — fresh-session retry (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
    await deps.store.updateTask(task.id, {
      recoveryRetryCount: decision.nextState.recoveryRetryCount,
      nextRecoveryAt: decision.nextState.nextRecoveryAt,
      sessionFile: null,
    });
    deps.markGraphExecuteSelfRequeued(task.id);
    await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: true });
    return true;
  }

  executorLog.error(`✗ ${task.id} non-continuable session fresh-session retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
  await deps.store.logEntry(task.id, `Non-continuable session fresh-session retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, deps.getRunContextFor(task.id));
  await deps.store.updateTask(task.id, {
    recoveryRetryCount: null,
    nextRecoveryAt: null,
  });
  return false;
}
