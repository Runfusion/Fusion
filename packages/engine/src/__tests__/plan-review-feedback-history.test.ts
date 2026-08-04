import { describe, expect, it } from "vitest";

import {
  collectPlanReviewFeedbackHistory,
  countPlanReviewRevisionAttempts,
  nextPlanReviewAttemptCount,
  PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT,
} from "../plan-review-feedback-history.js";

describe("Plan Review feedback history", () => {
  it("caps rendered chronology to the current episode without capping raw attempts", () => {
    const attempt = (number: number) => ({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      verdict: "REVISE",
      notes: `CURRENT-EPISODE-${number}`,
    });
    const priorAttempts = Array.from({ length: 16 }, (_, index) => attempt(16 - index));
    const results = [{
      ...attempt(17),
      priorAttempts: [
        ...priorAttempts,
        { ...attempt(99), notes: "SUPERSEDED-BOUNDARY", supersededAt: "2026-08-04T06:00:00.000Z" },
        { ...attempt(98), notes: "STALE-OLDER-EPISODE" },
      ],
    }, {
      ...attempt(97),
      notes: "STALE-SUPERSEDED-PROJECTION",
      supersededAt: "2026-08-04T06:00:00.000Z",
    }];

    const history = collectPlanReviewFeedbackHistory(results);

    expect(history).toHaveLength(PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT);
    expect(history[0]).toBe("CURRENT-EPISODE-3");
    expect(history.at(-1)).toBe("CURRENT-EPISODE-17");
    expect(history).not.toContain("CURRENT-EPISODE-1");
    expect(history).not.toContain("SUPERSEDED-BOUNDARY");
    expect(history).not.toContain("STALE-OLDER-EPISODE");
    expect(history).not.toContain("STALE-SUPERSEDED-PROJECTION");
    expect(countPlanReviewRevisionAttempts(results)).toBe(17);
  });

  it("deduplicates rendered prose but counts every same-episode revision", () => {
    const repeated = {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      verdict: "REVISE",
      notes: "REPEATED",
    };
    const results = [{ ...repeated, priorAttempts: [{ ...repeated }, { ...repeated }] }];

    expect(collectPlanReviewFeedbackHistory(results)).toEqual(["REPEATED"]);
    expect(countPlanReviewRevisionAttempts(results)).toBe(3);
  });

  it("uses the persisted raw count after rendered history reaches its cap", () => {
    const result = {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      verdict: "REVISE",
      notes: "latest",
      planReviewAttemptCount: 37,
      priorAttempts: Array.from({ length: PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT }, (_, index) => ({
        workflowStepId: "plan-review",
        verdict: "REVISE",
        notes: `retained-${index}`,
      })),
    };

    expect(collectPlanReviewFeedbackHistory([result])).toHaveLength(PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT);
    expect(countPlanReviewRevisionAttempts([result])).toBe(37);
    expect(countPlanReviewRevisionAttempts([result], { includeCurrent: false })).toBe(36);
  });

  it("advances the persisted count once per terminal attempt and resets after supersession", () => {
    const firstFailure = {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      verdict: "REVISE",
      startedAt: "T1",
    };
    expect(nextPlanReviewAttemptCount(undefined, firstFailure)).toBe(1);

    const pending = {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "pending",
      startedAt: "T2",
    };
    expect(nextPlanReviewAttemptCount({ ...firstFailure, planReviewAttemptCount: 18 }, pending)).toBe(18);
    expect(nextPlanReviewAttemptCount({ ...pending, planReviewAttemptCount: 18 }, { ...firstFailure, startedAt: "T2" })).toBe(19);
    expect(nextPlanReviewAttemptCount({ ...firstFailure, planReviewAttemptCount: 19 }, firstFailure)).toBe(19);
    expect(nextPlanReviewAttemptCount({ ...firstFailure, planReviewAttemptCount: 19, supersededAt: "T3" }, pending)).toBe(0);
  });
});
