import { isStaleContentApprovalBlocker } from "@fusion/core";

export const AUTO_MERGE_RETRY_REJECTED_PREFIX = "AUTO_MERGE_RETRY_REJECTED:";

export type StaleContentParkShape = "retry-rejected" | "raw-blocker" | "retry-exhausted";

export type StaleContentParkTask = {
  status?: string | null;
  error?: unknown;
  paused?: boolean;
  userPaused?: boolean;
  deletedAt?: string | null;
  mergeRetries?: number;
};

/**
 * FNXC:PreMergeApproval 2026-09-06-00:11:
 * Stale approval failures remain visible terminal parks to release merge leases and avoid retry
 * spins. This narrow classifier lets self-healing recover only those known reviewable outcomes,
 * not ordinary failed cards or operator-held work.
 */
export function classifyStaleContentPark(task: StaleContentParkTask): StaleContentParkShape | undefined {
  if (task.paused || task.userPaused || task.deletedAt) return undefined;
  if (typeof task.error !== "string" || !isStaleContentApprovalBlocker(task.error)) return undefined;
  if (task.status === "failed") {
    return task.error.startsWith(AUTO_MERGE_RETRY_REJECTED_PREFIX)
      ? "retry-rejected"
      : "raw-blocker";
  }
  return task.status == null ? "retry-exhausted" : undefined;
}

export function isStaleContentApprovalPark(task: StaleContentParkTask): boolean {
  return classifyStaleContentPark(task) !== undefined;
}
