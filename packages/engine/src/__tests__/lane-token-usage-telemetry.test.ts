import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  persistTokenUsage,
  type PersistTokenUsageDeps,
  type TokenUsageBaseline,
} from "../executor/persist-token-usage.js";
import { accumulateSessionTokenUsage, captureSessionTokenBaseline } from "../execution/session-token-usage.js";
import {
  emitLaneTokenUsage,
  resetLaneTokenBaseline,
} from "../agents/prompt-telemetry.js";

const { notificationService } = vi.hoisted(() => ({ notificationService: { dispatch: vi.fn() } }));
vi.mock("../util/notifier.js", () => ({ getActiveNotificationService: () => notificationService }));

/**
 * RUFU-284 single-emit invariant: every lane leaves exactly ONE `token_usage` row per authoritative
 * delta, tagged with the lane named at the call site, and no lane leaves two rows for one spend.
 */

interface SessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

type FakeSession = {
  getSessionStats: () => SessionStats | undefined;
  model?: { provider?: string; id?: string };
  setStats: (stats: SessionStats | undefined) => void;
};

function fakeSession(stats: SessionStats | undefined, model = { provider: "anthropic", id: "claude-test" }): FakeSession {
  let current = stats;
  return {
    getSessionStats: () => current,
    model,
    setStats: (next) => { current = next; },
  } as FakeSession;
}

interface FakeStore extends TaskStore {
  emitted: Array<Record<string, unknown>>;
  updateTask: ReturnType<typeof vi.fn>;
  task: Task;
}

function fakeStore(options: { tokenUsage?: Task["tokenUsage"]; hostileEmit?: boolean } = {}): FakeStore {
  const task = {
    id: "FN-284",
    title: "telemetry",
    assignedAgentId: "agent-284",
    tokenUsage: options.tokenUsage,
  } as Task;
  const emitted: Array<Record<string, unknown>> = [];
  const emitUsageEvent = vi.fn(async (event: Record<string, unknown>) => {
    if (options.hostileEmit) throw new Error("sink offline");
    emitted.push(event);
    return true;
  });
  const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
    return task;
  });
  const store = {
    task,
    emitted,
    getTask: vi.fn(async () => task),
    getSettingsByScope: vi.fn(async () => ({ project: {}, global: {} })),
    updateTask,
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    pauseTask: vi.fn(async () => task),
    emitUsageEvent,
  } as unknown as FakeStore;
  return store;
}

function executorDeps(store: FakeStore, session: FakeSession): PersistTokenUsageDeps {
  return {
    store,
    getRunContextFor: () => undefined,
    tokenUsageBaselines: new Map<string, TokenUsageBaseline>(),
    getActiveSession: () => session as unknown as Parameters<typeof persistTokenUsage>[2],
  };
}

/** Rows of one kind, newest order preserved. */
function rowsOfKind(store: FakeStore, kind: string): Array<Record<string, unknown>> {
  return store.emitted.filter((event) => event.kind === kind);
}

function usageRows(store: FakeStore): Array<Record<string, unknown>> {
  return rowsOfKind(store, "token_usage");
}

beforeEach(() => {
  vi.restoreAllMocks();
  notificationService.dispatch.mockReset();
});

describe("executor central session (persistTokenUsage — the F1 seam)", () => {
  it("writes exactly one lane-tagged token_usage row carrying the delta cache numbers", async () => {
    const session = fakeSession({ tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 5 } });
    const store = fakeStore();
    await persistTokenUsage(executorDeps(store, session), "FN-284");

    const rows = usageRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "token_usage",
      taskId: "FN-284",
      agentId: "agent-284",
      model: "claude-test",
      provider: "anthropic",
      meta: {
        lane: "executor",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        cacheWriteTokens: 5,
        cacheReadReported: true,
      },
    });
    expect(store.task.tokenUsage?.inputTokens).toBe(100);
  });

  it("credits only the new tokens on a second call, so repeated persists cannot double-count", async () => {
    const session = fakeSession({ tokens: { input: 100, output: 10, cacheRead: 10, cacheWrite: 0 } });
    const store = fakeStore();
    const deps = executorDeps(store, session);
    await persistTokenUsage(deps, "FN-284");
    session.setStats({ tokens: { input: 160, output: 15, cacheRead: 30, cacheWrite: 2 } });
    await persistTokenUsage(deps, "FN-284");
    // Nothing new since the previous call: still exactly two rows, never a third zero row.
    await persistTokenUsage(deps, "FN-284");

    const rows = usageRows(store);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.meta).toMatchObject({ inputTokens: 60, outputTokens: 5, cachedTokens: 20, cacheWriteTokens: 2 });
    expect(store.task.tokenUsage?.inputTokens).toBe(160);
  });

  it("reports an unmeasured cache read as unreported instead of a silent zero", async () => {
    const session = fakeSession({ tokens: { input: 50, output: 5 } });
    const store = fakeStore();
    await persistTokenUsage(executorDeps(store, session), "FN-284");
    expect(usageRows(store)[0]?.meta).toMatchObject({ cachedTokens: 0, cacheReadReported: false });
  });

  it("keeps the task write and budget enforcement intact when the telemetry sink throws", async () => {
    const session = fakeSession({ tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const store = fakeStore({ hostileEmit: true });
    await expect(persistTokenUsage(executorDeps(store, session), "FN-284")).resolves.toBeUndefined();
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.emitted).toHaveLength(0);
  });
});

