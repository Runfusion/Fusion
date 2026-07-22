import type { RetrySummary, Task, TaskDetail } from "../types.js";

export const RETRY_STORM_WARNING_RATIO = 0.8;

const toCount = (value: number | null | undefined): number => (typeof value === "number" ? value : 0);

export function computeRetrySummary(task: Pick<Task | TaskDetail, "stuckKillCount" | "recoveryRetryCount" | "taskDoneRetryCount" | "worktreeSessionRetryCount" | "workflowStepRetries" | "verificationFailureCount" | "postReviewFixCount" | "mergeConflictBounceCount" | "branchConflictRecoveryCount" | "reviewerContextRetryCount" | "reviewerFallbackRetryCount">): RetrySummary {
  const stuckKill = toCount(task.stuckKillCount);
  const recovery = toCount(task.recoveryRetryCount);
  const taskDone = toCount(task.taskDoneRetryCount);
  const worktreeSession = toCount(task.worktreeSessionRetryCount);
  const workflowStep = toCount(task.workflowStepRetries);
  const verification = toCount(task.verificationFailureCount);
  const postReviewFix = toCount(task.postReviewFixCount);
  const mergeConflict = toCount(task.mergeConflictBounceCount);
  const branchConflict = toCount(task.branchConflictRecoveryCount);
  const reviewerContext = toCount(task.reviewerContextRetryCount);
  const reviewerFallback = toCount(task.reviewerFallbackRetryCount);
  const total = stuckKill
    + recovery
    + taskDone
    + worktreeSession
    + workflowStep
    + verification
    + postReviewFix
    + mergeConflict
    + branchConflict
    + reviewerContext
    + reviewerFallback;

  return {
    stuckKill,
    recovery,
    taskDone,
    worktreeSession,
    workflowStep,
    verification,
    postReviewFix,
    mergeConflict,
    branchConflict,
    reviewerContext,
    reviewerFallback,
    total,
  };
}
