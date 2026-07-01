import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

describe("TaskExecutor model marker logging", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("logs executor model rows with the resolved task thinking effort", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      defaultThinkingLevel: "medium",
    });
    store.getTask.mockResolvedValue({
      id: "FN-7370",
      title: "Thinking marker",
      description: "Verify executor marker",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      thinkingLevel: "high",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          throw new Error("stop after model marker");
        }),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(await store.getTask("FN-7370") as any);

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7370",
      "Executor using model: mock-provider/mock-model (thinking effort: high)",
      undefined,
      expect.any(Object),
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-7370",
      "Executor using model: mock-provider/mock-model (thinking effort: high)",
      "text",
      undefined,
      "executor",
    );
  });
});
