import { derivePlannerOverseerState, PLANNER_RECOVERY_MAX_ATTEMPTS, type PlannerOverseerRuntimeSnapshot } from "@fusion/core";
import type { OverseerStageObservation } from "./planner-overseer.js";

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * FN-7531 narrow read-only shapes for the two engine subsystems this
 * assembly helper reads. Kept as minimal structural interfaces (rather than
 * importing the concrete `PlannerOverseerMonitor`/`PlannerRecoveryController`
 * classes) so unit tests can pass focused in-memory fakes without
 * constructing the full engine.
 */
export interface PlannerOverseerObservationSource {
  getObservations(taskId: string): OverseerStageObservation[];
}

export interface PlannerRecoveryRegistrySource {
  getPendingConfirmations(taskId: string): { status?: string }[];
  getAttemptCount(taskId: string, stage: string): number;
  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 addition: last dispatched/recorded action label for a
   * `(taskId, stage)` pair, consumed by the "explain current action"
   * control. Optional on the source interface so pre-FN-7517 fakes in
   * existing tests keep compiling without a stub.
   */
  getLastAction?(taskId: string, stage: string): string | undefined;
}

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Pure(-ish) assembly of the transient `PlannerOverseerRuntimeSnapshot` for
 * one task from the FN-7511 monitor's latest observation plus the
 * FN-7512/FN-7513 controller's attempt/pending-confirmation registries.
 * Read-only: never mutates either source. Returns `null` when there is no
 * active observation for the task (nothing to show on the card). Never
 * throws — this is `ProjectEngine.getPlannerOverseerRuntimeSnapshot`'s
 * delegate, called from the hot `GET /api/tasks` path, so any subsystem
 * error degrades to `null` rather than risking the board load.
 */
export function assemblePlannerOverseerRuntimeSnapshot(
  taskId: string,
  monitor: PlannerOverseerObservationSource | undefined,
  recoveryController: PlannerRecoveryRegistrySource | undefined,
): PlannerOverseerRuntimeSnapshot | null {
  try {
    const observations = monitor?.getObservations(taskId);
    const observation = observations && observations.length > 0 ? observations[observations.length - 1] : undefined;
    if (!observation) {
      return null;
    }

    const pendingConfirmationCount = recoveryController?.getPendingConfirmations(taskId).length ?? 0;
    const attemptCount = recoveryController?.getAttemptCount(taskId, observation.stage) ?? 0;
    const lastAction = recoveryController?.getLastAction?.(taskId, observation.stage);

    const state = derivePlannerOverseerState({
      oversightLevel: observation.oversightLevel,
      hasObservation: true,
      attemptCount,
      pendingConfirmationCount,
    });

    return {
      state,
      oversightLevel: observation.oversightLevel,
      watchedStage: observation.stage,
      signal: observation.signal,
      attemptCount,
      attemptLimit: PLANNER_RECOVERY_MAX_ATTEMPTS,
      pendingConfirmation: pendingConfirmationCount > 0,
      observedAt: observation.observedAt,
      reason: observation.reason,
      ...(lastAction ? { lastAction } : {}),
    };
  } catch {
    return null;
  }
}
