import { getTaskMergeBlocker } from "./task-merge.js";
import type { Task, TaskLogEntry } from "./types.js";

/**
 * State-based in-review stall detection. This is complementary to FN-4168's
 * planned heuristic `stalledReview` signal.
 *
 * Returning a signal is diagnostic-only and does not trigger any mutation by
 * itself. Callers MUST NOT use this helper as an auto-completion signal.
 *
 * When `context.autoMerge === false`, the signal is unconditionally suppressed
 * because in-review tasks are expected to remain on the PR-based manual flow.
 */
export type InReviewStallCode =
  | "merge-blocker"
  | "transient-merge-status-no-owner"
  | "merge-retries-exhausted"
  | "no-worktree-no-merge-confirmed";

export interface InReviewStallSignal {
  reason: string;
  code: InReviewStallCode;
  observedAt: string;
}

export interface InReviewStallContext {
  now?: number;
  autoMerge?: boolean;
  activeMergeTaskId?: string | null;
  executingTaskIds?: ReadonlySet<string>;
  staleMergingMinAgeMs?: number;
  maxAutoMergeRetries?: number;
}

/** Keep aligned with engine DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS. */
export const DEFAULT_STALE_MERGING_MIN_AGE_MS = 5 * 60_000;
/** Keep aligned with engine MAX_AUTO_MERGE_RETRIES (core must not import engine). */
export const DEFAULT_MAX_AUTO_MERGE_RETRIES = 3;
export const IN_REVIEW_STALL_LOG_PREFIX = "In-review stall surfaced [";
export const IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX = "In-review stall auto-disposed [";

const TRANSIENT_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);

export function countRecentIdenticalStallEntries(
  task: Pick<Task, "log">,
  signal: Pick<InReviewStallSignal, "code" | "reason">,
): number {
  const trimmedReason = signal.reason.trim();
  const reversed = [...(task.log ?? [])].reverse();
  let count = 0;

  for (const entry of reversed) {
    if (!entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX)) {
      break;
    }
    if (!matchesStallEntry(entry, signal.code, trimmedReason)) {
      break;
    }
    count += 1;
  }

  return count;
}

function matchesStallEntry(entry: TaskLogEntry, code: InReviewStallCode, reason: string): boolean {
  const prefix = `${IN_REVIEW_STALL_LOG_PREFIX}${code}]:`;
  if (!entry.action.startsWith(prefix)) return false;
  const rawReason = entry.action.slice(prefix.length).trim();
  return rawReason === reason;
}

export function getInReviewStallReason(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "worktree" | "mergeDetails" | "mergeRetries" | "updatedAt"> & { id?: string },
  context: InReviewStallContext = {},
): InReviewStallSignal | undefined {
  if (task.column !== "in-review" || task.paused === true) {
    return undefined;
  }

  if (context.autoMerge === false) {
    return undefined;
  }

  const now = context.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const staleMergingMinAgeMs = context.staleMergingMinAgeMs ?? DEFAULT_STALE_MERGING_MIN_AGE_MS;
  const maxAutoMergeRetries = context.maxAutoMergeRetries ?? DEFAULT_MAX_AUTO_MERGE_RETRIES;

  if (task.mergeDetails?.mergeConfirmed === true) {
    return undefined;
  }

  if (task.id && (context.activeMergeTaskId === task.id || context.executingTaskIds?.has(task.id))) {
    return undefined;
  }

  if (task.status === "awaiting-user-review" || task.status === "awaiting-approval") {
    return undefined;
  }

  if (task.status && TRANSIENT_MERGE_STATUSES.has(task.status)) {
    const updatedAtMs = Date.parse(task.updatedAt);
    if (Number.isFinite(updatedAtMs) && now - updatedAtMs >= staleMergingMinAgeMs) {
      const minutes = Math.max(1, Math.floor(staleMergingMinAgeMs / 60_000));
      return {
        code: "transient-merge-status-no-owner",
        reason: `In transient '${task.status}' state with no active merger for >= ${minutes} min`,
        observedAt,
      };
    }
  }

  const mergeRetries = task.mergeRetries ?? 0;
  if (mergeRetries >= maxAutoMergeRetries) {
    return {
      code: "merge-retries-exhausted",
      reason: `Auto-merge retries exhausted (${mergeRetries}/${maxAutoMergeRetries}) without confirmed merge`,
      observedAt,
    };
  }

  if (!task.worktree && task.mergeDetails?.noOpMerge !== true) {
    return {
      code: "no-worktree-no-merge-confirmed",
      reason: "No worktree on disk and merge not confirmed",
      observedAt,
    };
  }

  const mergeBlocker = getTaskMergeBlocker(task);
  if (mergeBlocker) {
    return {
      code: "merge-blocker",
      reason: mergeBlocker,
      observedAt,
    };
  }

  return undefined;
}
