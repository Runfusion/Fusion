import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { reviewStep as mockedReviewStepFn } from "../reviewer.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("executor tool step numbering is 0-based", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  async function captureTools(stepStates = [
    { name: "Preflight", status: "pending" },
    { name: "First", status: "pending" },
    { name: "Second", status: "pending" },
  ]) {
    const store = createMockStore();
    store.getTask.mockImplementation(async () => ({
      id: "FN-6607-T",
      title: "Zero based steps",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: stepStates.map((step) => ({ ...step })),
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: First\n### Step 2: Second",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
      stepStates[stepIndex].status = status;
      return { steps: stepStates.map((step) => ({ ...step })) };
    });

    let customTools: any[] = [];
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      customTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          navigateTree: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-step"),
            branchWithSummary: vi.fn(),
          },
          state: {},
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-6607-T",
      title: "Zero based steps",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const tools: Record<string, any> = {};
    for (const tool of customTools) tools[tool.name] = tool.execute;
    return { tools, store, stepStates };
  }

  it("maps fn_task_update and fn_review_step step directly to task.steps index", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "ok", summary: "ok" } as any);
    const { tools, store, stepStates } = await captureTools();

    const preflightDone = await tools.fn_task_update("update-0", { step: 0, status: "done" });
    expect(preflightDone.content[0].text).toContain("Step 0 (Preflight) → done");
    expect(store.updateStep).toHaveBeenCalledWith("FN-6607-T", 0, "done");
    expect(stepStates[0].status).toBe("done");

    const firstStarted = await tools.fn_task_update("update-1", { step: 1, status: "in-progress" });
    expect(firstStarted.content[0].text).toContain("Step 1 (First) → in-progress");
    expect(store.updateStep).toHaveBeenCalledWith("FN-6607-T", 1, "in-progress");
    expect(stepStates[1].status).toBe("in-progress");

    const review = await tools.fn_review_step("review-1", {
      step: 1,
      type: "code",
      step_name: "First",
      baseline: "abc123",
    });
    expect(review.content[0].text).toBe("APPROVE");
    expect(mockedReviewStep).toHaveBeenCalledWith(
      expect.any(String),
      "FN-6607-T",
      1,
      "First",
      "code",
      expect.any(String),
      "abc123",
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith("FN-6607-T", "code review Step 1: APPROVE", "ok");
    expect(store.updateStep).toHaveBeenCalledWith("FN-6607-T", 1, "done");

    const invalidNegative = await tools.fn_task_update("bad-update-negative", { step: -1, status: "done" });
    expect(invalidNegative.content[0].text).toContain("0-indexed");
    const invalidReview = await tools.fn_review_step("bad-review", { step: 3, type: "code", step_name: "Missing", baseline: "abc" });
    expect(invalidReview.details.error).toBe("invalid_step");
  });

  it("resume recovery reads the same 0-based review log written by fn_review_step", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-6607-R",
      title: "Resume",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "First", status: "in-progress" },
        { name: "Second", status: "pending" },
      ],
      currentStep: 1,
      log: [
        { timestamp: "2026-06-17T00:00:00.000Z", action: "Step 1 (First) → in-progress" },
        { timestamp: "2026-06-17T00:00:01.000Z", action: "code review Step 1: APPROVE" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).recoverApprovedStepsOnResume("FN-6607-R");

    expect(store.updateStep).toHaveBeenCalledWith("FN-6607-R", 1, "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6607-R",
      expect.stringContaining("Step 1 (First) recovered as done on resume"),
    );
  });

  it("pending-review loop detection matches 0-based writer strings", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-6607-P",
      title: "Pending review",
      description: "",
      column: "in-progress",
      dependencies: [],
      taskDoneRetryCount: 2,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "First", status: "in-progress" },
      ],
      currentStep: 1,
      log: [{ timestamp: new Date().toISOString(), action: "code review requested for Step 1 (First)" }],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: First",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    store.getTask.mockResolvedValue(task);
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

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(task);

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-6607-P",
      expect.stringContaining("Step 1 is blocked on pending review"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-6607-P", "in-review");
  });
});
