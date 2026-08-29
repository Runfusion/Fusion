import { isPlanReviewSatisfied, PlanningLifecycleLockTransportError, type Task } from "@fusion/core";

export const LEGACY_NULL_PLAN_HANDOFF_STALE_MS = 30 * 60 * 1000;

export type PersistedPlanHandoffKind = "planning" | "approved-null" | "legacy-null";

export function isPlanningLifecycleLockTransportError(error: unknown): error is Error {
  return error instanceof PlanningLifecycleLockTransportError
    || (error instanceof Error && error.name === "PlanningLifecycleLockTransportError");
}

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
  // FNXC:PlanningHandoffRecovery 2026-08-04-06:35 (FN-8768): Manual approval
  // parks and execution evidence outrank stale planning projections. In particular,
  // a retained Plan Review approval must never make an operator-held or already-
  // executing task eligible for planning-handoff recovery.
  if (task.awaitingApprovalReason) return null;
  if (task.firstExecutionAt || task.executionStartedAt) return null;
  // A planning worktree belongs to the planner and may legitimately survive a
  // crashed session. It must not hide a written plan from canonical handoff
  // recovery. Null-status compatibility recovery remains fenced below because
  // at that point a retained worktree is ambiguous execution evidence.
  if (task.status === "planning") return "planning";
  if (task.status != null) return null;
  if (task.worktree) return null;
  if (task.workflowStepResults?.some(isPlanReviewSatisfied)) return "approved-null";
  if (task.approvedPlanFingerprint != null) return null;
  if (task.workflowStepResults?.length) return null;
  if (options.requirePersistedSteps && !task.steps?.length) return null;

  const staleMs = options.legacyStaleMs ?? 0;
  const updatedAt = new Date(task.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || options.now - updatedAt < staleMs) return null;
  return "legacy-null";
}
