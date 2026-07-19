import {
  computeRetrySummary,
  RetryStormError,
  type Settings,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";
import { createLogger } from "./logger.js";

const retryBurnedLog = createLogger("retry-burned");

type RetryCategory =
  | "branchConflict"
  | "reviewerContext"
  | "reviewerFallback"
  | "stuckKill"
  | "recovery"
  | "taskDone"
  | "workflowStep"
  | "verification"
  | "postReviewFix"
  | "mergeConflict"
  | "messageDelivery";

const CATEGORY_COLUMN: Record<RetryCategory, keyof TaskDetail> = {
  branchConflict: "branchConflictRecoveryCount",
  reviewerContext: "reviewerContextRetryCount",
  reviewerFallback: "reviewerFallbackRetryCount",
  stuckKill: "stuckKillCount",
  recovery: "recoveryRetryCount",
  taskDone: "taskDoneRetryCount",
  workflowStep: "workflowStepRetries",
  verification: "verificationFailureCount",
  postReviewFix: "postReviewFixCount",
  mergeConflict: "mergeConflictBounceCount",
  messageDelivery: "recoveryRetryCount",
};

const CATEGORY_CAP = (category: RetryCategory, settings: Settings): number | undefined => {
  switch (category) {
    case "branchConflict":
      return settings.maxBranchConflictRecoveries;
    case "reviewerContext":
      return settings.maxReviewerContextRetries;
    case "reviewerFallback":
      return settings.maxReviewerFallbackRetries;
    default:
      return undefined;
  }
};

export async function recordRetry(options: {
  store: Pick<TaskStore, "updateTask" | "getTask">;
  settings: Settings;
  task: TaskDetail;
  category: RetryCategory;
  role: string;
  agentId?: string;
  attempt?: number;
  skipIncrement?: boolean;
  /** The failure that burned this retry, when the caller has one. Folded into any
   *  RetryStormError so the cap does not mask what actually kept failing. */
  cause?: unknown;
}): Promise<TaskDetail> {
  const { store, settings, task, category, role, agentId, attempt, skipIncrement, cause } = options;
  const column = CATEGORY_COLUMN[category];

  if (!skipIncrement) {
    const current = (task[column] as number | undefined) ?? 0;
    await store.updateTask(task.id, { [column]: current + 1 });
  }

  const refreshed = await store.getTask(task.id);
  const breakdown = computeRetrySummary(refreshed);
  const categoryCount = (refreshed[column] as number | undefined) ?? 0;
  const categoryCap = CATEGORY_CAP(category, settings);
  const totalCap = settings.maxTotalRetriesBeforeFail;

  retryBurnedLog.log("retry-burned", {
    taskId: task.id,
    agentId,
    role,
    category,
    attempt,
    total: breakdown.total,
    breakdown,
  });

  if (typeof categoryCap === "number" && categoryCount > categoryCap) {
    throw new RetryStormError({
      category,
      total: breakdown.total,
      cap: categoryCap,
      breakdown,
      cause,
    });
  }

  if (typeof totalCap === "number" && breakdown.total > totalCap) {
    throw new RetryStormError({
      category,
      total: breakdown.total,
      cap: totalCap,
      breakdown,
      cause,
    });
  }

  return refreshed;
}
