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

async function captureTools() {
  const store = createMockStore();
  const stepStates = [
    { name: "Preflight", status: "done" },
    { name: "Implement", status: "pending" },
    { name: "Test", status: "pending" },
  ];

  let checkpointLeafId = "leaf-1";
  const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });

  store.getTask.mockImplementation(async () => ({
    id: "FN-TEST",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: stepStates.map((s) => ({ ...s })),
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
    stepStates[stepIndex].status = status;
    return { steps: stepStates.map((s) => ({ ...s })) };
  });

  let customTools: any[] = [];
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    customTools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree,
        sessionManager: {
          getLeafId: vi.fn(() => checkpointLeafId),
          branchWithSummary: vi.fn(),
        },
      },
    } as any;
  });

  mockedExistsSync.mockReturnValue(true);
  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute({
    id: "FN-TEST",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const tools: Record<string, any> = {};
  for (const tool of customTools) tools[tool.name] = tool.execute;
  return { tools, store, stepStates, navigateTree, setLeaf: (leaf: string) => { checkpointLeafId = leaf; } };
}

describe("fn_review_step indexing", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("uses step=1 to update internal step index 1", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "ok", summary: "ok" } as any);
    const { tools, store, stepStates } = await captureTools();

    await tools.fn_review_step("call-1", { step: 1, type: "code", step_name: "Implement", baseline: "abc" });

    expect(stepStates[1].status).toBe("done");
    expect(store.updateStep).toHaveBeenCalledWith("FN-TEST", 1, "in-progress");
    expect(store.updateStep).toHaveBeenCalledWith("FN-TEST", 1, "done");
  });

  it("RETHINK resets internal step index 1 and uses step-index checkpoint", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "RETHINK", review: "redo", summary: "redo" } as any);
    const { tools, store, navigateTree } = await captureTools();

    await tools.fn_task_update("set-cp", { step: 1, status: "in-progress" });
    await tools.fn_review_step("call-1", { step: 1, type: "code", step_name: "Implement", baseline: "abc" });

    expect(store.updateStep).toHaveBeenCalledWith("FN-TEST", 1, "pending");
    expect(navigateTree).toHaveBeenCalled();
  });

  it("REVISE verdict for step=1 blocks fn_task_update step=1 done", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "fix", summary: "fix" } as any);
    const { tools } = await captureTools();

    await tools.fn_review_step("call-1", { step: 1, type: "code", step_name: "Implement", baseline: "abc" });
    const result = await tools.fn_task_update("call-2", { step: 1, status: "done" });

    expect(result.content[0].text).toContain("Cannot mark Step 1 as done");
  });

  it("rejects out-of-range steps without reviewer call", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "ok", summary: "ok" } as any);
    const { tools, store } = await captureTools();

    const invalids = [-1, 3, 4];
    for (const step of invalids) {
      const result = await tools.fn_review_step("bad", { step, type: "code", step_name: "Implement", baseline: "abc" });
      expect(result.details.error).toBe("invalid_step");
    }

    expect(mockedReviewStep).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-TEST", expect.stringContaining("review requested"));
  });
});
