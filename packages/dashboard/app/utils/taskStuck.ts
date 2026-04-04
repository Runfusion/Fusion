import type { Task } from "@fusion/core";

/**
 * Check if a task is stuck based on the project's stuck timeout setting.
 *
 * A task is considered stuck when:
 * - It is in the "in-progress" column
 * - A positive `taskStuckTimeoutMs` value is provided (stuck detection enabled)
 * - Its `updatedAt` timestamp is older than `taskStuckTimeoutMs` milliseconds ago
 *
 * When `taskStuckTimeoutMs` is undefined, null, or 0, stuck detection is
 * disabled and this function always returns false.
 */
export function isTaskStuck(task: Task, taskStuckTimeoutMs: number | undefined): boolean {
  if (task.column !== "in-progress") {
    return false;
  }

  if (!taskStuckTimeoutMs || taskStuckTimeoutMs <= 0) {
    return false;
  }

  const updatedAt = new Date(task.updatedAt).getTime();
  const now = Date.now();
  return now - updatedAt > taskStuckTimeoutMs;
}

/**
 * Derive the stuck task count from a list of tasks using the given threshold.
 *
 * Returns 0 when stuck detection is disabled (undefined/0 threshold).
 */
export function countStuckTasks(tasks: Task[], taskStuckTimeoutMs: number | undefined): number {
  if (!taskStuckTimeoutMs || taskStuckTimeoutMs <= 0) {
    return 0;
  }

  let count = 0;
  for (const task of tasks) {
    if (isTaskStuck(task, taskStuckTimeoutMs)) {
      count++;
    }
  }
  return count;
}
