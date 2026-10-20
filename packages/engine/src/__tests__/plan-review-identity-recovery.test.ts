import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/** FNXC:CurrentPlanReviewIdentity 2026-10-20-07:50: Exercise the real failure sink and atomic continuation seam while preserving the genuine prior verdict. */
function recoveryHarness(options: { paused?: boolean; active?: boolean; exhausted?: boolean } = {}) {
  const task = {
    id: "REVIEW-IDENTITY-1", title: "Review the current plan", description: "", column: "todo",
    status: null, steps: [], currentStep: 0, dependencies: [], log: [],
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
    enabledWorkflowSteps: ["plan-review"], paused: options.paused,
    graphResumeRetryCount: options.exhausted ? 2 : 0,
    workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE", reviewKind: "plan", startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:01Z" }],
  };
  const store = createMockStore();
  store.getTask.mockImplementation(async () => task);
  store.getSettings.mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false });
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:legacy-coding", stepIds: ["plan-review"] }));
  store.listWorkflowWorkItemsForTask = vi.fn(async () => options.active ? [{ id: "newer-review", state: "running", kind: "task" }] : []);
  store.seedStrandedPlanReviewContinuation = vi.fn(async () => ({ seeded: true, workItemId: "fresh-plan-review" }));
  store.updateTask.mockImplementation(async (_id, patch) => Object.assign(task, patch));
  const executor = new TaskExecutor(store as never, "/tmp/review-identity-recovery");
  return { task, store, executor };
}

describe("Plan Review identity failure recovery", () => {
  beforeEach(resetExecutorMocks);
  it.each(["gate-unproven-plan-review-input", "gate-stale-review-input"])("seeds a genuine new review after %s", async (value) => {
    const h = recoveryHarness();
    const originalHistory = structuredClone(h.task.workflowStepResults);
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": value, "node:plan-review:outcome": "failure" } });
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(expect.objectContaining({ taskId: h.task.id, nodeId: "plan-review", state: "runnable", targetColumn: "todo" }));
    expect(h.task.workflowStepResults).toEqual(originalHistory);
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(h.task.graphResumeRetryCount).toBe(1);
  });
  it.each([{ paused: true }, { active: true }, { exhausted: true }])("does not seed across an operator hold, active successor or exhausted budget (%j)", async (options) => {
    const h = recoveryHarness(options);
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": "gate-stale-review-input", "node:plan-review:outcome": "failure" } });
    expect(h.store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(h.task.workflowStepResults[0].verdict).toBe("APPROVE");
  });
});
