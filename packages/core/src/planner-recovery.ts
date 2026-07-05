/**
 * FNXC:PlannerOversight 2026-07-04-12:00:
 * FN-7512 requirement: when the effective planner oversight level is
 * `"autonomous"`, the planner overseer may take BOUNDED autonomous
 * corrective action on the task's currently watched stage — inject steering
 * guidance into the active agent lane, retry a stuck/failed step, or request
 * a targeted fix for a detected error. Every action is capped by a
 * per-(task, watched-stage) attempt limit (`PLANNER_RECOVERY_MAX_ATTEMPTS`)
 * so recovery can never loop forever; once the budget is exhausted the
 * decision degrades to `"none"` with `exhausted: true` and the task is left
 * for human/other escalation. Merge/PR and destructive/external-service
 * actions are classified confirmation-required (FN-7513: `action:
 * "await_confirmation"`, `requiresConfirmation: true`) rather than dispatched
 * from this bounded layer — they only ever run once a
 * `PlannerConfirmationRequest` is explicitly approved via the engine
 * controller's `resolveConfirmation`. Comprehensive human-control safeguards
 * beyond a bare `userPaused` skip are FN-7514's responsibility. This module is pure,
 * never-throws, and has NO engine imports — the engine-side dispatch lives
 * in `@fusion/engine`'s `PlannerRecoveryController`.
 *
 * Delivered-shape note: FN-7511 shipped its observation model in
 * `packages/engine/src/planner-overseer.ts` (`OverseerStageObservation` /
 * `OverseerWatchedStage` / `OverseerSourceLink`) rather than the
 * `PlannerObservationSnapshot` shape anticipated at spec time, and it has no
 * `getSnapshot`/`isActive`/`watchedStage === "none"` API — instead
 * `PlannerOverseerMonitor.observeTask()` returns one observation (or `null`
 * when there is nothing to watch). This module's `PlannerRecoveryObservation`
 * input type mirrors the delivered `OverseerStageObservation` field names
 * structurally (`stage`, `signal`, `oversightLevel`, `sources`) so the engine
 * controller can pass an `OverseerStageObservation` straight through without
 * an adapter; "no watched stage" is represented by passing `snapshot: null`.
 */

import type { PlannerOversightLevel } from "./types.js";
import { classifyPlannerActionSideEffect, requiresPlannerConfirmation, type PlannerActionSideEffectClass } from "./planner-confirmation.js";

/**
 * The bounded corrective actions autonomous planner recovery may take, plus
 * `"await_confirmation"` (FN-7513) — the recovery layer has identified a
 * confirmation-required action (merge/PR progression, or a destructive/
 * external-service side effect) and is waiting on an explicit, recorded
 * human approval before it may run.
 */
export type PlannerRecoveryActionKind = "inject_guidance" | "retry_step" | "request_targeted_fix" | "await_confirmation" | "none";

/** Mirrors the delivered `OverseerWatchedStage` union (FN-7511). */
export type PlannerRecoveryWatchedStage = "executor" | "reviewer" | "merger" | "pull-request" | "workflow-gate";

/** Mirrors the delivered `OverseerObservationSignal` union (FN-7511). */
export type PlannerRecoveryObservationSignal = "progressing" | "stuck" | "failed" | "blocked" | "awaiting-human" | "complete";

/** Mirrors the delivered `OverseerSourceLink` shape (FN-7511) structurally. */
export interface PlannerRecoverySourceLink {
  kind: string;
  ref: string;
  url?: string;
}

/**
 * The minimal observation shape `decidePlannerRecovery` reads. Structurally
 * compatible with the engine's `OverseerStageObservation` (FN-7511) so the
 * engine controller can pass one straight through. `null` means "no watched
 * stage currently active for this task" (equivalent to the spec's
 * `watchedStage === "none"` / `isActive: false`).
 */
export interface PlannerRecoveryObservation {
  taskId: string;
  stage: PlannerRecoveryWatchedStage;
  signal: PlannerRecoveryObservationSignal;
  oversightLevel: PlannerOversightLevel | string;
  sources?: PlannerRecoverySourceLink[];
}

