import type { Task } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { isTaskAwaitingPlanApproval } from "../reviewBudgetApproval";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-228",
    title: "Approval hold",
    description: "Review before execution",
    column: "todo",
    status: "awaiting-approval",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-08-28T11:29:00.000Z",
    updatedAt: "2026-08-28T11:29:00.000Z",
    ...overrides,
  } as Task;
}

describe("isTaskAwaitingPlanApproval", () => {
  it("shows an ordinary manual hold in a resolved planning lane", () => {
    expect(isTaskAwaitingPlanApproval(task(), true)).toBe(true);
  });

  it("hides an ordinary manual hold outside the planning lane", () => {
    expect(isTaskAwaitingPlanApproval(task({ column: "in-progress" }), false)).toBe(false);
  });

  it("retains the exhausted Plan Review exception outside the planning lane", () => {
    expect(isTaskAwaitingPlanApproval(task({ awaitingApprovalReason: "plan-review-replan-cap" }), false)).toBe(true);
  });

  it("requires awaiting-approval status", () => {
    expect(isTaskAwaitingPlanApproval(task({ status: "planning" }), true)).toBe(false);
  });
});
