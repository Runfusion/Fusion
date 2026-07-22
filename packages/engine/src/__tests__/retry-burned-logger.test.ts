import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { DEFAULT_PROJECT_SETTINGS, RetryStormError, type TaskDetail } from "@fusion/core";
import { recordRetry } from "../errors/retry-burned-logger.js";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-1",
    lineageId: "lineage-1",
    description: "desc",
    column: "in-progress",
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

describe("recordRetry", () => {
  const baseSettings = {
    ...DEFAULT_PROJECT_SETTINGS,
    maxBranchConflictRecoveries: 5,
    maxReviewerContextRetries: 2,
    maxReviewerFallbackRetries: 2,
    maxTotalRetriesBeforeFail: 25,
  };

  let task: TaskDetail;
  let store: { updateTask: ReturnType<typeof vi.fn>; getTask: ReturnType<typeof vi.fn> };
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    task = makeTask();
    store = {
      updateTask: vi.fn(async (_id: string, patch: Record<string, number>) => {
        Object.assign(task, patch);
      }),
      getTask: vi.fn(async () => task),
    };
  });

  afterEach(() => {
    consoleSpy.mockClear();
  });

  it("increments new-category counters and logs payload", async () => {
    await recordRetry({
      store: store as never,
      settings: baseSettings,
      task,
      category: "reviewerContext",
      role: "reviewer",
      attempt: 1,
    });

    expect(task.reviewerContextRetryCount).toBe(1);
    expect(store.updateTask).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[retry-burned] retry-burned"),
      expect.objectContaining({ taskId: "FN-1", category: "reviewerContext", attempt: 1, total: 1 }),
    );
  });

  it("does not rewrite persisted counters when skipIncrement=true", async () => {
    task.stuckKillCount = 3;
    await recordRetry({
      store: store as never,
      settings: { ...baseSettings, maxTotalRetriesBeforeFail: 3 },
      task,
      category: "stuckKill",
      role: "self-healing",
      skipIncrement: true,
    });

    expect(task.stuckKillCount).toBe(3);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("throws RetryStormError when master cap is exceeded", async () => {
    task.stuckKillCount = 26;
    await expect(
      recordRetry({
        store: store as never,
        settings: { ...baseSettings, maxTotalRetriesBeforeFail: 25 },
        task,
        category: "stuckKill",
        role: "self-healing",
        skipIncrement: true,
      }),
    ).rejects.toBeInstanceOf(RetryStormError);
  });
});
