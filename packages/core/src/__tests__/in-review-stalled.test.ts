import { describe, expect, it } from "vitest";
import { DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS, getInReviewStalledSignal } from "../tasks/in-review-stalled.js";

const NOW = Date.parse("2026-05-19T12:00:00.000Z");

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const baseTask = {
  id: "FN-5093-A",
  column: "in-review" as const,
  paused: false,
  status: "in-review" as const,
  columnMovedAt: iso(NOW - DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS - 1_000),
  updatedAt: iso(NOW - DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS - 1_000),
  mergeDetails: {},
  log: [],
};

describe("getInReviewStalledSignal", () => {
  it("returns signal for quiet in-review task beyond threshold", () => {
    const signal = getInReviewStalledSignal(baseTask, { now: NOW });
    expect(signal?.code).toBe("in-review-stalled");
    expect(signal?.quietMs).toBeGreaterThanOrEqual(DEFAULT_IN_REVIEW_STALLED_THRESHOLD_MS);
    expect(signal?.lastActivitySource).toBe("column-moved");
  });

  it("returns undefined for paused task", () => {
    expect(getInReviewStalledSignal({ ...baseTask, paused: true }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for non in-review column", () => {
    expect(getInReviewStalledSignal({ ...baseTask, column: "todo" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined when autoMerge is disabled", () => {
    expect(getInReviewStalledSignal(baseTask, { now: NOW, autoMerge: false })).toBeUndefined();
  });

  it("returns undefined when merge is already confirmed", () => {
    expect(getInReviewStalledSignal({ ...baseTask, mergeDetails: { mergeConfirmed: true } }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for awaiting-user-review", () => {
    expect(getInReviewStalledSignal({ ...baseTask, status: "awaiting-user-review" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for awaiting-approval", () => {
    expect(getInReviewStalledSignal({ ...baseTask, status: "awaiting-approval" }, { now: NOW })).toBeUndefined();
  });

  it.each(["merging", "merging-pr", "merging-fix"])("returns undefined for active merge status %s", (status) => {
    expect(getInReviewStalledSignal({ ...baseTask, status }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for active merge owner", () => {
    expect(getInReviewStalledSignal(baseTask, { now: NOW, activeMergeTaskId: baseTask.id })).toBeUndefined();
  });

  it("returns undefined when task is currently executing", () => {
    expect(getInReviewStalledSignal(baseTask, {
      now: NOW,
      executingTaskIds: new Set([baseTask.id]),
    })).toBeUndefined();
  });

  it("suppresses when recent log activity is within threshold and emits once aged out", () => {
    const withRecentLog = {
      ...baseTask,
      log: [{ timestamp: iso(NOW - 5_000), action: "random activity" }],
    };
    expect(getInReviewStalledSignal(withRecentLog, { now: NOW, thresholdMs: 10_000 })).toBeUndefined();

    const later = getInReviewStalledSignal(withRecentLog, { now: NOW + 15_000, thresholdMs: 10_000 });
    expect(later?.code).toBe("in-review-stalled");
  });

  it("suppresses while recent reason-driven stall log exists and emits after it ages out", () => {
    const task = {
      ...baseTask,
      log: [{ timestamp: iso(NOW - 2_000), action: "In-review stall surfaced [merge-blocker]: blocked" }],
    };
    expect(getInReviewStalledSignal(task, { now: NOW, thresholdMs: 10_000 })).toBeUndefined();

    const later = getInReviewStalledSignal(task, { now: NOW + 12_000, thresholdMs: 10_000 });
    expect(later?.code).toBe("in-review-stalled");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("returns undefined for invalid threshold %s", (thresholdMs) => {
    expect(getInReviewStalledSignal(baseTask, { now: NOW, thresholdMs })).toBeUndefined();
  });

  it("uses log as last activity source when newest", () => {
    const signal = getInReviewStalledSignal({
      ...baseTask,
      columnMovedAt: iso(NOW - 30_000),
      updatedAt: iso(NOW - 20_000),
      log: [{ timestamp: iso(NOW - 10_000), action: "newest" }],
    }, { now: NOW, thresholdMs: 10_000 });
    expect(signal?.lastActivitySource).toBe("log");
  });

  it("uses column-moved when it is newest and log is absent", () => {
    const signal = getInReviewStalledSignal({
      ...baseTask,
      columnMovedAt: iso(NOW - 12_000),
      updatedAt: iso(NOW - 20_000),
      log: [],
    }, { now: NOW, thresholdMs: 10_000 });
    expect(signal?.lastActivitySource).toBe("column-moved");
  });

  it("uses updated when only updatedAt is parseable", () => {
    const signal = getInReviewStalledSignal({
      ...baseTask,
      columnMovedAt: undefined,
      updatedAt: iso(NOW - 12_000),
      log: [],
    }, { now: NOW, thresholdMs: 10_000 });
    expect(signal?.lastActivitySource).toBe("updated");
  });

  it("suppresses signal during activation grace warmup", () => {
    const signal = getInReviewStalledSignal(baseTask, {
      now: NOW,
      thresholdMs: 10_000,
      engineActiveSinceMs: NOW - 5_000,
      engineActivationGraceMs: 30_000,
    });
    expect(signal).toBeUndefined();
  });

  it("adds effectiveLastActivityAt when floor changes activity anchor", () => {
    const signal = getInReviewStalledSignal(baseTask, {
      now: NOW,
      thresholdMs: 10_000,
      engineActiveSinceMs: NOW - 20_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("in-review-stalled");
    expect(signal?.effectiveLastActivityAt).toBe(iso(NOW - 20_000));
    expect(signal?.lastActivityAt).not.toBe(signal?.effectiveLastActivityAt);
  });

  it("fires normally when activation floor is far in the past", () => {
    const signal = getInReviewStalledSignal(baseTask, {
      now: NOW,
      thresholdMs: 10_000,
      engineActiveSinceMs: NOW - 100_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("in-review-stalled");
  });
});
