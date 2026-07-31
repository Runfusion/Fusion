import type { Task } from "@fusion/core";
import { isWipColumnRole } from "./columnRoles";
import { isOverdue } from "./dataFreshness";

const NON_STUCK_STATUSES = new Set(["failed", "stuck-killed"]);

/**
 * Check if a task is stuck based on the project's stuck timeout setting.
 *
 * A task is considered stuck when:
 * - It is in the "in-progress" column
 * - A positive `taskStuckTimeoutMs` value is provided (stuck detection enabled)
 * - Its `updatedAt` timestamp is older than `taskStuckTimeoutMs` milliseconds ago
 *   compared to `dataAsOfMs` (or `Date.now()` if `dataAsOfMs` is not provided)
 *
 * When `taskStuckTimeoutMs` is undefined, null, or 0, stuck detection is
 * disabled and this function always returns false.
 *
 * The optional `dataAsOfMs` parameter represents when the task data was last
 * confirmed fresh by the server. When provided, it is used instead of `Date.now()`
 * for the comparison. This prevents false positives when the tab has been in
 * the background and the task data is stale.
 */
export function isTaskStuck(
  task: Task,
  taskStuckTimeoutMs: number | undefined,
  dataAsOfMs?: number,
  columnFlags?: Parameters<typeof isWipColumnRole>[0],
): boolean {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:10 (batch-dashboard-app):
  "Stuck" only means anything for a card in the WIP lane. Keyed on the literal, NO card on a renamed
  board could ever be reported stuck — the stuck badge and `countStuckTasks` both read zero while
  work sat wedged. `columnFlags` omitted -> the legacy id.
  */
  if (!isWipColumnRole(columnFlags, task.column)) {
    return false;
  }

  if (task.status && NON_STUCK_STATUSES.has(task.status)) {
    return false;
  }

  if (!taskStuckTimeoutMs || taskStuckTimeoutMs <= 0) {
    return false;
  }

  /*
  FNXC:MobileTabDiscard 2026-07-26-10:16:
  The clock choice moved to `isOverdue` (utils/dataFreshness.ts) so the same rule serves every
  staleness verdict in the client and `dataAsOfMs` cannot be omitted at a call site. Behavior is
  unchanged: `dataAsOfMs ?? Date.now()`, strict `>` against a threshold already proven positive above,
  and an unparseable `updatedAt` (NaN) still yields false.
  */
  const updatedAt = new Date(task.updatedAt).getTime();
  return isOverdue(updatedAt, taskStuckTimeoutMs, dataAsOfMs);
}

/**
 * Derive the stuck task count from a list of tasks using the given threshold.
 *
 * Returns 0 when stuck detection is disabled (undefined/0 threshold).
 *
 * The optional `dataAsOfMs` parameter is passed through to `isTaskStuck()` for
 * freshness-aware stuck detection.
 */
export function countStuckTasks(tasks: Task[], taskStuckTimeoutMs: number | undefined, dataAsOfMs?: number, columnFlagsByTaskId?: ReadonlyMap<string, Parameters<typeof isWipColumnRole>[0]>): number {
  if (!taskStuckTimeoutMs || taskStuckTimeoutMs <= 0) {
    return 0;
  }

  let count = 0;
  for (const task of tasks) {
    if (isTaskStuck(task, taskStuckTimeoutMs, dataAsOfMs, columnFlagsByTaskId?.get(task.id))) {
      count++;
    }
  }
  return count;
}
