import { describe, expect, it } from "vitest";

import { computeRetrySummary } from "../tasks/retry-summary.js";
import type { TaskDetail } from "../types.js";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-1",
    lineageId: "lineage-1",
    description: "desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeRetrySummary", () => {
  it("returns zeros when counters are missing", () => {
    expect(computeRetrySummary(makeTask())).toEqual({
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
      reviewerFallback: 0,
      total: 0,
    });
  });

  it("aggregates every retry counter", () => {
    const summary = computeRetrySummary(makeTask({
      stuckKillCount: 1,
      recoveryRetryCount: 2,
      taskDoneRetryCount: 3,
      worktreeSessionRetryCount: 4,
      workflowStepRetries: 5,
      verificationFailureCount: 5,
      postReviewFixCount: 6,
      mergeConflictBounceCount: 7,
      branchConflictRecoveryCount: 8,
      reviewerContextRetryCount: 9,
      reviewerFallbackRetryCount: 11,
    }));

    expect(summary).toEqual({
      stuckKill: 1,
      recovery: 2,
      taskDone: 3,
      worktreeSession: 4,
      workflowStep: 5,
      verification: 5,
      postReviewFix: 6,
      mergeConflict: 7,
      branchConflict: 8,
      reviewerContext: 9,
      reviewerFallback: 11,
      total: 61,
    });
  });

  it("treats null/undefined fields as zero", () => {
    const summary = computeRetrySummary(makeTask({
      stuckKillCount: undefined,
      recoveryRetryCount: undefined,
      branchConflictRecoveryCount: undefined,
      reviewerContextRetryCount: undefined,
      reviewerFallbackRetryCount: undefined,
    }));

    expect(summary.total).toBe(0);
  });
});
