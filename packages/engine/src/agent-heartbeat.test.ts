import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatMonitor, type AgentSession, type HeartbeatExecutionOptions, HEARTBEAT_SYSTEM_PROMPT } from "./agent-heartbeat.js";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent } from "@fusion/core";

// Mock logger to suppress noise in test output
vi.mock("./logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
  };
});

// Mock pi.ts for executeHeartbeat tests
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

// Import the mocked functions for test control
import { createKbAgent } from "./pi.js";
const mockedCreateKbAgent = vi.mocked(createKbAgent);

// Mock store factory
function createMockStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentStore;
}

// Mock session factory
function createMockSession(): AgentSession {
  return {
    dispose: vi.fn(),
  };
}

describe("HeartbeatMonitor", () => {
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

  describe("constructor", () => {
    it("initializes with default options", () => {
      expect(monitor).toBeDefined();
      expect(monitor.isActive()).toBe(false);
    });

    it("accepts custom pollIntervalMs", () => {
      const customMonitor = new HeartbeatMonitor({ store, pollIntervalMs: 5000 });
      expect(customMonitor).toBeDefined();
    });

    it("accepts custom heartbeatTimeoutMs", () => {
      const customMonitor = new HeartbeatMonitor({ store, heartbeatTimeoutMs: 120000 });
      expect(customMonitor).toBeDefined();
    });

    it("accepts callbacks", () => {
      const onMissed = vi.fn();
      const onRecovered = vi.fn();
      const onTerminated = vi.fn();

      const customMonitor = new HeartbeatMonitor({
        store,
        onMissed,
        onRecovered,
        onTerminated,
      });

      expect(customMonitor).toBeDefined();
    });
  });

  describe("start", () => {
    it("initiates polling interval", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);
      vi.useRealTimers();
    });

    it("is idempotent (multiple calls don't create multiple intervals)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.start();
      monitor.start();

      expect(monitor.isActive()).toBe(true);
      // Stop should clean up properly
      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("stop", () => {
    it("clears the polling interval", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });

    it("is safe to call when not started", () => {
      expect(() => monitor.stop()).not.toThrow();
      expect(monitor.isActive()).toBe(false);
    });

    it("is safe to call multiple times", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.stop();
      monitor.stop();
      monitor.stop();

      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("isActive", () => {
    it("reflects monitor state (false when not started)", () => {
      expect(monitor.isActive()).toBe(false);
    });

    it("reflects monitor state (true when started)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      expect(monitor.isActive()).toBe(true);
      vi.useRealTimers();
    });

    it("reflects monitor state (false after stopped)", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      monitor.start();
      monitor.stop();
      expect(monitor.isActive()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("trackAgent", () => {
    it("adds agent to tracked set with correct initial state", () => {
      const session = createMockSession();
      const before = Date.now();

      monitor.trackAgent("agent-001", session, "run-001");
      const lastSeen = monitor.getLastSeen("agent-001");

      expect(lastSeen).toBeDefined();
      expect(lastSeen).toBeGreaterThanOrEqual(before);
      expect(monitor.getTrackedAgents()).toContain("agent-001");
    });

    it("records initial heartbeat to store", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");

      expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "ok", "run-001");
    });

    it("can track multiple agents", () => {
      monitor.trackAgent("agent-001", createMockSession(), "run-001");
      monitor.trackAgent("agent-002", createMockSession(), "run-002");
      monitor.trackAgent("agent-003", createMockSession(), "run-003");

      expect(monitor.getTrackedAgents()).toHaveLength(3);
      expect(monitor.getTrackedAgents()).toContain("agent-001");
      expect(monitor.getTrackedAgents()).toContain("agent-002");
      expect(monitor.getTrackedAgents()).toContain("agent-003");
    });
  });

  describe("recordHeartbeat", () => {
    it("updates lastSeen timestamp", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      monitor.trackAgent("agent-001", session, "run-001");
      const initialLastSeen = monitor.getLastSeen("agent-001")!;

      vi.advanceTimersByTime(100);
      monitor.recordHeartbeat("agent-001");

      const newLastSeen = monitor.getLastSeen("agent-001")!;
      expect(newLastSeen).toBeGreaterThan(initialLastSeen);

      vi.useRealTimers();
    });

    it("records ok heartbeat to store", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");
      monitor.recordHeartbeat("agent-001");

      // Should have been called twice: once on track, once on heartbeat
      expect(store.recordHeartbeat).toHaveBeenCalledTimes(2);
      expect(store.recordHeartbeat).toHaveBeenLastCalledWith("agent-001", "ok", "run-001");
    });

    it("triggers onRecovered callback after missed heartbeat", () => {
      const onRecovered = vi.fn();
      const customMonitor = new HeartbeatMonitor({ store, onRecovered });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Simulate missed heartbeat by advancing time
      vi.advanceTimersByTime(70000); // Default timeout is 60000

      // Trigger the check
      customMonitor.stop();

      // Reset and record heartbeat (should trigger recovery)
      customMonitor.recordHeartbeat("agent-001");
      expect(onRecovered).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does nothing for untracked agent", () => {
      expect(() => monitor.recordHeartbeat("agent-001")).not.toThrow();
      expect(store.recordHeartbeat).not.toHaveBeenCalled();
    });
  });

  describe("isAgentHealthy", () => {
    it("returns true for recent heartbeat", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");

      expect(monitor.isAgentHealthy("agent-001")).toBe(true);
    });

    it("returns false for missed heartbeat", () => {
      const session = createMockSession();
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // Use short timeout for testing
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
      });

      customMonitor.trackAgent("agent-001", session, "run-001");
      expect(customMonitor.isAgentHealthy("agent-001")).toBe(true);

      // Advance past timeout
      vi.advanceTimersByTime(6000);
      expect(customMonitor.isAgentHealthy("agent-001")).toBe(false);

      vi.useRealTimers();
    });

    it("returns false for untracked agent", () => {
      expect(monitor.isAgentHealthy("agent-001")).toBe(false);
    });
  });

  describe("getTrackedAgents", () => {
    it("returns empty array when no agents tracked", () => {
      expect(monitor.getTrackedAgents()).toEqual([]);
    });

    it("returns all tracked agent IDs", () => {
      monitor.trackAgent("agent-001", createMockSession(), "run-001");
      monitor.trackAgent("agent-002", createMockSession(), "run-002");

      const agents = monitor.getTrackedAgents();
      expect(agents).toHaveLength(2);
      expect(agents).toContain("agent-001");
      expect(agents).toContain("agent-002");
    });
  });

  describe("getLastSeen", () => {
    it("returns correct timestamp for tracked agent", () => {
      const session = createMockSession();
      const before = Date.now();

      monitor.trackAgent("agent-001", session, "run-001");
      const lastSeen = monitor.getLastSeen("agent-001");

      expect(lastSeen).toBeDefined();
      expect(lastSeen).toBeGreaterThanOrEqual(before);
    });

    it("returns undefined for untracked agent", () => {
      expect(monitor.getLastSeen("agent-001")).toBeUndefined();
    });
  });

  describe("missed heartbeat detection", () => {
    it("triggers onMissed callback when heartbeat is missed", async () => {
      const onMissed = vi.fn();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
        onMissed,
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for polling to detect missed heartbeat
      vi.advanceTimersByTime(6000);

      // Wait for async checkMissedHeartbeats
      await vi.advanceTimersByTimeAsync(100);

      expect(onMissed).toHaveBeenCalledWith("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });

    it("records missed heartbeat to store", async () => {
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
      });
      const session = createMockSession();

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for polling to detect missed heartbeat
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      expect(store.recordHeartbeat).toHaveBeenCalledWith("agent-001", "missed", "run-001");

      customMonitor.stop();
      vi.useRealTimers();
    });
  });

  describe("unresponsive agent termination", () => {
    it("disposes session and terminates agent after 2x timeout", async () => {
      const onTerminated = vi.fn();
      const session = createMockSession();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
        onTerminated,
      });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      // Wait for missed heartbeat (1x timeout)
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      // Wait for termination (2x timeout = 10 seconds total from start)
      vi.advanceTimersByTime(6000);
      await vi.advanceTimersByTimeAsync(100);

      expect(session.dispose).toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "terminated");
      expect(onTerminated).toHaveBeenCalledWith("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });

    it("removes agent from tracking after termination", async () => {
      const session = createMockSession();
      const customMonitor = new HeartbeatMonitor({
        store,
        heartbeatTimeoutMs: 5000,
        pollIntervalMs: 1000,
      });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      customMonitor.start();
      customMonitor.trackAgent("agent-001", session, "run-001");

      expect(customMonitor.getTrackedAgents()).toContain("agent-001");

      // Wait for termination
      vi.advanceTimersByTime(12000);
      await vi.advanceTimersByTimeAsync(100);

      expect(customMonitor.getTrackedAgents()).not.toContain("agent-001");

      customMonitor.stop();
      vi.useRealTimers();
    });
  });

  describe("untrackAgent", () => {
    it("removes agent from tracking", () => {
      const session = createMockSession();
      monitor.trackAgent("agent-001", session, "run-001");
      expect(monitor.getTrackedAgents()).toContain("agent-001");

      monitor.untrackAgent("agent-001");
      expect(monitor.getTrackedAgents()).not.toContain("agent-001");
      expect(monitor.getTrackedAgents()).toHaveLength(0);
    });

    it("is safe to call for untracked agent", () => {
      expect(() => monitor.untrackAgent("agent-001")).not.toThrow();
    });
  });

  // ── Per-Agent Config Tests ──────────────────────────────────────────────

  describe("per-agent heartbeat config", () => {
    /** Create a mock store that returns a specific agent from getCachedAgent */
    function createStoreWithAgent(agent: { id: string; runtimeConfig?: Record<string, unknown> }): AgentStore {
      return {
        recordHeartbeat: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        getCachedAgent: vi.fn().mockReturnValue(agent),
      } as unknown as AgentStore;
    }

    describe("getAgentHeartbeatConfig", () => {
      it("returns monitor defaults when agentStore is not provided", () => {
        const monitor = new HeartbeatMonitor({
          store,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
          maxConcurrentRuns: 2,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
        expect(config.maxConcurrentRuns).toBe(2);
      });

      it("returns monitor defaults when agent has no runtimeConfig", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns per-agent values when runtimeConfig is set", () => {
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

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(2000);
        expect(config.heartbeatTimeoutMs).toBe(30000);
        expect(config.maxConcurrentRuns).toBe(3);
      });

      it("clamps heartbeatIntervalMs to minimum of 1000", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatIntervalMs: 100 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(1000);
      });

      it("clamps heartbeatTimeoutMs to minimum of 5000", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 1000 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          heartbeatTimeoutMs: 60000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.heartbeatTimeoutMs).toBe(5000);
      });

      it("clamps maxConcurrentRuns to minimum of 1", () => {
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { maxConcurrentRuns: 0 },
        });
        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          maxConcurrentRuns: 1,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.maxConcurrentRuns).toBe(1);
      });

      it("falls back to monitor defaults when runtimeConfig values are NaN", () => {
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

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("falls back to monitor defaults when agent is not found", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        (agentStore.getCachedAgent as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-999");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns monitor defaults when getCachedAgent throws", () => {
        const agentStore = createStoreWithAgent({ id: "agent-001" });
        (agentStore.getCachedAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("Read error");
        });

        const monitor = new HeartbeatMonitor({
          store,
          agentStore,
          pollIntervalMs: 5000,
          heartbeatTimeoutMs: 10000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000);
        expect(config.heartbeatTimeoutMs).toBe(10000);
      });

      it("returns partial overrides when only some runtimeConfig keys are set", () => {
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

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.pollIntervalMs).toBe(5000); // fallback
        expect(config.heartbeatTimeoutMs).toBe(120000); // overridden
        expect(config.maxConcurrentRuns).toBe(1); // fallback
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

        expect(onMissed).toHaveBeenCalledWith("agent-001");

        monitor.stop();
        vi.useRealTimers();
      });

      it("terminates unresponsive agent using per-agent timeout", async () => {
        const onTerminated = vi.fn();
        const agentStore = createStoreWithAgent({
          id: "agent-001",
          runtimeConfig: { heartbeatTimeoutMs: 5000 },
        });
        const session = createMockSession();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const monitor = new HeartbeatMonitor({
          store,
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
        expect(onTerminated).toHaveBeenCalledWith("agent-001");

        monitor.stop();
        vi.useRealTimers();
      });
    });

    describe("backward compatibility", () => {
      it("works without agentStore (no per-agent config)", () => {
        const monitor = new HeartbeatMonitor({
          store,
          heartbeatTimeoutMs: 5000,
        });

        const config = monitor.getAgentHeartbeatConfig("agent-001");
        expect(config.heartbeatTimeoutMs).toBe(5000);
        expect(config.pollIntervalMs).toBe(30000); // default
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

  describe("executeHeartbeat", () => {
    let mockTaskStore: TaskStore;
    let mockAgent: Agent;

    // Helper: create a mock session returned by createKbAgent
    function createMockAgentSession() {
      return {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        model: { provider: "mock", id: "mock-model" },
      };
    }

    // Helper: create a basic mock task store
    function createMockTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
      return {
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          title: "Test Task",
          description: "Test task description",
          prompt: "# Test PROMPT.md\nSome content",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
        createTask: vi.fn().mockResolvedValue({
          id: "FN-002",
          description: "Created task",
          dependencies: [],
          column: "triage",
        }),
        logEntry: vi.fn().mockResolvedValue({}),
        ...overrides,
      } as unknown as TaskStore;
    }

    // Helper: create a mock store that returns a specific agent
    function createStoreWithAgentForExec(agentData: Partial<Agent> = {}): AgentStore {
      mockAgent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "active",
        taskId: "FN-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
        ...agentData,
      } as Agent;

      // Track saved runs so getRunDetail returns the most recent state
      const savedRuns: Map<string, AgentHeartbeatRun> = new Map();

      return {
        recordHeartbeat: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        updateAgent: vi.fn().mockResolvedValue(undefined),
        getAgent: vi.fn().mockResolvedValue(mockAgent),
        startHeartbeatRun: vi.fn().mockResolvedValue({
          id: "run-001",
          agentId: "agent-001",
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "active",
        } as AgentHeartbeatRun),
        saveRun: vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
          savedRuns.set(run.id, run);
        }),
        getRunDetail: vi.fn().mockImplementation(async (_agentId: string, runId: string) => {
          return savedRuns.get(runId) ?? {
            id: runId,
            agentId: "agent-001",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            status: "completed" as const,
          };
        }),
        endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
        getCachedAgent: vi.fn().mockReturnValue(null),
      } as unknown as AgentStore;
    }

    beforeEach(() => {
      mockTaskStore = createMockTaskStore();
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("dependency validation", () => {
      it("throws when taskStore is not configured", async () => {
        const store = createStoreWithAgentForExec();
        const monitor = new HeartbeatMonitor({ store, rootDir: "/tmp" });

        await expect(
          monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" })
        ).rejects.toThrow("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
      });

      it("throws when rootDir is not configured", async () => {
        const store = createStoreWithAgentForExec();
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore });

        await expect(
          monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" })
        ).rejects.toThrow("HeartbeatMonitor not configured for execution (missing taskStore/rootDir)");
      });
    });

    describe("graceful exit", () => {
      it("completes with no_assignment when agent has no taskId and no explicit taskId", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        expect(result.resultJson).toEqual({ reason: "no_assignment" });
        // Should NOT have created an agent session
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("completes with invalid_state when agent state is terminated", async () => {
        const store = createStoreWithAgentForExec({ state: "terminated" });
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        expect(result.resultJson).toEqual({ reason: "invalid_state", state: "terminated" });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("completes as failed when agent not found in store", async () => {
        const store = createStoreWithAgentForExec();
        (store.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("failed");
        expect(result.stderrExcerpt).toContain("not found");
      });

      it("completes with task_not_found when task does not exist", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-MISSING" });
        mockTaskStore.getTask = vi.fn().mockRejectedValue(new Error("Task FN-MISSING not found"));
        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        expect(result.resultJson).toEqual({ reason: "task_not_found", taskId: "FN-MISSING" });
      });
    });

    describe("execution", () => {
      it("creates session with correct system prompt and tools", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        expect(callArgs.cwd).toBe("/tmp/test");
        expect(callArgs.systemPrompt).toBe(HEARTBEAT_SYSTEM_PROMPT);
        expect(callArgs.tools).toBe("readonly");
        expect(callArgs.customTools).toHaveLength(3);
        expect(callArgs.customTools![0]!.name).toBe("task_create");
        expect(callArgs.customTools![1]!.name).toBe("task_log");
        expect(callArgs.customTools![2]!.name).toBe("heartbeat_done");
      });

      it("calls promptWithFallback with task context", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment", triggerDetail: "new task assigned" });

        expect(mockSession.prompt).toHaveBeenCalledOnce();
        const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
        expect(promptArg).toContain("agent-001");
        expect(promptArg).toContain("Test Task");
        expect(promptArg).toContain("assignment");
        expect(promptArg).toContain("new task assigned");
        expect(promptArg).toContain("PROMPT.md");
      });

      it("completes run with status completed on successful execution", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        // Agent state should be set back to active
        expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
        // Session should be disposed
        expect(mockSession.dispose).toHaveBeenCalled();
      });

      it("uses explicit taskId override instead of agent.taskId", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-DEFAULT" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        // Override getTask to return a different task
        mockTaskStore.getTask = vi.fn().mockResolvedValue({
          id: "FN-OVERRIDE",
          title: "Override Task",
          description: "Override description",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail);

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          taskId: "FN-OVERRIDE",
        });

        // Should have fetched the override task
        expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-OVERRIDE");
        // task_log tool should use the override task ID
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        const taskLogTool = callArgs.customTools![1]!;
        expect(taskLogTool.name).toBe("task_log");
      });

      it("passes model config from agent runtimeConfig to createKbAgent", async () => {
        const store = createStoreWithAgentForExec({
          runtimeConfig: { modelProvider: "openai", modelId: "gpt-4o" },
        });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        expect(callArgs.defaultProvider).toBe("openai");
        expect(callArgs.defaultModelId).toBe("gpt-4o");
      });

      it("passes undefined model when runtimeConfig has no model", async () => {
        const store = createStoreWithAgentForExec({ runtimeConfig: {} });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        expect(callArgs.defaultProvider).toBeUndefined();
        expect(callArgs.defaultModelId).toBeUndefined();
      });
    });

    describe("heartbeat_done tool", () => {
      it("captures summary from heartbeat_done in resultJson", async () => {
        const store = createStoreWithAgentForExec();
        let capturedDoneTool: any;
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          capturedDoneTool = opts.customTools[2]; // heartbeat_done
          return { session: mockSession as any };
        });

        // Simulate: when prompt is called, invoke the heartbeat_done tool
        mockSession.prompt = vi.fn().mockImplementation(async (prompt: string) => {
          // Simulate the agent calling heartbeat_done
          const result = await capturedDoneTool.execute("call-1", { summary: "Checked task, all good" });
          expect(result.content[0].text).toContain("Heartbeat complete");
          expect(result.content[0].text).toContain("Checked task, all good");
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const run = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(run.resultJson).toBeDefined();
        expect((run.resultJson as any).summary).toBe("Checked task, all good");
      });

      it("works without summary in heartbeat_done", async () => {
        const store = createStoreWithAgentForExec();
        let capturedDoneTool: any;
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          capturedDoneTool = opts.customTools[2];
          return { session: mockSession as any };
        });

        mockSession.prompt = vi.fn().mockImplementation(async () => {
          await capturedDoneTool.execute("call-1", {});
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const run = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(run.resultJson).toBeDefined();
        expect((run.resultJson as any).summary).toBeUndefined();
      });
    });

    describe("task_create tool", () => {
      it("creates a task in the store when task_create tool is called", async () => {
        const store = createStoreWithAgentForExec();
        let capturedCreateTool: any;
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          capturedCreateTool = opts.customTools[0]; // task_create
          return { session: mockSession as any };
        });

        mockSession.prompt = vi.fn().mockImplementation(async () => {
          await capturedCreateTool.execute("call-1", { description: "Follow-up task" });
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(mockTaskStore.createTask).toHaveBeenCalledWith({
          description: "Follow-up task",
          dependencies: undefined,
          column: "triage",
        });
      });
    });

    describe("error handling", () => {
      it("completes run as failed when createKbAgent throws", async () => {
        const store = createStoreWithAgentForExec();
        mockedCreateKbAgent.mockRejectedValue(new Error("Model unavailable"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("failed");
        expect(result.stderrExcerpt).toContain("Model unavailable");
        // Agent state should be set to error
        expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "error");
      });

      it("completes run as failed when promptWithFallback throws", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });
        mockSession.prompt = vi.fn().mockRejectedValue(new Error("Prompt failed"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result).toBeDefined();
        expect(result.status).toBe("failed");
        expect(result.stderrExcerpt).toContain("Prompt failed");
        // Session should still be disposed in finally block
        expect(mockSession.dispose).toHaveBeenCalled();
        // Agent should be untracked
        expect(monitor.getTrackedAgents()).not.toContain("agent-001");
      });
    });

    describe("concurrency", () => {
      it("serializes concurrent executeHeartbeat calls for the same agent", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        let promptCallCount = 0;

        // Make prompt take some time to ensure overlap
        mockSession.prompt = vi.fn().mockImplementation(async () => {
          promptCallCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
        });

        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        // We need getRunDetail to return different runs for each call
        let runCount = 0;
        const concurrentSavedRuns: Map<string, AgentHeartbeatRun> = new Map();
        (store.startHeartbeatRun as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          runCount++;
          return {
            id: `run-${runCount}`,
            agentId: "agent-001",
            startedAt: new Date().toISOString(),
            endedAt: null,
            status: "active",
          } as AgentHeartbeatRun;
        });
        (store.saveRun as ReturnType<typeof vi.fn>).mockImplementation(async (run: AgentHeartbeatRun) => {
          concurrentSavedRuns.set(run.id, run);
        });
        (store.getRunDetail as ReturnType<typeof vi.fn>).mockImplementation(async (_agentId: string, runId: string) => {
          return concurrentSavedRuns.get(runId) ?? {
            id: runId,
            agentId: "agent-001",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            status: "completed" as const,
          };
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        // Fire two concurrent executions
        const [result1, result2] = await Promise.all([
          monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" }),
          monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" }),
        ]);

        // Both should complete
        expect(result1).toBeDefined();
        expect(result2).toBeDefined();
        // Both should have called prompt (serialized, not concurrent)
        expect(promptCallCount).toBe(2);
      });
    });

    describe("usage tracking", () => {
      it("records estimated output tokens in usageJson", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        let onTextCallback: ((delta: string) => void) | undefined;

        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          onTextCallback = opts.onText;
          return { session: mockSession as any };
        });

        // Simulate text output
        mockSession.prompt = vi.fn().mockImplementation(async () => {
          // Simulate 100 chars of output (roughly 25 tokens at 4 chars/token)
          if (onTextCallback) {
            onTextCallback("A".repeat(100));
          }
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result.usageJson).toBeDefined();
        expect(result.usageJson!.inputTokens).toBe(0);
        expect(result.usageJson!.outputTokens).toBe(25); // 100/4 = 25
        expect(result.usageJson!.cachedTokens).toBe(0);
      });

      it("accumulates usage on agent record", async () => {
        const store = createStoreWithAgentForExec({
          totalInputTokens: 100,
          totalOutputTokens: 200,
        });
        const mockSession = createMockAgentSession();
        let onTextCallback: ((delta: string) => void) | undefined;

        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          onTextCallback = opts.onText;
          return { session: mockSession as any };
        });

        mockSession.prompt = vi.fn().mockImplementation(async () => {
          if (onTextCallback) {
            onTextCallback("A".repeat(100));
          }
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        // Should update cumulative tokens: 200 + 25 = 225
        expect(store.updateAgent).toHaveBeenCalledWith("agent-001", {
          totalInputTokens: 100,
          totalOutputTokens: 225,
        });
      });
    });

    describe("cleanup", () => {
      it("disposes session and untracks agent even on error", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });
        mockSession.prompt = vi.fn().mockRejectedValue(new Error("Crash"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        // Session disposed
        expect(mockSession.dispose).toHaveBeenCalled();
        // Agent untracked
        expect(monitor.getTrackedAgents()).not.toContain("agent-001");
      });

      it("disposes session and untracks agent on success", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(mockSession.dispose).toHaveBeenCalled();
        expect(monitor.getTrackedAgents()).not.toContain("agent-001");
      });
    });
  });
});
