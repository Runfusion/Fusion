import type { Task } from "./types.js";

export const IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON = "in-review-stall-deadlock";

export const MANUAL_RETRY_RESET_COUNTER_KEYS = [
  "stuckKillCount",
  "resumeLimboCount",
  "executeRequeueLoopCount",
  "graphResumeRetryCount",
  "recoveryRetryCount",
  "taskDoneRetryCount",
  "worktreeSessionRetryCount",
  "workflowStepRetries",
  "verificationFailureCount",
  "postReviewFixCount",
  "planReviewReplanCount",
  "mergeConflictBounceCount",
  "branchConflictRecoveryCount",
  "reviewerContextRetryCount",
  "reviewerFallbackRetryCount",
  "completionHandoffLimboRecoveryCount",
  "mergeAuditBounceCount",
] as const satisfies ReadonlyArray<keyof Task>;

export function buildAutoPauseClearPatch(
  task: Pick<Task, "paused" | "userPaused" | "pausedReason">,
): Partial<Task> {
  if (
    task.paused === true
    && task.userPaused !== true
    && task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON
  ) {
    return {
      paused: false,
      pausedReason: null as unknown as Task["pausedReason"],
    };
  }

  return {};
}

export function buildManualRetryResetPatch(options?: { resetMergeRetries?: boolean }): Partial<Task> {
  const patch: Partial<Task> = {
    nextRecoveryAt: null as unknown as Task["nextRecoveryAt"],
  };

  for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
    patch[key] = 0;
  }

  if (options?.resetMergeRetries) {
    patch.mergeRetries = 0;
  }

  return patch;
}
