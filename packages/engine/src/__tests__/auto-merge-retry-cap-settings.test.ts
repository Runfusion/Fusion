import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { shouldRetryAutoMergeConflict } from "../project-engine.js";
import { SelfHealingManager } from "../self-healing.js";

function inReviewFailedTask(mergeRetries: number): Task {
  return {
    id: "FN-6569-BLOCKER",
    title: "blocked merge",
    description: "",
    priority: "normal",
    column: "in-review",
    status: "failed",
    error: "target-not-queued",
    steps: [],
    dependencies: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    mergeRetries,
    log: [],
  } as Task;
}

describe("maxAutoMergeRetries setting", () => {
  it("drives ProjectEngine conflict retry decisions for 1, 5, unset, and invalid values", () => {
    expect(shouldRetryAutoMergeConflict(0, { maxAutoMergeRetries: 1 })).toMatchObject({
      shouldRetry: false,
      maxAutoMergeRetries: 1,
      nextRetryCount: 1,
    });

    expect(shouldRetryAutoMergeConflict(3, { maxAutoMergeRetries: 5 })).toMatchObject({
      shouldRetry: true,
      maxAutoMergeRetries: 5,
      nextRetryCount: 4,
    });
    expect(shouldRetryAutoMergeConflict(4, { maxAutoMergeRetries: 5 })).toMatchObject({
      shouldRetry: false,
      maxAutoMergeRetries: 5,
      nextRetryCount: 5,
    });

    expect(shouldRetryAutoMergeConflict(1, {})).toMatchObject({
      shouldRetry: true,
      maxAutoMergeRetries: 3,
      nextRetryCount: 2,
    });
    expect(shouldRetryAutoMergeConflict(2, {})).toMatchObject({
      shouldRetry: false,
      maxAutoMergeRetries: 3,
      nextRetryCount: 3,
    });

    expect(shouldRetryAutoMergeConflict(2, { maxAutoMergeRetries: 0 })).toMatchObject({
      shouldRetry: false,
      maxAutoMergeRetries: 3,
      nextRetryCount: 3,
    });
    expect(shouldRetryAutoMergeConflict(0, { autoResolveConflicts: false, maxAutoMergeRetries: 5 }).shouldRetry).toBe(false);
  });

  it("keeps SelfHealingManager from treating retries below a configured cap as exhausted", async () => {
    const task = inReviewFailedTask(3);
    const requeueForAutoMerge = vi.fn(async () => undefined);
    const store = {
      getSettings: vi.fn(async () => ({ maxAutoMergeRetries: 5, autoMerge: true })),
      listTasks: vi.fn(async () => [task]),
      getTask: vi.fn(async () => task),
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
    };

    const manager = new SelfHealingManager(store as any, { requeueForAutoMerge } as any);

    await expect(manager.recoverTransientMergeFailures()).resolves.toBe(0);
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.getTask).not.toHaveBeenCalled();
  });
});
