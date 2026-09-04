import type { TaskLogEntry } from "../types.js";
import { CLEAN_COMPLETION_MARKERS, MAX_LOG_SCAN } from "../merge/completed-promotion-failure-provenance.js";

/*
FNXC:StepLedgerIntegrity 2026-08-29-06:46:
Completion is durable lifecycle evidence, not a transient process flag. Reuse the bounded,
most-recent-marker scan already trusted by completion promotion so a late step projection is refused
until a fresh executor session, a pending reset, or an explicit operator edit supersedes the claim.
A bounded tail deliberately fails open rather than wedging old completed cards.
*/

/** Prefix recorded before any admitted implementation re-entry after completion. */
export const STEP_LEDGER_REOPEN_MARKER_PREFIX = "Step ledger reopened";

/*
FNXC:StepLedgerIntegrity 2026-09-01-00:35:
The seal's OWN refusal narration must never be read back as evidence of completion.

That refusal quotes the marker it acted on -- `implementation ended at "<markerAction>"` -- and the
scan below matches by SUBSTRING. So the refusal line itself contains "Task marked done by agent",
the next backward scan hits that newer line first, and the seal re-seals on its own output. Each
refusal then quotes the previous one, nesting deeper every pass, and NO re-entry marker can ever lift
it again because the newest refusal always wins the scan.

Measured on FN-270: "Ignored post-completion in-progress for step 12 ... implementation ended at
\"Ignored post-completion in-progress for step 12 ... implementation ended at \"Task marked done by
agent\"\"" -- a card resuming, reporting progress, and still refused.

This is the same doctrine `CLEAN_COMPLETION_MARKERS` already states for the promoter: a component's
own narration is never proof of the thing it narrates. Skipping it keeps the operator-facing message
intact while denying it evidentiary weight.
*/
export const STEP_LEDGER_REFUSAL_MARKER_PREFIX = "Ignored post-completion";

/**
 * Durable execution markers that supersede a prior clean-completion claim. Keep this list narrow:
 * a forward lifecycle move and a pre-merge step start intentionally do not reopen implementation.
 *
 * FNXC:StepLedgerIntegrity 2026-09-01-00:35:
 * BOTH unpause resume wordings are listed. The seal documents "a resume-after-unpause" as re-entry,
 * but only `run-implementation.ts` writes "Resumed agent session after unpause"; the graph resume in
 * `unpause-resume.ts` writes "Resuming execution after unpause", which matched nothing. One of the
 * two declared re-entry paths therefore never worked -- an unpaused card kept its seal and its steps
 * stayed unstartable.
 */
export const STEP_LEDGER_REENTRY_MARKERS = [
  "Executor using model:",
  "Resumed agent session after unpause",
  "Resuming execution after unpause",
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
    /* This seam's own refusal quotes the marker verbatim; reading it back would re-seal on self-narration. */
    if (action.startsWith(STEP_LEDGER_REFUSAL_MARKER_PREFIX)) continue;
    if (includesAny(action, CLEAN_COMPLETION_MARKERS)) {
      return { sealed: true, markerAction: action };
    }
    if (includesAny(action, STEP_LEDGER_REENTRY_MARKERS)) {
      return { sealed: false };
    }
  }
  return { sealed: false };
}

/**
 * Build the atomic log patch that acknowledges genuine implementation re-entry after completion.
 * Live sessions return `undefined` so callers omit the log field instead of manufacturing a marker.
 */
export function buildStepLedgerReopenLog(
  log: readonly TaskLogEntry[] | undefined | null,
  reason: string,
): TaskLogEntry[] | undefined {
  if (!evaluateStepLedgerSeal(log).sealed) return undefined;
  return [
    ...(log ?? []),
    {
      timestamp: new Date().toISOString(),
      action: `${STEP_LEDGER_REOPEN_MARKER_PREFIX} — ${reason}`,
    },
  ];
}
