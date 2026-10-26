import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { getBuiltinWorkflow, parseWorkflowIr } from "@fusion/core";
import { executorLog } from "../logger.js";
import { seedPreReleasePlanReviewContinuation } from "../plan-review-continuation.js";
import { resolvePlanningContinuationCandidate } from "../runtimes/in-process-runtime.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/** FNXC:CurrentPlanReviewIdentity 2026-10-20-07:50: Exercise the real failure sink and atomic continuation seam while preserving the genuine prior verdict. */
function recoveryHarness(options: { paused?: boolean; active?: boolean; exhausted?: boolean; wip?: boolean } = {}) {
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
  store.seedStrandedPlanReviewContinuation = vi.fn(async (_input, options) => { task.graphResumeRetryCount = options.identityRecovery.expectedRetryCount + 1; return { seeded: true, workItemId: "fresh-plan-review" }; });
  store.updateTask.mockImplementation(async (_id, patch) => Object.assign(task, patch));
  if (options.wip) {
    const source = getBuiltinWorkflow("builtin:legacy-coding")!.ir;
    const ir = typeof source === "string" ? parseWorkflowIr(source) : structuredClone(source);
    if (ir.version !== "v2") throw new Error("Expected a column-native workflow fixture");
    task.column = "active-review";
    ir.columns ??= [];
    ir.columns.push({ id: task.column, name: "Active review", traits: [{ trait: "wip" }] });
    ir.nodes.find((node) => node.id === "plan-review")!.column = task.column;
    store.getTaskWorkflowSelectionAsync.mockResolvedValue({ workflowId: "custom:wip-review", stepIds: ["plan-review"] });
    store.getWorkflowDefinition = vi.fn(async () => ({ ir }));
  }
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
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledWith(expect.objectContaining({ taskId: h.task.id, nodeId: "plan-review", state: "runnable", targetColumn: "todo" }), { identityRecovery: expect.objectContaining({ expectedRetryCount: 0, maxRetries: 2, expectedWorkflowStepResults: originalHistory }) });
    expect(h.task.workflowStepResults).toEqual(originalHistory);
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(h.task.graphResumeRetryCount).toBe(1);
  });
  it.each(["gate-unproven-plan-review-input", "gate-stale-review-input"])("preserves a pending replan before the first %s recovery attempt", async (value) => {
    const h = recoveryHarness();
    Object.assign(h.task, { status: "needs-replan" });
    const history = structuredClone(h.task.workflowStepResults);
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": value, "node:plan-review:outcome": "failure" } });
    expect(h.store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(h.task.graphResumeRetryCount).toBe(0);
    expect(h.task.status).toBe("needs-replan");
    expect(h.task.workflowStepResults).toEqual(history);
    expect(h.store.moveTask).not.toHaveBeenCalled();
  });
  it.each([{ paused: true }, { active: true }, { exhausted: true }])("does not seed across an operator hold, active successor or exhausted budget (%j)", async (options) => {
    const h = recoveryHarness(options);
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": "gate-stale-review-input", "node:plan-review:outcome": "failure" } });
    expect(h.store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    expect(h.task.workflowStepResults[0].verdict).toBe("APPROVE");
  });
});

