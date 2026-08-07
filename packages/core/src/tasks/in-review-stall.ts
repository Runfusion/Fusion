import { getTaskMergeBlocker } from "../merge/task-merge.js";
import type { Task, TaskLogEntry } from "../types.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:40 (fleet — long-tail fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guard below.

A named set rather than an inline `=== "<id>"` arm. Behaviour is identical; the census counts an
inline comparison whether or not it sits in a fallback branch (its `traitFallback` hint is advisory
and never changes `kind`), so a correctly-converted guard with an inline legacy arm stays on the
backlog permanently and the number stops distinguishing real debt from documented degraded answers.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);


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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:10 (the lane seam, MEMBERSHIP not one column):
  `reviewColumn` is `resolveLifecycleColumns().review` — the FIRST column carrying a review role. A
  board declaring a separate merge lane beside its human-review lane has TWO, and a card in the second
  read as not-in-review. This takes the SET.

  Optional, with today's behaviour preserved as the fallback, so a caller that does not pass it is
  byte-identical.
  */
  reviewColumns?: ReadonlySet<string>;
}

/** Keep aligned with engine DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS. */
export const DEFAULT_STALE_MERGING_MIN_AGE_MS = 5 * 60_000;
/** Historical default for the configurable auto-merge conflict retry cap. */
export const DEFAULT_MAX_AUTO_MERGE_RETRIES = 3;
export const DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES = 2;
export const DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS = 2_000;
/*
FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
One terminal tool_error after an execute-family run cursor must qualify for the
existing bounded same-model recovery. Explicit thresholds, retry budgets, and
cursor ownership remain the operator-controlled safety fences.
*/
export const CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD = 1;

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

/**
 * FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
 * Normalize project policy identically in engine and settings UI. Invalid or
 * undefined thresholds fall back to the first-error default; finite explicit
 * thresholds at or above one retain operator intent.
 */
function resolveNonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.floor(numeric) >= 0 ? Math.floor(numeric) : fallback;
}
export function resolveMaxConsecutiveToolFailureRetries(settings?: { executorToolFailureRetryCount?: unknown } | null): number {
  return resolveNonNegativeInteger(settings?.executorToolFailureRetryCount, DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES);
}
export function resolveConsecutiveToolFailureRetryBackoffMs(settings?: { executorToolFailureRetryBackoffMs?: unknown } | null): number {
  return resolveNonNegativeInteger(settings?.executorToolFailureRetryBackoffMs, DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS);
}
export function resolveConsecutiveToolFailureThreshold(settings?: { executorToolFailureThreshold?: unknown } | null): number {
  const numeric = Number(settings?.executorToolFailureThreshold);
  return Number.isFinite(numeric) && Math.floor(numeric) >= 1 ? Math.floor(numeric) : CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD;
}

export interface ExecutorEscalationTarget {
  enabled: boolean;
  provider?: string;
  modelId?: string;
  nodeId?: string;
}

/**
 * FNXC:ExecutorEscalation 2026-07-16-21:00:
 * Escalation remains opt-in and only accepts a complete model pair or a node target. Keeping this resolver in core makes engine and settings surfaces agree that incomplete targets silently preserve FN-7996 terminal behavior.
 */
export function resolveExecutorEscalationTarget(settings?: {
  executorModelEscalationEnabled?: unknown;
  executorEscalationProvider?: unknown;
  executorEscalationModelId?: unknown;
  executorEscalationNodeId?: unknown;
} | null): ExecutorEscalationTarget {
  const provider = typeof settings?.executorEscalationProvider === "string" ? settings.executorEscalationProvider.trim() : "";
  const modelId = typeof settings?.executorEscalationModelId === "string" ? settings.executorEscalationModelId.trim() : "";
  const nodeId = typeof settings?.executorEscalationNodeId === "string" ? settings.executorEscalationNodeId.trim() : "";
  const hasModelTarget = Boolean(provider && modelId);
  const hasNodeTarget = Boolean(nodeId);
  return {
    enabled: settings?.executorModelEscalationEnabled === true && (hasModelTarget || hasNodeTarget),
    ...(hasModelTarget ? { provider, modelId } : {}),
    ...(hasNodeTarget ? { nodeId } : {}),
  };
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
  /*
  This classifier had NO seam while its two siblings did, so one decorated row could have
  `inReviewStalled` resolved and `inReviewStall` literal — one row, two lane answers.
  */
  const inReviewLane = (context.reviewColumns ?? LEGACY_REVIEW_LANES).has(task.column);
  if (!inReviewLane || task.paused === true) {
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:05 (this reported EVERY healthy review card as stalled):
  Forward the resolved lanes. This function had already satisfied its OWN lane check above using
  `context.reviewColumns`, then called getTaskMergeBlocker without them — so the helper re-ran its
  identity check against the literal `in-review` and, on a renamed board, returned
  `task is in 'signoff', must be in 'in-review'` for a perfectly healthy card.

  That string was then surfaced as `{ code: "merge-blocker" }`, i.e. a stall reason naming a column
  the board does not have — for every card in review. Worse than silence: the operator gets a wall of
  false stalls, each citing a lane that does not exist.

  The outer question was resolved and the inner one was not — the same half-conversion recorded at the
  helper itself for moves.ts, and fixed in #2963/#2964 for the merge paths.
  */
  const mergeBlocker = getTaskMergeBlocker(task, { reviewColumns: context.reviewColumns });
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
