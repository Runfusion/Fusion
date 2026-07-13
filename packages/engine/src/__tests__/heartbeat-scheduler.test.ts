import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  HeartbeatMonitor,
  HeartbeatTriggerScheduler,
} from "../agent-heartbeat.js";
import type { TriggerCallback } from "../agent-heartbeat.js";
import type { AgentStore, TaskStore, Agent } from "@fusion/core";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
import { heartbeatLog } from "../logger.js";

describe("HeartbeatTriggerScheduler", () => {
  let store: AgentStore;
  let callback: ReturnType<typeof vi.fn<TriggerCallback>>;
  let scheduler: import("../agent-heartbeat.js").HeartbeatTriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    callback = vi.fn().mockResolvedValue(undefined);
    store = {
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      listAgents: vi.fn().mockResolvedValue([]),
      getRunDetail: vi.fn().mockResolvedValue(null),
      saveRun: vi.fn().mockResolvedValue(undefined),
      endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
      updateAgent: vi.fn().mockImplementation(async (_id: string, updates: { metadata: Record<string, unknown> }) => ({
        id: "agent-001",
        metadata: updates.metadata,
      })),
    } as unknown as AgentStore;
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  describe("constructor and lifecycle", () => {
    it("starts and stops cleanly", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      expect(scheduler.isActive()).toBe(false);

      scheduler.start();
      expect(scheduler.isActive()).toBe(true);

      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });

    it("start is idempotent", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.start(); // second call should be no-op
      expect(scheduler.isActive()).toBe(true);
    });

    it("stop is idempotent", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // second call should be no-op
      expect(scheduler.isActive()).toBe(false);
    });
  });

  describe("agent lifecycle seam registration", () => {
    type LifecycleStore = EventEmitter & Pick<AgentStore, "getAgent" | "getActiveHeartbeatRun" | "getBudgetStatus" | "listAgents" | "getRecentRuns" | "updateAgent"> & {
      agents: Map<string, Agent>;
    };

    const baseAgent = (id: string, patch: Partial<Agent> = {}): Agent => ({
      id,
      name: patch.name ?? id,
      role: patch.role ?? "executor",
      state: patch.state ?? "active",
      createdAt: patch.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: patch.updatedAt ?? "2026-01-01T00:00:00.000Z",
      metadata: patch.metadata ?? {},
      runtimeConfig: patch.runtimeConfig,
      lastHeartbeatAt: patch.lastHeartbeatAt,
      taskId: patch.taskId,
      lastError: patch.lastError,
    }) as Agent;

    function createLifecycleStore(initialAgents: Agent[] = []): LifecycleStore {
      const eventStore = Object.assign(new EventEmitter(), {
        agents: new Map(initialAgents.map((agent) => [agent.id, agent])),
        getAgent: vi.fn(async function(this: LifecycleStore, agentId: string) {
          return this.agents.get(agentId) ?? null;
        }),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        listAgents: vi.fn(async function(this: LifecycleStore) {
          return Array.from(this.agents.values());
        }),
        getRecentRuns: vi.fn().mockResolvedValue([]),
        updateAgent: vi.fn().mockImplementation(async function(this: LifecycleStore, agentId: string, patch: Partial<Agent>) {
          const before = this.agents.get(agentId) ?? baseAgent(agentId);
          const after = { ...before, ...patch, runtimeConfig: patch.runtimeConfig ?? before.runtimeConfig } as Agent;
          this.agents.set(agentId, after);
          this.emit("agent:configRevision", agentId, { before, after });
          this.emit("agent:updated", after);
          return after;
        }),
      }) as LifecycleStore;
      return eventStore;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      scheduler?.stop();
      vi.useRealTimers();
    });

    it("registers created heartbeat agents and excludes disabled or internal workers", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-11:06:
      Scheduler lifecycle behavior should be exercised at the EventEmitter seam instead of paying InProcessRuntime startup cost for created/default/explicit/disabled registration variants.
      */
      const eventStore = createLifecycleStore();
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();

      const defaultAgent = baseAgent("agent-default");
      const explicitAgent = baseAgent("agent-explicit", { runtimeConfig: { enabled: true, heartbeatIntervalMs: 15_000 } });
      const disabledAgent = baseAgent("agent-disabled", { runtimeConfig: { enabled: false } });
      const internalWorker = baseAgent("agent-worker", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 } });
      for (const agent of [defaultAgent, explicitAgent, disabledAgent, internalWorker]) {
        eventStore.agents.set(agent.id, agent);
        eventStore.emit("agent:created", agent);
      }

      expect(scheduler.getRegisteredAgents()).toContain(defaultAgent.id);
      expect(scheduler.getRegisteredAgents()).toContain(explicitAgent.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(disabledAgent.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(internalWorker.id);

      await vi.advanceTimersByTimeAsync(14_999);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith(explicitAgent.id, "timer", expect.objectContaining({ intervalMs: 15_000 }));
    });

    it("keeps recoverable error agents timer-eligible and dispatches their next tick", async () => {
      const recoverable = baseAgent("agent-recoverable", {
        state: "error",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 },
        lastError: "socket hang up",
      });
      const exhausted = baseAgent("agent-exhausted", {
        state: "error",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 },
        lastError: "socket hang up",
        metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 5 } },
      });
      const disabled = baseAgent("agent-disabled-error", {
        state: "error",
        runtimeConfig: { enabled: false, heartbeatIntervalMs: 1_000 },
      });
      const ephemeral = baseAgent("agent-ephemeral-error", {
        state: "error",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 },
        metadata: { agentKind: "task-worker" },
      });
      const operatorActionable = baseAgent("agent-operator-error", {
        state: "error",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 },
        lastError: "invalid api key",
      });
      const eventStore = createLifecycleStore([recoverable, exhausted, disabled, ephemeral, operatorActionable]);
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();

      for (const agent of [recoverable, exhausted, disabled, ephemeral, operatorActionable]) {
        eventStore.emit("agent:created", agent);
      }

      expect(scheduler.getRegisteredAgents()).toContain(recoverable.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(exhausted.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(disabled.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(ephemeral.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(operatorActionable.id);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(callback).toHaveBeenCalledWith(recoverable.id, "timer", expect.objectContaining({ intervalMs: 1_000 }));
    });

    it("keeps unrelated updates stable, re-arms interval changes, and clears paused timers", async () => {
      const agent = baseAgent("agent-lifecycle", { runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 } });
      const eventStore = createLifecycleStore([agent]);
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
      eventStore.emit("agent:created", agent);

      await vi.advanceTimersByTimeAsync(400);
      const renamed = { ...agent, name: "renamed" } as Agent;
      eventStore.agents.set(agent.id, renamed);
      eventStore.emit("agent:updated", renamed);
      await vi.advanceTimersByTimeAsync(599);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledTimes(1);

      callback.mockClear();
      await eventStore.updateAgent(agent.id, { runtimeConfig: { enabled: true, heartbeatIntervalMs: 2_000 } });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith(agent.id, "timer", expect.objectContaining({ intervalMs: 2_000 }));

      callback.mockClear();
      const paused = { ...eventStore.agents.get(agent.id)!, state: "paused" as const };
      eventStore.agents.set(agent.id, paused);
      eventStore.emit("agent:updated", paused);
      expect(scheduler.getRegisteredAgents()).not.toContain(agent.id);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(callback).not.toHaveBeenCalled();

      const resumed = { ...paused, state: "active" as const };
      eventStore.agents.set(agent.id, resumed);
      eventStore.emit("agent:updated", resumed);
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("unregisters deleted agents and removes lifecycle listeners on stop", async () => {
      const agent = baseAgent("agent-cleanup", { runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 } });
      const eventStore = createLifecycleStore([agent]);
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
      eventStore.emit("agent:created", agent);
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);

      eventStore.emit("agent:deleted", agent.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(agent.id);

      eventStore.emit("agent:created", agent);
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);
      scheduler.stop();
      expect(eventStore.listenerCount("agent:created")).toBe(0);
      expect(eventStore.listenerCount("agent:updated")).toBe(0);
      expect(eventStore.listenerCount("agent:configRevision")).toBe(0);
      expect(eventStore.listenerCount("agent:deleted")).toBe(0);

      const afterStop = baseAgent("agent-after-stop", { runtimeConfig: { enabled: true, heartbeatIntervalMs: 1_000 } });
      eventStore.emit("agent:created", afterStop);
      expect(scheduler.getRegisteredAgents()).not.toContain(afterStop.id);
    });

    it("FN-7718: force re-arms a stale present timer entry on an in-process start transition instead of no-oping", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      // Long interval so the default 2x-multiplier stale threshold (7.2M ms) is
      // easy to cross deterministically within the test.
      const agent = baseAgent("agent-stale-start", {
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 3_600_000 },
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      });
      const eventStore = createLifecycleStore([agent]);
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
      eventStore.emit("agent:created", agent);
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);

      // Advance well past the stale threshold with no lifecycle event firing —
      // the timer entry stays present in `this.timers` (a live audit cycle
      // would normally repair this, but this test isolates the in-process
      // syncTimerForAgent seam specifically, independent of the audit).
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000); // 8 hours, no ticks fired (interval never elapses)
      callback.mockClear();
      vi.mocked(heartbeatLog.warn).mockClear();

      // Simulate an in-process start transition (e.g. agent:updated firing for
      // an in-process-driven resume) while the stale entry from before is still
      // present. Previously syncTimerForAgent's bare `this.timers.has(...)`
      // check would no-op here and leave the stale entry untouched.
      const started = { ...eventStore.agents.get(agent.id)!, state: "active" as const };
      eventStore.agents.set(agent.id, started);
      eventStore.emit("agent:updated", started);

      expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("Timer sync force re-armed stale present entry"));
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);

      // Exactly one entry results — registerAgent clears before re-arming.
      const timers = (scheduler as unknown as { timers: Map<string, unknown> }).timers;
      expect(timers.has(agent.id)).toBe(true);
    });

    it("FN-7718: does not force re-arm a healthy fresh present timer entry on an unrelated in-process update", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const agent = baseAgent("agent-fresh-update", {
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 3_600_000 },
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      });
      const eventStore = createLifecycleStore([agent]);
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
      eventStore.emit("agent:created", agent);
      expect(scheduler.getRegisteredAgents()).toContain(agent.id);

      // Well within the stale threshold — an unrelated update must not reset
      // the interval or force a re-arm.
      await vi.advanceTimersByTimeAsync(30 * 60_000); // 30 minutes
      vi.mocked(heartbeatLog.warn).mockClear();

      const renamed = { ...eventStore.agents.get(agent.id)!, name: "renamed-fresh" };
      eventStore.agents.set(agent.id, renamed);
      eventStore.emit("agent:updated", renamed);

      expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("Timer sync force re-armed stale present entry"));
    });
  });

  describe("scheduler timer audit", () => {
    it("re-arms a tickable durable agent when timer entry is missing and no lifecycle event fires", async () => {
      vi.useFakeTimers();
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
      scheduler.unregisterAgent("agent-001");
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });

    it("re-arms a recoverable error agent when timer entry is missing and no lifecycle event fires", async () => {
      vi.useFakeTimers();
      const agent = {
        id: "agent-error-audit",
        name: "Agent Error Audit",
        role: "executor",
        state: "error",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastError: "socket hang up",
        metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 1 } },
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.getRegisteredAgents()).toContain(agent.id);
      scheduler.unregisterAgent(agent.id);
      expect(scheduler.getRegisteredAgents()).not.toContain(agent.id);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(scheduler.getRegisteredAgents()).toContain(agent.id);
    });

    it("marks repaired agent metadata as stale when last heartbeat exceeds the default 2x threshold", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.updateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: expect.objectContaining({
            heartbeatTimerRepair: expect.objectContaining({ staleAtRepair: true }),
          }),
        }),
      );
      expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("Timer re-armed stale agent agent-001"));
    });

    it("marks repaired agent metadata as healthy when heartbeat is within stale threshold", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.updateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: expect.objectContaining({
            heartbeatTimerRepair: expect.objectContaining({ staleAtRepair: false }),
          }),
        }),
      );
      expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("Timer re-armed stale agent"));
    });

    it("uses project heartbeatRepairStaleMultiplier when configured", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:50.000Z"));
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatRepairStaleMultiplier: 1 }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(taskStore.getSettings).toHaveBeenCalled();
      expect(store.updateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: expect.objectContaining({
            heartbeatTimerRepair: expect.objectContaining({ staleAtRepair: true }),
          }),
        }),
      );
    });

    it("skips audit re-arm when the agent already has an active heartbeat run", async () => {
      vi.useFakeTimers();
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({ id: "run-1" } as any);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.unregisterAgent("agent-001");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("FN-4119 reaps a stale active run and re-arms the timer when audit finds a lost registration", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 3_600_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      const activeRun = {
        id: "run-stale",
        agentId: "agent-001",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
      } as any;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(activeRun);
      vi.mocked(store.getRunDetail).mockResolvedValue(activeRun);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.endHeartbeatRun).toHaveBeenCalledOnce();
      expect(store.endHeartbeatRun).toHaveBeenCalledWith("run-stale", "terminated");
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
      expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("reason=orphaned-run-reaped agentId=agent-001 runId=run-stale"));
      expect(heartbeatLog.log).toHaveBeenCalledWith(expect.stringContaining("reason=timer-audit-rearmed agentId=agent-001 runId=run-stale"));

      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.endHeartbeatRun).toHaveBeenCalledTimes(1);
    });

    it("FN-4119 leaves healthy active runs alone during audit", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:15.000Z"));
      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:10.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 3_600_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:10.000Z",
        metadata: {},
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({ id: "run-healthy", status: "active" } as any);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.endHeartbeatRun).not.toHaveBeenCalled();
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
      expect(heartbeatLog.log).toHaveBeenCalledWith("Timer audit skipped re-arm for agent-001 (active run)");
    });

    it("FN-4119 does not reap task-worker runs during audit", async () => {
      vi.useFakeTimers();
      const agent = {
        id: "executor-FN-999",
        name: "executor-FN-999",
        role: "executor",
        state: "active",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: { agentKind: "task-worker" },
      } as Agent;
      vi.mocked(store.listAgents).mockResolvedValue([agent]);

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getActiveHeartbeatRun).not.toHaveBeenCalled();
      expect(store.endHeartbeatRun).not.toHaveBeenCalled();
      expect(scheduler.getRegisteredAgents()).not.toContain("executor-FN-999");
    });

    describe("FN-7645: zombie long-interval timer re-arm", () => {
      /**
       * FNXC:AgentHeartbeat 2026-07-07-00:00:
       * Regression coverage for FN-7645: a long-interval (~1h) agent whose
       * live setInterval silently stops firing must self-heal within one 60s
       * audit cycle once its lastHeartbeatAt goes stale beyond threshold, even
       * though a timer map entry is still present (the audit previously
       * short-circuited on `this.timers.has(agent.id)` and only repaired
       * *missing* registrations). A parallel healthy short-interval agent must
       * keep ticking on its own cadence, unaffected/undisturbed.
       */
      function buildAgent(overrides: Partial<Agent> & { id: string; heartbeatIntervalMs: number }): Agent {
        const { heartbeatIntervalMs, ...rest } = overrides;
        return {
          name: rest.id,
          role: "executor",
          state: "active",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { enabled: true, heartbeatIntervalMs },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
          ...rest,
        } as Agent;
      }

      it("re-arms a present-but-non-advancing long-interval timer while leaving a healthy short-interval agent unaffected", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-long": buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000 }),
          "agent-short": buildAgent({ id: "agent-short", heartbeatIntervalMs: 300_000 }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        // Simulate production behavior: a dispatched timer tick advances the
        // agent's lastHeartbeatAt (as a real heartbeat run completion would).
        callback.mockImplementation(async (agentId: string) => {
          agents[agentId] = { ...agents[agentId], lastHeartbeatAt: new Date().toISOString() };
        });

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.getRegisteredAgents()).toContain("agent-long");
        expect(scheduler.getRegisteredAgents()).toContain("agent-short");

        // Kill the long-interval agent's live interval handle out from under the
        // scheduler, simulating a silently-dead setInterval while its map entry
        // (and therefore the audit's "already registered" short-circuit) remains
        // present — the exact "zombie timer" signature this task fixes.
        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        const longTimerEntry = timers.get("agent-long");
        expect(longTimerEntry?.kind).toBe("interval");
        clearInterval(longTimerEntry!.handle as ReturnType<typeof setInterval>);

        callback.mockClear();

        // Advance across many 60s audit cycles spanning several hours — the
        // ~18h staleness signature from the original report, scaled down for
        // test speed but well past the default 2x-interval (7.2M ms) threshold.
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); // 4 hours

        // Assertion it is gone: the long-interval agent must have been
        // re-armed and dispatched within one audit cycle of going stale.
        expect(callback).toHaveBeenCalledWith("agent-long", "timer", expect.anything());
        expect(scheduler.getRegisteredAgents()).toContain("agent-long");
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));

        // The healthy short-interval agent ticks on its own normal cadence
        // (4h / 300_000ms = 48 ticks) and must not be force re-armed or thrashed.
        const shortTicks = callback.mock.calls.filter((call) => call[0] === "agent-short").length;
        expect(shortTicks).toBe(48);
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed agentId=agent-short"));
      });

      it("does not force re-arm a long-interval timer entry whose lastHeartbeatAt is fresh", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000 });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        // Well within the 2x-interval stale threshold (7.2M ms) — several audit
        // cycles must not force a re-arm or dispatch.
        await vi.advanceTimersByTimeAsync(30 * 60_000); // 30 minutes

        expect(callback).not.toHaveBeenCalled();
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
      });

      it("does not force re-arm when lastHeartbeatAt is null/never-ticked even though a timer entry is present", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000, lastHeartbeatAt: null as unknown as string });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        // getHeartbeatAgeMs() returns NaN for a null lastHeartbeatAt, so the
        // "stale beyond threshold" comparison must never be true — a never-ticked
        // agent with a live timer entry must be left alone by the audit.
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
      });

      it("only force re-arms once stale beyond threshold, not at a small multiple within it", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        // Default repair-stale multiplier is 2x, so threshold = 7_200_000ms (2h).
        const agent = buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000 });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        clearInterval(timers.get("agent-long")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        // Stale by a small multiple (1.1x interval = 3_960_000ms) — still under
        // the 2x threshold, so the zombie repair must not fire yet.
        await vi.advanceTimersByTimeAsync(3_960_000);
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
        expect(callback).not.toHaveBeenCalled();

        // Cross the 2x threshold (total elapsed now > 7_200_000ms) — the next
        // audit cycle must repair it. Repair re-registers via a jittered
        // (<=5s) catch-up timeout, so advance a little further to let that
        // dispatch actually fire.
        await vi.advanceTimersByTimeAsync(3_300_000);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
        expect(callback).toHaveBeenCalledWith("agent-long", "timer", expect.anything());
      });

      it("pause guards still suppress dispatch after a zombie re-arm (does not regress FN-2658)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000 });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        const taskStore = {
          getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
        } as unknown as TaskStore;

        scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        clearInterval(timers.get("agent-long")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();

        // The audit still re-registers the zombie timer (registration is not
        // itself gated on pause), but the dispatched tick must be suppressed by
        // onTimerTick's globalPause guard — the callback must never fire while
        // globally paused, even for a freshly-repaired long-interval agent.
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

        expect(callback).not.toHaveBeenCalled();
      });

      it("does not disturb a healthy active heartbeat run even when lastHeartbeatAt looks stale", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));

        // Active-run staleness (FN-4119) is judged against `heartbeatTimeoutMs`,
        // independently from the timer-registration repair threshold (which is
        // based on `heartbeatIntervalMs`). Use a long heartbeatTimeoutMs so the
        // active run reads as healthy throughout the audit window even though
        // lastHeartbeatAt (2h old) has already crossed the interval-based
        // zombie-repair threshold. An agent with a genuinely live active run
        // never gets a bare timer entry armed in the first place (audit skips
        // re-arm while the run is healthy), so this proves the new zombie-stale
        // check does not override the FN-4119 active-run guard.
        const agent = buildAgent({ id: "agent-long", heartbeatIntervalMs: 3_600_000 });
        (agent.runtimeConfig as Record<string, unknown>).heartbeatTimeoutMs = 24 * 60 * 60 * 1000;
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({ id: "run-healthy", status: "active" } as any);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.getRegisteredAgents()).not.toContain("agent-long");
        callback.mockClear();
        vi.mocked(store.endHeartbeatRun).mockClear();

        await vi.advanceTimersByTimeAsync(60_000); // one audit cycle

        expect(store.endHeartbeatRun).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-long");
        expect(heartbeatLog.log).toHaveBeenCalledWith("Timer audit skipped re-arm for agent-long (active run)");
      });
    });

    describe("FN-7939: heartbeat audit driver supervision and bounded re-arm churn", () => {
      /**
       * FNXC:AgentHeartbeat 2026-07-13-00:00:
       * FN-7939 proves the FN-7645/FN-7718 repair layer is not allowed to depend on a single unsupervised audit setInterval. The reported CEO outage kept a timer entry present for ~62,348s, so tests kill the audit driver itself and require the scheduler to self-rearm within a bounded watchdog window instead of waiting for an external stop/start.
       */
      function buildAgent(overrides: Partial<Agent> & { id: string; heartbeatIntervalMs: number }): Agent {
        const { heartbeatIntervalMs, ...rest } = overrides;
        return {
          name: rest.id,
          role: "executor",
          state: "active",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { enabled: true, heartbeatIntervalMs },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
          ...rest,
        } as Agent;
      }

      it("self-rearms a stalled audit interval and dispatches a stale present short-interval timer within the bounded watchdog window", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-short-stalled-audit": buildAgent({ id: "agent-short-stalled-audit", heartbeatIntervalMs: 300_000 }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => agents[agentId] ?? null);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
        vi.mocked(store.updateAgent).mockImplementation(async (agentId: string, updates: Partial<Agent>) => {
          agents[agentId] = { ...agents[agentId], ...updates } as Agent;
          return agents[agentId];
        });
        callback.mockImplementation(async (agentId: string) => {
          agents[agentId] = { ...agents[agentId], lastHeartbeatAt: new Date().toISOString() };
        });

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const internals = scheduler as unknown as {
          timerAuditIntervalHandle: ReturnType<typeof setInterval> | null;
          timers: Map<string, { handle: unknown; kind: string }>;
        };
        expect(internals.timerAuditIntervalHandle).not.toBeNull();
        clearInterval(internals.timerAuditIntervalHandle!);
        clearInterval(internals.timers.get("agent-short-stalled-audit")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        await vi.advanceTimersByTimeAsync(62_348_000);

        expect(callback).toHaveBeenCalledWith("agent-short-stalled-audit", "timer", expect.anything());
        expect(agents["agent-short-stalled-audit"].lastHeartbeatAt).not.toBe("2026-01-01T00:00:00.000Z");
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat-audit-watchdog-rearmed"));
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat-rearm-nonadvancing-escalated"));
      });

      it("self-rearms a stalled audit interval for the long 3_600_000ms interval bucket without double-auditing while healthy", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-long-stalled-audit": buildAgent({ id: "agent-long-stalled-audit", heartbeatIntervalMs: 3_600_000 }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => agents[agentId] ?? null);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
        callback.mockImplementation(async (agentId: string) => {
          agents[agentId] = { ...agents[agentId], lastHeartbeatAt: new Date().toISOString() };
        });

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const internals = scheduler as unknown as {
          timerAuditIntervalHandle: ReturnType<typeof setInterval> | null;
          timers: Map<string, { handle: unknown; kind: string }>;
        };
        clearInterval(internals.timerAuditIntervalHandle!);
        clearInterval(internals.timers.get("agent-long-stalled-audit")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();

        await vi.advanceTimersByTimeAsync(62_348_000);

        expect(callback).toHaveBeenCalledWith("agent-long-stalled-audit", "timer", expect.anything());
        const longTicks = callback.mock.calls.filter((call) => call[0] === "agent-long-stalled-audit").length;
        expect(longTicks).toBeGreaterThanOrEqual(1);
        expect(longTicks).toBeLessThanOrEqual(18);
      });

      it("does not resurrect a stopped scheduler after the audit watchdog cadence passes", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-stopped-scheduler", heartbeatIntervalMs: 300_000 });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        scheduler.stop();
        const internals = scheduler as unknown as {
          timerAuditIntervalHandle: ReturnType<typeof setInterval> | null;
          timerAuditWatchdogHandle: ReturnType<typeof setInterval> | null;
        };
        expect(internals.timerAuditIntervalHandle).toBeNull();
        expect(internals.timerAuditWatchdogHandle).toBeNull();

        await vi.advanceTimersByTimeAsync(62_348_000);

        expect(scheduler.isActive()).toBe(false);
        expect(callback).not.toHaveBeenCalled();
      });

      it("does not watchdog-rearm or double-audit while the normal audit interval keeps firing", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-healthy-auditor", heartbeatIntervalMs: 300_000 });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        vi.mocked(heartbeatLog.warn).mockClear();

        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat-audit-watchdog-rearmed"));
      });

      it("does not escalate repeated zombie re-arms while globalPause intentionally suppresses timer dispatch", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-global-pause": buildAgent({ id: "agent-global-pause", heartbeatIntervalMs: 120_000 }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => agents[agentId] ?? null);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
        const taskStore = {
          getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
        } as unknown as TaskStore;

        scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        clearInterval(timers.get("agent-global-pause")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        await vi.advanceTimersByTimeAsync(12 * 60_000);

        expect(callback).not.toHaveBeenCalled();
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat-rearm-nonadvancing-escalated"));
      });

      it("escalates repeated zombie re-arms when skipHeartbeatWhenIdle prevents lastHeartbeatAt from advancing", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-churn": buildAgent({
            id: "agent-churn",
            heartbeatIntervalMs: 120_000,
            runtimeConfig: { enabled: true, heartbeatIntervalMs: 120_000, skipHeartbeatWhenIdle: true },
          }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getAgent).mockImplementation(async (agentId: string) => agents[agentId] ?? null);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);
        vi.mocked(store.updateAgent).mockImplementation(async (agentId: string, updates: Partial<Agent>) => {
          agents[agentId] = { ...agents[agentId], ...updates } as Agent;
          return agents[agentId];
        });

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        clearInterval(timers.get("agent-churn")!.handle as ReturnType<typeof setInterval>);
        callback.mockClear();
        vi.mocked(heartbeatLog.warn).mockClear();

        await vi.advanceTimersByTimeAsync(12 * 60_000);

        expect(callback).not.toHaveBeenCalled();
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("reason=heartbeat-rearm-nonadvancing-escalated agentId=agent-churn"));
        expect((agents["agent-churn"].metadata as Record<string, any>).heartbeatTimerRepair).toEqual(
          expect.objectContaining({
            staleAtRepair: true,
            staleRepairReason: expect.stringContaining("heartbeat-rearm-nonadvancing-escalated"),
          }),
        );
      });
    });

    describe("FN-7718: orphaned/zombie timer invalidation on stop/start", () => {
      /**
       * FNXC:AgentHeartbeat 2026-07-09-00:00:
       * Regression coverage for FN-7718: `fn agent stop`/`start` mutate the
       * agent row from a SEPARATE process, so the in-process `agent:updated`
       * listener never fires for CLI-driven transitions — the 60s audit is the
       * ONLY cross-process reconciliation path. Before the fix, the audit loop
       * opened with `if (!this.isTimerEligibleAgent(agent)) continue;`, which
       * skipped stopped/paused/disabled agents WITHOUT clearing any timer entry
       * armed while they were running — an orphaned/zombie entry that then sat
       * until the FN-7645 stale-repair path eventually fired minutes later on
       * the next start, producing the recurring `zombie-timer-rearmed` symptom.
       */
      function buildAgent(overrides: Partial<Agent> & { id: string; heartbeatIntervalMs: number }): Agent {
        const { heartbeatIntervalMs, ...rest } = overrides;
        return {
          name: rest.id,
          role: "executor",
          state: "active",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { enabled: true, heartbeatIntervalMs },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
          ...rest,
        } as Agent;
      }

      it("clears an orphaned timer entry within one audit cycle when an agent is stopped out-of-process, and the subsequent start arms exactly one fresh timer with no zombie-timer-rearmed repair", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        // listAgents is mutated in-place to simulate a CLI `fn agent stop`/`start`
        // cycle mutating the DB out-of-process — no `agent:updated` event fires.
        let agent = buildAgent({ id: "agent-cli", heartbeatIntervalMs: 300_000, state: "active" });
        vi.mocked(store.listAgents).mockImplementation(async () => [agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.getRegisteredAgents()).toContain("agent-cli");

        // Simulate `fn agent stop`: DB now reports a non-tickable state, but no
        // in-process event fires — the timer entry the scheduler armed earlier
        // is still present until the next audit cycle reconciles it.
        agent = { ...agent, state: "paused" };
        vi.mocked(heartbeatLog.warn).mockClear();

        // Advance across several 60s audit cycles.
        await vi.advanceTimersByTimeAsync(3 * 60_000);

        // Assertion it is gone: the orphaned timer must be cleared within one
        // audit cycle — no lingering registration for the stopped agent.
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-cli");

        // Simulate `fn agent start` with a stale lastHeartbeatAt left over from
        // before the stop (no heartbeat happened while paused).
        agent = { ...agent, state: "active", lastHeartbeatAt: "2026-01-01T00:00:00.000Z" };
        callback.mockClear();

        await vi.advanceTimersByTimeAsync(60_000); // one more audit cycle picks up the start

        // Exactly one fresh timer entry results — not zero, not two.
        expect(scheduler.getRegisteredAgents()).toContain("agent-cli");
        const timers = (scheduler as unknown as { timers: Map<string, unknown> }).timers;
        expect(timers.has("agent-cli")).toBe(true);

        // No zombie-timer-rearmed repair should ever have been needed for this
        // agent — the orphaned entry was invalidated at stop time, so the start
        // begins clean instead of requiring the FN-7645 stale-repair path.
        expect(heartbeatLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
      });

      it("clears a present timer for each ineligibility cause: non-tickable state, runtimeConfig.enabled:false, and ephemeral/non-heartbeat-managed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-paused": buildAgent({ id: "agent-paused", heartbeatIntervalMs: 300_000 }),
          "agent-disabled": buildAgent({ id: "agent-disabled", heartbeatIntervalMs: 300_000 }),
          "agent-ephemeral": buildAgent({ id: "agent-ephemeral", heartbeatIntervalMs: 300_000, metadata: { agentKind: "task-worker" } }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        // ephemeral/task-worker agents are never timer-eligible in the first
        // place, so only the two heartbeat-managed agents get an initial entry.
        expect(scheduler.getRegisteredAgents()).toContain("agent-paused");
        expect(scheduler.getRegisteredAgents()).toContain("agent-disabled");
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-ephemeral");

        // Flip each to a non-eligible condition out-of-process.
        agents["agent-paused"] = { ...agents["agent-paused"], state: "paused" };
        agents["agent-disabled"] = {
          ...agents["agent-disabled"],
          runtimeConfig: { ...(agents["agent-disabled"].runtimeConfig as Record<string, unknown>), enabled: false },
        };

        await vi.advanceTimersByTimeAsync(60_000); // one audit cycle

        expect(scheduler.getRegisteredAgents()).not.toContain("agent-paused");
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-disabled");
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-ephemeral");
      });

      it("is a safe no-op for a non-eligible agent that never had a timer entry", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildAgent({ id: "agent-never-armed", heartbeatIntervalMs: 300_000, state: "paused" });
        vi.mocked(store.listAgents).mockResolvedValue([agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.getRegisteredAgents()).not.toContain("agent-never-armed");

        await expect(vi.advanceTimersByTimeAsync(3 * 60_000)).resolves.not.toThrow();
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-never-armed");
      });

      it("clears an orphaned entry for both short (300_000) and long (3_600_000) interval buckets, and does not regress the FN-7645 long-interval zombie re-arm for a still-eligible stale agent", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-short-stopped": buildAgent({ id: "agent-short-stopped", heartbeatIntervalMs: 300_000 }),
          "agent-long-stopped": buildAgent({ id: "agent-long-stopped", heartbeatIntervalMs: 3_600_000 }),
          "agent-long-zombie": buildAgent({ id: "agent-long-zombie", heartbeatIntervalMs: 3_600_000 }),
        };
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        for (const id of Object.keys(agents)) {
          expect(scheduler.getRegisteredAgents()).toContain(id);
        }

        // Stop the short and long agents out-of-process; leave agent-long-zombie
        // eligible but kill its live interval handle to reproduce the FN-7645
        // present-but-non-advancing case, which must still self-heal.
        agents["agent-short-stopped"] = { ...agents["agent-short-stopped"], state: "paused" };
        agents["agent-long-stopped"] = { ...agents["agent-long-stopped"], state: "paused" };
        const timers = (scheduler as unknown as { timers: Map<string, { handle: unknown; kind: string }> }).timers;
        clearInterval(timers.get("agent-long-zombie")!.handle as ReturnType<typeof setInterval>);

        vi.mocked(heartbeatLog.warn).mockClear();

        // 4 hours covers both the 60s stop-side audit reconciliation and the
        // FN-7645 stale threshold (2x interval = 7.2M ms) for the still-eligible
        // zombie agent.
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

        // Both stopped agents' orphaned timers were invalidated.
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-short-stopped");
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-long-stopped");

        // The still-eligible long-interval zombie agent is unaffected by the
        // stop-path fix and still gets FN-7645's stale re-arm + dispatch.
        expect(scheduler.getRegisteredAgents()).toContain("agent-long-zombie");
        expect(callback).toHaveBeenCalledWith("agent-long-zombie", "timer", expect.anything());
        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("zombie-timer-rearmed"));
      });

      it("guards remain intact: globalPause suppresses dispatch, a healthy active run is untouched, and a healthy fresh short-interval agent is never force-re-armed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agents: Record<string, Agent> = {
          "agent-stopped": buildAgent({ id: "agent-stopped", heartbeatIntervalMs: 300_000 }),
          "agent-healthy-run": buildAgent({ id: "agent-healthy-run", heartbeatIntervalMs: 300_000 }),
          "agent-healthy-fresh": buildAgent({ id: "agent-healthy-fresh", heartbeatIntervalMs: 300_000 }),
        };
        (agents["agent-healthy-run"].runtimeConfig as Record<string, unknown>).heartbeatTimeoutMs = 24 * 60 * 60 * 1000;
        vi.mocked(store.listAgents).mockImplementation(async () => Object.values(agents));
        vi.mocked(store.getActiveHeartbeatRun).mockImplementation(async (agentId: string) =>
          agentId === "agent-healthy-run" ? ({ id: "run-healthy", status: "active" } as any) : null,
        );

        const taskStore = {
          getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
        } as unknown as TaskStore;

        scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        // agent-healthy-run never gets a bare timer armed while its run is live.
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-healthy-run");
        expect(scheduler.getRegisteredAgents()).toContain("agent-healthy-fresh");

        agents["agent-stopped"] = { ...agents["agent-stopped"], state: "paused" };
        callback.mockClear();
        vi.mocked(store.endHeartbeatRun).mockClear();

        // Flip globalPause on for this cycle to confirm dispatch stays suppressed.
        vi.mocked(taskStore.getSettings).mockResolvedValue({ globalPause: true, enginePaused: false } as any);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(scheduler.getRegisteredAgents()).not.toContain("agent-stopped");
        expect(store.endHeartbeatRun).not.toHaveBeenCalled();
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-healthy-run");
        // Healthy fresh short-interval agent keeps its original entry — not
        // force-cleared or re-armed just because an unrelated agent was stopped.
        expect(scheduler.getRegisteredAgents()).toContain("agent-healthy-fresh");
      });

      it("a repeat stop (already-cleared orphaned timer) is a safe idempotent no-op", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        let agent = buildAgent({ id: "agent-repeat-stop", heartbeatIntervalMs: 300_000 });
        vi.mocked(store.listAgents).mockImplementation(async () => [agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);

        agent = { ...agent, state: "paused" };
        await vi.advanceTimersByTimeAsync(60_000);
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-repeat-stop");

        // Multiple further audit cycles while still stopped must remain a
        // cheap no-op — no throw, no re-entry into the timer map.
        await expect(vi.advanceTimersByTimeAsync(3 * 60_000)).resolves.not.toThrow();
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-repeat-stop");
      });
    });

    /*
     * FNXC:AgentHeartbeat 2026-07-09-08:15:
     * FN-7723 — the cross-process notification fast-path over the FN-7718/
     * FN-7645 audit backstop. `AgentStore.checkForChanges()` re-emits the
     * SAME `agent:updated`/`agent:stateChanged` events exercised by the
     * "agent lifecycle seam registration" tests above; this describe proves
     * `watchAgentLifecycle`'s existing listener reacts to a re-emitted
     * EXTERNAL event (simulated here by emitting directly on the
     * EventEmitter-backed store, exactly as AgentStore.checkForChanges()
     * would after diffing a cross-process write) WITHOUT the 60s audit ever
     * running, and that the audit still works as the backstop when no event
     * arrives at all. No new engine-side listener/seam was added for this
     * task — syncTimerForAgent handles the re-emitted event identically to
     * an in-process one, so this is a pure regression/characterization
     * suite over the existing wiring plus FN-7718's stale-repair guard.
     */
    describe("FN-7723: re-emitted external agent:updated drives the timer without the audit", () => {
      // Self-contained EventEmitter-backed store mirroring `createLifecycleStore`
      // from the "agent lifecycle seam registration" describe above (out of
      // scope here since this sits inside "scheduler timer audit"). Emitting
      // directly on this store simulates AgentStore.checkForChanges()'s
      // re-emit of the EXISTING `agent:updated` event after diffing a
      // cross-process write — no new event names, no engine-side seam.
      type CrossProcessStore = EventEmitter & Pick<AgentStore, "getAgent" | "getActiveHeartbeatRun" | "getBudgetStatus" | "listAgents" | "getRecentRuns" | "updateAgent"> & {
        agents: Map<string, Agent>;
      };

      function buildCrossProcessAgent(overrides: Partial<Agent> & { id: string; heartbeatIntervalMs: number }): Agent {
        const { heartbeatIntervalMs, ...rest } = overrides;
        return {
          name: rest.id,
          role: "executor",
          state: "active",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { enabled: true, heartbeatIntervalMs },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
          ...rest,
        } as Agent;
      }

      function createCrossProcessStore(initialAgents: Agent[] = []): CrossProcessStore {
        return Object.assign(new EventEmitter(), {
          agents: new Map(initialAgents.map((agent) => [agent.id, agent])),
          getAgent: vi.fn(async function(this: CrossProcessStore, agentId: string) {
            return this.agents.get(agentId) ?? null;
          }),
          getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
          getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
          listAgents: vi.fn(async function(this: CrossProcessStore) {
            return Array.from(this.agents.values());
          }),
          getRecentRuns: vi.fn().mockResolvedValue([]),
          updateAgent: vi.fn(),
        }) as CrossProcessStore;
      }

      it("a re-emitted external stop clears the timer and a re-emitted external start re-arms it, with zero audit cycles elapsed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildCrossProcessAgent({ id: "agent-cross-process", heartbeatIntervalMs: 300_000 });
        const eventStore = createCrossProcessStore([agent]);
        scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
        scheduler.start();
        eventStore.emit("agent:created", agent);
        expect(scheduler.getRegisteredAgents()).toContain(agent.id);

        // Simulate AgentStore.checkForChanges() re-emitting agent:updated for a
        // CLI `fn agent stop` it detected on its next poll tick — well before
        // the 60s audit interval elapses.
        const stopped = { ...eventStore.agents.get(agent.id)!, state: "paused" as const };
        eventStore.agents.set(agent.id, stopped);
        await vi.advanceTimersByTimeAsync(2_000); // one AgentStore poll tick (2s default), zero audit cycles (60s)
        eventStore.emit("agent:updated", stopped, "active");

        expect(scheduler.getRegisteredAgents()).not.toContain(agent.id);

        // Simulate the re-emitted external `fn agent start`, still with no
        // audit cycle having elapsed.
        const started = { ...eventStore.agents.get(agent.id)!, state: "active" as const };
        eventStore.agents.set(agent.id, started);
        await vi.advanceTimersByTimeAsync(2_000);
        eventStore.emit("agent:updated", started, "paused");

        expect(scheduler.getRegisteredAgents()).toContain(agent.id);
        const timers = (scheduler as unknown as { timers: Map<string, unknown> }).timers;
        expect(timers.has(agent.id)).toBe(true);

        // Total elapsed time (4s) never reached a single 60s audit cycle.
        expect(callback).not.toHaveBeenCalled();
      });

      it("honors FN-7718's stale-present-entry force-re-arm when the re-emitted event arrives after the timer entry went stale", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        const agent = buildCrossProcessAgent({ id: "agent-cross-process-stale", heartbeatIntervalMs: 3_600_000 });
        const eventStore = createCrossProcessStore([agent]);
        scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
        scheduler.start();
        eventStore.emit("agent:created", agent);
        expect(scheduler.getRegisteredAgents()).toContain(agent.id);

        // Advance well past the 2x stale threshold (7.2M ms) with the entry
        // still present — the audit is never driven here, only the poll-detected
        // re-emit path.
        await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
        vi.mocked(heartbeatLog.warn).mockClear();

        // A re-emitted external start (CLI `fn agent start`, surfaced by
        // AgentStore.checkForChanges()) while the stale entry is still present
        // must force re-arm exactly like an in-process start would (FN-7718).
        const started = { ...eventStore.agents.get(agent.id)!, state: "active" as const };
        eventStore.agents.set(agent.id, started);
        eventStore.emit("agent:updated", started, "paused");

        expect(heartbeatLog.warn).toHaveBeenCalledWith(expect.stringContaining("Timer sync force re-armed stale present entry"));
        expect(scheduler.getRegisteredAgents()).toContain(agent.id);
      });

      it("the 60s audit still reconciles a stop/start when NO re-emitted event ever arrives (backstop retained)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        // Use the plain (non-EventEmitter) mocked store so no agent:updated
        // event can ever fire — the ONLY path that can reconcile this stop is
        // the audit's listAgents() sweep, proving the backstop is untouched by
        // this task's additive fast-path.
        let agent: Agent = {
          id: "agent-audit-backstop",
          name: "agent-audit-backstop",
          role: "executor",
          state: "active",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { enabled: true, heartbeatIntervalMs: 300_000 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
        };
        vi.mocked(store.listAgents).mockImplementation(async () => [agent]);
        vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(null);

        scheduler = new HeartbeatTriggerScheduler(store, callback);
        scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.getRegisteredAgents()).toContain("agent-audit-backstop");

        // Mutate the DB row out-of-process (no event, ever) — same shape as the
        // FN-7718 "clears an orphaned timer entry" test, kept here to assert the
        // audit backstop is unchanged by FN-7723's additive fast-path.
        agent = { ...agent, state: "paused" };
        await vi.advanceTimersByTimeAsync(3 * 60_000); // several audit cycles
        expect(scheduler.getRegisteredAgents()).not.toContain("agent-audit-backstop");

        agent = { ...agent, state: "active", lastHeartbeatAt: "2026-01-01T00:00:00.000Z" };
        await vi.advanceTimersByTimeAsync(60_000);
        expect(scheduler.getRegisteredAgents()).toContain("agent-audit-backstop");
      });
    });
  });

  describe("registerAgent", () => {
    beforeEach(() => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("registers an agent with timer", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });

    it("does not register when heartbeat is explicitly disabled", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000, enabled: false });
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("applies default 3600-second interval when intervalMs is undefined", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", {});
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 3600-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 3600-second interval when intervalMs is 0", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 0 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 3600-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 3600-second interval when heartbeatIntervalMs is not set", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at exactly 3600 seconds (default interval)
      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // Now at exactly 3600 seconds
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 3_600_000,
      });
      vi.useRealTimers();
    });

    it("uses explicit interval over default when both are provided", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 15_000, enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at 15 seconds (explicit), not 3600
      await vi.advanceTimersByTimeAsync(14_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // Now at exactly 15 seconds
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 15_000,
      });
      vi.useRealTimers();
    });

    it("applies heartbeatMultiplier to timer interval", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.5 }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 60_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 30_000 }));
      vi.useRealTimers();
    });

    it("defaults multiplier to 1 when setting is missing", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({}),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 20_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(19_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 20_000 }));
      vi.useRealTimers();
    });

    it("clamps multiplied interval to 1000ms minimum", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.1 }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 2_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 1_000 }));
      vi.useRealTimers();
    });

    it("clears previous timer when re-registering", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 20000 });
      expect(scheduler.getRegisteredAgents()).toHaveLength(1);
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });
  });

  describe("unregisterAgent", () => {
    beforeEach(() => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("removes a registered agent", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      scheduler.unregisterAgent("agent-001");
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("is no-op for unregistered agent", () => {
      scheduler.unregisterAgent("agent-999");
      expect(scheduler.getRegisteredAgents()).toHaveLength(0);
    });
  });

  describe("timer triggers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("fires callback at the configured interval", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Advance by one interval and let async callbacks settle
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("clamps configured interval to a minimum of 1000ms", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10 });

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 1000,
      });
    });

    it("fires multiple times for multiple intervals", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(15000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("does not fire after stop", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("does not fire after unregister", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      scheduler.unregisterAgent("agent-001");
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("phase-aligns the first tick to lastHeartbeatAt when supplied", async () => {
      // Simulate: last tick was 4s ago, interval is 5s.
      // The next tick is due in 1s, not in a fresh full 5s window.
      vi.setSystemTime(new Date("2026-04-30T05:00:00.000Z"));
      const lastHeartbeatAt = new Date("2026-04-30T04:59:56.000Z").toISOString();

      scheduler.registerAgent(
        "agent-001",
        { heartbeatIntervalMs: 5000 },
        { lastHeartbeatAt },
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();

      // Subsequent ticks resume the steady cadence.
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("fires promptly with jitter when lastHeartbeatAt is already overdue", async () => {
      // Interval is 60s but the last tick was 10 minutes ago — fire immediately
      // (within the OVERDUE_FIRE_JITTER_MS window) instead of waiting another
      // full 60s. This is the core fix for "agents look unresponsive after a
      // dashboard restart" — the previous setInterval-only scheduler would
      // have made the user wait a full interval before the catch-up tick.
      vi.setSystemTime(new Date("2026-04-30T05:00:00.000Z"));
      const lastHeartbeatAt = new Date("2026-04-30T04:50:00.000Z").toISOString();

      scheduler.registerAgent(
        "agent-001",
        { heartbeatIntervalMs: 60_000 },
        { lastHeartbeatAt },
      );

      // Jitter window is 5s; advance past it to guarantee the fire happens.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("falls back to full-interval delay when lastHeartbeatAt is missing", async () => {
      // No options provided — preserves the original "wait one full interval"
      // behavior for agents that have never ticked.
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(4999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("skips tick when agent has active run", async () => {
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("FN-4119 reaps a stale active run and proceeds with the timer tick", async () => {
      const staleAgent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      const activeRun = {
        id: "run-stale",
        agentId: "agent-001",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
      } as any;
      vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
      vi.mocked(store.getAgent).mockResolvedValue(staleAgent);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue(activeRun);
      vi.mocked(store.getRunDetail).mockResolvedValue(activeRun);

      await (scheduler as any).onTimerTick("agent-001", 30_000);

      expect(store.endHeartbeatRun).toHaveBeenCalledOnce();
      expect(store.endHeartbeatRun).toHaveBeenCalledWith("run-stale", "terminated");
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 30_000,
      });
      expect(heartbeatLog.log).toHaveBeenCalledWith(expect.stringContaining("reason=tick-proceeded-after-reap agentId=agent-001 runId=run-stale"));
    });

    it("FN-4119 preserves the active-run skip when the run is still healthy", async () => {
      const healthyAgent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        lastHeartbeatAt: "2026-01-01T00:00:12.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:12.000Z",
        metadata: {},
      } as Agent;
      vi.setSystemTime(new Date("2026-01-01T00:00:15.000Z"));
      vi.mocked(store.getAgent).mockResolvedValue(healthyAgent);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({ id: "run-healthy", status: "active" } as any);

      await (scheduler as any).onTimerTick("agent-001", 30_000);

      expect(store.endHeartbeatRun).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(heartbeatLog.log).toHaveBeenCalledWith("Timer tick skipped for agent-001 (active run)");
    });

    it.each([
      { name: "paused agent state", agentState: "paused" as const, settings: null, expectedLog: "Timer tick skipped for agent-001 (state=paused)" },
      { name: "global pause", agentState: "active" as const, settings: { globalPause: true, enginePaused: false }, expectedLog: "Timer tick skipped for agent-001 (global pause active)" },
      { name: "engine pause", agentState: "active" as const, settings: { globalPause: false, enginePaused: true }, expectedLog: "Timer tick skipped for agent-001 (engine paused)" },
    ])("FN-4119 does not reap stale runs during $name", async ({ agentState, settings, expectedLog }) => {
      scheduler.stop();
      const taskStore = settings
        ? ({ getSettings: vi.fn().mockResolvedValue(settings) } as unknown as TaskStore)
        : undefined;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      const agent = {
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: agentState,
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      } as Agent;
      vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
      vi.mocked(store.getAgent).mockResolvedValue(agent);
      vi.mocked(store.getActiveHeartbeatRun).mockResolvedValue({ id: "run-stale", status: "active" } as any);

      await (scheduler as any).onTimerTick("agent-001", 30_000);

      expect(store.getActiveHeartbeatRun).not.toHaveBeenCalled();
      expect(store.endHeartbeatRun).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(heartbeatLog.log).toHaveBeenCalledWith(expectedLog);
    });

    it("skips timer dispatch when global pause is active", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
      expect(heartbeatLog.log).toHaveBeenCalledWith("Timer tick skipped for agent-001 (global pause active)");
    });

    it("skips timer dispatch when engine pause is active", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: true }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("dispatches timer callback when pause flags are false", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("respects maxConcurrentRuns from config", async () => {
      // Agent with active run should be skipped
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      scheduler.registerAgent("agent-001", {
        heartbeatIntervalMs: 5000,
        maxConcurrentRuns: 1,
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("dispatches timer callback even when agent is over budget (budget enforcement in executeHeartbeat)", async () => {
      // Budget checks have been moved from the scheduler to executeHeartbeat().
      // The scheduler dispatches the callback so that executeHeartbeat() can create
      // explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      // Callback IS called so executeHeartbeat() can create a run record
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("dispatches timer callback even when agent is over threshold (budget enforcement in executeHeartbeat)", async () => {
      // Budget checks have been moved from the scheduler to executeHeartbeat().
      // The scheduler dispatches the callback so that executeHeartbeat() can create
      // explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({
          budgetLimit: 1000,
          usagePercent: 85,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: true,
        })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      // Callback IS called so executeHeartbeat() can create a run record
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("fires timer tick normally when below threshold", async () => {
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({
          budgetLimit: 1000,
          usagePercent: 30,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: false,
        })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("fires timer tick when getBudgetStatus throws", async () => {
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("budget unavailable"));

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe("stop clears all timers", () => {
    it("clears all registered timers on stop", () => {
      vi.useFakeTimers();

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      scheduler.registerAgent("agent-002", { heartbeatIntervalMs: 10000 });

      expect(scheduler.getRegisteredAgents()).toHaveLength(2);

      scheduler.stop();
      expect(scheduler.getRegisteredAgents()).toHaveLength(0);

      vi.advanceTimersByTime(20000);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ── FN-2289 Regression: Idle-state timer persistence ─────────────────────────────────────
  // These tests verify the fix for the defect where agent timers were unintentionally cleared
  // when agents transitioned to "idle" state. The isTickableState() function must include "idle"
  // as a valid state so that timers remain armed for agents between tasks.
  describe("FN-2289: idle-state timer persistence", () => {
    let eventStore: EventEmitter & {
      getAgent: ReturnType<typeof vi.fn>;
      getActiveHeartbeatRun: ReturnType<typeof vi.fn>;
      getBudgetStatus: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useFakeTimers();

      eventStore = Object.assign(new EventEmitter(), {
        getAgent: vi.fn().mockImplementation((agentId: string) => ({
          id: agentId,
          name: `Agent ${agentId}`,
          role: "executor" as const,
          state: "active" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
        })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      });

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
    });

    afterEach(() => {
      scheduler?.stop();
      vi.useRealTimers();
    });

    it("timer remains armed when agent transitions to idle state (regression test for FN-2289)", async () => {
      // Register agent with active state
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Simulate agent transitioning to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const, // Agent is now idle
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be registered
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Timer should fire for idle agent
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("timer fires correctly for idle agent at scheduled interval", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update agent to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be armed
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time and verify multiple fires
      await vi.advanceTimersByTimeAsync(30000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("timer fires for agent transitioning from idle back to active", async () => {
      // Start with idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Timer should be armed even for idle agent
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time - timer should fire
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("idle agent receives timer trigger with correct context", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 15000 });

      // Update to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      await vi.advanceTimersByTimeAsync(15000);

      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 15000,
      }));
    });

    it("timer is still armed after multiple idle state transitions", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });

      // First transition to idle
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Second transition (still idle, but emit update)
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Third transition back to active
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "active", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be registered through all transitions
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Timer should fire
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer fires for running agent (pre-existing behavior)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Update to running state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "running" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "running", metadata: {} } as import("@fusion/core").Agent);

      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer is unregistered when agent becomes paused (should clear timer)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to paused state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "paused" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "paused", metadata: {} } as import("@fusion/core").Agent);

      // Timer should be cleared for paused agents
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("timer remains registered when agent becomes recoverable error state", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to a recoverable durable error state.
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "error" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastError: "socket hang up",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "error", lastError: "socket hang up", metadata: {} } as import("@fusion/core").Agent);

      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 5000 }));
    });

    it("timer is unregistered when agent becomes paused state (should clear timer)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to paused state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "paused" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "paused", metadata: {} } as import("@fusion/core").Agent);

      // Timer should be cleared for paused agents
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── FN-2289 Regression: Multiplier stability across re-registration ─────────────────────
  describe("FN-2289: multiplier stability across re-registration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      scheduler?.stop();
      vi.useRealTimers();
    });

    it("multiplier-adjusted interval remains stable when re-registering", async () => {
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.5 }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      // First registration with multiplier 0.5 -> effective interval 5000ms
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await vi.advanceTimersByTimeAsync(100); // Allow pending async operations to complete

      // Re-register (simulating settings change or config update)
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await vi.advanceTimersByTimeAsync(100);

      // Timer should still fire at the multiplied interval (5000ms)
      // The timer was set up immediately, so we need to ensure we advance past 5000ms total
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("async multiplier registration does not stale-overwrite newer registration", async () => {
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 2.0 }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      // Register with multiplier 2.0 -> effective interval 20000ms
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await Promise.resolve();

      // Immediately re-register before async multiplier completes
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });

      // Timer should still be registered
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time past the original interval (10s) but before multiplied (20s)
      // If stale-overwrite happens, callback would be called at 10s instead of 20s
      await vi.advanceTimersByTimeAsync(15000);
      expect(callback).not.toHaveBeenCalled();

      // Timer should fire at 20s (correct multiplied interval)
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe("assignment watching", () => {
    let eventStore: EventEmitter & {
      getAgent: ReturnType<typeof vi.fn>;
      getActiveHeartbeatRun: ReturnType<typeof vi.fn>;
      getBudgetStatus: ReturnType<typeof vi.fn>;
      getRecentRuns: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useRealTimers(); // Ensure real timers for these tests

      eventStore = Object.assign(new EventEmitter(), {
        getAgent: vi.fn().mockResolvedValue({ id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} }),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockRejectedValue(new Error("budget status unavailable")),
        getRecentRuns: vi.fn().mockResolvedValue([]),
      });

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
    }, 30000);

    afterEach(() => {
      scheduler?.stop();
    });

    it("triggers callback on agent:assigned event", async () => {
      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {}, taskId: "FN-001" } as import("@fusion/core").Agent;

      eventStore.emit("agent:assigned", agent, "FN-001");

      // Allow asynchronous assignment listeners to run in heavily loaded test environments.
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", {
        taskId: "FN-001",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
      });
    });

    it("does NOT trigger when stopped", async () => {
      scheduler.stop();

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-002");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips trigger when agent heartbeat is disabled", async () => {
      const agent: import("@fusion/core").Agent = {
        id: "agent-test",
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        metadata: {},
        runtimeConfig: { enabled: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      eventStore.emit("agent:assigned", agent, "FN-1661");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
      expect(eventStore.getActiveHeartbeatRun).not.toHaveBeenCalled();
    });

    // Regression surface checklist for deferred assignments:
    // - active-run assignment skip records pending work; no-active-run control remains immediate
    // - run-completion drain re-fires once, latest rapid re-assignment wins
    // - transient global/engine pause, new active run, and parallel-execution guards preserve pending work
    // - terminal missing/disabled/budget-exhausted states and unregister clear pending work
    // - skipHeartbeatWhenIdle/long timer stalls are avoided because drain is completion-driven, not timer-driven
    it("defers an active-run assignment and re-fires it exactly once on drain", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-001");

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callback).not.toHaveBeenCalled();

      await scheduler.drainPendingAssignment("agent-test");

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({
        taskId: "FN-001",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
      }));

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).toHaveBeenCalledOnce();
    });

    it("does not record pending work when assignment fires immediately", async () => {
      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-002");

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      callback.mockClear();
      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();
    });

    it("keeps only the latest task when assignments are repeated during an active run", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-OLD");
      eventStore.emit("agent:assigned", agent, "FN-LATEST");

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callback).not.toHaveBeenCalled();

      await scheduler.drainPendingAssignment("agent-test");

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({ taskId: "FN-LATEST" }));
    });

    it.each([
      ["globalPause", { globalPause: true }],
      ["enginePaused", { enginePaused: true }],
    ])("preserves pending assignment while %s blocks drain", async (_name, settings) => {
      scheduler.stop();
      const pausedTaskStore = { getSettings: vi.fn().mockResolvedValue(settings) } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback, pausedTaskStore);
      scheduler.start();
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-PAUSED");
      await new Promise((resolve) => setTimeout(resolve, 10));

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();

      (pausedTaskStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({ taskId: "FN-PAUSED" }));
    });

    it("preserves pending assignment when a new active run exists at drain time", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValueOnce({ id: "run-new", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-ACTIVE");
      await new Promise((resolve) => setTimeout(resolve, 10));

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({ taskId: "FN-ACTIVE" }));
    });

    it.each([
      ["missing agent", async () => {
        eventStore.getAgent.mockResolvedValue(null);
      }],
      ["disabled agent", async () => {
        eventStore.getAgent.mockResolvedValue({ id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {}, runtimeConfig: { enabled: false } });
      }],
      ["budget exhausted", async () => {
        eventStore.getBudgetStatus.mockResolvedValue(createBudgetStatus({
          agentId: "agent-test",
          isOverBudget: true,
          isOverThreshold: true,
          usagePercent: 100,
          budgetLimit: 1000,
          thresholdPercent: 80,
        }));
      }],
    ])("clears pending assignment without re-fire for %s", async (_name, configureTerminal) => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);
      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-CLEAR");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await configureTerminal();

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();

      eventStore.getAgent.mockResolvedValue({ id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} });
      eventStore.getBudgetStatus.mockRejectedValue(new Error("budget status unavailable"));
      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();
    });

    it("preserves pending assignment while parallel execution guard blocks drain", async () => {
      scheduler.stop();
      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback, undefined, {
        isTaskExecuting: (taskId) => taskId === "FN-EXECUTING",
      });
      scheduler.start();
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {}, runtimeConfig: { allowParallelExecution: false } } as import("@fusion/core").Agent;
      eventStore.getAgent.mockResolvedValue(agent);
      eventStore.emit("agent:assigned", agent, "FN-EXECUTING");
      await new Promise((resolve) => setTimeout(resolve, 10));

      await scheduler.drainPendingAssignment("agent-test");
      expect(callback).not.toHaveBeenCalled();
    });

    it("clears pending assignment when unregistering an agent", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "run-active", status: "active" })
        .mockResolvedValue(null);

      const agent = { id: "agent-test", name: "Test", role: "executor", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-UNREGISTER");
      await new Promise((resolve) => setTimeout(resolve, 10));

      scheduler.unregisterAgent("agent-test");
      await scheduler.drainPendingAssignment("agent-test");

      expect(callback).not.toHaveBeenCalled();
    });

    it("blocks assignment trigger when agent is over budget", async () => {
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(
        createBudgetStatus({
          agentId: "agent-test",
          isOverBudget: true,
          isOverThreshold: true,
          usagePercent: 100,
          budgetLimit: 1000,
          thresholdPercent: 80,
        })
      );

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it("allows assignment trigger when agent is over threshold", async () => {
      const budgetStatus = createBudgetStatus({
        agentId: "agent-test",
        budgetLimit: 1000,
        usagePercent: 85,
        thresholdPercent: 80,
        isOverBudget: false,
        isOverThreshold: true,
      });
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(budgetStatus);

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", {
        taskId: "FN-003",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
        budgetStatus,
      });
    });

    it("passes budgetStatus in WakeContext for assignment triggers", async () => {
      const budgetStatus = createBudgetStatus({
        agentId: "agent-test",
        budgetLimit: 1000,
        usagePercent: 45,
        thresholdPercent: 80,
      });
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(budgetStatus);

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-005");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledWith(
        "agent-test",
        "assignment",
        expect.objectContaining({
          taskId: "FN-005",
          budgetStatus,
        }),
      );
    });

    it("includes new steering comment IDs for assignment wakes when taskStore is available", async () => {
      scheduler.stop();

      (eventStore as any).getRecentRuns = vi.fn().mockResolvedValue([
        { startedAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const assignmentTaskStore = {
        getTask: vi.fn().mockResolvedValue({
          id: "FN-006",
          steeringComments: [
            { id: "steer-old", text: "older", author: "user", createdAt: "2025-12-31T23:00:00.000Z" },
            { id: "steer-new", text: "new guidance", author: "user", createdAt: "2026-01-01T01:00:00.000Z" },
          ],
        }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback, assignmentTaskStore);
      scheduler.start();

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-006");

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({
        taskId: "FN-006",
        triggeringCommentIds: ["steer-new"],
        triggeringCommentType: "steering",
      }));
    });

    it("cleans up listener on unwatch", async () => {
      scheduler.unwatchAssignments();

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-004");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("Run context propagation", () => {
    it("createHeartbeatTools passes runContext to taskStore.logEntry", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-NEW", description: "New task" }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const runContext = { runId: "run-123", agentId: "agent-456", source: "timer" };

      // Create tools with run context
      const tools = monitor.createHeartbeatTools("agent-456", mockTaskStore, "FN-001", runContext);

      // Find the fn_task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "fn_task_log");
      expect(taskLogTool).toBeDefined();

      const result = await taskLogTool!.execute("call-1", { message: "Test log entry", outcome: undefined }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called with runContext
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Test log entry",
        undefined,
        runContext,
      );
    });

    it("createHeartbeatTools tracks task creations with runContext", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-200", description: "New task created", dependencies: [] }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const runContext = { runId: "run-789", agentId: "agent-abc", source: "on_demand" };

      // Create tools with run context
      const tools = monitor.createHeartbeatTools("agent-abc", mockTaskStore, "FN-001", runContext);

      // Find the fn_task_create tool and execute it
      const taskCreateTool = tools.find(t => t.name === "fn_task_create");
      expect(taskCreateTool).toBeDefined();

      const result = await taskCreateTool!.execute("call-1", { description: "New task created" }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called with runContext for the created task
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-200",
        "Created by agent agent-abc during heartbeat run",
        undefined,
        runContext,
      );
    });

    it("createHeartbeatTools works without runContext (backward compat)", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-NEW", description: "New task" }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      // Create tools without run context
      const tools = monitor.createHeartbeatTools("agent-456", mockTaskStore, "FN-001");

      // Find the fn_task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "fn_task_log");
      expect(taskLogTool).toBeDefined();

      const result = await taskLogTool!.execute("call-1", { message: "Test log entry", outcome: undefined }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called without runContext
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Test log entry",
        undefined,
        undefined,
      );
    });
  });

  describe("allowParallelExecution gate", () => {
    function makeAgentWithConfig(overrides: Record<string, unknown> = {}) {
      return {
        id: "agent-par",
        name: "Parallel Agent",
        role: "executor",
        state: "active",
        taskId: "FN-TASK-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
        runtimeConfig: overrides,
      };
    }

    it("timer tick skips when allowParallelExecution=false and task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: false })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).not.toHaveBeenCalled();
      expect(isTaskExecuting).toHaveBeenCalledWith("FN-TASK-1");
    });

    it("timer tick fires when allowParallelExecution=false and task is NOT executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(false);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: false })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer tick fires when allowParallelExecution=true even while task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: true })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer tick fires when allowParallelExecution is unset (default) even while task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({})),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe("skipHeartbeatWhenIdle gate", () => {
    function makeAgentWithConfig(overrides: Record<string, unknown> = {}, taskId?: string) {
      return {
        id: "agent-idle",
        name: "Idle Agent",
        role: "executor",
        state: "active",
        taskId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
        runtimeConfig: overrides,
      };
    }

    it("timer tick is skipped when skipHeartbeatWhenIdle=true and no task is assigned", async () => {
      vi.useFakeTimers();

      const idleStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ skipHeartbeatWhenIdle: true })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(idleStore, callback);
      scheduler.start();
      scheduler.registerAgent("agent-idle", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).not.toHaveBeenCalled();
      expect(scheduler.getRegisteredAgents()).toContain("agent-idle");
    });

    it("timer tick fires when skipHeartbeatWhenIdle=true and task is assigned", async () => {
      vi.useFakeTimers();

      const idleStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ skipHeartbeatWhenIdle: true }, "FN-TASK-7")),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(idleStore, callback);
      scheduler.start();
      scheduler.registerAgent("agent-idle", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it.each([
      [undefined, undefined],
      [{}, undefined],
      [{ skipHeartbeatWhenIdle: false }, undefined],
    ])("timer tick fires by default when config=%p taskId=%p", async (runtimeConfig, taskId) => {
      vi.useFakeTimers();

      const idleStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig((runtimeConfig ?? {}) as Record<string, unknown>, taskId as string | undefined)),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(idleStore, callback);
      scheduler.start();
      scheduler.registerAgent("agent-idle", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("assignment trigger still fires when skipHeartbeatWhenIdle=true", async () => {
      vi.useRealTimers();
      const eventStore = Object.assign(new EventEmitter(), {
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockRejectedValue(new Error("budget status unavailable")),
        getRecentRuns: vi.fn().mockResolvedValue([]),
      });

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();

      const agent = makeAgentWithConfig({ skipHeartbeatWhenIdle: true }) as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-123");

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      expect(callback).toHaveBeenCalledWith("agent-idle", "assignment", {
        taskId: "FN-123",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
      });
    });
  });
});

