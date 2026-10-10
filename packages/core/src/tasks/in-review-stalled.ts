import { isActiveMergeStatus } from "../merge/active-merge-status.js";
import { IN_REVIEW_STALL_LOG_PREFIX } from "./in-review-stall.js";
/* FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615): projection-backed answers for the two log readers
 * below, used ONLY when the caller says the row did not carry the `log` column. */
import {
  latestLogTimestampFromProjection,
  projectionOverride,
  stallSurfacedAtFromProjection,
  type TaskLogRecentEnvelope,
} from "../task-store/task-log-projections.js";
import type { Task } from "../types.js";

export type InReviewStalledCode = "in-review-stalled";

export interface InReviewStalledSignal {
  code: InReviewStalledCode;
  reason: string;
  observedAt: string;
  ageMs: number;
  quietMs: number;
  thresholdMs: number;
  lastActivityAt: string;
  effectiveLastActivityAt?: string;
  lastActivitySource: "log" | "column-moved" | "updated";
}

export interface InReviewStalledContext {
  /** The workflow's REVIEW (merge-orchestration) column. Defaults to the legacy
   *  `"in-review"` so unconverted callers are byte-identical. */
  reviewColumn?: string;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:10 (the lane seam, MEMBERSHIP not one column):
  `reviewColumn` is `resolveLifecycleColumns().review` — the FIRST column carrying a review role. A
  board declaring a separate merge lane beside its human-review lane has TWO, and a card in the second
  read as not-in-review. This takes the SET.

  Optional, with today's behaviour preserved as the fallback, so a caller that does not pass it is
  byte-identical.
  */
  reviewColumns?: ReadonlySet<string>;
  now?: number;
  thresholdMs?: number;
  autoMerge?: boolean;
  activeMergeTaskId?: string | null;
  executingTaskIds?: ReadonlySet<string>;
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
  /*
  FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
  `logLoaded: false` plus an envelope is the ONLY way a caller can ask for the projection path; omitted
  or `logLoaded: true` keeps the log arithmetic below byte-identical to today. That is deliberate — a
  shared loader that still selects `log` must never silently change what a badge means.
  */
  logLoaded?: boolean;
  projection?: TaskLogRecentEnvelope | null;
}

export const DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS = 24 * 60 * 60_000;

type InReviewStalledTask = Pick<Task, "id" | "column" | "paused" | "status" | "columnMovedAt" | "updatedAt" | "log" | "mergeDetails">;

type ActivityCandidate = {
  time: number;
  source: "log" | "column-moved" | "updated";
  tiePriority: number;
};

