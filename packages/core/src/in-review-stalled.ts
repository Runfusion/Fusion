import { IN_REVIEW_STALL_LOG_PREFIX } from "./in-review-stall.js";
import type { Task } from "./types.js";

export type InReviewStalledCode = "in-review-stalled";

export interface InReviewStalledSignal {
  code: InReviewStalledCode;
  reason: string;
  observedAt: string;
  ageMs: number;
  quietMs: number;
  thresholdMs: number;
  lastActivityAt: string;
  lastActivitySource: "log" | "column-moved" | "updated";
}

export interface InReviewStalledContext {
  now?: number;
  thresholdMs?: number;
  autoMerge?: boolean;
  activeMergeTaskId?: string | null;
  executingTaskIds?: ReadonlySet<string>;
}

export const DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS = 24 * 60 * 60_000;

const ACTIVE_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);

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
  if (task.column !== "in-review" || task.paused === true) return undefined;
  if (context.autoMerge === false) return undefined;
  if (task.mergeDetails?.mergeConfirmed === true) return undefined;
  if (task.status === "awaiting-user-review" || task.status === "awaiting-approval") return undefined;
  if (task.status && ACTIVE_MERGE_STATUSES.has(task.status)) return undefined;
  if (context.activeMergeTaskId === task.id || context.executingTaskIds?.has(task.id)) return undefined;

  const thresholdMs = context.thresholdMs ?? DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return undefined;

  const now = context.now ?? Date.now();
  if (hasRecentReasonDrivenStall(task.log ?? [], now - thresholdMs)) return undefined;

  const lastActivity = getLastActivity(task);
  if (!lastActivity) return undefined;

  const quietMs = Math.max(0, now - lastActivity.time);
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
    lastActivitySource: lastActivity.source,
  };
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

function getLastActivity(task: InReviewStalledTask): ActivityCandidate | undefined {
  const candidates: ActivityCandidate[] = [];

  const logTime = getLatestLogTimestamp(task.log ?? []);
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
