import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { ACTIVE_STATUSES, isTaskAgentActive } from "../taskActivity";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8055",
    title: "Activity fixture",
    description: "Activity fixture",
    column: "triage",
    status: null,
    steps: [],
    enabledWorkflowSteps: [],
    workflowStepResults: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function taskWithRunningWorkflowStep(overrides: Partial<Task> = {}): Task {
  return makeTask({
    enabledWorkflowSteps: ["plan-review"],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "pending",
      startedAt: "2026-07-16T00:00:00.000Z",
    }],
    ...overrides,
  });
}

describe("isTaskAgentActive", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the canonical set for every active phase", () => {
    expect([...ACTIVE_STATUSES]).toEqual([
      "planning", "researching", "executing", "finalizing", "merging", "merging-pr", "merging-fix", "reviewing", "landing",
    ]);
    for (const status of ACTIVE_STATUSES) {
      expect(isTaskAgentActive(makeTask({ status }))).toBe(true);
    }
  });

  it("recognizes an in-progress task and status-null running workflow step", () => {
    expect(isTaskAgentActive(makeTask({ column: "in-progress" }))).toBe(true);
    expect(isTaskAgentActive(taskWithRunningWorkflowStep())).toBe(true);
  });

  it("does not treat a status-null task without a running item as active", () => {
    expect(isTaskAgentActive(makeTask())).toBe(false);
  });

  it("uses a fresh client-only planner log signal for a status-null triage card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:30.000Z"));

    expect(isTaskAgentActive(makeTask({
      recentAgentActivityAt: "2026-07-28T12:00:00.000Z",
    }))).toBe(true);
    expect(isTaskAgentActive(makeTask({
      recentAgentActivityAt: "2026-07-28T11:59:00.000Z",
    }))).toBe(false);
  });

  it.each([
    ["queued task status", taskWithRunningWorkflowStep({ status: "queued" }), {}],
    ["paused status", taskWithRunningWorkflowStep({ status: "paused" }), {}],
    ["paused task", taskWithRunningWorkflowStep({ paused: true }), {}],
    ["failed status", taskWithRunningWorkflowStep({ status: "failed" }), {}],
    ["stuck-killed status", taskWithRunningWorkflowStep({ column: "in-progress", status: "stuck-killed" }), {}],
    ["awaiting approval", taskWithRunningWorkflowStep({ status: "awaiting-approval" }), {}],
    ["awaiting user input", taskWithRunningWorkflowStep({ status: "awaiting-user-input" }), {}],
    ["done status", taskWithRunningWorkflowStep({ status: "done" }), {}],
    ["done column", taskWithRunningWorkflowStep({ column: "done" }), {}],
    ["archived column with merging status", taskWithRunningWorkflowStep({ column: "archived", status: "merging" }), {}],
    ["archived column with running workflow", taskWithRunningWorkflowStep({ column: "archived" }), {}],
    ["render queue", taskWithRunningWorkflowStep(), { queued: true }],
    ["derived stuck", taskWithRunningWorkflowStep(), { isStuck: true }],
    ["global pause", taskWithRunningWorkflowStep(), { globalPaused: true }],
    ["failed status with fresh planner log", makeTask({ status: "failed", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["paused task with fresh planner log", makeTask({ paused: true, recentAgentActivityAt: new Date().toISOString() }), {}],
    ["done column with fresh planner log", makeTask({ column: "done", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["archived column with fresh planner log", makeTask({ column: "archived", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["awaiting approval with fresh planner log", makeTask({ status: "awaiting-approval", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["awaiting user input with fresh planner log", makeTask({ status: "awaiting-user-input", recentAgentActivityAt: new Date().toISOString() }), {}],
  ] as const)("rejects %s before running workflow activity", (_name, task, options) => {
    expect(isTaskAgentActive(task, options)).toBe(false);
  });
});
