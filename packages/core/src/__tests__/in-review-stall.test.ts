import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  countRecentIdenticalStallEntries,
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  getInReviewStallReason,
} from "../tasks/in-review-stall.js";

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

describe("classifyProviderError", () => {
  it.each([
    "HTTP 400 invalid_request_error: unsupported parameter",
    "model gpt-5.3-codex is not supported by this provider",
    "model claude-next not found",
    "Configured model provider/model was not found in the pi model registry",
    "invalid model: gpt-unknown",
    "The requested model does not exist",
    "permission denied for model access",
    "HTTP 403 forbidden for model",
    "401 unauthorized: invalid api key",
  ])("classifies non-retryable provider errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("non_retryable");
  });

  it.each([
    "HTTP 503 service unavailable",
    "429 rate limit exceeded",
    "Request timed out after 60s",
    "ECONNRESET while reading provider response",
    "provider overloaded; try again later",
  ])("classifies retryable provider errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("retryable");
  });

  it.each([
    "",
    "task has incomplete steps",
    "merge conflict in package.json",
    "unexpected provider response shape",
  ])("classifies unknown errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("unknown");
  });

  it("gives non-retryable patterns precedence over retryable patterns", () => {
    expect(classifyProviderError("HTTP 400 invalid_request_error after rate limit warning")).toBe("non_retryable");
  });
});

describe("countRecentIdenticalStallEntries", () => {
  const reason = "Failed to create worktree after 3 attempts";
  const task = (log: Array<{ timestamp: string; action: string }>) => ({ log });

  it("returns 0 with no log entries", () => {
    expect(countRecentIdenticalStallEntries(task([]), { code: "merge-blocker", reason })).toBe(0);
  });

  it("counts three identical most-recent entries", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(3);
  });

  it("stops at first non-stall entry and only counts the suffix", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:56:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:57:00.000Z", action: "something else" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });

  it("stops counting on different code", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: "In-review stall surfaced [merge-retries-exhausted]: retries exhausted" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });

  it("stops counting on different reason text", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: "In-review stall surfaced [merge-blocker]: another reason" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });
});

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

  it("returns non-retryable-provider-error for failed task provider blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
    }, { now: NOW });
    expect(signal?.code).toBe("non-retryable-provider-error");
    expect(signal?.reason).toBe("Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported");
  });

  it("keeps retryable provider errors as merge-blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "HTTP 503 service unavailable",
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toBe("task is marked 'failed': HTTP 503 service unavailable");
  });

  it("keeps unknown failed task errors as merge-blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "merge conflict requires manual resolution",
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toBe("task is marked 'failed': merge conflict requires manual resolution");
  });

  it("suppresses merge-blocker when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      workflowStepResults: [{ workflowStepId: "WS-1", workflowStepName: "gate", status: "failed", phase: "pre-merge" as const }],
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses transient-merge-status-no-owner when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses merge-retries-exhausted when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      mergeDetails: { mergeConfirmed: false },
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses no-worktree-no-merge-confirmed when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      worktree: undefined,
      mergeDetails: {},
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("preserves legacy behavior when autoMerge is true or omitted", () => {
    const stalledTask = {
      ...baseTask,
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      mergeDetails: { mergeConfirmed: false },
    };
    expect(getInReviewStallReason(stalledTask, { now: NOW, autoMerge: true })?.code).toBe("merge-retries-exhausted");
    expect(getInReviewStallReason(stalledTask, { now: NOW })?.code).toBe("merge-retries-exhausted");
  });

  it("returns undefined when all clear", () => {
    expect(getInReviewStallReason({ ...baseTask }, { now: NOW })).toBeUndefined();
  });

  it("preserves status-driven merge-blocker even when activation floor is recent", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - (DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000),
      engineActivationGraceMs: 90_000,
    });
    expect(signal?.code).toBe("merge-blocker");
  });

  it("fires transient status once engine activation floor is old", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 120_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });

  it("with zero grace, counts from activation timestamp immediately", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 1).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("merge-blocker");
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