export function getInReviewStalledSignal(
  task: InReviewStalledTask,
  context: InReviewStalledContext = {},
): InReviewStalledSignal | undefined {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-23:55 (U4 — surfacing family):
  REVIEW role, not the literal `in-review` id. Same conversion and same reason as
  its sibling in stale-paused-review.ts; defaults to the legacy id so existing
  callers are byte-identical.
  */
  const inReviewLane = context.reviewColumns
    ? context.reviewColumns.has(task.column)
    /* DELIBERATE-LITERAL — the no-metadata fallback; a supplied set always wins. */
    : task.column === (context.reviewColumn ?? "in-review");
  if (!inReviewLane || task.paused === true) return undefined;
  if (context.autoMerge === false) return undefined;
  if (task.mergeDetails?.mergeConfirmed === true) return undefined;
  if (task.status === "awaiting-user-review" || task.status === "awaiting-approval") return undefined;
  if (isActiveMergeStatus(task.status)) return undefined;
  if (context.activeMergeTaskId === task.id || context.executingTaskIds?.has(task.id)) return undefined;

  const thresholdMs = context.thresholdMs ?? DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return undefined;

  const now = context.now ?? Date.now();
  /*
  FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
  The stored value is the MAX timestamp over every stall-prefixed entry; the LIVE `thresholdMs` is applied
  here rather than baked into the column, so raising `settings.inReviewStalledThresholdMs` changes the
  answer on the next read instead of freezing yesterday's threshold into stored data.
  */
  const surfaced = projectionOverride(context);
  const recentReasonDriven = surfaced
    ? (() => {
        const at = stallSurfacedAtFromProjection(surfaced);
        return at.ms !== null && at.ms >= now - thresholdMs;
      })()
    : hasRecentReasonDrivenStall(task.log ?? [], now - thresholdMs);
  if (recentReasonDriven) return undefined;

  const lastActivity = getLastActivity(task, context);
  if (!lastActivity) return undefined;

  const activationFloorMs = getActivationFloorMs(context);
  const effectiveLastActivityMs = activationFloorMs !== undefined
    ? Math.max(lastActivity.time, activationFloorMs)
    : lastActivity.time;
  const quietMs = Math.max(0, now - effectiveLastActivityMs);
  if (quietMs < thresholdMs) return undefined;

  const ageAnchor = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(ageAnchor)) return undefined;

  const ageMs = Math.max(0, now - ageAnchor);
  const thresholdHours = thresholdMs / 3_600_000;
  const quietHours = quietMs / 3_600_000;

  return {
    code: "in-review-stalled",
    reason: `In-review task quiet for ${quietHours.toFixed(1)}h beyond ${thresholdHours.toFixed(1)}h threshold`,
    observedAt: new Date(now).toISOString(),
    ageMs,
    quietMs,
    thresholdMs,
    lastActivityAt: new Date(lastActivity.time).toISOString(),
    ...(effectiveLastActivityMs !== lastActivity.time
      ? { effectiveLastActivityAt: new Date(effectiveLastActivityMs).toISOString() }
      : {}),
    lastActivitySource: lastActivity.source,
  };
}

function getActivationFloorMs(context: InReviewStalledContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}

function hasRecentReasonDrivenStall(log: readonly Pick<Task["log"][number], "action" | "timestamp">[], floor: number): boolean {
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const entry of log) {
    if (!entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX)) continue;
    const entryTime = Date.parse(entry.timestamp);
    if (!Number.isFinite(entryTime)) continue;
    if (entryTime > latestTime) latestTime = entryTime;
  }

  return Number.isFinite(latestTime) && latestTime >= floor;
}

function getLastActivity(task: InReviewStalledTask, context?: InReviewStalledContext): ActivityCandidate | undefined {
  const candidates: ActivityCandidate[] = [];

  /*
  FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
  `getLatestLogTimestamp` is a MAX over the WHOLE log, which is precisely why `log_recent` stores that
  MAX (`latestAt`) instead of a tail slice: a slice loses the maximum whenever timestamps are
  non-monotonic. `-Infinity` means "no log candidate", the same answer the loop below gives.
  */
  const surfaced = projectionOverride(context);
  const logTime = surfaced
    ? latestLogTimestampFromProjection(surfaced).ms
    : getLatestLogTimestamp(task.log ?? []);
  if (Number.isFinite(logTime)) {
    candidates.push({ time: logTime, source: "log", tiePriority: 0 });
  }

  const columnMovedTime = Date.parse(task.columnMovedAt ?? "");
  if (Number.isFinite(columnMovedTime)) {
    candidates.push({ time: columnMovedTime, source: "column-moved", tiePriority: 1 });
  }

  const updatedAtTime = Date.parse(task.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    candidates.push({ time: updatedAtTime, source: "updated", tiePriority: 2 });
  }

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    return a.tiePriority - b.tiePriority;
  });

  return candidates[0];
}

function getLatestLogTimestamp(log: readonly Pick<Task["log"][number], "timestamp">[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of log) {
    const entryTime = Date.parse(entry.timestamp);
    if (Number.isFinite(entryTime) && entryTime > latest) {
      latest = entryTime;
    }
  }
  return latest;
}
