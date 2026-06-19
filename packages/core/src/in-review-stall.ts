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
  | "no-worktree-no-merge-confirmed"
  | "non-retryable-provider-error";

export type ProviderErrorClassification = "non_retryable" | "retryable" | "unknown";

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
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
}

/** Keep aligned with engine DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS. */
export const DEFAULT_STALE_MERGING_MIN_AGE_MS = 5 * 60_000;
/** Historical default for the configurable auto-merge conflict retry cap. */
export const DEFAULT_MAX_AUTO_MERGE_RETRIES = 3;

/**
 * FNXC:AutoMergeRetries 2026-06-17-04:20:
 * Every engine, self-healing, dashboard, and core display surface must resolve the same project setting with defensive fallback semantics. Invalid persisted values intentionally fall back to 3 so old configs and hand-edits preserve the prior hardcoded behavior.
 */
export function resolveMaxAutoMergeRetries(settings?: { maxAutoMergeRetries?: unknown } | null): number {
  const configured = Number(settings?.maxAutoMergeRetries);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_MAX_AUTO_MERGE_RETRIES;
}
export const IN_REVIEW_STALL_LOG_PREFIX = "In-review stall surfaced [";
export const IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX = "In-review stall auto-disposed [";
export const IN_REVIEW_STALL_TERMINAL_LOG_PREFIX = "In-review stall terminal disposed [";

const TRANSIENT_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);
const FAILED_TASK_MERGE_BLOCKER_PREFIX = "task is marked 'failed':";

export function classifyProviderError(error: string): ProviderErrorClassification {
  const normalized = error.trim().toLowerCase();
  if (!normalized) return "unknown";

  if (
    (/\b400\b/.test(normalized) && normalized.includes("invalid_request_error"))
    || /model\b.*\bis not supported/.test(normalized)
    || /model\b.*\bnot found/.test(normalized)
    || normalized.includes("was not found in the pi model registry")
    || normalized.includes("invalid model")
    || normalized.includes("model does not exist")
    || (/\b401\b/.test(normalized) && normalized.includes("unauthorized"))
    || (/\b403\b/.test(normalized) && normalized.includes("forbidden"))
    || (/permission denied/.test(normalized) && /model|access/.test(normalized))
  ) {
    return "non_retryable";
  }

  if (
    /\b429\b/.test(normalized)
    || normalized.includes("too many requests")
    || normalized.includes("rate limit")
    || /\b5\d\d\b/.test(normalized)
    || normalized.includes("overloaded")
    || normalized.includes("econnreset")
    || normalized.includes("etimedout")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
  ) {
    return "retryable";
  }

  return "unknown";
}

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
  const maxAutoMergeRetries = resolveMaxAutoMergeRetries(context);

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
    const activationFloorMs = getActivationFloorMs(context);
    const effectiveUpdatedAtMs = Number.isFinite(updatedAtMs)
      ? activationFloorMs !== undefined ? Math.max(updatedAtMs, activationFloorMs) : updatedAtMs
      : Number.NaN;
    if (Number.isFinite(effectiveUpdatedAtMs) && Math.max(0, now - effectiveUpdatedAtMs) >= staleMergingMinAgeMs) {
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
    if (mergeBlocker.startsWith(FAILED_TASK_MERGE_BLOCKER_PREFIX)) {
      const error = mergeBlocker.slice(FAILED_TASK_MERGE_BLOCKER_PREFIX.length).trim();
      if (classifyProviderError(error) === "non_retryable") {
        return {
          code: "non-retryable-provider-error",
          reason: `Terminal provider error: ${error}`,
          observedAt,
        };
      }
    }

    return {
      code: "merge-blocker",
      reason: mergeBlocker,
      observedAt,
    };
  }

  return undefined;
}

function getActivationFloorMs(context: InReviewStallContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}