/** Per-`(taskId, watchedStage)` bounded attempt counter the caller persists/tracks. */
export interface PlannerRecoveryAttemptState {
  attemptCount: number;
  attemptLimit?: number;
}

/** Result of `decidePlannerRecovery` — pure, deterministic, never throws. */
export interface PlannerRecoveryDecision {
  action: PlannerRecoveryActionKind;
  reason: string;
  attemptCount: number;
  attemptLimit: number;
  exhausted: boolean;
  watchedStage: PlannerRecoveryWatchedStage | null;
  sourceLinks: PlannerRecoverySourceLink[];
  /**
   * FN-7513: `true` when this decision's action must not run without an
   * explicit, recorded human approval (`PlannerActionSideEffectClass` of
   * `"merge_pr"` or `"destructive_external"`). `false` for bounded recovery
   * (`inject_guidance` / `retry_step` / `request_targeted_fix`) and for
   * `"none"` decisions, which take no action either way.
   */
  requiresConfirmation: boolean;
  /** FN-7513: the side-effect class this decision's action was classified into. */
  sideEffectClass: PlannerActionSideEffectClass;
  /**
   * FN-7513: for `action: "await_confirmation"`, the specific action name
   * that would run once a matching `PlannerConfirmationRequest` is approved.
   * Undefined for actions that dispatch immediately (bounded recovery) or
   * for `"none"`.
   */
  proposedAction?: string;
}

/**
 * Maximum bounded recovery attempts per `(taskId, watchedStage)` before
 * autonomous action stops and the task is left for escalation. Mirrors the
 * bound style of `MAX_RECOVERY_RETRIES` in `recovery-policy.ts`.
 */
export const PLANNER_RECOVERY_MAX_ATTEMPTS = 3;

/** Source-link kinds treated as carrying a specific, fixable error (vs. a bare stuck/blocked signal). */
const ERROR_SOURCE_KINDS = new Set(["failed-check", "merge-error"]);

export interface DecidePlannerRecoveryInput {
  /** The current observation for the task's watched stage, or `null` when nothing is currently watched. */
  snapshot: PlannerRecoveryObservation | null | undefined;
  /** Current attempt state for this `(taskId, watchedStage)`; omit for a fresh stage. */
  attemptState?: PlannerRecoveryAttemptState;
}

/**
 * FNXC:PlannerOversight 2026-07-04-12:00:
 * Pure, never-throw decision function for bounded autonomous planner
 * recovery. Rules:
 *  1. No observation, or `oversightLevel !== "autonomous"` → `"none"`
 *     (nothing to do / oversight level does not permit autonomous action).
 *  2. Attempt budget for the `(taskId, watchedStage)` already spent
 *     (`attemptCount >= attemptLimit`) → `"none"`, `exhausted: true` (stop
 *     autonomously; leave the task for escalation).
 *  3. `merger` / `pull-request` stages → `"await_confirmation"` with
 *     `requiresConfirmation: true`, `sideEffectClass: "merge_pr"` (FN-7513) —
 *     the decision names what WOULD run on approval but never dispatches it
 *     from this bounded layer; only the engine controller's
 *     `resolveConfirmation`, after an explicit human approval, may.
 *  4. `reviewer` stage → `"inject_guidance"`.
 *  5. `executor` / `workflow-gate` stage with `signal === "failed"` →
 *     `"request_targeted_fix"` when a source link carries a specific
 *     fixable error (`failed-check` / `merge-error`), else `"retry_step"`.
 *  6. Any other `executor` / `workflow-gate` signal (stuck/blocked/
 *     progressing/awaiting-human) → `"inject_guidance"`.
 */
