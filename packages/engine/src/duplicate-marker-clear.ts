/**
 * Shared contracts for clearing an explicit DUPLICATE: marker without a real plan.
 *
 * FNXC:NearDuplicateDetection 2026-08-01-18:47:
 * Clearing a DUPLICATE marker must leave needs-replan + durable feedback +
 * nearDuplicateDismissed — never status:null. status:null is the planning-finished
 * signal the scheduler wakes on, so a prompt-less null-status card re-dispatches,
 * FS-fails, and storms (observed on FN-8704 / inactive FN-8676).
 *
 * FNXC:NearDuplicateDetection 2026-08-02-00:46:
 * First clear of an inactive/dismissed-id marker gets one needs-replan chance.
 * A second DUPLICATE write for the same already-dismissed canonical parks failed
 * (DUPLICATE_REPLAN_EXHAUSTED) so triage stops re-admitting the card forever.
 */

/** Log action picked up by triage's needs-replan feedback scanner. */
export const TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION = "Duplicate marker cleared for re-specification";

/** Terminal park after planner re-emits the same dismissed inactive DUPLICATE. */
export const DUPLICATE_REPLAN_EXHAUSTED_PREFIX = "DUPLICATE_REPLAN_EXHAUSTED:";

export function buildInactiveDuplicateClearFeedback(canonicalId: string): string {
  return `Explicit duplicate marker targeting ${canonicalId} was cleared because that task is missing, deleted, done, or archived. Write a full PROMPT.md for this work. Do not re-emit DUPLICATE: ${canonicalId}.`;
}

export function buildKeepDuplicateClearFeedback(canonicalId: string): string {
  return `Duplicate marker for ${canonicalId} was cleared (Keep / keep-acknowledged). Write a full PROMPT.md for this work. Do not re-emit DUPLICATE: ${canonicalId}.`;
}

export function buildDuplicateReplanExhaustedError(canonicalId: string): string {
  return `${DUPLICATE_REPLAN_EXHAUSTED_PREFIX} planner re-emitted DUPLICATE: ${canonicalId} after that inactive or dismissed canonical was already cleared. Write a real plan for this card, or archive it.`;
}

const dismissedSourcePatch = (canonicalId: string, clearCount: number) => ({
  nearDuplicateOf: canonicalId,
  nearDuplicateScore: 1,
  duplicateSource: "triage-marker" as const,
  nearDuplicateDismissed: true as const,
  /** How many times we cleared a DUPLICATE marker for this card (exhaust after >= 1 prior). */
  duplicateMarkerClearCount: clearCount,
});

/** Patch applied when a marker is cleared so the card is unplanned, not "planning finished". */
export function buildMarkerClearedReplanTaskPatch(canonicalId: string, priorClearCount = 0): {
  paused: false;
  pausedReason: null;
  status: "needs-replan";
  error: null;
  sourceMetadataPatch: ReturnType<typeof dismissedSourcePatch>;
} {
  return {
    paused: false,
    pausedReason: null,
    status: "needs-replan",
    error: null,
    sourceMetadataPatch: dismissedSourcePatch(canonicalId, priorClearCount + 1),
  };
}

/**
 * After one free replan, re-emitting the same dismissed inactive DUPLICATE parks failed
 * so triage's `status === "failed"` filter stops re-admitting the card.
 */
export function buildMarkerExhaustedFailedTaskPatch(canonicalId: string, priorClearCount = 1): {
  paused: false;
  pausedReason: null;
  status: "failed";
  error: string;
  recoveryRetryCount: null;
  nextRecoveryAt: null;
  sourceMetadataPatch: ReturnType<typeof dismissedSourcePatch>;
} {
  return {
    paused: false,
    pausedReason: null,
    status: "failed",
    error: buildDuplicateReplanExhaustedError(canonicalId),
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    sourceMetadataPatch: dismissedSourcePatch(canonicalId, Math.max(priorClearCount + 1, 2)),
  };
}
