import { beforeEach, describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import type { Task } from "@fusion/core";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

describe("TaskExecutor.resetStepsIfWorkLost", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("resets completed steps and recomputes currentStep when branch has no unique commits", async () => {
    const store = createMockStore();
    const task: Task = {
      id: "FN-4990",
      title: "Reset steps",
      description: "desc",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "done" },
        { name: "Step 3", status: "done" },
        { name: "Step 4", status: "pending" },
        { name: "Step 5", status: "pending" },
      ],
      currentStep: 3,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      branch: "fusion/fn-4990",
    };

    store.getTask.mockImplementation(async () => task);
    store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: Task["steps"][number]["status"]) => {
      task.steps[stepIndex].status = status;
      return task;
    });
    store.updateTask.mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
      Object.assign(task, updates);
      return task;
    });

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git merge-base")) return "abc123\n";
      if (cmd.includes("git rev-parse")) return "abc123\n";
      return "";
    });

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).resetStepsIfWorkLost(task);

    expect(task.steps[0].status).toBe("pending");
    expect(task.steps[1].status).toBe("pending");
    expect(task.steps[2].status).toBe("pending");
    expect(task.currentStep).toBe(0);
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("currentStep"),
    );
  });
});
