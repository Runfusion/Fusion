import { describe, expect, it } from "vitest";

import { RetryStormError, serializeRetryStormError } from "../tasks/retry-storm-error.js";
import type { RetrySummary } from "../types.js";

const BREAKDOWN: RetrySummary = {
  stuckKill: 0,
  recovery: 0,
  taskDone: 0,
  worktreeSession: 0,
  workflowStep: 0,
  verification: 0,
  postReviewFix: 0,
  mergeConflict: 0,
  branchConflict: 0,
  reviewerContext: 0,
  reviewerFallback: 3,
  total: 3,
};

function makeStorm(cause?: unknown): RetryStormError {
  return new RetryStormError({ category: "reviewerFallback", total: 3, cap: 2, breakdown: BREAKDOWN, cause });
}

/**
 * FNXC:RetryStorm 2026-07-15-21:30:
 * The storm message used to REPLACE the real error from the cap onward, so "the provider is down"
 * and "the reviewer keeps failing for other reasons" were indistinguishable in logs and task.error.
 */
describe("RetryStormError", () => {
  it("keeps the underlying error in the message, the field, and the native cause", () => {
    const cause = new Error("429: overloaded_error");
    const err = makeStorm(cause);

    expect(err.message).toContain("Retry storm: 3 retries exceeds cap 2");
    expect(err.message).toContain("429: overloaded_error");
    expect(err.underlyingError).toBe("429: overloaded_error");
    expect(err.cause).toBe(cause);
  });

  it("stringifies a non-Error cause", () => {
    expect(makeStorm("plain string failure").underlyingError).toBe("plain string failure");
  });

  it("stays silent about a cause it was never given", () => {
    const err = makeStorm();

    expect(err.message).toBe("Retry storm: 3 retries exceeds cap 2 (top category: reviewerFallback)");
    expect(err.underlyingError).toBeUndefined();
    expect(serializeRetryStormError(err)).not.toHaveProperty("underlyingError");
  });

  it("serializes the underlying error for structured surfaces", () => {
    expect(serializeRetryStormError(makeStorm(new Error("429: overloaded_error")))).toEqual({
      type: "RetryStormError",
      category: "reviewerFallback",
      total: 3,
      cap: 2,
      breakdown: BREAKDOWN,
      underlyingError: "429: overloaded_error",
    });
  });
});