export function decidePlannerRecovery(input: DecidePlannerRecoveryInput): PlannerRecoveryDecision {
  const attemptCount = input?.attemptState?.attemptCount ?? 0;
  const attemptLimit = input?.attemptState?.attemptLimit ?? PLANNER_RECOVERY_MAX_ATTEMPTS;

  try {
    const snapshot = input?.snapshot ?? null;
    const watchedStage = snapshot?.stage ?? null;
    const sourceLinks = snapshot?.sources ?? [];

    if (!snapshot) {
      return {
        action: "none",
        reason: "No watched stage is currently active for this task",
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: false,
        sideEffectClass: "bounded_recovery",
      };
    }

    if (snapshot.oversightLevel !== "autonomous") {
      return {
        action: "none",
        reason: `Effective planner oversight level "${String(snapshot.oversightLevel)}" does not permit autonomous recovery`,
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: false,
        sideEffectClass: "bounded_recovery",
      };
    }

    if (attemptCount >= attemptLimit) {
      return {
        action: "none",
        reason: `Bounded recovery attempt budget (${attemptLimit}) exhausted for stage "${watchedStage}"`,
        attemptCount,
        attemptLimit,
        exhausted: true,
        watchedStage,
        sourceLinks,
        requiresConfirmation: false,
        sideEffectClass: "bounded_recovery",
      };
    }

    // FNXC:PlannerOversight 2026-07-04-13:00: merger / pull-request stage
    // actions beyond guidance/retry now surface as a confirmation-required
    // `"await_confirmation"` decision (FN-7513) instead of the FN-7512
    // `"none"` deferral — the recovery layer identifies what WOULD run on
    // approval, but never dispatches it itself.
    if (snapshot.stage === "merger" || snapshot.stage === "pull-request") {
      const proposedAction = snapshot.stage === "merger" ? "advance_merge" : "advance_pull_request";
      const sideEffectClass = classifyPlannerActionSideEffect({ watchedStage: snapshot.stage, proposedAction });
      return {
        action: "await_confirmation",
        reason: `Stage "${snapshot.stage}" requires explicit confirmation before ${proposedAction.replace(/_/g, " ")} may run`,
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: requiresPlannerConfirmation(sideEffectClass),
        sideEffectClass,
        proposedAction,
      };
    }

    if (snapshot.stage === "reviewer") {
      const proposedAction = "inject_guidance";
      const sideEffectClass = classifyPlannerActionSideEffect({ watchedStage: snapshot.stage, proposedAction });
      return {
        action: "inject_guidance",
        reason: "Reviewer stage — injecting steering guidance",
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: requiresPlannerConfirmation(sideEffectClass),
        sideEffectClass,
      };
    }

    // executor / workflow-gate beyond this point.
    if (snapshot.signal === "failed") {
      const hasErrorSource = sourceLinks.some((link) => ERROR_SOURCE_KINDS.has(link.kind));
      const proposedAction = hasErrorSource ? "request_targeted_fix" : "retry_step";
      const sideEffectClass = classifyPlannerActionSideEffect({ watchedStage: snapshot.stage, proposedAction });
      return {
        action: proposedAction,
        reason: hasErrorSource
          ? "Failed stage with a specific error source — requesting a targeted fix"
          : "Failed stage with no specific error source — retrying the step",
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: requiresPlannerConfirmation(sideEffectClass),
        sideEffectClass,
      };
    }

    {
      const proposedAction = "inject_guidance";
      const sideEffectClass = classifyPlannerActionSideEffect({ watchedStage: snapshot.stage, proposedAction });
      return {
        action: "inject_guidance",
        reason: `Stage "${snapshot.stage}" signal "${snapshot.signal}" — injecting steering guidance`,
        attemptCount,
        attemptLimit,
        exhausted: false,
        watchedStage,
        sourceLinks,
        requiresConfirmation: requiresPlannerConfirmation(sideEffectClass),
        sideEffectClass,
      };
    }
  } catch {
    return {
      action: "none",
      reason: "decidePlannerRecovery: malformed input — degraded to no-op",
      attemptCount,
      attemptLimit,
      exhausted: false,
      watchedStage: null,
      sourceLinks: [],
      requiresConfirmation: false,
      sideEffectClass: "bounded_recovery",
    };
  }
}
