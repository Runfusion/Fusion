import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_AGE_STALENESS_THRESHOLDS,
  getTaskAgeStalenessSignal,
} from "../task-age-staleness.js";

const NOW = Date.parse("2026-05-14T12:00:00.000Z");

const baseTask = {
  column: "in-progress" as const,
  paused: false,
  columnMovedAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  mergeDetails: {},
};

describe("getTaskAgeStalenessSignal", () => {
  it("returns undefined when under warning threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - 60_000).toISOString() },
      { now: NOW },
    );
    expect(signal).toBeUndefined();
  });

  it("returns warning at warning threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("returns warning between warning and critical", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs - 1_000).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("returns critical at/over critical threshold", () => {
    const signal = getTaskAgeStalenessSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString() },
      { now: NOW },
    );
    expect(signal?.level).toBe("critical");
  });

  it("returns undefined for non-applicable columns", () => {
    expect(getTaskAgeStalenessSignal({ ...baseTask, column: "todo" }, { now: NOW })).toBeUndefined();
    expect(getTaskAgeStalenessSignal({ ...baseTask, column: "done" }, { now: NOW })).toBeUndefined();
  });

  it("includes paused=true in payload", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        column: "in-review",
        paused: true,
        columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inReviewWarningMs).toISOString(),
      },
      { now: NOW },
    );
    expect(signal?.paused).toBe(true);
  });

  it("suppresses signal when merge is confirmed", () => {
    expect(
      getTaskAgeStalenessSignal(
        {
          ...baseTask,
          columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressCriticalMs).toISOString(),
          mergeDetails: { mergeConfirmed: true },
        },
        { now: NOW },
      ),
    ).toBeUndefined();
  });

  it("falls back to updatedAt when columnMovedAt missing", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        columnMovedAt: undefined,
        updatedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString(),
      },
      { now: NOW },
    );
    expect(signal?.level).toBe("warning");
  });

  it("treats 0/undefined thresholds as disabled levels", () => {
    const signal = getTaskAgeStalenessSignal(
      {
        ...baseTask,
        columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs).toISOString(),
      },
      {
        now: NOW,
        thresholds: {
          inProgressWarningMs: DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inProgressWarningMs,
          inProgressCriticalMs: 0,
        },
      },
    );
    expect(signal?.level).toBe("warning");
    expect(signal?.criticalThresholdMs).toBe(0);
  });

  it("throws when critical threshold is below warning", () => {
    expect(() =>
      getTaskAgeStalenessSignal(
        {
          ...baseTask,
          column: "in-review",
          columnMovedAt: new Date(NOW - DEFAULT_TASK_AGE_STALENESS_THRESHOLDS.inReviewWarningMs).toISOString(),
        },
        {
          now: NOW,
          thresholds: {
            inReviewWarningMs: 10_000,
            inReviewCriticalMs: 9_000,
          },
        },
      )
    ).toThrowError(new RangeError("critical threshold must be >= warning threshold"));
  });
});
