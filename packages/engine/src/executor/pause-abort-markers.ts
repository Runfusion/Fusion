/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * clearPausedAborted + markCompletionFinalized peeled from TaskExecutor (U4).
 * Companion markers to markPausedAborted (already free).
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
