import { describe, expect, it } from "vitest";

import { getInReviewStallCopy, getInReviewStallDeadlockCopy, shouldShowInReviewStallBadge } from "../inReviewStallCopy";

describe("inReviewStallCopy", () => {
  it.each([
    ["merge-blocker", "Merge blocked"],
    ["transient-merge-status-no-owner", "Merge stalled"],
    ["merge-retries-exhausted", "Retries exhausted"],
    ["no-worktree-no-merge-confirmed", "No worktree"],
    ["non-retryable-provider-error", "Provider error"],
  ] as const)("returns populated copy for %s", (code, badgeLabel) => {
    const copy = getInReviewStallCopy({
      code,
      reason: "reason",
      observedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(copy.badgeLabel).toBe(badgeLabel);
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
    expect(copy.suggestedAction.length).toBeGreaterThan(0);
  });

  it("renders merge retry counter when retries are supplied", () => {
    const copy = getInReviewStallCopy(
      {
        code: "merge-retries-exhausted",
        reason: "reason",
        observedAt: "2026-05-13T00:00:00.000Z",
      },
      { mergeRetries: 3 },
    );

    expect(copy.counter).toBe("3/3");
  });

  it("renders merge retry counter above max when retries exceed max", () => {
    const copy = getInReviewStallCopy(
      {
        code: "merge-retries-exhausted",
        reason: "reason",
        observedAt: "2026-05-13T00:00:00.000Z",
      },
      { mergeRetries: 5 },
    );

    expect(copy.counter).toBe("5/3");
  });

  it("omits merge retry counter without retry context", () => {
    const copy = getInReviewStallCopy({
      code: "merge-retries-exhausted",
      reason: "reason",
      observedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(copy.counter).toBeUndefined();
  });

  it.each(["merge-blocker", "transient-merge-status-no-owner", "no-worktree-no-merge-confirmed", "non-retryable-provider-error"] as const)(
    "does not render counter for non-retry stall code %s",
    (code) => {
      const copy = getInReviewStallCopy(
        {
          code,
          reason: "reason",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
        { mergeRetries: 99 },
      );

      expect(copy.counter).toBeUndefined();
    },
  );

  it.each([
    { column: "in-review", paused: false, inReviewStall: undefined, status: undefined },
    {
      column: "in-review",
      paused: true,
      inReviewStall: { code: "merge-blocker", reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
      status: undefined,
    },
    {
      column: "in-progress",
      paused: false,
      inReviewStall: { code: "merge-blocker", reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
      status: undefined,
    },
  ] as const)("hides badge for non-canonical visibility cases", (task) => {
    expect(shouldShowInReviewStallBadge(task)).toBe(false);
  });

  it.each([
    ["merge-blocker", "merging", false],
    ["merge-blocker", "merging-pr", false],
    ["merge-blocker", "merging-fix", false],
    ["merge-blocker", undefined, false],
    ["merge-retries-exhausted", "merging", true],
    ["transient-merge-status-no-owner", "merging", true],
    ["non-retryable-provider-error", undefined, true],
    ["non-retryable-provider-error", "merging", true],
    ["no-worktree-no-merge-confirmed", undefined, false],
    ["no-worktree-no-merge-confirmed", "merging", false],
  ] as const)("badge visibility for %s with status %s is %s", (code, status, expected) => {
    expect(
      shouldShowInReviewStallBadge({
        column: "in-review",
        paused: false,
        status,
        inReviewStall: { code, reason: "r", observedAt: "2026-05-13T00:00:00.000Z" },
      }),
    ).toBe(expected);
  });

  const failedGate = {
    workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge" as const,
    status: "failed" as const, startedAt: "2026-09-20T00:00:00Z", output: "review-input-unprovable",
  };
  const blockedTask = {
    column: "in-review", status: undefined, enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [failedGate],
    inReviewStall: { code: "merge-blocker" as const, reason: "failed pre-merge steps", observedAt: "2026-09-20T00:00:00Z" },
  };

  it("shows the failing gate and reason despite a missing task status", () => {
    expect(shouldShowInReviewStallBadge(blockedTask)).toBe(true);
    expect(getInReviewStallCopy(blockedTask.inReviewStall, blockedTask)).toMatchObject({
      badgeLabel: "Code Review blocked", description: "review-input-unprovable",
    });
    expect(shouldShowInReviewStallBadge({ ...blockedTask, column: "custom-review" }, { humanReview: true })).toBe(true);
  });

  it.each([undefined, [], [{ ...failedGate, status: "passed" as const }],
    [{ ...failedGate, status: "advisory_failure" as const }],
    [failedGate, { ...failedGate, status: "passed" as const }],
    [{ ...failedGate, phase: "pre-execution" as const }],
  ])("keeps normal or superseded review waits quiet: %j", workflowStepResults => {
    expect(shouldShowInReviewStallBadge({ ...blockedTask, workflowStepResults })).toBe(false);
  });

  it("filters disabled gates but includes recorded nodes and ignores historical attempts", () => {
    expect(shouldShowInReviewStallBadge({ ...blockedTask, enabledWorkflowSteps: [] })).toBe(false);
    expect(shouldShowInReviewStallBadge({ ...blockedTask, enabledWorkflowSteps: [], workflowStepResults: [{ ...failedGate, source: "node" }] })).toBe(true);
    expect(shouldShowInReviewStallBadge({ ...blockedTask, workflowStepResults: [{ ...failedGate, status: "passed", priorAttempts: [failedGate] }] })).toBe(false);
    expect(shouldShowInReviewStallBadge({ ...blockedTask, paused: true })).toBe(false);
    expect(shouldShowInReviewStallBadge({ ...blockedTask, column: "done" })).toBe(false);
  });

  it("falls back to defensive default for unknown codes", () => {
    const copy = getInReviewStallCopy({
      code: "future-code" as never,
      reason: "future reason",
      observedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(copy.headline).toBe("In-review stall surfaced");
    expect(copy.description).toBe("future reason");
    expect(copy.suggestedAction).toBe("Open the activity log for details.");
    expect(copy.badgeLabel).toBe("In-review stall");
  });

  it("returns deadlock disposition copy when paused reason indicates auto-dispose", () => {
    const copy = getInReviewStallDeadlockCopy({
      pausedReason: "in-review-stall-deadlock",
      log: [],
    } as any);

    expect(copy).toMatchObject({
      headline: "In-review deadlock auto-disposed",
    });
    expect(copy?.nextAction).toContain("unpause");
  });
});