describe("accumulate seam with an explicit lane", () => {
  it("labels merger spend merger, never the role default executor (R4)", async () => {
    const session = fakeSession({ tokens: { input: 30, output: 3, cacheRead: 6, cacheWrite: 1 } });
    const store = fakeStore();
    await accumulateSessionTokenUsage(store, "FN-284", session as never, { lane: "merger" });

    const rows = usageRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toMatchObject({ lane: "merger" });
    expect(rows[0]?.meta).not.toMatchObject({ lane: "executor" });
  });

  it("credits task.tokenUsage exactly once when a lane already has accounting (R3)", async () => {
    const session = fakeSession({ tokens: { input: 70, output: 7, cacheRead: 7, cacheWrite: 0 } });
    const store = fakeStore();
    await accumulateSessionTokenUsage(store, "FN-284", session as never, {
      agentId: "agent-284",
      role: "triage",
      lane: "triage",
    });

    expect(usageRows(store)).toHaveLength(1);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.task.tokenUsage?.inputTokens).toBe(70);
  });

  it("stays silent for a call site that passes no lane, leaving its accounting untouched", async () => {
    const session = fakeSession({ tokens: { input: 11, output: 1, cacheRead: 1, cacheWrite: 0 } });
    const store = fakeStore();
    await accumulateSessionTokenUsage(store, "FN-284", session as never);
    expect(usageRows(store)).toHaveLength(0);
    expect(store.task.tokenUsage?.inputTokens).toBe(11);
  });
});

describe("event-only emitters for lanes without accounting", () => {
  it("records reviewer usage without ever writing task.tokenUsage", async () => {
    const session = fakeSession({ tokens: { input: 20, output: 2, cacheRead: 4, cacheWrite: 0 } });
    const store = fakeStore();
    emitLaneTokenUsage(store, "reviewer", session as never, { agentId: "agent-284" });

    const rows = usageRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toMatchObject({ lane: "reviewer", inputTokens: 20 });
    expect(rows[0]?.taskId).toBeNull();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.task.tokenUsage).toBeUndefined();
  });

  it("adds only the delta when an idle heartbeat run is measured twice", async () => {
    const session = fakeSession({ tokens: { input: 1000, output: 10, cacheRead: 900, cacheWrite: 0 } });
    const store = fakeStore();
    emitLaneTokenUsage(store, "heartbeat", session as never);
    session.setStats({ tokens: { input: 1200, output: 12, cacheRead: 1000, cacheWrite: 0 } });
    emitLaneTokenUsage(store, "heartbeat", session as never);

    const rows = usageRows(store);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.meta).toMatchObject({ inputTokens: 200, cachedTokens: 100, lane: "heartbeat" });
  });

  it("starts a fresh baseline after resetLaneTokenBaseline so a reused session is not under-credited", async () => {
    const session = fakeSession({ tokens: { input: 500, output: 5, cacheRead: 10, cacheWrite: 0 } });
    const store = fakeStore();
    emitLaneTokenUsage(store, "heartbeat", session as never);
    resetLaneTokenBaseline(session as never);
    emitLaneTokenUsage(store, "heartbeat", session as never);
    expect(usageRows(store)[1]?.meta).toMatchObject({ inputTokens: 500 });
  });

  it("skips a run whose session reported no usage at all", async () => {
    const session = fakeSession(undefined);
    const store = fakeStore();
    emitLaneTokenUsage(store, "reviewer", session as never);
    expect(usageRows(store)).toHaveLength(0);
  });

  it("captures a task-start baseline so a reused session cannot bleed a previous task's counters", async () => {
    const session = fakeSession({ tokens: { input: 5000, output: 50, cacheRead: 100, cacheWrite: 0 } });
    captureSessionTokenBaseline(session as never);
    session.setStats({ tokens: { input: 5100, output: 55, cacheRead: 120, cacheWrite: 1 } });
    const store = fakeStore();
    await accumulateSessionTokenUsage(store, "FN-284", session as never, { lane: "workflow-step" });
    expect(usageRows(store)[0]?.meta).toMatchObject({ lane: "workflow-step", inputTokens: 100, cachedTokens: 20 });
  });
});
