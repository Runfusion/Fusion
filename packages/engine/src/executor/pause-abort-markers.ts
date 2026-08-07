/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * clearPausedAborted + markCompletionFinalized peeled from TaskExecutor (U4).
 * Companion markers to markPausedAborted (already free).
 *
 * FNXC:WorkflowLifecycle 2026-06-18-10:56:
 * FN-6644 makes completed/no-commit finalize-to-review state durable beyond volatile pause provenance. FN-6641 showed FN-6625 was incomplete because teardown can re-mark `completion-finalize` as `hard-cancel`; the completionFinalizedTaskIds marker keeps the already-finalized handoff from being re-parked as an operator-action pause abort while preserving genuine live pauses and active hard-cancels.
 */
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";

export type PauseAbortMarkerDeps = {
  pausedAborted: Set<string>;
  pausedAbortProvenance: Map<string, PausedAbortProvenance>;
  completionFinalizedTaskIds: Set<string>;
  markPausedAborted: (
    taskId: string,
    provenance?: PausedAbortProvenance,
    source?: string,
  ) => void;
};

export function markCompletionFinalized(
  deps: PauseAbortMarkerDeps,
  taskId: string,
): void {
  deps.markPausedAborted(taskId, "completion-finalize", "completion-finalize");
  deps.completionFinalizedTaskIds.add(taskId);
}

export function clearPausedAborted(
  deps: PauseAbortMarkerDeps,
  taskId: string,
): void {
  deps.pausedAborted.delete(taskId);
  deps.pausedAbortProvenance.delete(taskId);
  deps.completionFinalizedTaskIds.delete(taskId);
}
