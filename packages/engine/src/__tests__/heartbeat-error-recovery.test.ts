import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

vi.mock("../agent-session-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-session-helpers.js")>("../agent-session-helpers.js");
  const pi = await import("../pi.js");
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async () => ({
      session: await pi.createFnAgent(),
      sessionFile: undefined,
      runtimeId: "mock",
      wasConfigured: true,
    })),
  };
});

import { createFnAgent } from "../pi.js";
import {
  buildHeartbeatErrorRecoveryMetadata,
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
  HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
  HeartbeatMonitor,
  HeartbeatTriggerScheduler,
  incrementHeartbeatErrorRecoveryMetadata,
  isErrorRecoveryEligible,
  isHeartbeatErrorRecoverable,
  readHeartbeatErrorRetryCount,
  resetHeartbeatErrorRecoveryMetadata,
  resolveErrorRecoveryLimit,
} from "../agent-heartbeat.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

const baseAgent = (patch: Partial<Agent> = {}): Agent => ({
  id: "agent-recovery",
  name: "Recovery Agent",
  role: "executor",
  state: "error",
  soul: "Keeps durable heartbeat agents healthy",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  metadata: {},
  runtimeConfig: { enabled: true },
  ...patch,
}) as Agent;

function createNoTaskStore(settings: Record<string, unknown> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

function createAgentStore(agent: Agent): AgentStore & { agent: Agent; runs: Map<string, AgentHeartbeatRun> } {
  let runSeq = 0;
  const runs = new Map<string, AgentHeartbeatRun>();
  const store = {
    agent,
    runs,
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn(async () => store.agent),
    getCachedAgent: vi.fn(() => store.agent),
    listAgents: vi.fn(async () => [store.agent]),
    on: vi.fn(),
    off: vi.fn(),
    updateAgentState: vi.fn(async (_agentId: string, state: Agent["state"]) => {
      store.agent = { ...store.agent, state };
      return store.agent;
    }),
    updateAgent: vi.fn(async (_agentId: string, updates: Partial<Agent>) => {
      store.agent = { ...store.agent, ...updates };
      return store.agent;
    }),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    startHeartbeatRun: vi.fn(async () => {
      runSeq += 1;
      const run = {
        id: `run-${runSeq}`,
        agentId: store.agent.id,
        source: "timer",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun;
      runs.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => {
      runs.set(run.id, run);
    }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runs.get(runId) ?? null),
    endHeartbeatRun: vi.fn(async (_runId: string) => undefined),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    assignTask: vi.fn().mockResolvedValue(agent),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentStore & { agent: Agent; runs: Map<string, AgentHeartbeatRun> };
  return store;
}

function createSession(promptImpl: () => Promise<void>) {
  return {
    prompt: vi.fn(promptImpl),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

describe("heartbeat error-recovery primitives", () => {
  it("resolves a minimum bounded retry limit from optional settings", () => {
    expect(resolveErrorRecoveryLimit(undefined)).toBe(5);
    expect(resolveErrorRecoveryLimit({ heartbeatErrorRecoveryAttempts: 3 } as never)).toBe(3);
    expect(resolveErrorRecoveryLimit({ heartbeatErrorRecoveryAttempts: 0 } as never)).toBe(1);
    expect(resolveErrorRecoveryLimit({ heartbeatErrorRecoveryAttempts: Number.NaN } as never)).toBe(5);
  });

  it("reads, increments, and resets the shared counter without clobbering unrelated metadata", () => {
    const agent = baseAgent({ metadata: { heartbeatTimerRepair: { repairedAt: "now" } } });
    expect(readHeartbeatErrorRetryCount(agent)).toBe(0);

    const incremented = incrementHeartbeatErrorRecoveryMetadata(agent);
    expect(incremented.heartbeatTimerRepair).toEqual({ repairedAt: "now" });
    expect(readHeartbeatErrorRetryCount({ metadata: incremented })).toBe(1);

    const forced = buildHeartbeatErrorRecoveryMetadata({ metadata: incremented }, 4);
    expect(readHeartbeatErrorRetryCount({ metadata: forced })).toBe(4);

    const legacySweepMetadata = {
      ...forced,
      durableErrorRecovery: { attempts: 5, exhausted: true },
    };
    expect(readHeartbeatErrorRetryCount({ metadata: legacySweepMetadata })).toBe(5);

    const reset = resetHeartbeatErrorRecoveryMetadata({ metadata: legacySweepMetadata });
    expect(reset.heartbeatTimerRepair).toEqual({ repairedAt: "now" });
    expect(reset.durableErrorRecovery).toBeUndefined();
    expect(readHeartbeatErrorRetryCount({ metadata: reset })).toBe(0);
    expect(reset[HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]).toMatchObject({ consecutiveAttempts: 0 });
  });

  it("only marks durable runtime-enabled under-budget transient error agents eligible", () => {
    expect(isErrorRecoveryEligible(baseAgent({ lastError: "socket hang up" }), 5)).toBe(true);
    expect(isErrorRecoveryEligible(baseAgent({ state: "active", lastError: "socket hang up" }), 5)).toBe(false);
    expect(isErrorRecoveryEligible(baseAgent({ runtimeConfig: { enabled: false }, lastError: "socket hang up" }), 5)).toBe(false);
    expect(isErrorRecoveryEligible(baseAgent({ metadata: { agentKind: "task-worker" }, lastError: "socket hang up" }), 5)).toBe(false);
    expect(isErrorRecoveryEligible(baseAgent({ metadata: buildHeartbeatErrorRecoveryMetadata(baseAgent(), 5), lastError: "socket hang up" }), 5)).toBe(false);
    expect(isErrorRecoveryEligible(baseAgent({ lastError: "invalid api key" }), 5)).toBe(false);
    expect(isErrorRecoveryEligible(baseAgent({ lastError: "SyntaxError: Unexpected token" }), 5)).toBe(false);
    // OAuth token-rotation 401s are transient credential rotations, not operator problems.
    expect(isErrorRecoveryEligible(baseAgent({ lastError: 'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcxRi9mwx1NrZmX9qN7p2"}' }), 5)).toBe(true);
    expect(isErrorRecoveryEligible(baseAgent({ lastError: '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token does not meet scope requirements"}}' }), 5)).toBe(false);
    expect(isHeartbeatErrorRecoverable({ lastError: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/deleted/node_modules/@runfusion/fusion/dist/bin.js' imported from /tmp/deleted/packages/engine/src/pi.ts" })).toBe(false);
  });
});

describe("HeartbeatMonitor error-state recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateFnAgent.mockReset();
  });

  it("reproduces a failed run, then clears error state and retries on the next heartbeat", async () => {
    const firstSession = createSession(async () => { throw new Error("socket hang up"); });
    const secondSession = createSession(async () => undefined);
    mockedCreateFnAgent.mockResolvedValueOnce(firstSession as never).mockResolvedValueOnce(secondSession as never);
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });
    expect(store.agent.state).toBe("error");
    expect(store.agent.lastError).toContain("socket hang up");

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(secondSession.prompt).toHaveBeenCalledTimes(1);
    expect(store.agent.state).toBe("active");
    expect(store.agent.lastError).toBeUndefined();
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
      target: store.agent.id,
      metadata: expect.objectContaining({ attempt: 1, limit: 5 }),
    }));
  });

  it("parks an operator-actionable error state instead of auto-recovering or stranding it", async () => {
    const session = createSession(async () => undefined);
    mockedCreateFnAgent.mockResolvedValueOnce(session as never);
    const store = createAgentStore(baseAgent({ lastError: "invalid api key" }));
    const taskStore = createNoTaskStore();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(store.agent.state).toBe("paused");
    expect(store.agent.lastError).toBe("invalid api key");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
      target: store.agent.id,
      metadata: expect.objectContaining({ agentId: store.agent.id, source: "timer" }),
    }));
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
    }));
  });

  it("parks a first-run operator-actionable failure immediately with an explicit reason", async () => {
    mockedCreateFnAgent.mockResolvedValueOnce(createSession(async () => {
      throw new Error('401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token does not meet scope requirements"}}');
    }) as never);
    const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
    const taskStore = createNoTaskStore();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(store.agent.state).toBe("paused");
    expect(store.agent.lastError).toContain("OAuth token does not meet scope requirements");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
      target: store.agent.id,
      metadata: expect.objectContaining({ agentId: store.agent.id, source: "timer" }),
    }));
  });

  /*
  FNXC:AgentHeartbeat 2026-07-12-20:10:
  Regression for the OAuth token-rotation incident: a mid-run 401
  "authentication_error: Invalid authentication credentials" must be retried
  IN-RUN (withRateLimitRetry transient-auth budget) so a routine ~8h Claude Max
  token rotation never fails the heartbeat run, and — if it still escapes —
  must classify as a recoverable error (bare `error` + bounded auto-retry),
  never an operator-actionable "error-unrecoverable" park.
  */
  it("retries a transient OAuth token-rotation 401 in-run and completes without entering error state", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const session = createSession(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcxRi9mwx1NrZmX9qN7p2"}');
        }
      });
      mockedCreateFnAgent.mockResolvedValueOnce(session as never);
      const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
      const taskStore = createNoTaskStore();
      const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

      let settled = false;
      const heartbeat = monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" }).finally(() => { settled = true; });
      // Flat transient-auth retry delay is ~5s ±10% jitter; advance fake time until the run settles.
      for (let i = 0; i < 30 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await heartbeat;

      expect(session.prompt).toHaveBeenCalledTimes(2);
      expect(store.agent.state).toBe("active");
      expect(store.agent.lastError).toBeUndefined();
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "agent:error-parked-unrecoverable",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a persistent rotation-shaped 401 recoverable (bare error, no unrecoverable park)", async () => {
    vi.useFakeTimers();
    try {
      const rotation401 = 'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcxRi9mwx1NrZmX9qN7p2"}';
      mockedCreateFnAgent.mockResolvedValueOnce(createSession(async () => { throw new Error(rotation401); }) as never);
      const store = createAgentStore(baseAgent({ state: "active", lastError: undefined }));
      const taskStore = createNoTaskStore();
      const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

      let settled = false;
      const heartbeat = monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" }).finally(() => { settled = true; });
      // Exhaust the in-run transient-auth retry budget (2 retries × ~5s) on fake time.
      for (let i = 0; i < 30 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await heartbeat;

      expect(store.agent.state).toBe("error");
      expect(store.agent.pauseReason).toBeUndefined();
      expect(isErrorRecoveryEligible(store.agent, 5)).toBe(true);
      expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "agent:error-parked-unrecoverable",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves runtime-disabled operator-actionable error agents excluded from timer recovery", async () => {
    const session = createSession(async () => undefined);
    mockedCreateFnAgent.mockResolvedValueOnce(session as never);
    const store = createAgentStore(baseAgent({ runtimeConfig: { enabled: false }, lastError: "invalid api key" }));
    const taskStore = createNoTaskStore();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(store.agent.state).toBe("error");
    expect(store.agent.pauseReason).toBeUndefined();
    expect(taskStore.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-parked-unrecoverable",
    }));
  });

  it("parks the agent paused after the bounded recovery budget is exhausted", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createSession(async () => { throw new Error("socket hang up 1"); }) as never)
      .mockResolvedValueOnce(createSession(async () => { throw new Error("socket hang up 2"); }) as never);
    const store = createAgentStore(baseAgent({ metadata: {}, lastError: "socket hang up" }));
    const taskStore = createNoTaskStore({ heartbeatErrorRecoveryAttempts: 2 });
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });
    expect(store.agent.state).toBe("error");
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(1);

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(store.agent.state).toBe("paused");
    expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(2);
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:error-retry-exhausted",
      target: store.agent.id,
      metadata: expect.objectContaining({ attempts: 2, limit: 2 }),
    }));
  });

  it("parks an exhausted agent through the real timer scheduler path", async () => {
    vi.useFakeTimers();
    let scheduler: HeartbeatTriggerScheduler | undefined;
    try {
      mockedCreateFnAgent
        .mockResolvedValueOnce(createSession(async () => { throw new Error("socket hang up 1"); }) as never)
        .mockResolvedValueOnce(createSession(async () => { throw new Error("socket hang up 2"); }) as never);
      const store = createAgentStore(baseAgent({
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 },
        lastError: "socket hang up",
      }));
      const taskStore = createNoTaskStore({ heartbeatErrorRecoveryAttempts: 2 });
      const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });
      const triggerPromises: Array<Promise<unknown>> = [];
      scheduler = new HeartbeatTriggerScheduler(
        store,
        (agentId, source) => {
          const run = monitor.executeHeartbeat({ agentId, source });
          triggerPromises.push(run);
          return run;
        },
        taskStore,
      );

      scheduler.start();
      scheduler.registerAgent(store.agent.id, store.agent.runtimeConfig!);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.allSettled(triggerPromises.splice(0));
      expect(store.agent.state).toBe("error");
      expect(readHeartbeatErrorRetryCount(store.agent)).toBe(1);
      expect(scheduler.getRegisteredAgents()).toContain(store.agent.id);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.allSettled(triggerPromises.splice(0));
      expect(store.agent.state).toBe("paused");
      expect(store.agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
      expect(readHeartbeatErrorRetryCount(store.agent)).toBe(2);
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
      expect(taskStore.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "agent:error-retry-exhausted",
        target: store.agent.id,
        metadata: expect.objectContaining({ attempts: 2, limit: 2 }),
      }));

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.allSettled(triggerPromises.splice(0));
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
      expect(scheduler.getRegisteredAgents()).not.toContain(store.agent.id);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.allSettled(triggerPromises.splice(0));
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally {
      scheduler?.stop();
      vi.useRealTimers();
    }
  });

  it("resets the recovery budget after a successful run", async () => {
    const session = createSession(async () => undefined);
    mockedCreateFnAgent.mockResolvedValueOnce(session as never);
    const store = createAgentStore(baseAgent({
      lastError: "socket hang up",
      metadata: buildHeartbeatErrorRecoveryMetadata(baseAgent(), 3),
    }));
    const taskStore = createNoTaskStore();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: process.cwd() });

    await monitor.executeHeartbeat({ agentId: store.agent.id, source: "timer" });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(store.agent.state).toBe("active");
    expect(store.agent.lastError).toBeUndefined();
    expect(readHeartbeatErrorRetryCount(store.agent)).toBe(0);
  });
});
