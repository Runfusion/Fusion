import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { createFnAgent } from "../../pi.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-5436-RI",
    title: "Pending review skip",
    description: "",
    column: "in-progress",
    dependencies: [],
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 1: Step 1\n- [ ] do work",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("reliability interactions: FN-5436 executor pending-review skip", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);
  });

  it("FN-5436 composition: implicit-done wins when no in-progress step exists despite stale review logs", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-A",
      steps: [{ name: "Step 1", status: "done" }],
      log: [{ action: "code review Step 0: REVISE", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-A", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-A", "in-review");
  });

  it("FN-5436 composition: reclaim-abort path takes precedence over pending-review skip", async () => {
    const store = createMockStore();
    const task = makeTask({ id: "FN-5436-RI-B", paused: true });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-B", "todo", { preserveProgress: true });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-B", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
  });

  it("FN-5436 composition: pending-review park does not consume taskDone requeue budget", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-C",
      taskDoneRetryCount: 2,
      log: [{ action: "code review requested for Step 0 (Step 1)", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-C", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-C", expect.objectContaining({ taskDoneRetryCount: 3 }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-C", "in-review");
  });

  it("FN-5436 composition: recoverApprovedStepsOnResume leaves pending-review skip disabled after approval resolves step", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-D",
      steps: [{ name: "Step 1", status: "done" }],
      log: [{ action: "code review Step 0: APPROVE", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    // FNXC:ExecutorRetry 2026-07-13: Use objectContaining because production now passes additional fields (executeRequeueLoopCount, executeRequeueLoopSignature, branch, worktree, sessionFile) in the same updateTask call.
    expect(store.updateTask).toHaveBeenCalledWith("FN-5436-RI-D", expect.objectContaining({ workflowStepRetries: undefined, taskDoneRetryCount: null }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-D", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-D", "in-review");
  });

  it("FN-5436 negative: plan-review UNAVAILABLE advisory remains non-blocking", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-E",
      log: [{ action: "plan review Step 0: UNAVAILABLE — proceeding advisory after fallback retry exhausted", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
    expect(store.updateTask).toHaveBeenCalledWith("FN-5436-RI-E", {
      status: "queued",
      error: null,
      taskDoneRetryCount: 1,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-E", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
  });
});
