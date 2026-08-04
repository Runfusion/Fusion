import { isPlanReviewSatisfied, type Task } from "@fusion/core";

export const LEGACY_NULL_PLAN_HANDOFF_STALE_MS = 30 * 60 * 1000;

export type PersistedPlanHandoffKind = "planning" | "approved-null" | "legacy-null";

/**
 * Shared persisted-state classifier for planning handoff recovery. It deliberately
 * excludes graph work-item/step-instance evidence, which callers must check at
 * their own store boundary before acting on a `legacy-null` result.
 */
export function classifyPersistedPlanHandoff(
  task: Pick<Task,
    | "status"
    | "paused"
    | "userPaused"
    | "approvedPlanFingerprint"
    | "awaitingApprovalReason"
    | "workflowStepResults"
    | "updatedAt"
    | "steps"
    | "worktree"
    | "firstExecutionAt"
    | "executionStartedAt"
  >,
  options: {
    now: number;
    hasLivePlanningWork: boolean;
    legacyStaleMs?: number;
    requirePersistedSteps?: boolean;
  },
): PersistedPlanHandoffKind | null {
  if (task.paused || task.userPaused || options.hasLivePlanningWork) return null;
  if (task.status === "planning") return "planning";
  if (task.status != null) return null;
  if (task.workflowStepResults?.some(isPlanReviewSatisfied)) return "approved-null";
  if (task.approvedPlanFingerprint != null) return null;
  if (task.awaitingApprovalReason) return null;
  if (task.workflowStepResults?.length) return null;
  if (options.requirePersistedSteps && !task.steps?.length) return null;
  if (task.worktree || task.firstExecutionAt || task.executionStartedAt) return null;

  const staleMs = options.legacyStaleMs ?? 0;
  const updatedAt = new Date(task.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || options.now - updatedAt < staleMs) return null;
  return "legacy-null";
}
