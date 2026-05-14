import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { accumulateSessionTokenUsage, computeCacheHitRatio } from "../session-token-usage.js";
import { TaskExecutor } from "../executor.js";

interface MockSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
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
    vi.restoreAllMocks();
  });

  it("writes initial token usage and emits cache metrics log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createStore(undefined);
    const session = createSession({ tokens: { input: 100, output: 30, cacheRead: 5, cacheWrite: 2 } });

    await accumulateSessionTokenUsage(store, "FN-1", session, { agentId: "agent-1", role: "reviewer" });

    expect(store.updateTask).toHaveBeenCalledTimes(1);
    const call = store.updateTask.mock.calls[0]![1] as { tokenUsage: Task["tokenUsage"] };
    expect(call.tokenUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cachedTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 137,
    });
    const cacheLogCall = errorSpy.mock.calls.find((entry) => String(entry[0]).includes("[token-cache-metrics]"));
    expect(cacheLogCall).toBeTruthy();
    const payload = JSON.parse(String(cacheLogCall?.[0] ?? "").replace(/^.*\[token-cache-metrics\]\s*/, ""));
    expect(payload).toMatchObject({
      taskId: "FN-1",
      agentId: "agent-1",
      role: "reviewer",
      inputTokens: 100,
      cachedTokens: 5,
      cacheWriteTokens: 2,
      hitRatio: computeCacheHitRatio(100, 5),
    });
  });

  it("does nothing when delta is zero (no write, no metrics log)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    await accumulateSessionTokenUsage(store, "FN-1", session);

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.find((entry) => String(entry[0]).includes("[token-cache-metrics]"))).toBeUndefined();
  });

  it("emits token-cache-metrics log when executor persists non-zero delta", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createStore(undefined);
    const executor = Object.create(TaskExecutor.prototype) as TaskExecutor & {
      store: TaskStore;
      tokenUsageBaselines: Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>;
      activeSessions: Map<string, { session: unknown }>;
      persistTokenUsage: (taskId: string, session?: unknown) => Promise<void>;
    };
    executor.store = store;
    executor.tokenUsageBaselines = new Map();
    executor.activeSessions = new Map();

    await executor.persistTokenUsage("FN-1", { getSessionStats: () => ({ tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6 } }) });

    const cacheLogCall = errorSpy.mock.calls.find((entry) => String(entry[0]).includes("[token-cache-metrics]"));
    expect(cacheLogCall).toBeTruthy();
  });

  it("swallows store errors instead of throwing", async () => {
    const store = createStore(undefined);
    (store.updateTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const session = createSession({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

    await expect(accumulateSessionTokenUsage(store, "FN-1", session)).resolves.toBeUndefined();
  });

  it.each([
    { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    { input: 1000, output: 500, cacheRead: 800, cacheWrite: 200, total: 2500 },
  ])("FN-4389 canonical semantic parity for stats %#", async (tokens) => {
    const heartbeatStore = createStore(undefined);
    const heartbeatSession = createSession({ tokens });
    await accumulateSessionTokenUsage(heartbeatStore, "FN-1", heartbeatSession);
    const heartbeatUsage = (heartbeatStore.updateTask.mock.calls[0]?.[1] as { tokenUsage?: Task["tokenUsage"] })?.tokenUsage;

    const executor = Object.create(TaskExecutor.prototype) as TaskExecutor;
    const extract = (executor as unknown as {
      extractSessionTokenUsage: (session: unknown) => Promise<{ inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number } | undefined>;
      accumulateTokenUsage: (existing: Task["tokenUsage"], delta: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }) => Task["tokenUsage"];
    });
    const delta = await extract.extractSessionTokenUsage({ getSessionStats: () => ({ tokens }) });
    const executorUsage = delta ? extract.accumulateTokenUsage(undefined, delta) : undefined;

    expect(heartbeatUsage).toMatchObject({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      totalTokens: tokens.total,
    });
    expect(executorUsage).toMatchObject({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      totalTokens: tokens.total,
    });
  });
});
