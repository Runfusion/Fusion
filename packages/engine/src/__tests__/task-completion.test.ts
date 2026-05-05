import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { getTaskCompletionBlockerForStore } from "../task-completion.js";

function createTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-100",
    description: "Task",
    prompt: "Task prompt",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("getTaskCompletionBlockerForStore", () => {
  it("treats dependency lookup failures as unresolved dependencies", async () => {
    const getTask = vi.fn(async (taskId: string) => {
      if (taskId === "FN-DONE") {
        return createTask({ id: taskId, column: "done" });
      }
      throw new Error("database temporarily unavailable");
    });

    await expect(getTaskCompletionBlockerForStore(
      { getTask },
      createTask({ dependencies: ["FN-DONE", "FN-MISSING"] }),
    )).resolves.toBe("task has unresolved dependencies: FN-MISSING");

    expect(getTask).toHaveBeenCalledWith("FN-DONE");
    expect(getTask).toHaveBeenCalledWith("FN-MISSING");
  });
});
