/**
 * FNXC:PlannerOversight 2026-07-04-13:00:
 * FN-7513 requirement: merge/PR actions beyond bounded guidance/retry, and
 * any destructive or external-service side effect (branch/worktree
 * deletion, force operations, remote pushes, third-party GitHub/GitLab
 * calls), MUST NOT be executed autonomously by the planner overseer —
 * regardless of the effective oversight level. They are classified as
 * confirmation-required and must be blocked behind an explicit, recorded
 * user approval (`PlannerConfirmationRequest`, resolved via the engine's
 * `PlannerRecoveryController.resolveConfirmation`) before the associated
 * side-effecting handler ever runs. Bounded recovery (inject_guidance /
 * retry_step / request_targeted_fix on non-merge/PR stages, delivered by
 * FN-7512) requires no confirmation and is unaffected by this module.
 *
 * This module is pure, deterministic, and never throws — it has no engine
 * imports and performs no I/O. It only classifies; it never itself decides
 * *whether* to run, only *what class of side effect* a proposed action
 * belongs to.
 */

import type { PlannerRecoveryActionKind, PlannerRecoveryWatchedStage, PlannerRecoverySourceLink } from "./planner-recovery.js";

/**
 * The three side-effect classes a proposed planner-overseer action can fall
 * into:
 *  - `"bounded_recovery"` — inject_guidance / retry_step / request_targeted_fix
 *    on a non-merge/PR stage (FN-7512's autonomous, no-confirmation layer).
 *  - `"merge_pr"` — advancing a merge, promoting a shared branch, retrying or
 *    forcing a merge, or opening/updating/merging a pull request — i.e. any
 *    watched-stage action on the `merger` / `pull-request` stages that is not
 *    pure guidance or a bounded step-retry.
 *  - `"destructive_external"` — deleting branches/worktrees, force
 *    operations, pushing to a remote, or calling a third-party service
 *    (GitHub/GitLab/etc.), regardless of stage.
 */
export type PlannerActionSideEffectClass = "bounded_recovery" | "merge_pr" | "destructive_external";

/**
 * A pending (or resolved) request for explicit human approval of a
 * confirmation-required planner-overseer action. Conceptually mirrors
 * `TaskMergeDetails.mergeConfirmed` (an explicit human approval precedes the
 * side effect) but is its own record — it does NOT read or write
 * `mergeConfirmed`, which remains owned by the merge dispatch path.
 */
export interface PlannerConfirmationRequest {
  requestId: string;
  taskId: string;
  watchedStage: PlannerRecoveryWatchedStage;
  sideEffectClass: PlannerActionSideEffectClass;
  /** The action that would run if this request is approved. */
  proposedAction: PlannerRecoveryActionKind | string;
  reason: string;
  sourceLinks: PlannerRecoverySourceLink[];
  requestedAt: number;
  status: "pending" | "approved" | "denied";
  resolvedAt?: number;
  resolvedBy?: string;
}

/**
 * Proposed-action names known to represent a destructive or external-service
 * side effect (branch/worktree deletion, force operations, remote pushes,
 * third-party GitHub/GitLab/service calls) irrespective of watched stage.
 * Kept as an explicit allow-list (rather than a heuristic over free-form
 * strings) so classification stays deterministic and easy to audit/extend.
 */
const DESTRUCTIVE_EXTERNAL_ACTIONS = new Set<string>([
  "delete_branch",
  "delete_worktree",
  "force_push",
  "force_merge",
  "force_delete",
  "push_remote",
  "call_external_service",
  "github_api_call",
  "gitlab_api_call",
  "open_pull_request",
  "merge_pull_request",
  "promote_shared_branch",
]);

/** Bounded, non-merge/PR recovery actions FN-7512 already dispatches with no confirmation. */
const BOUNDED_RECOVERY_ACTIONS = new Set<string>(["inject_guidance", "retry_step", "request_targeted_fix"]);

export interface ClassifyPlannerActionSideEffectInput {
  /** The watched stage the action would apply to, or `null` when there is none. */
  watchedStage: PlannerRecoveryWatchedStage | null | undefined;
  /** The proposed action name (a `PlannerRecoveryActionKind`, or an FN-7514+ specific action string). */
  proposedAction: string | null | undefined;
}

/**
 * FNXC:PlannerOversight 2026-07-04-13:00:
 * Pure, deterministic, never-throw classifier mapping a proposed action on a
 * watched stage to its `PlannerActionSideEffectClass`:
 *  1. A proposed action on the explicit destructive/external allow-list →
 *     `"destructive_external"`, regardless of stage.
 *  2. `merger` / `pull-request` stage for any action that is not a bare
 *     bounded-recovery action → `"merge_pr"`. Bounded-recovery action names
 *     landing on these stages (which FN-7512's decision function never
 *     actually dispatches there) still classify as `"merge_pr"` — these
 *     stages are inherently merge/PR side effects.
 *  3. Anything else (bounded recovery actions on executor/reviewer/
 *     workflow-gate stages, or no watched stage) → `"bounded_recovery"`.
 * On malformed/unexpected input, degrades to the FAIL-CLOSED default
 * `"destructive_external"` rather than silently allowing an unclassified
 * action to run unconfirmed.
 */
export function classifyPlannerActionSideEffect(input: ClassifyPlannerActionSideEffectInput): PlannerActionSideEffectClass {
  try {
    const watchedStage = input?.watchedStage ?? null;
    const proposedAction = typeof input?.proposedAction === "string" ? input.proposedAction : "";

    if (DESTRUCTIVE_EXTERNAL_ACTIONS.has(proposedAction)) {
      return "destructive_external";
    }

    if (watchedStage === "merger" || watchedStage === "pull-request") {
      return "merge_pr";
    }

    if (BOUNDED_RECOVERY_ACTIONS.has(proposedAction) || proposedAction === "" || proposedAction === "none") {
      return "bounded_recovery";
    }

    // Unknown, non-bounded action name on a non-merge/PR stage: fail closed.
    return "destructive_external";
  } catch {
    return "destructive_external";
  }
}

/**
 * `true` when `sideEffectClass` requires an explicit, recorded human
 * approval before the associated action may run (`"merge_pr"` and
 * `"destructive_external"`); `false` for `"bounded_recovery"`, which FN-7512
 * already dispatches autonomously with no confirmation.
 */
export function requiresPlannerConfirmation(sideEffectClass: PlannerActionSideEffectClass | null | undefined): boolean {
  return sideEffectClass === "merge_pr" || sideEffectClass === "destructive_external";
}
