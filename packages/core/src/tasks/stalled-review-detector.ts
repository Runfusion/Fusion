import type { Task } from "../types.js";

/**
 * Heuristic-only stalled review detector.
 *
 * This scans recent task log entries for repeat recovery-loop signatures seen in
 * FN-2997/FN-3050 (re-enqueue churn) and FN-3946/FN-3951 (invalid transition
 * loop) and returns a non-destructive signal for UI surfacing.
 */

/**
 * Threshold for re-enqueue churn: observed incidents required at least 3
 * repeated merge re-enqueue messages within a short window before queues backed
 * up (FN-2997/FN-3050).
 */
export const STALLED_REVIEW_REENQUEUE_THRESHOLD = 3;

/**
 * Threshold for invalid-transition loop errors: repeated recoveries were noisy
 * and actionable by the second hit in a one-hour window (FN-3946/FN-3951).
 */
export const STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD = 2;

/**
 * Lookback window for the stall heuristics. Tune conservatively: widening this
 * increases sensitivity/noise, shrinking it can miss active loops.
 */
export const STALLED_REVIEW_WINDOW_MS = 60 * 60 * 1000;

export const STALLED_REVIEW_REENQUEUE_PATTERN = "Auto-recovered: eligible in-review task re-enqueued for merge";
export const STALLED_REVIEW_INVALID_TRANSITION_PATTERN = /Invalid transition: '[^']+' → '[^']+'/;

export interface StalledReviewSignal {
  reason: string;
  heuristic: "reenqueue-churn" | "invalid-transition-loop";
  matchCount: number;
  firstMatchAt: string;
  lastMatchAt: string;
}

export function detectStalledReview(
  task: Pick<Task, "column" | "paused" | "log">,
  options?: { now?: number; windowMs?: number },
): StalledReviewSignal | undefined {
  if (task.column !== "in-review" || task.paused === true || task.log.length === 0) {
    return undefined;
  }

  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? STALLED_REVIEW_WINDOW_MS;
  const windowStart = now - windowMs;
  const windowedEntries = task.log.filter((entry) => {
    const ts = Date.parse(entry.timestamp);
    return Number.isFinite(ts) && ts >= windowStart && ts <= now;
  });

  if (windowedEntries.length === 0) {
    return undefined;
  }

  const reenqueueMatches = windowedEntries.filter((entry) => entry.action.includes(STALLED_REVIEW_REENQUEUE_PATTERN));
  if (reenqueueMatches.length >= STALLED_REVIEW_REENQUEUE_THRESHOLD) {
    const minutes = Math.floor(windowMs / (60 * 1000));
    return {
      reason: `Re-enqueued for merge ${reenqueueMatches.length} times in the last ${minutes} minutes without leaving in-review`,
      heuristic: "reenqueue-churn",
      matchCount: reenqueueMatches.length,
      firstMatchAt: reenqueueMatches[0]!.timestamp,
      lastMatchAt: reenqueueMatches[reenqueueMatches.length - 1]!.timestamp,
    };
  }

  const invalidTransitionMatches = windowedEntries.filter((entry) => {
    const action = entry.action ?? "";
    const outcome = entry.outcome ?? "";
    return STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(action)
      || STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(outcome);
  });

  if (invalidTransitionMatches.length >= STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD) {
    const minutes = Math.floor(windowMs / (60 * 1000));
    return {
      reason: `Repeated invalid-transition recovery errors (${invalidTransitionMatches.length}) in the last ${minutes} minutes`,
      heuristic: "invalid-transition-loop",
      matchCount: invalidTransitionMatches.length,
      firstMatchAt: invalidTransitionMatches[0]!.timestamp,
      lastMatchAt: invalidTransitionMatches[invalidTransitionMatches.length - 1]!.timestamp,
    };
  }

  return undefined;
}
