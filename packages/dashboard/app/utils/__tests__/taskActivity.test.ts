import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { ACTIVE_STATUSES, isTaskAgentActive } from "../taskActivity";

/*
FNXC:TaskActivity 2026-08-01-17:53:
Operator requirement: card activity chrome (and the lane counts derived from it) must never show
more work than the engine's actual live-agent population. The positive arm of isTaskAgentActive is
now exactly the shared isRunningAgentTask predicate used by footer Running and project admission,
so the former render-only extras — needs-replan REVISING chrome, the fresh planner-log window,
ACTIVE_STATUSES in arbitrary columns — no longer glow: they described cards that hold no
concurrency slot, and summing lane headers exceeded the concurrency cap (10 glowing cards under a
9-slot limit read as a capacity breach).
*/

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
  it("keeps the canonical phase vocabulary for lock policy without gating glow on it", () => {
    // ACTIVE_STATUSES remains the model/routing lock vocabulary; glow no longer unions it.
    expect([...ACTIVE_STATUSES]).toEqual([
      "planning", "researching", "executing", "finalizing", "merging", "merging-pr", "merging-fix", "reviewing", "landing",
    ]);
  });

  it("glows only where the shared Running predicate holds a slot", () => {
    // planning is live in any non-terminal column.
    expect(isTaskAgentActive(makeTask({ status: "planning" }))).toBe(true);
    // Merge-pipeline statuses are live only in the review/merge lane.
    expect(isTaskAgentActive(makeTask({ column: "in-review", status: "merging" }))).toBe(true);
    expect(isTaskAgentActive(makeTask({ column: "triage", status: "merging" }))).toBe(false);
    // A stale execution status outside the WIP lane holds no slot and must not glow.
    expect(isTaskAgentActive(makeTask({ column: "triage", status: "executing" }))).toBe(false);
    // WIP membership is live regardless of status.
    expect(isTaskAgentActive(makeTask({ column: "in-progress", status: "executing" }))).toBe(true);
  });

  it("recognizes an in-progress task and status-null pending gate lease", () => {
    expect(isTaskAgentActive(makeTask({ column: "in-progress" }))).toBe(true);
    expect(isTaskAgentActive(taskWithRunningWorkflowStep())).toBe(true);
  });

  it("does not glow durable replan parks — they hold no concurrency slot", () => {
    expect(ACTIVE_STATUSES.has("needs-replan")).toBe(false);
    expect(isTaskAgentActive(makeTask({ status: "needs-replan", column: "triage" }))).toBe(false);
    expect(isTaskAgentActive(makeTask({ status: "needs-replan", column: "todo" }))).toBe(false);
  });

  it("does not treat a status-null intake task as active", () => {
    expect(isTaskAgentActive(makeTask())).toBe(false);
  });

  it("does not glow on a fresh planner log without an authoritative live status", () => {
    // The FN-8300 client-only fresh-log window is removed: a log line is not a slot.
    expect(isTaskAgentActive(makeTask({
      recentAgentActivityAt: new Date().toISOString(),
    }))).toBe(false);
    expect(isTaskAgentActive(makeTask({
      column: "todo",
      status: "needs-replan",
      recentAgentActivityAt: new Date().toISOString(),
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
    // FNXC:StuckTagRemoval 2026-08-17-22:30: stuck-task tagging removed from the dashboard; stuck coverage deleted with it.
    ["render queue", taskWithRunningWorkflowStep(), { queued: true }],
    ["global pause", taskWithRunningWorkflowStep(), { globalPaused: true }],
    ["failed status with fresh planner log", makeTask({ status: "failed", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["paused task with fresh planner log", makeTask({ paused: true, recentAgentActivityAt: new Date().toISOString() }), {}],
    ["done column with fresh planner log", makeTask({ column: "done", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["awaiting approval with fresh planner log", makeTask({ status: "awaiting-approval", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["awaiting user input with fresh planner log", makeTask({ status: "awaiting-user-input", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["queued replan", makeTask({ status: "needs-replan", recentAgentActivityAt: new Date().toISOString() }), { queued: true }],
    ["global pause replan", makeTask({ status: "needs-replan", recentAgentActivityAt: new Date().toISOString() }), { globalPaused: true }],
    ["paused replan", makeTask({ status: "needs-replan", paused: true, recentAgentActivityAt: new Date().toISOString() }), {}],
    ["failed replan", makeTask({ status: "failed", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["done-column replan", makeTask({ column: "done", status: "needs-replan", recentAgentActivityAt: new Date().toISOString() }), {}],
    ["paused planning", makeTask({ status: "planning", paused: true }), {}],
    ["globally paused WIP", makeTask({ column: "in-progress" }), { globalPaused: true }],
  ] as const)("rejects %s before running-agent evaluation", (_name, task, options) => {
    expect(isTaskAgentActive(task, options)).toBe(false);
  });
});
