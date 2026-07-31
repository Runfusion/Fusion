import { describe, expect, it } from "vitest";

import {
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  detectStalledReview,
} from "../stalled-review-detector.js";
import type { TaskLogEntry } from "../types.js";

function entry(timestamp: string, action: string, outcome?: string): TaskLogEntry {
  return { timestamp, action, outcome };
}

describe("detectStalledReview", () => {
  const now = Date.parse("2026-05-12T12:00:00.000Z");

  it("fires reenqueue-churn at threshold", () => {
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [
        entry("2026-05-12T11:30:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
        entry("2026-05-12T11:40:00.000Z", `noise ${STALLED_REVIEW_REENQUEUE_PATTERN}`),
        entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
      ],
    }, { now });

    expect(signal?.heuristic).toBe("reenqueue-churn");
    expect(signal?.matchCount).toBe(STALLED_REVIEW_REENQUEUE_THRESHOLD);
  });

  it("does not fire reenqueue-churn below threshold", () => {
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [
        entry("2026-05-12T11:30:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
        entry("2026-05-12T11:40:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
      ],
    }, { now });

    expect(signal).toBeUndefined();
  });

  it("fires invalid-transition-loop at threshold", () => {
    const invalid = "Invalid transition: 'todo' → 'done'";
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [
        entry("2026-05-12T11:30:00.000Z", "merge recovery", invalid),
        entry("2026-05-12T11:40:00.000Z", invalid),
      ],
    }, { now });

    expect(invalid).toMatch(STALLED_REVIEW_INVALID_TRANSITION_PATTERN);
    expect(signal?.heuristic).toBe("invalid-transition-loop");
    expect(signal?.matchCount).toBe(STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD);
  });

  it("does not fire invalid-transition-loop below threshold", () => {
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [entry("2026-05-12T11:30:00.000Z", "Invalid transition: 'todo' → 'done'")],
    }, { now });

    expect(signal).toBeUndefined();
  });

  it("excludes older entries outside window", () => {
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [
        entry("2026-05-12T09:00:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
        entry("2026-05-12T11:40:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
        entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
      ],
    }, { now, windowMs: STALLED_REVIEW_WINDOW_MS });

    expect(signal).toBeUndefined();
  });

  it("returns undefined when not in-review", () => {
    expect(detectStalledReview({ column: "todo", paused: false, log: [entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN)] }, { now })).toBeUndefined();
  });

  it("returns undefined when paused", () => {
    expect(detectStalledReview({ column: "in-review", paused: true, log: [entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN)] }, { now })).toBeUndefined();
  });

  it("returns undefined when log is empty", () => {
    expect(detectStalledReview({ column: "in-review", paused: false, log: [] }, { now })).toBeUndefined();
  });

  it("prioritizes reenqueue-churn when both heuristics match", () => {
    const invalid = "Invalid transition: 'todo' → 'done'";
    const signal = detectStalledReview({
      column: "in-review",
      paused: false,
      log: [
        entry("2026-05-12T11:30:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN, invalid),
        entry("2026-05-12T11:40:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN, invalid),
        entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
      ],
    }, { now });

    expect(signal?.heuristic).toBe("reenqueue-churn");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet — the review lane, resolved):
  The renamed-board arm. Before the `reviewColumns` parameter this detector compared against the
  literal `"in-review"`, so on a board whose review lane is called anything else it returned
  `undefined` for EVERY card and the stall was unreportable — while the adjacent
  `getInReviewStallReason` on the very next line in `reads.ts` resolved the real lane. Two stall
  signals for one card, disagreeing by construction.

  Both arms are asserted, because the literal default is load-bearing: every caller outside
  `reads.ts` still omits the parameter and must keep today's behaviour exactly.
  */
  const churnLog = [
    entry("2026-05-12T11:30:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
    entry("2026-05-12T11:40:00.000Z", `noise ${STALLED_REVIEW_REENQUEUE_PATTERN}`),
    entry("2026-05-12T11:50:00.000Z", STALLED_REVIEW_REENQUEUE_PATTERN),
  ];

  it("RENAMED BOARD — detects the stall when the resolved review lane is passed", () => {
    const task = { column: "checking", paused: false, log: churnLog };

    // The unconverted call shape: silent on this board, which is the defect.
    expect(detectStalledReview(task, { now })).toBeUndefined();

    // The resolved answer the reads.ts hydration passes.
    const signal = detectStalledReview(task, { now, reviewColumns: new Set(["in-review", "checking"]) });
    expect(signal?.heuristic).toBe("reenqueue-churn");
    expect(signal?.matchCount).toBe(STALLED_REVIEW_REENQUEUE_THRESHOLD);
  });

  it("DEFAULT BOARD — the literal default is unchanged, and a resolved set still gates", () => {
    const task = { column: "in-review", paused: false, log: churnLog };

    // No parameter: exactly today's behaviour, which is what every caller outside reads.ts relies on.
    expect(detectStalledReview(task, { now })?.heuristic).toBe("reenqueue-churn");

    // A resolved set that does NOT contain the card's column must still say "not in review" — the
    // parameter is a real gate, not a widening that makes every card eligible.
    expect(detectStalledReview(task, { now, reviewColumns: new Set(["checking"]) })).toBeUndefined();
  });
});
