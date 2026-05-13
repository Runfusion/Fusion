import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  getInReviewStallReason,
} from "../in-review-stall.js";

const NOW = Date.parse("2026-05-12T12:00:00.000Z");

const baseTask = {
  id: "FN-4110",
  column: "in-review" as const,
  paused: false,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [{ name: "Step 1", status: "done" as const }],
  workflowStepResults: undefined,
  worktree: "/tmp/fn-4110",
  mergeDetails: {},
  mergeRetries: 0,
  updatedAt: new Date(NOW).toISOString(),
};

describe("getInReviewStallReason", () => {
  it("returns transient-merge-status-no-owner for FN-4110 fixture", () => {
    const signal = getInReviewStallReason(
      {
        ...baseTask,
        status: "merging",
        mergeRetries: 0,
        worktree: "/tmp/fn-4110",
        updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
      },
      { now: NOW },
    );

    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });

  it("returns undefined when active merger owns task", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "merging" }, { now: NOW, activeMergeTaskId: "FN-4110" })).toBeUndefined();
  });

  it("returns undefined when task is currently executing", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "merging" }, { now: NOW, executingTaskIds: new Set(["FN-4110"]) })).toBeUndefined();
  });

  it("returns merge-retries-exhausted", () => {
    const signal = getInReviewStallReason({ ...baseTask, mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES, mergeDetails: { mergeConfirmed: false } }, { now: NOW });
    expect(signal?.code).toBe("merge-retries-exhausted");
  });

  it("returns no-worktree-no-merge-confirmed", () => {
    const signal = getInReviewStallReason({ ...baseTask, worktree: undefined, mergeDetails: {} }, { now: NOW });
    expect(signal?.code).toBe("no-worktree-no-merge-confirmed");
  });

  it("returns undefined for awaiting-user-review", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "awaiting-user-review" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for awaiting-approval", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "awaiting-approval" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for paused tasks", () => {
    expect(getInReviewStallReason({ ...baseTask, paused: true }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined when merge is confirmed", () => {
    expect(getInReviewStallReason({ ...baseTask, mergeDetails: { mergeConfirmed: true }, status: "merging" }, { now: NOW })).toBeUndefined();
  });

  it("returns merge-blocker for failed pre-merge workflow step", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      workflowStepResults: [{ workflowStepId: "WS-1", workflowStepName: "gate", status: "failed", phase: "pre-merge" as const }],
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toContain("failed pre-merge workflow steps");
  });

  it("returns undefined when all clear", () => {
    expect(getInReviewStallReason({ ...baseTask }, { now: NOW })).toBeUndefined();
  });

  it("prioritizes transient merge status over retries exhausted", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, { now: NOW });
    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });
});
