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
  if (task.column !== "in-progress" && task.column !== "in-review") {
    return undefined;
  }
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
    task.column === "in-progress" ? resolvedThresholds.inProgressWarningMs : resolvedThresholds.inReviewWarningMs,
  );
  const criticalThresholdMs = getNormalizedThreshold(
    task.column === "in-progress" ? resolvedThresholds.inProgressCriticalMs : resolvedThresholds.inReviewCriticalMs,
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
  const ageMs = Math.max(0, now - ageAnchorMs);

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
    column: task.column,
    paused: task.paused === true,
  };
}
