import type { TaskLogEntry } from "../types.js";
import { CLEAN_COMPLETION_MARKERS, MAX_LOG_SCAN } from "../merge/completed-promotion-failure-provenance.js";

/*
FNXC:StepLedgerIntegrity 2026-08-29-06:46:
Completion is durable lifecycle evidence, not a transient process flag. Reuse the bounded,
most-recent-marker scan already trusted by completion promotion so a late step projection is refused
until a fresh executor session, a pending reset, or an explicit operator edit supersedes the claim.
A bounded tail deliberately fails open rather than wedging old completed cards.
*/

/** Prefix recorded before a pending reset or operator edit resumes implementation after completion. */
export const STEP_LEDGER_REOPEN_MARKER_PREFIX = "Step ledger reopened";

/**
 * Durable execution markers that supersede a prior clean-completion claim. Keep this list narrow:
 * a forward lifecycle move and a pre-merge step start intentionally do not reopen implementation.
 */
export const STEP_LEDGER_REENTRY_MARKERS = [
  "Executor using model:",
  "Resumed agent session after unpause",
  STEP_LEDGER_REOPEN_MARKER_PREFIX,
] as const;

export interface StepLedgerSealEvaluation {
  sealed: boolean;
  markerAction?: string;
}

function includesAny(action: string, markers: readonly string[]): boolean {
  return markers.some((marker) => action.includes(marker));
}

/**
 * Derive the current step-ledger completion window from the durable task-log tail. The newest
 * lifecycle marker wins, and a bounded scan deliberately fails open when history is too old.
 */
export function evaluateStepLedgerSeal(
  log: readonly Pick<TaskLogEntry, "action">[] | undefined | null,
): StepLedgerSealEvaluation {
  const entries = log ?? [];
  const scanFloor = Math.max(0, entries.length - MAX_LOG_SCAN);
  for (let index = entries.length - 1; index >= scanFloor; index -= 1) {
    const action = entries[index]?.action ?? "";
    if (includesAny(action, CLEAN_COMPLETION_MARKERS)) {
      return { sealed: true, markerAction: action };
    }
    if (includesAny(action, STEP_LEDGER_REENTRY_MARKERS)) {
      return { sealed: false };
    }
  }
  return { sealed: false };
}
