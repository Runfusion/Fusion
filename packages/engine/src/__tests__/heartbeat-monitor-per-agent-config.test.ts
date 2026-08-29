import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HeartbeatMonitor,
} from "../agent-heartbeat.js";
import type { AgentStore, TaskStore } from "@fusion/core";
import { createMockStore, createMockSession } from "./heartbeat-test-helpers.js";
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
import { heartbeatLog } from "../logger.js";

let store: AgentStore;
let monitor: HeartbeatMonitor;

beforeEach(() => {
  store = createMockStore();
  monitor = new HeartbeatMonitor({ store });
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

describe("per-agent heartbeat config", () => {
  /** Create a mock store that returns a specific agent from getCachedAgent */
  function createStoreWithAgent(agent: { id: string; runtimeConfig?: Record<string, unknown> }): AgentStore {
    return {
      recordHeartbeat: vi.fn().mockResolvedValue(undefined),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockResolvedValue({ ...agent, state: "running" }),
      getCachedAgent: vi.fn().mockReturnValue(agent),
    } as unknown as AgentStore;
  }

  describe("getAgentHeartbeatConfig", () => {
    it("returns monitor defaults when agentStore is not provided", async () => {
      const monitor = new HeartbeatMonitor({
        store,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
        maxConcurrentRuns: 2,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.heartbeatTimeoutMs).toBe(10000);
      expect(config.maxConcurrentRuns).toBe(2);
    });

    it("returns monitor defaults when agent has no runtimeConfig", async () => {
      const agentStore = createStoreWithAgent({ id: "agent-001" });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.heartbeatTimeoutMs).toBe(10000);
    });

    it("returns per-agent values when runtimeConfig is set", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: {
          heartbeatIntervalMs: 2000,
          heartbeatTimeoutMs: 30000,
          maxConcurrentRuns: 3,
        },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
        maxConcurrentRuns: 1,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(2000);
      expect(config.heartbeatTimeoutMs).toBe(30000);
      expect(config.maxConcurrentRuns).toBe(3);
    });

    it("clamps heartbeatIntervalMs to minimum of 1000", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatIntervalMs: 100 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(1000);
    });

    it("clamps heartbeatTimeoutMs to minimum of 5000", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 1000 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        heartbeatTimeoutMs: 60000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.heartbeatTimeoutMs).toBe(5000);
    });

    it("clamps maxConcurrentRuns to minimum of 1", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { maxConcurrentRuns: 0 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        maxConcurrentRuns: 1,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.maxConcurrentRuns).toBe(1);
    });

    it("falls back to monitor defaults when runtimeConfig values are NaN", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: {
          heartbeatIntervalMs: NaN,
          heartbeatTimeoutMs: "not a number" as any,
        },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.heartbeatTimeoutMs).toBe(10000);
    });

    it("falls back to monitor defaults when agent is not found", async () => {
      const agentStore = createStoreWithAgent({ id: "agent-001" });
      vi.mocked(agentStore.getAgent).mockResolvedValue(null);

      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-999");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.heartbeatTimeoutMs).toBe(10000);
    });

    it("returns monitor defaults when getAgent throws", async () => {
      const agentStore = createStoreWithAgent({ id: "agent-001" });
      vi.mocked(agentStore.getAgent).mockRejectedValue(new Error("Read error"));

      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 10000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(5000);
      expect(config.heartbeatTimeoutMs).toBe(10000);
    });

    it("returns partial overrides when only some runtimeConfig keys are set", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 120000 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 5000,
        heartbeatTimeoutMs: 60000,
        maxConcurrentRuns: 1,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(5000); // fallback
      expect(config.heartbeatTimeoutMs).toBe(120000); // overridden
      expect(config.maxConcurrentRuns).toBe(1); // fallback
    });

    it("applies project heartbeatMultiplier to pollIntervalMs and heartbeatTimeoutMs", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.5 }),
        } as unknown as TaskStore,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(30_000);
      expect(config.heartbeatTimeoutMs).toBe(15_000);
    });

    it("doubles pollIntervalMs and heartbeatTimeoutMs with multiplier 2", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 10_000 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 2 }),
        } as unknown as TaskStore,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(40_000);
      expect(config.heartbeatTimeoutMs).toBe(20_000);
    });

    it("clamps multiplied intervals to minimum floors", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatIntervalMs: 2000, heartbeatTimeoutMs: 10_000 },
      });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.1 }),
        } as unknown as TaskStore,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(1000);
      expect(config.heartbeatTimeoutMs).toBe(5000);
    });

    it("falls back to unscaled per-agent values when settings lookup fails", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 },
      });
      const warnSpy = vi.spyOn(heartbeatLog, "warn").mockImplementation(() => {});
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockRejectedValue(new Error("boom")),
        } as unknown as TaskStore,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.pollIntervalMs).toBe(60_000);
      expect(config.heartbeatTimeoutMs).toBe(30_000);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("isAgentHealthy with per-agent config", () => {
    it("uses per-agent timeout for health check", () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 30000 },
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        heartbeatTimeoutMs: 5000, // Global default is 5000
      });
      monitor.trackAgent("agent-001", session, "run-001");

      // Advance 10s — past the global 5s default, but within the per-agent 30s
      vi.advanceTimersByTime(10000);
      expect(monitor.isAgentHealthy("agent-001")).toBe(true);

      // Advance past per-agent 30s timeout
      vi.advanceTimersByTime(25000);
      expect(monitor.isAgentHealthy("agent-001")).toBe(false);

      vi.useRealTimers();
    });

    it("uses cached multiplier for sync health checks after async config resolve", async () => {
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 10_000 },
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 2 }),
        } as unknown as TaskStore,
      });
      monitor.trackAgent("agent-001", session, "run-001");

      await monitor.getAgentHeartbeatConfig("agent-001");

      vi.advanceTimersByTime(15_000);
      expect(monitor.isAgentHealthy("agent-001")).toBe(true);

      vi.advanceTimersByTime(6_000);
      expect(monitor.isAgentHealthy("agent-001")).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("checkMissedHeartbeats with per-agent config", () => {
    it("detects missed heartbeat using per-agent timeout", async () => {
      const onMissed = vi.fn();
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 10000 },
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const monitor = new HeartbeatMonitor({
        store,
        agentStore,
        pollIntervalMs: 1000,
        heartbeatTimeoutMs: 5000, // Global default 5s — agent overrides to 10s
        onMissed,
      });
      monitor.start();
      monitor.trackAgent("agent-001", session, "run-001");

      // Advance 6s — past global 5s but within per-agent 10s
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      // Should NOT have triggered onMissed because per-agent timeout is 10s
      expect(onMissed).not.toHaveBeenCalled();

      // Advance past the 10s per-agent timeout
      vi.advanceTimersByTime(5000);
      await vi.advanceTimersByTimeAsync(100);

      expect(onMissed).toHaveBeenCalledWith("agent-001", expect.any(String));

      monitor.stop();
      vi.useRealTimers();
    });

    it("recovers unresponsive agent using per-agent timeout", async () => {
      const onTerminated = vi.fn();
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 5000 },
      });
      const runtimeStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { enabled: false },
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const monitor = new HeartbeatMonitor({
        store: runtimeStore,
        agentStore,
        pollIntervalMs: 1000,
        heartbeatTimeoutMs: 60000, // Global default 60s — agent overrides to 5s
        onTerminated,
      });
      monitor.start();
      monitor.trackAgent("agent-001", session, "run-001");

      // Wait for missed (5s) + termination at 2x timeout (10s)
      vi.advanceTimersByTime(12000);
      await vi.advanceTimersByTimeAsync(100);

      expect(session.dispose).toHaveBeenCalled();
      expect(runtimeStore.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(runtimeStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      expect(onTerminated).not.toHaveBeenCalled();

      monitor.stop();
      vi.useRealTimers();
    });
  });

  describe("reconcileOrphanedRunningAgents with multiplier cache", () => {
    it("uses scaled timeout x3 after cache is warmed", async () => {
      const nowIso = new Date().toISOString();
      const staleIso = new Date(Date.now() - 50_000).toISOString();
      const runningAgent = {
        id: "agent-001",
        name: "Agent",
        role: "engineer",
        state: "running",
        createdAt: nowIso,
        updatedAt: nowIso,
        lastHeartbeatAt: staleIso,
        runtimeConfig: { heartbeatTimeoutMs: 10_000 },
      };
      const monitorStore = {
        listAgents: vi.fn().mockResolvedValue([runningAgent]),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue({ id: "run-001", status: "running" }),
        getRunDetail: vi.fn().mockResolvedValue({ id: "run-001", status: "running" }),
        saveRun: vi.fn().mockResolvedValue(undefined),
        endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentStore;
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 10_000 },
      });
      const monitor = new HeartbeatMonitor({
        store: monitorStore,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 2 }),
        } as unknown as TaskStore,
      });

      await monitor.getAgentHeartbeatConfig("agent-001");
      await (monitor as any).reconcileOrphanedRunningAgents();

      expect((monitorStore.endHeartbeatRun as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((monitorStore.updateAgentState as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  describe("backward compatibility", () => {
    it("keeps missed and unresponsive thresholds unchanged when multiplier is 1", async () => {
      const onMissed = vi.fn();
      const runtimeStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { enabled: false },
      });
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 5000 },
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const monitor = new HeartbeatMonitor({
        store: runtimeStore,
        agentStore,
        pollIntervalMs: 1000,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
        } as unknown as TaskStore,
        onMissed,
      });
      monitor.start();
      monitor.trackAgent("agent-001", session, "run-001");

      vi.advanceTimersByTime(4000);
      await vi.advanceTimersByTimeAsync(100);
      expect(onMissed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1500);
      await vi.advanceTimersByTimeAsync(100);
      expect(onMissed).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      await vi.advanceTimersByTimeAsync(100);
      expect(session.dispose).toHaveBeenCalledTimes(1);

      monitor.stop();
      vi.useRealTimers();
    });

    it("keeps orphan reconcile 3x timeout window unchanged when multiplier is unset", async () => {
      const nowIso = new Date().toISOString();
      const staleIso = new Date(Date.now() - 31_000).toISOString();
      const runningAgent = {
        id: "agent-001",
        name: "Agent",
        role: "engineer",
        state: "running",
        createdAt: nowIso,
        updatedAt: nowIso,
        lastHeartbeatAt: staleIso,
        runtimeConfig: { heartbeatTimeoutMs: 10_000 },
      };
      const monitorStore = {
        listAgents: vi.fn().mockResolvedValue([runningAgent]),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue({ id: "run-001", status: "running" }),
        getRunDetail: vi.fn().mockResolvedValue({ id: "run-001", status: "running" }),
        saveRun: vi.fn().mockResolvedValue(undefined),
        endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentStore;
      const agentStore = createStoreWithAgent({
        id: "agent-001",
        runtimeConfig: { heartbeatTimeoutMs: 10_000 },
      });
      const monitor = new HeartbeatMonitor({
        store: monitorStore,
        agentStore,
        taskStore: {
          getSettings: vi.fn().mockResolvedValue({}),
        } as unknown as TaskStore,
      });

      await monitor.getAgentHeartbeatConfig("agent-001");
      await (monitor as any).reconcileOrphanedRunningAgents();

      expect((monitorStore.endHeartbeatRun as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((monitorStore.updateAgentState as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("agent-001", "active");
    });

    it("works without agentStore (no per-agent config)", async () => {
      const monitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
      });

      const config = await monitor.getAgentHeartbeatConfig("agent-001");
      expect(config.heartbeatTimeoutMs).toBe(5000);
      expect(config.pollIntervalMs).toBe(3_600_000); // default
      expect(config.maxConcurrentRuns).toBe(1); // default
    });

    it("existing isAgentHealthy works without per-agent config", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const monitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
      });
      monitor.trackAgent("agent-001", session, "run-001");
      expect(monitor.isAgentHealthy("agent-001")).toBe(true);

      vi.advanceTimersByTime(6000);
      expect(monitor.isAgentHealthy("agent-001")).toBe(false);

      vi.useRealTimers();
    });
  });
});

// ── Heartbeat Execution Tests ──────────────────────────────────────────
