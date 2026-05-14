import type { Task } from "@fusion/core";

export type TodoAgeBucket = "fresh" | "aging" | "stale";

export interface TodoAgingCounts {
  fresh: number;
  aging: number;
  stale: number;
  total: number;
}

export const TODO_AGING_THRESHOLDS_MS = {
  aging: 7 * 24 * 60 * 60 * 1000,
  stale: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Derive todo age in milliseconds using timestamp precedence:
 * 1) `columnMovedAt` (when task entered todo)
 * 2) `createdAt` (legacy fallback)
 * 3) `updatedAt` (last-resort fallback)
 *
 * The optional `dataAsOfMs` represents when task data was last confirmed
 * fresh by the server. When provided, it is used instead of `Date.now()` to
 * avoid false aging when the tab has been backgrounded.
 */
export function getTodoAgeMs(task: Task, dataAsOfMs?: number): number | undefined {
  if (task.column !== "todo") {
    return undefined;
  }

  const timestamp = task.columnMovedAt || task.createdAt || task.updatedAt;
  if (!timestamp) {
    return undefined;
  }

  const referenceMs = new Date(timestamp).getTime();
  if (!Number.isFinite(referenceMs)) {
    return undefined;
  }

  const now = dataAsOfMs ?? Date.now();
  return now - referenceMs;
}

export function getTodoAgeBucket(task: Task, dataAsOfMs?: number): TodoAgeBucket | undefined {
  const ageMs = getTodoAgeMs(task, dataAsOfMs);
  if (ageMs === undefined || ageMs < 0) {
    return undefined;
  }

  if (ageMs <= TODO_AGING_THRESHOLDS_MS.aging) {
    return "fresh";
  }

  if (ageMs <= TODO_AGING_THRESHOLDS_MS.stale) {
    return "aging";
  }

  return "stale";
}

export function summarizeTodoAging(tasks: Task[], dataAsOfMs?: number): TodoAgingCounts {
  const counts: TodoAgingCounts = {
    fresh: 0,
    aging: 0,
    stale: 0,
    total: 0,
  };

  for (const task of tasks) {
    const bucket = getTodoAgeBucket(task, dataAsOfMs);
    if (!bucket) {
      continue;
    }
    counts[bucket] += 1;
    counts.total += 1;
  }

  return counts;
}
