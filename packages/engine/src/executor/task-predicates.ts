/**
 * FNXC:CodeOrganization 2026-08-03-13:10:
 * Tiny pure TaskExecutor predicates peeled from executor.ts (U4).
 * No instance state; re-exported from the facade for call-site stability.
 */
import type { Task } from "@fusion/core";

/** True when every step is done or skipped (and at least one step exists). */
export function isTaskWorkComplete(task: Task): boolean {
  if (task.steps.length === 0) return false;
  return task.steps.every((s) => s.status === "done" || s.status === "skipped");
}

/** Failed with "without calling fn_task_done" and zero step progress. */
export function isNoProgressNoTaskDoneFailure(task: Task): boolean {
  return task.status === "failed" &&
    task.error?.includes("without calling fn_task_done") === true &&
    task.steps.every((step) => step.status === "pending");
}

export function createSeenSteeringIds(task: {
  comments?: Array<{ id: string }>;
  steeringComments?: Array<{ id: string }>;
}): Set<string> {
  const seenSteeringIds = new Set<string>();
  for (const comment of task.steeringComments ?? task.comments ?? []) {
    seenSteeringIds.add(comment.id);
  }
  return seenSteeringIds;
}

export function createConfiguredCommandAbortError(taskId: string, command: string): Error {
  const error = new Error(`Configured command aborted for ${taskId}: ${command}`);
  error.name = "AbortError";
  return error;
}

/** Composite key for graph-owned per-instance state: never share parallel foreach instances. */
export function graphActiveContextKey(taskId: string, instanceId: string): string {
  return `${taskId}:${instanceId}`;
}

export function isRetryableMergePauseAbortStatus(status: string | null | undefined): boolean {
  /*
  FNXC:WorkflowMerge 2026-07-01-22:05:
  FN-7335 surfaced a merge-node pause/resume abort while the row was legitimately `in-review` with status="reviewing" from the AI merge reviewer. That status is merge activity, not a pre-existing terminal failure; keep the retry classifier strict on real errors while allowing transient merge/review statuses to re-enter bounded merge retry.
  */
  return status == null || status === "reviewing" || status === "merging" || status === "merging-pr";
}

export function isTerminalMergeGraphFailureValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized.includes("conflict")
    || normalized.includes("contamination")
    || normalized.includes("foreign")
    || normalized.includes("retry-exhausted")
    || normalized.includes("retries exhausted")
    || normalized.includes("max retries");
}

export function isAwaitingGraphFailureValue(
  value: string | undefined,
): value is "awaiting-user-input" | "awaiting-cli-approval" {
  return value === "awaiting-user-input" || value === "awaiting-cli-approval";
}
