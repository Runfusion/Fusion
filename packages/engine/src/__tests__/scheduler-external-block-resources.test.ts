import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { persistedTopLevelAgentSlots } from "../concurrency/concurrency.js";
import { shouldHoldActiveFileScopeLease } from "../scheduler.js";

function blockedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-209",
    description: "external obstacle",
    column: "in-progress",
    status: "blocked",
    paused: true,
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "in-progress" }],
    currentStep: 0,
    worktree: "/worktrees/fn-209",
    branch: "fusion/fn-209",
    fileScope: ["packages/core/**"],
    createdAt: "2026-08-28T04:01:00.000Z",
    updatedAt: "2026-08-28T04:01:00.000Z",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T04:01:00.000Z",
      resume: {
        column: "in-progress",
        nodeId: "steps#0:step-execute",
        currentStep: 0,
        worktree: "/worktrees/fn-209",
        branch: "fusion/fn-209",
      },
    },
    ...overrides,
  };
}

describe("external-block resource ownership", () => {
  it("retains a WIP file-scope lease for external and ordinary pauses", () => {
    const blocked = blockedTask();
    expect(shouldHoldActiveFileScopeLease(blocked, [blocked], { isWipColumn: true })).toBe(true);
    expect(shouldHoldActiveFileScopeLease({ ...blocked, status: null, externalBlock: undefined }, [blocked], { isWipColumn: true })).toBe(true);
  });

  it("retains the review-lane lease only while its worktree remains present", () => {
    const blockedReview = blockedTask({ column: "in-review" });
    expect(shouldHoldActiveFileScopeLease(blockedReview, [blockedReview], { isReviewColumn: true })).toBe(true);
    expect(shouldHoldActiveFileScopeLease({ ...blockedReview, worktree: undefined }, [blockedReview], { isReviewColumn: true })).toBe(false);
  });

  it("keeps the blocked card in maxConcurrent and maxWorktrees holder arithmetic", () => {
    const blocked = blockedTask();
    expect(persistedTopLevelAgentSlots([blocked])).toBe(1);
    expect(persistedTopLevelAgentSlots([{ ...blocked, status: null, externalBlock: undefined }])).toBe(0);
  });
});
