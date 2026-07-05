import type { PlannerOversightLevel } from "./types.js";

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * FN-7531 exposes the planner overseer's engine-side, in-memory runtime state
 * (from FN-7511's `PlannerOverseerMonitor` observations and FN-7512/FN-7513's
 * `PlannerRecoveryController` attempt/confirmation registries) to the
 * dashboard. This module declares the externally-meaningful, serializable
 * state enum and the pure derivation function that is the seam FN-7516's
 * `TaskCard` badge consumes — it does NOT change the monitor, the recovery
 * controller, the oversight-level resolution, the confirmation gates, or the
 * human-control safeguards (those remain owned by FN-7511–FN-7514).
 *
 * `watchedStage`/`signal` are intentionally typed as bare `string` (not the
 * engine's `OverseerWatchedStage`/`OverseerObservationSignal` unions) so the
 * engine's stage taxonomy is not pulled into `@fusion/core`.
 */
export const PLANNER_OVERSEER_STATES = ["idle", "watching", "steering", "recovering", "awaiting-confirmation"] as const;
export type PlannerOverseerState = (typeof PLANNER_OVERSEER_STATES)[number];

/**
 * A transient, serializable snapshot of the planner overseer's current
 * runtime state for one task. Engine-populated at `GET /api/tasks`
 * serialization time (mirroring the additive `branchProgress` board-payload
 * convention) — never persisted to the store or task.json.
 */
export interface PlannerOverseerRuntimeSnapshot {
  state: PlannerOverseerState;
  oversightLevel: PlannerOversightLevel;
  watchedStage?: string;
  signal?: string;
  attemptCount?: number;
  attemptLimit?: number;
  pendingConfirmation?: boolean;
  observedAt?: number;
  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 addition: the human-readable reason for the latest observation
   * (verbatim from `OverseerStageObservation.reason`), so the task-detail
   * "explain current action" affordance can render a readable summary
   * without re-deriving it. Optional/best-effort — absent when there is no
   * active observation (mirrors `watchedStage`/`signal`).
   */
  reason?: string;
  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 addition: a short label for the last dispatched bounded-recovery
   * action (e.g. `"inject_guidance"`, `"retry_step"`, `"request_targeted_fix"`)
   * OR a manual operator action recorded via the explain/nudge/stop control
   * surface (e.g. `"manual_nudge"`, `"manual_stop"`). Absent when no action
   * has been dispatched/recorded yet for the current watched stage.
   */
  lastAction?: string;
}

/** Pure input the state derivation reads — no engine types, no side effects. */
export interface DerivePlannerOverseerStateInput {
  oversightLevel: PlannerOversightLevel;
  hasObservation: boolean;
  attemptCount?: number;
  pendingConfirmationCount?: number;
}

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Pure, deterministic, never-throw mapping from the overseer's current
 * inputs to exactly one of the five `PlannerOverseerState` values. Checked
 * in this precedence order:
 *   1. `oversightLevel === "off"` OR no active observation → `"idle"`.
 *   2. A pending confirmation exists → `"awaiting-confirmation"` (wins over
 *      an in-flight recovery attempt — a human decision is blocking).
 *   3. A recovery attempt has been recorded → `"recovering"`.
 *   4. `oversightLevel === "steer"` → `"steering"`.
 *   5. Otherwise (`observe`/`autonomous` watching with no attempts/pending)
 *      → `"watching"`.
 */
export function derivePlannerOverseerState(input: DerivePlannerOverseerStateInput): PlannerOverseerState {
  const oversightLevel = input?.oversightLevel;
  const hasObservation = Boolean(input?.hasObservation);
  const attemptCount = input?.attemptCount ?? 0;
  const pendingConfirmationCount = input?.pendingConfirmationCount ?? 0;

  if (oversightLevel === "off" || !hasObservation) {
    return "idle";
  }
  if (pendingConfirmationCount > 0) {
    return "awaiting-confirmation";
  }
  if (attemptCount > 0) {
    return "recovering";
  }
  if (oversightLevel === "steer") {
    return "steering";
  }
  return "watching";
}
