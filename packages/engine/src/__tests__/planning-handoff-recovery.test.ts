import { describe, expect, it } from "vitest";

import { classifyPersistedPlanHandoff } from "../planning-handoff-recovery.js";

type HandoffTask = Parameters<typeof classifyPersistedPlanHandoff>[0];

function approvedNullTask(overrides: Partial<HandoffTask> = {}): HandoffTask {
  return {
    status: null,
    paused: false,
    userPaused: false,
    approvedPlanFingerprint: null,
    awaitingApprovalReason: null,
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
    }],
    updatedAt: "2026-08-04T05:00:00.000Z",
    steps: [],
    worktree: undefined,
    firstExecutionAt: undefined,
    executionStartedAt: undefined,
    ...overrides,
  };
}

const options = { now: Date.parse("2026-08-04T07:00:00.000Z"), hasLivePlanningWork: false };

describe("classifyPersistedPlanHandoff", () => {
  it("recognizes an inert null-status task with a current Plan Review approval", () => {
    expect(classifyPersistedPlanHandoff(approvedNullTask(), options)).toBe("approved-null");
  });

  it("does not recover an operator-held task even when Plan Review passed", () => {
    expect(classifyPersistedPlanHandoff(approvedNullTask({
      awaitingApprovalReason: "plan-review-replan-cap",
    }), options)).toBeNull();
  });

  it.each([
    ["worktree", { worktree: "/tmp/fusion-task" }],
    ["first execution timestamp", { firstExecutionAt: "2026-08-04T06:00:00.000Z" }],
    ["execution segment timestamp", { executionStartedAt: "2026-08-04T06:00:00.000Z" }],
  ])("does not recover approved-null tasks with %s evidence", (_label, evidence) => {
    expect(classifyPersistedPlanHandoff(approvedNullTask(evidence), options)).toBeNull();
  });

  it("does not recover a planning-status task parked for approval", () => {
    expect(classifyPersistedPlanHandoff(approvedNullTask({
      status: "planning",
      awaitingApprovalReason: "require-all",
    }), options)).toBeNull();
  });

  it("recovers a planning-status task with its retained planning worktree", () => {
    expect(classifyPersistedPlanHandoff(approvedNullTask({
      status: "planning",
      workflowStepResults: [],
      worktree: "/tmp/fusion-planning-worktree",
    }), options)).toBe("planning");
  });

  it("keeps the retained-worktree fence for null-status legacy recovery", () => {
    expect(classifyPersistedPlanHandoff(approvedNullTask({
      status: null,
      workflowStepResults: [],
      steps: [{ id: "planned-step", description: "planned", status: "pending" }],
      worktree: "/tmp/fusion-planning-worktree",
    }), options)).toBeNull();
  });
});
