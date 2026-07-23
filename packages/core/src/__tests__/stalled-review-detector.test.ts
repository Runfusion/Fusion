import { describe, expect, it } from "vitest";

import {
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD,
  STALLED_REVIEW_REENQUEUE_PATTERN,
  STALLED_REVIEW_REENQUEUE_THRESHOLD,
  STALLED_REVIEW_WINDOW_MS,
  detectStalledReview,
} from "../tasks/stalled-review-detector.js";
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
});
