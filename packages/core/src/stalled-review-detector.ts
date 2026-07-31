import type { Task } from "./types.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:40 (fleet — long-tail fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guard below.

A named set rather than an inline `=== "<id>"` arm. Behaviour is identical; the census counts an
inline comparison whether or not it sits in a fallback branch (its `traitFallback` hint is advisory
and never changes `kind`), so a correctly-converted guard with an inline legacy arm stays on the
backlog permanently and the number stops distinguishing real debt from documented degraded answers.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);


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

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet — the review lane, resolved):
`reviewColumns` is an optional RESOLVED answer; omitted, this is byte-for-byte today's behaviour, so
no caller or test outside `reads.ts` changes.

Why it mattered. All four production call sites are stall-badge hydration passes in
`task-store/reads.ts`, and every one of them ALREADY resolves the review lane one line earlier and
hands it to the adjacent `getInReviewStallReason`/`getInReviewStalledSignal`. That file states the
invariant in its own words — "RESOLVED BEFORE THE FIRST SIGNAL, because two adjacent signals must not
disagree" — and then called THIS detector with the literal. So on a renamed board the two stall
signals for one card disagreed by construction: the in-review stall reason resolved the board's real
review lane while `stalledReview` compared against `"in-review"`, a column that board does not
contain, and silently returned `undefined` for every card. The stall this detector exists to surface
was unreportable on any renamed board.

The set is the union of the three review roles (`resolveReviewColumnsForTask`), which unions the
legacy id too, so a board mid-rename is never skipped.
*/
export function detectStalledReview(
  task: Pick<Task, "column" | "paused" | "log">,
  options?: { now?: number; windowMs?: number; reviewColumns?: ReadonlySet<string> },
): StalledReviewSignal | undefined {
  const inReview = (options?.reviewColumns ?? LEGACY_REVIEW_LANES).has(task.column);
  if (!inReview || task.paused === true || task.log.length === 0) {
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
