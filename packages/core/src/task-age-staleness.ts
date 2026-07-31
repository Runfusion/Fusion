import type { Task } from "./types.js";

export type TaskAgeStalenessLevel = "warning" | "critical";

export interface TaskAgeStalenessSignal {
  level: TaskAgeStalenessLevel;
  reason: string;
  observedAt: string;
  ageMs: number;
  warningThresholdMs: number;
  criticalThresholdMs: number;
  column: "in-progress" | "in-review";
  paused: boolean;
}

export interface TaskAgeStalenessThresholds {
  inProgressWarningMs?: number;
  inProgressCriticalMs?: number;
  inReviewWarningMs?: number;
  inReviewCriticalMs?: number;
}

export const DEFAULT_TASK_AGE_STALENESS_THRESHOLDS: Required<TaskAgeStalenessThresholds> = {
  inProgressWarningMs: 4 * 60 * 60_000,
  inProgressCriticalMs: 24 * 60 * 60_000,
  inReviewWarningMs: 24 * 60 * 60_000,
  inReviewCriticalMs: 3 * 24 * 60 * 60_000,
};

interface TaskAgeStalenessContext {
  now?: number;
  thresholds?: TaskAgeStalenessThresholds;
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-08:10 (fleet phase):
  The task's resolved lifecycle columns. Age-staleness applies ONLY to the mid-flight and review lanes —
  a card resting in a hold or terminal lane is not "stale", it is waiting or finished. Both lanes were
  named by id, so on a renamed board this signal returned undefined for every card and the stale-card
  warning never appeared anywhere on the board.

  OPTIONAL, so the existing callers and every test keep the legacy-id behaviour. The one production
  caller (`task-store/reads.ts`) already holds a per-pass IR cache for exactly this kind of resolution.
  */
  lifecycle?: { wip?: string; review?: string };
}

type TaskAgeStalenessTask = Pick<Task, "column" | "paused" | "columnMovedAt" | "updatedAt" | "mergeDetails">;

function getNormalizedThreshold(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function getTaskAgeStalenessSignal(
  task: TaskAgeStalenessTask,
  context: TaskAgeStalenessContext = {},
): TaskAgeStalenessSignal | undefined {
  const wipColumn = context.lifecycle?.wip ?? "in-progress";
  const reviewColumn = context.lifecycle?.review ?? "in-review";
  if (task.column !== wipColumn && task.column !== reviewColumn) {
    return undefined;
  }
  // The guard above proves `column` is one of these two legacy ids; the
  // `ColumnId` union's `string & {}` member can't be excluded by literal `!==`
  // narrowing, so the cast is provably safe here (#1403).
  const activeColumn = task.column as "in-progress" | "in-review";
  if (task.mergeDetails?.mergeConfirmed === true) {
    return undefined;
  }

  const now = context.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const resolvedThresholds = {
    ...DEFAULT_TASK_AGE_STALENESS_THRESHOLDS,
    ...(context.thresholds ?? {}),
  };

  const warningThresholdMs = getNormalizedThreshold(
    task.column === wipColumn ? resolvedThresholds.inProgressWarningMs : resolvedThresholds.inReviewWarningMs,
  );
  const criticalThresholdMs = getNormalizedThreshold(
    task.column === wipColumn ? resolvedThresholds.inProgressCriticalMs : resolvedThresholds.inReviewCriticalMs,
  );

  if (warningThresholdMs === undefined && criticalThresholdMs === undefined) {
    return undefined;
  }
  if (
    warningThresholdMs !== undefined
    && criticalThresholdMs !== undefined
    && criticalThresholdMs < warningThresholdMs
  ) {
    throw new RangeError("critical threshold must be >= warning threshold");
  }

  const ageAnchorMs = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(ageAnchorMs)) {
    return undefined;
  }
  const activationFloorMs = getActivationFloorMs(context);
  const effectiveAgeAnchorMs = activationFloorMs !== undefined ? Math.max(ageAnchorMs, activationFloorMs) : ageAnchorMs;
  const ageMs = Math.max(0, now - effectiveAgeAnchorMs);

  let level: TaskAgeStalenessLevel | undefined;
  if (criticalThresholdMs !== undefined && ageMs >= criticalThresholdMs) {
    level = "critical";
  } else if (warningThresholdMs !== undefined && ageMs >= warningThresholdMs) {
    level = "warning";
  }

  if (!level) {
    return undefined;
  }

  return {
    level,
    reason: `Task has been in ${task.column} for ${ageMs}ms`,
    observedAt,
    ageMs,
    warningThresholdMs: warningThresholdMs ?? 0,
    criticalThresholdMs: criticalThresholdMs ?? 0,
    column: activeColumn,
    paused: task.paused === true,
  };
}

function getActivationFloorMs(context: TaskAgeStalenessContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}
