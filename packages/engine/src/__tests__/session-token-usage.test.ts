import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { accumulateSessionTokenUsage } from "../session-token-usage.js";

interface MockSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

function createSession(stats: MockSessionStats | undefined) {
  return { getSessionStats: vi.fn(() => stats) } as unknown as Parameters<typeof accumulateSessionTokenUsage>[2];
}

function createStore(initial: Task["tokenUsage"]): TaskStore & { _task: Task; updateTask: ReturnType<typeof vi.fn> } {
  const task = { id: "FN-1", tokenUsage: initial } as Task;
  const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => {
    if (updates.tokenUsage !== undefined) task.tokenUsage = updates.tokenUsage as Task["tokenUsage"];
    return task;
  });
  const store = {
    _task: task,
    getTask: vi.fn(async () => task),
    updateTask,
  } as unknown as TaskStore & { _task: Task; updateTask: ReturnType<typeof vi.fn> };
  return store;
}

describe("accumulateSessionTokenUsage", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("writes initial token usage when task has none", async () => {
    const store = createStore(undefined);
    const session = createSession({ tokens: { input: 100, output: 30, cacheRead: 5, cacheWrite: 2 } });

    await accumulateSessionTokenUsage(store, "FN-1", session);

    expect(store.updateTask).toHaveBeenCalledTimes(1);
    const call = store.updateTask.mock.calls[0]![1] as { tokenUsage: Task["tokenUsage"] };
    expect(call.tokenUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cachedTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 137,
    });
    expect(typeof call.tokenUsage!.firstUsedAt).toBe("string");
    expect(typeof call.tokenUsage!.lastUsedAt).toBe("string");
  });

  it("accumulates only the delta on subsequent calls for the same session", async () => {
    const store = createStore(undefined);
    const session = createSession({ tokens: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 } });

    await accumulateSessionTokenUsage(store, "FN-1", session);

    // Second call: session has progressed.
    (session as unknown as { getSessionStats: () => MockSessionStats }).getSessionStats = () => ({
      tokens: { input: 250, output: 80, cacheRead: 0, cacheWrite: 0 },
    });
    await accumulateSessionTokenUsage(store, "FN-1", session);

    expect(store.updateTask).toHaveBeenCalledTimes(2);
    const second = store.updateTask.mock.calls[1]![1] as { tokenUsage: Task["tokenUsage"] };
    expect(second.tokenUsage).toMatchObject({
      inputTokens: 250,
      outputTokens: 80,
      cachedTokens: 0,
      totalTokens: 330,
    });
  });

  it("preserves firstUsedAt across updates", async () => {
    const store = createStore(undefined);
    const session = createSession({ tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });

    await accumulateSessionTokenUsage(store, "FN-1", session);
    const first = store.updateTask.mock.calls[0]![1] as { tokenUsage: Task["tokenUsage"] };
    const initialFirstUsed = first.tokenUsage!.firstUsedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    (session as unknown as { getSessionStats: () => MockSessionStats }).getSessionStats = () => ({
      tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await accumulateSessionTokenUsage(store, "FN-1", session);

    const second = store.updateTask.mock.calls[1]![1] as { tokenUsage: Task["tokenUsage"] };
    expect(second.tokenUsage!.firstUsedAt).toBe(initialFirstUsed);
    expect(second.tokenUsage!.lastUsedAt >= initialFirstUsed).toBe(true);
  });

  it("does nothing when session has no getSessionStats", async () => {
    const store = createStore(undefined);
    const session = {} as Parameters<typeof accumulateSessionTokenUsage>[2];

    await accumulateSessionTokenUsage(store, "FN-1", session);

    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("does nothing when delta is zero", async () => {
    const store = createStore({
      inputTokens: 50,
      outputTokens: 20,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 70,
      firstUsedAt: "2024-01-01T00:00:00.000Z",
      lastUsedAt: "2024-01-01T00:00:00.000Z",
    });
    const session = createSession({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

    await accumulateSessionTokenUsage(store, "FN-1", session);
    // Calling again with the same zero stats should not produce another update.
    await accumulateSessionTokenUsage(store, "FN-1", session);

    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("swallows store errors instead of throwing", async () => {
    const store = createStore(undefined);
    (store.updateTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const session = createSession({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

    await expect(accumulateSessionTokenUsage(store, "FN-1", session)).resolves.toBeUndefined();
  });
});
