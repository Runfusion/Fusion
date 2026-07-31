import type { Task } from "./types.js";

export type StalePausedReviewCode = "stale-paused-review";

export interface StalePausedReviewSignal {
  code: StalePausedReviewCode;
  reason: string;
  observedAt: string;
  ageMs: number;
  thresholdMs: number;
  pausedReason?: string;
  pausedByAgentId?: string;
}

export interface StalePausedReviewContext {
  /** The workflow's REVIEW (merge-orchestration) column. Defaults to the legacy
   *  `"in-review"` so unconverted callers are byte-identical. */
  reviewColumn?: string;
  now?: number;
  thresholdMs?: number;
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
}

export const DEFAULT_STALE_PAUSED_REVIEW_THRESHOLD_MS = 24 * 60 * 60_000;

export function getStalePausedReviewSignal(
  task: Pick<Task, "column" | "paused" | "columnMovedAt" | "updatedAt" | "mergeDetails" | "pausedReason" | "pausedByAgentId">,
  context: StalePausedReviewContext = {},
): StalePausedReviewSignal | undefined {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-23:55 (U4 — surfacing family):
  The lifecycle role this signal is about is REVIEW (the merge-orchestration
  lane), not the id `in-review` — that is only what the builtin coding workflow
  calls it. `getStalePausedTodoSignal` gained the equivalent `holdColumn`
  parameter in B1; this sibling was missed, so it silently stopped matching for
  any workflow that renames its review column. Defaults to the legacy id, so
  every existing caller is byte-identical.
  */
  const reviewColumn = context.reviewColumn ?? "in-review";
  if (task.column !== reviewColumn || task.paused !== true) return undefined;
  if (task.mergeDetails?.mergeConfirmed === true) return undefined;

  const thresholdMs = context.thresholdMs ?? DEFAULT_STALE_PAUSED_REVIEW_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return undefined;

  const now = context.now ?? Date.now();
  const anchor = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(anchor)) return undefined;

  const activationFloorMs = getActivationFloorMs(context);
  const effectiveAnchor = activationFloorMs !== undefined ? Math.max(anchor, activationFloorMs) : anchor;
  const ageMs = Math.max(0, now - effectiveAnchor);
  if (ageMs < thresholdMs) return undefined;

  return {
    code: "stale-paused-review",
    reason: "Task has remained paused in review beyond threshold",
    observedAt: new Date(now).toISOString(),
    ageMs,
    thresholdMs,
    pausedReason: task.pausedReason,
    pausedByAgentId: task.pausedByAgentId,
  };
}

function getActivationFloorMs(context: StalePausedReviewContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}
