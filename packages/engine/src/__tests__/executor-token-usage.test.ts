import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";

function createTokenStore(): TaskStore & { task: Task; updateTask: ReturnType<typeof vi.fn> } {
  const task = { id: "FN-1", title: "Token accounting", tokenUsage: undefined } as Task;
  const updateTask = vi.fn(async (_taskId: string, patch: Partial<Task>) => Object.assign(task, patch));
  return {
    task,
    getTask: vi.fn(async () => task),
    updateTask,
    getSettingsByScope: vi.fn(async () => ({ project: {}, global: {} })),
  } as unknown as TaskStore & { task: Task; updateTask: ReturnType<typeof vi.fn> };
}

describe("executor token usage extraction", () => {
  it("uses canonical cache-read/cache-write split (FN-4389)", async () => {
    const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
    const methods = executor as unknown as {
      extractSessionTokenUsage: (session: unknown) => Promise<{ inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number } | undefined>;
      accumulateTokenUsage: (existing: undefined, delta: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }) => { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number };
    };

    const delta = await methods.extractSessionTokenUsage({
      getSessionStats: () => ({
        tokens: { input: 1000, output: 500, cacheRead: 800, cacheWrite: 200, total: 2500 },
      }),
    });

    expect(delta).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 800,
      cacheWriteTokens: 200,
      totalTokens: 2500,
    });

    const merged = delta ? methods.accumulateTokenUsage(undefined, delta) : undefined;
    expect(merged).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 800,
      cacheWriteTokens: 200,
      totalTokens: 2500,
    });
  });

  it("starts a resumed central session at its task baseline and persists each prompt delta once", async () => {
    const store = createTokenStore();
    const executor = Object.create(TaskExecutor.prototype) as any;
    executor.store = store;
    executor.tokenUsageBaselines = new Map();
    executor.activeSessions = new Map();
    executor.currentRunContexts = new Map();

    const stats = { input: 1_000, output: 400, cacheRead: 50, cacheWrite: 10, total: 1_460 };
    const session = {
      model: { provider: "mock", id: "resumed" },
      getSessionStats: () => ({ tokens: stats }),
    };

    await executor.captureExecutorTokenUsageBaseline("FN-1", session);
    await executor.persistTokenUsage("FN-1", session);
    expect(store.updateTask).not.toHaveBeenCalled();

    Object.assign(stats, { input: 1_020, output: 410, cacheRead: 54, cacheWrite: 12, total: 1_496 });
    // Prompt-path and finalization both use the same writer/baseline; only the first sees this delta.
    await executor.persistTokenUsage("FN-1", session);
    await executor.persistTokenUsage("FN-1", session);

    expect(store.task.tokenUsage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      cachedTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 36,
    });
    expect(store.task.tokenUsage?.perModel?.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(36);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
  });
});
