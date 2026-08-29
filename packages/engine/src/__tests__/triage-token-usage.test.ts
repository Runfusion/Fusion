import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { aggregateTokenAnalytics, type Task, type TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { TriageProcessor } from "../triage.js";

interface MockSessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

function createSession(
  stats: MockSessionStats,
  model: { provider: string; id: string },
): AgentSession {
  return {
    getSessionStats: vi.fn(() => stats),
    dispose: vi.fn(),
    model,
  } as unknown as AgentSession;
}

function createStore(taskId = "FN-7135"): TaskStore & { _task: Task; updateTask: ReturnType<typeof vi.fn> } {
  const task = {
    id: taskId,
    title: "Triage token usage regression",
    tokenUsage: undefined,
  } as Task;
  const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => {
    if (updates.tokenUsage !== undefined) {
      task.tokenUsage = updates.tokenUsage;
    }
    return task;
  });
  return {
    _task: task,
    getTask: vi.fn(async () => task),
    updateTask,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore & { _task: Task; updateTask: ReturnType<typeof vi.fn> };
}

type TriageTokenRecorder = TriageProcessor & {
  recordTriageSessionTokenUsage: (taskId: string, session: AgentSession, options?: { agentId?: string }) => Promise<void>;
  registerSubagentSession: (taskId: string, session: AgentSession) => void;
  unregisterSubagentSession: (taskId: string, session: AgentSession) => void;
  disposeSubagentsForTask: (taskId: string, reason: string) => void;
};

function createProcessor(store: TaskStore): TriageTokenRecorder {
  return new TriageProcessor(store, "/test/root") as TriageTokenRecorder;
}

async function flushAsyncRecorders(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/* FNXC:PgMigrationQuarantine 2026-07-17-18:25: FN-8258 proves token analytics through AsyncDataLayer project-scoped rows, replacing removed raw SQLite Database seeding. */
pgDescribe("triage session token usage recording", () => {
  let harness: PgTestHarness;

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it("records a triage-only Anthropic planning model and surfaces it in by-model analytics", async () => {
    const store = createStore("FN-TRIAGE-ANTHROPIC");
    const processor = createProcessor(store);
    const session = createSession(
      { tokens: { input: 120, output: 30, cacheRead: 10, cacheWrite: 5 } },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    );

    // Symptom baseline: before the triage recording path runs, the Anthropic bucket is absent.
    expect(store._task.tokenUsage?.perModel?.some((bucket) => bucket.modelProvider === "anthropic")).toBeFalsy();

    await processor.recordTriageSessionTokenUsage(store._task.id, session, { agentId: "triage" });

    expect(store._task.tokenUsage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(store._task.tokenUsage?.perModel).toEqual([
      expect.objectContaining({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        inputTokens: 120,
        outputTokens: 30,
        cachedTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 165,
      }),
    ]);

    harness = await createTaskStoreForTest({ prefix: "fusion_triage_token_usage" });
    const persisted = await harness.store.createTask({ description: "triage analytics" });
    await harness.store.updateTask(persisted.id, { tokenUsage: store._task.tokenUsage });

    const byModel = await aggregateTokenAnalytics(harness.layer, { groupBy: "model" });
    expect(byModel.totals).toMatchObject({ totalTokens: 165, nTasks: 1 });
    expect(byModel.groups).toEqual([
      expect.objectContaining({ key: "claude-sonnet-4-5", totalTokens: 165, nTasks: 1 }),
    ]);

    const byProvider = await aggregateTokenAnalytics(harness.layer, { groupBy: "provider" });
    expect(byProvider.groups).toEqual([
      expect.objectContaining({ key: "anthropic", totalTokens: 165, nTasks: 1 }),
    ]);
  });

  it("records primary and fallback planning sessions into distinct model buckets on the same task", async () => {
    const store = createStore("FN-TRIAGE-FALLBACK");
    const processor = createProcessor(store);
    const primary = createSession(
      { tokens: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 } },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    );
    const fallback = createSession(
      { tokens: { input: 25, output: 15, cacheRead: 3, cacheWrite: 2 } },
      { provider: "openai", id: "gpt-5" },
    );

    await processor.recordTriageSessionTokenUsage(store._task.id, primary, { agentId: "triage" });
    await processor.recordTriageSessionTokenUsage(store._task.id, fallback, { agentId: "triage" });

    expect(store._task.tokenUsage).toMatchObject({ inputTokens: 75, outputTokens: 35, cachedTokens: 3, cacheWriteTokens: 2, totalTokens: 115 });
    expect(store._task.tokenUsage?.perModel).toEqual([
      expect.objectContaining({ modelProvider: "anthropic", modelId: "claude-sonnet-4-5", totalTokens: 70 }),
      expect.objectContaining({ modelProvider: "openai", modelId: "gpt-5", totalTokens: 45 }),
    ]);
  });

  it("records spec-review subagent usage on normal completion and forced disposal", async () => {
    const store = createStore("FN-TRIAGE-SUBAGENT");
    const processor = createProcessor(store);
    const normalReview = createSession(
      { tokens: { input: 10, output: 6, cacheRead: 1, cacheWrite: 0 } },
      { provider: "anthropic", id: "claude-reviewer" },
    );
    const forcedReview = createSession(
      { tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } },
      { provider: "openai", id: "gpt-reviewer" },
    );

    processor.registerSubagentSession(store._task.id, normalReview);
    processor.unregisterSubagentSession(store._task.id, normalReview);
    await flushAsyncRecorders();

    processor.registerSubagentSession(store._task.id, forcedReview);
    processor.disposeSubagentsForTask(store._task.id, "test forced disposal");
    await flushAsyncRecorders();

    expect(normalReview.dispose).not.toHaveBeenCalled();
    expect(forcedReview.dispose).toHaveBeenCalledTimes(1);
    expect(store._task.tokenUsage).toMatchObject({ totalTokens: 27 });
    expect(store._task.tokenUsage?.perModel).toEqual([
      expect.objectContaining({ modelProvider: "anthropic", modelId: "claude-reviewer", totalTokens: 17 }),
      expect.objectContaining({ modelProvider: "openai", modelId: "gpt-reviewer", totalTokens: 10 }),
    ]);
  });
});