/** FNXC:CurrentPlanReviewIdentity 2026-10-23-05:34: A snapshot refusal may be a benign concurrent edit, but a retry must preserve newer owners and the durable retry budget. */
describe("Plan Review identity recovery snapshot races", () => {
  beforeEach(resetExecutorMocks);
  async function fail(h: ReturnType<typeof recoveryHarness>, value = "gate-stale-review-input") {
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": value, "node:plan-review:outcome": "failure" } });
  }
  it.each(["gate-unproven-plan-review-input", "gate-stale-review-input"])("retries %s once with fresh fencing values", async (value) => {
    const h = recoveryHarness();
    const seed = h.store.seedStrandedPlanReviewContinuation.getMockImplementation()!;
    h.store.seedStrandedPlanReviewContinuation.mockImplementationOnce(async () => {
      h.task.updatedAt = "2026-10-23T05:34:00.000Z";
      return { seeded: false, reason: "task-state-changed" };
    }).mockImplementation(seed);
    await fail(h, value);
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledTimes(2);
    expect(h.store.seedStrandedPlanReviewContinuation.mock.calls[1][1]).toEqual({ identityRecovery: expect.objectContaining({ expectedTaskUpdatedAt: h.task.updatedAt, expectedRetryCount: 0 }) });
    expect(h.task.graphResumeRetryCount).toBe(1);
    expect(h.task.workflowStepResults[0].verdict).toBe("APPROVE");
    expect(h.store.moveTask).not.toHaveBeenCalled();
  });
  it("stops after a second snapshot refusal", async () => {
    const h = recoveryHarness();
    h.store.seedStrandedPlanReviewContinuation.mockResolvedValue({ seeded: false, reason: "task-state-changed" });
    await fail(h);
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledTimes(2);
    expect(h.task.graphResumeRetryCount).toBe(0);
  });
  it.each(["paused", "userPaused", "deleted", "exhausted", "active", "approval", "replan", "column", "history", "enginePaused"])("respects a concurrent %s change", async (change) => {
    const h = recoveryHarness();
    h.store.seedStrandedPlanReviewContinuation.mockImplementationOnce(async () => {
      if (change === "paused") h.task.paused = true;
      if (change === "userPaused") Object.assign(h.task, { userPaused: true });
      if (change === "deleted") Object.assign(h.task, { deletedAt: "2026-10-23T05:34:00Z" });
      if (change === "exhausted") h.task.graphResumeRetryCount = 2;
      if (change === "active") h.store.listWorkflowWorkItemsForTask.mockResolvedValue([{ id: "newer", kind: "task", state: "running" }]);
      if (change === "approval") Object.assign(h.task, { status: "awaiting-approval" });
      if (change === "replan") Object.assign(h.task, { status: "needs-replan" });
      if (change === "column") h.store.getTask.mockResolvedValue({ ...h.task, column: "in-progress" });
      if (change === "history") h.store.getTask.mockResolvedValue({ ...h.task, workflowStepResults: [] });
      if (change === "enginePaused") h.store.getSettings.mockResolvedValue({ enginePaused: true });
      return { seeded: false, reason: "task-state-changed" };
    });
    await fail(h);
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    expect(h.store.moveTask).not.toHaveBeenCalled();
  });
  it.each(["missing", "unreadable"])("does not retry when the fresh task is %s", async (state) => {
    const h = recoveryHarness();
    h.store.seedStrandedPlanReviewContinuation.mockImplementationOnce(async () => {
      if (state === "missing") h.store.getTask.mockResolvedValue(null);
      else h.store.getTask.mockRejectedValue(new Error("read unavailable"));
      return { seeded: false, reason: "task-state-changed" };
    });
    await fail(h);
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
  });
});

/** FNXC:CurrentPlanReviewIdentity 2026-10-23-06:34: Identity recovery is valid in either hold or WIP columns and must remain consumable by the normal continuation drain. */
describe("WIP Plan Review identity recovery", () => {
  beforeEach(resetExecutorMocks);
  it.each(["gate-unproven-plan-review-input", "gate-stale-review-input"])("resumes %s in the same WIP column", async (value) => {
    const h = recoveryHarness({ wip: true });
    const history = structuredClone(h.task.workflowStepResults);
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": value, "node:plan-review:outcome": "failure" } });
    expect(h.store.seedStrandedPlanReviewContinuation).toHaveBeenCalledOnce();
    const [input] = h.store.seedStrandedPlanReviewContinuation.mock.calls[0];
    expect(input).toMatchObject({ nodeId: "plan-review", kind: "task", state: "runnable", sourceColumn: "active-review", targetColumn: "active-review" });
    expect(resolvePlanningContinuationCandidate({ ...input, id: "resumed-review" } as never, h.task as never).kind).toBe("actionable");
    expect(h.task.column).toBe("active-review");
    expect(h.task.workflowStepResults).toEqual(history);
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(h.task.graphResumeRetryCount).toBe(1);
  });
  it("keeps ordinary planning handoffs pre-release only", async () => {
    const h = recoveryHarness({ wip: true });
    const ir = (await h.store.getWorkflowDefinition("custom:wip-review"))!.ir;
    await expect(seedPreReleasePlanReviewContinuation(h.store as never, h.task as never, ir as never, { atomic: true })).resolves.toMatchObject({ seeded: false, reason: "no-pre-release-plan-review" });
    expect(h.store.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
  });
  it.each(["settings", "continuation-seed", "task-reload"])("logs the failing %s stage while preserving the unavailable outcome", async (stage) => {
    const h = recoveryHarness();
    if (stage === "settings") h.store.getSettings.mockRejectedValue(new Error("settings read failed"));
    if (stage === "continuation-seed") h.store.seedStrandedPlanReviewContinuation.mockRejectedValue(new Error("seed failed"));
    if (stage === "task-reload") h.store.seedStrandedPlanReviewContinuation.mockImplementationOnce(async () => {
      h.store.getTask.mockRejectedValue(new Error("task read failed"));
      return { seeded: false, reason: "task-state-changed" };
    });
    await (h.executor as any).handleGraphFailure(h.task, { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan-review"], context: { "node:plan-review:value": "gate-stale-review-input", "node:plan-review:outcome": "failure" } });
    expect(executorLog.warn).toHaveBeenCalledWith(h.task.id + ": Plan Review identity recovery failed during " + stage);
    expect(h.store.logEntry.mock.calls.some((call) => call[0] === h.task.id && call[1] === "Plan Review identity recovery withheld — task remains held" && call[2] === "recovery-unavailable")).toBe(true);
  });
});
