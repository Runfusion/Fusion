import type { InReviewStallCode, InReviewStallSignal, Task } from "@fusion/core";

import { MAX_AUTO_MERGE_RETRIES } from "../hooks/useBlockerFanout";
import { getTaskLogEntryAction } from "./taskLogEntryDisplay";

export interface InReviewStallCopy {
  badgeLabel: string;
  counter?: string;
  headline: string;
  description: string;
  suggestedAction: string;
  code: InReviewStallCode;
}

export interface InReviewStallDeadlockCopy {
  headline: string;
  description: string;
  nextAction: string;
}

const BADGE_LABEL_BY_CODE: Record<InReviewStallCode, string> = {
  "merge-blocker": "Merge blocked",
  "transient-merge-status-no-owner": "Merge stalled",
  "merge-retries-exhausted": "Retries exhausted",
  "no-worktree-no-merge-confirmed": "No worktree",
  "non-retryable-provider-error": "Provider error",
};

const COPY_BY_CODE: Record<InReviewStallCode, Omit<InReviewStallCopy, "badgeLabel" | "counter" | "code">> = {
  "merge-blocker": {
    headline: "Merge blocked by a pre-merge check",
    description:
      "A workflow step or merge precondition is reporting a blocker. The task is waiting for that check to pass before it can finalize.",
    suggestedAction: "Open the Review tab to see which step is blocking, then fix the failure or override the step.",
  },
  "transient-merge-status-no-owner": {
    headline: "Stuck in a transient merge state with no active merger",
    description:
      "The task is parked in a merging/merging-pr/merging-fix status but no merger process owns it. Self-healing will retry, but if this repeats the merge worker may need attention.",
    suggestedAction: "Wait one self-healing cycle; if it persists, inspect engine logs for crashed merger runs.",
  },
  "merge-retries-exhausted": {
    headline: "Auto-merge retries exhausted",
    description: "The merger hit its retry ceiling without confirming a merge. The task will not be re-enqueued automatically.",
    suggestedAction:
      "Resolve the underlying merge problem manually and re-run the merge from the Review tab, or move the task back to in-progress.",
  },
  "no-worktree-no-merge-confirmed": {
    headline: "No worktree on disk and merge not confirmed",
    description:
      "The task's working tree is gone but the merge was never confirmed. Either the worktree was removed prematurely or the merge metadata is incomplete.",
    suggestedAction:
      "Check the Changes tab and Git history; if the work landed, mark the merge confirmed, otherwise re-create the worktree.",
  },
  "non-retryable-provider-error": {
    headline: "Terminal provider error",
    description:
      "The provider rejected the task with a non-retryable error such as an invalid model, unsupported request, or permission denial. Self-healing will pause the task instead of retrying the same failure.",
    suggestedAction:
      "Fix the model/provider configuration or permissions, then unpause and retry the task once the provider can accept the request.",
  },
};

function defaultCopy(signal: InReviewStallSignal): InReviewStallCopy {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`Unhandled inReviewStall code in dashboard copy map: ${signal.code}`);
  }
  return {
    badgeLabel: "In-review stall",
    code: signal.code,
    headline: "In-review stall surfaced",
    description: signal.reason,
    suggestedAction: "Open the activity log for details.",
  };
}

export function getInReviewStallCopy(
  signal: InReviewStallSignal,
  options?: { mergeRetries?: number | null; maxAutoMergeRetries?: number },
): InReviewStallCopy {
  const mapped = COPY_BY_CODE[signal.code];
  if (!mapped) {
    return defaultCopy(signal);
  }

  const maxAutoMergeRetries = options?.maxAutoMergeRetries ?? MAX_AUTO_MERGE_RETRIES;
  const mergeRetries = options?.mergeRetries;
  const counter =
    signal.code === "merge-retries-exhausted" && Number.isFinite(mergeRetries) && mergeRetries != null && mergeRetries >= 0
      ? `${Math.max(mergeRetries, maxAutoMergeRetries)}/${maxAutoMergeRetries}`
      : undefined;

  return {
    badgeLabel: BADGE_LABEL_BY_CODE[signal.code],
    code: signal.code,
    counter,
    ...mapped,
  };
}

const ACTIVE_MERGE_STATUSES: ReadonlySet<Task["status"]> = new Set(["merging", "merging-pr", "merging-fix"]);

const IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX = "In-review stall auto-disposed [";

const IN_REVIEW_STALL_DEADLOCK_COPY: InReviewStallDeadlockCopy = {
  headline: "In-review deadlock auto-disposed",
  description:
    "Self-healing paused this in-review task after the same stall repeated without progress. This prevents infinite merge-blocker churn.",
  nextAction:
    "Inspect the merge blocker/branch conflict, recover manually, then unpause to retry. If recovery needs extra implementation, create a follow-up with fn_task_refine.",
};

/**
 * FNXC:TaskLogs 2026-06-14-14:27:
 * In-review deadlock detection must tolerate legacy/operator task log entries that may not have an `action` field.
 * Route through getTaskLogEntryAction so older persisted activity logs cannot crash dashboard rendering while checking for the self-healing marker.
 */
export function getInReviewStallDeadlockCopy(task: Pick<Task, "pausedReason" | "log">): InReviewStallDeadlockCopy | undefined {
  if (task.pausedReason === "in-review-stall-deadlock") {
    return IN_REVIEW_STALL_DEADLOCK_COPY;
  }

  const hasDeadlockLog = task.log?.some((entry) => getTaskLogEntryAction(entry).startsWith(IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX)) ?? false;
  return hasDeadlockLog ? IN_REVIEW_STALL_DEADLOCK_COPY : undefined;
}

export function shouldShowInReviewStallBadge(task: Pick<Task, "column" | "paused" | "inReviewStall" | "status">): boolean {
  if (task.column !== "in-review" || task.paused === true || task.inReviewStall == null) {
    return false;
  }

  if (task.inReviewStall.code === "no-worktree-no-merge-confirmed") {
    return false;
  }

  return !(
    task.inReviewStall.code === "merge-blocker" &&
    task.status != null &&
    ACTIVE_MERGE_STATUSES.has(task.status)
  );
}
