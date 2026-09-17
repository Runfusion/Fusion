import type { Task } from "../../../core/src/types";

/**
 * FNXC:PlanReviewReplan 2026-07-15-12:15:
 * FN-7985 requires every task surface to distinguish the manual approval caused by the
 * exhausted triage Plan Review budget from ordinary plan-approval and release-authorization
 * holds. Keep the persisted reason check centralized so card, list, and detail stay aligned.
 */
export function isReviewBudgetExhaustedApproval(task: Task): boolean {
  return task.status === "awaiting-approval" && task.awaitingApprovalReason === "plan-review-replan-cap";
}

/**
 * FNXC:PlanApproval 2026-08-28-11:29:
 * Every shipped coding workflow runs planning, Plan Review, and replan in its hold column. The graph moves the card to that node column before the manual gate parks `awaiting-approval`, so approval controls belong to the full planning lane (intake or hold), while exhausted Plan Review retains its persisted-reason exception.
 */
export function isTaskAwaitingPlanApproval(task: Task, isPlanningLane: boolean): boolean {
  return task.status === "awaiting-approval"
    && (isPlanningLane || task.awaitingApprovalReason === "plan-review-replan-cap");
}

/*
FNXC:TaskCardPromote 2026-08-11-09:09:
FN-8950 mirrors `isPlanReviewSatisfied`, `isWorkflowOptionalGroupEnabled`, and
`isTaskBlockedOnApproval` here because core's plan-approval module imports `node:crypto` at
module top and must not enter the browser bundle. The default-on fallback is load-bearing:
an absent enabled-steps array means the built-in default-on plan-review gate applies, rather
than that the gate is disabled. The contract test below prevents this deliberate duplication
from drifting.

`isTaskBlockedOnApprovalHold` intentionally has no column argument. Unlike the intake-gated
approval-control predicate above, the server refuses both approval-hold shapes on every column.
*/
export function isPlanReviewGateUnsatisfied(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults">,
  options?: { defaultOn?: boolean },
): boolean {
  const enabled = Array.isArray(task.enabledWorkflowSteps)
    ? task.enabledWorkflowSteps.includes("plan-review")
    : (options?.defaultOn ?? true);
  if (!enabled) return false;

  return !task.workflowStepResults?.some((result) => {
    if (result.workflowStepId !== "plan-review" || result.supersededAt != null) return false;
    if (result.status === "passed") return true;
    return result.status === "skipped"
      && (result.bypassedFromStatus === "failed" || result.bypassedFromStatus === "advisory_failure")
      && result.bypassedFromVerdict === "REVISE"
      && typeof result.bypassedBy === "string"
      && result.bypassedBy.trim().length > 0
      && typeof result.bypassedAt === "string"
      && result.bypassedAt.trim().length > 0
      && typeof result.bypassReason === "string"
      && result.bypassReason.trim().length > 0;
  });
}

/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — browser mirror of core's per-card decision predicates, for the same reason as the FN-8950
duplication above: core's plan-approval module imports `node:crypto` at module top and must not
enter the browser bundle. The contract test keeps this deliberate duplication from drifting.

The badge deliberately distinguishes THREE states, because a single "needs approval" label would
claim a card still being planned is already waiting on the operator:
  • `armed`    — the requirement exists, but the plan/review is not ready to be decided yet;
  • `awaiting` — Plan Review is satisfied and the operator's decision is what blocks execution;
  • `approved` — a current decision exists for this exact plan and review episode.
*/
export type HumanPlanApprovalBadgeState = "armed" | "awaiting" | "approved";

/**
 * Mirror of core's `HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH`. It is duplicated rather than imported
 * because importing the core constant pulls `planner/plan-approval.ts` — and its `node:crypto`
 * top-level import — into the browser bundle, which fails the dashboard build. The contract test
 * asserts the two values stay equal.
 */
export const HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH_CLIENT = 10_000;

export function isHumanPlanApprovalArmedClient(task: Pick<Task, "humanPlanApproval">): boolean {
  return task.humanPlanApproval?.enabled === true;
}

/** Mirrors core `resolvePlanReviewEpisodeId`: the stamp of the current satisfied Plan Review result. */
export function resolvePlanReviewEpisodeIdClient(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults">,
): string | undefined {
  const satisfied = (task.workflowStepResults ?? []).filter((result) => {
    if (result.workflowStepId !== "plan-review" || result.supersededAt != null) return false;
    if (result.status === "passed") return true;
    return result.status === "skipped"
      && (result.bypassedFromStatus === "failed" || result.bypassedFromStatus === "advisory_failure")
      && result.bypassedFromVerdict === "REVISE"
      && typeof result.bypassedBy === "string" && result.bypassedBy.trim().length > 0
      && typeof result.bypassedAt === "string" && result.bypassedAt.trim().length > 0
      && typeof result.bypassReason === "string" && result.bypassReason.trim().length > 0;
  });
  if (satisfied.length === 0) return undefined;
  const current = satisfied[satisfied.length - 1];
  const stamp = current.completedAt ?? current.startedAt;
  return typeof stamp === "string" && stamp.trim().length > 0 ? stamp.trim() : undefined;
}

export function hasCurrentHumanPlanApprovalClient(
  task: Pick<Task, "humanPlanApproval" | "workflowStepResults" | "approvedPlanFingerprint" | "enabledWorkflowSteps">,
): boolean {
  if (!isHumanPlanApprovalArmedClient(task)) return false;
  const decision = task.humanPlanApproval?.decision;
  if (!decision || typeof decision !== "object" || decision.decision !== "approved") return false;
  const episodeId = resolvePlanReviewEpisodeIdClient(task);
  if (!episodeId || decision.planningEpisodeId !== episodeId) return false;
  const fingerprint = task.approvedPlanFingerprint;
  return Boolean(fingerprint) && decision.planFingerprint === fingerprint;
}

export function resolveHumanPlanApprovalBadgeState(
  task: Pick<Task, "humanPlanApproval" | "workflowStepResults" | "approvedPlanFingerprint" | "enabledWorkflowSteps">,
): HumanPlanApprovalBadgeState | null {
  if (!isHumanPlanApprovalArmedClient(task)) return null;
  if (hasCurrentHumanPlanApprovalClient(task)) return "approved";
  const decidable = Boolean(resolvePlanReviewEpisodeIdClient(task)) && Boolean(task.approvedPlanFingerprint);
  return decidable ? "awaiting" : "armed";
}

export function isTaskBlockedOnApprovalHold(
  task: Pick<Task, "paused" | "pausedReason" | "status">,
): boolean {
  return (task.paused === true && task.pausedReason === "awaiting-approval")
    || task.status === "awaiting-approval";
}

/*
FNXC:PromoteVisibility 2026-08-11-20:38:
useTasks owns freshness. TaskCard consumes a present verdict verbatim for exact server parity; absent
or expired payloads retain FN-8950's conservative fallback rather than inventing a second authority.
*/
export function resolvePromoteSuppressed(task: Pick<Task, "releaseGate">, fallback: boolean): boolean {
  return task.releaseGate?.promoteBlocked ?? fallback;
}
