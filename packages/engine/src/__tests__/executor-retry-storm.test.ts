import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PROJECT_SETTINGS,
  RetryStormError,
  serializeRetryStormError,
  type TaskDetail,
} from "@fusion/core";
import { recordRetry } from "../errors/retry-burned-logger.js";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-4398",
    lineageId: "lineage-1",
    description: "retry storm",
    column: "in-review",
    status: "failed",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("executor retry storm integration", () => {
  it("throws and serializes RetryStormError on 26th retry and stays terminal", async () => {
    const task = makeTask({
      stuckKillCount: 5,
      recoveryRetryCount: 5,
      taskDoneRetryCount: 5,
      workflowStepRetries: 5,
      verificationFailureCount: 5,
      reviewerContextRetryCount: 0,
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = {
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        Object.assign(task, patch);
      }),
      getTask: vi.fn(async () => task),
      moveTask: vi.fn(async () => undefined),
    };

    let thrown: RetryStormError | undefined;
    try {
      await recordRetry({
        store: store as never,
        settings: {
          ...DEFAULT_PROJECT_SETTINGS,
          maxReviewerContextRetries: 2,
          maxTotalRetriesBeforeFail: 25,
        },
        task,
        category: "reviewerContext",
        role: "reviewer",
        attempt: 1,
      });
    } catch (error) {
      thrown = error as RetryStormError;
      const serialized = serializeRetryStormError(thrown);
      await store.updateTask(task.id, { error: JSON.stringify(serialized), status: "failed" });
    }

    expect(thrown).toBeInstanceOf(RetryStormError);
    expect(task.error).toContain('"type":"RetryStormError"');
    expect(task.error).toContain('"category":"reviewerContext"');
    expect(task.error).toContain('"total":26');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[retry-burned] retry-burned"),
      expect.objectContaining({ taskId: task.id, category: "reviewerContext", total: expect.any(Number) }),
    );
    expect(task.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
