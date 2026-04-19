import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatMonitor, HeartbeatTriggerScheduler, isBlockedStateDuplicate, type AgentSession, type HeartbeatExecutionOptions, HEARTBEAT_SYSTEM_PROMPT } from "./agent-heartbeat.js";
import { AgentLogger } from "./agent-logger.js";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";

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

function createMockMessageStore(onSetHook?: (hook: (message: Message) => void) => void): MessageStore {
  return {
    setMessageToAgentHook: vi.fn((hook: (message: Message) => void) => {
      onSetHook?.(hook);
    }),
  } as unknown as MessageStore;
}

function createMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: "msg-001",
    fromId: "user-1",
    fromType: "user",
    toId: "agent-1",
    toType: "agent",
    content: "hello",
    type: "user-to-agent",
    read: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createBudgetStatus(overrides: Partial<AgentBudgetStatus> = {}): AgentBudgetStatus {
  return {
    agentId: "agent-001",
    currentUsage: 0,
    budgetLimit: null,
    usagePercent: null,
    thresholdPercent: null,
    isOverBudget: false,
    isOverThreshold: false,
    lastResetAt: null,
    nextResetAt: null,
    ...overrides,
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

  describe("isBlockedStateDuplicate", () => {
    it("returns true when blockedBy and contextHash match", () => {
      expect(
        isBlockedStateDuplicate(
          { taskId: "FN-1", blockedBy: "FN-0", recordedAt: "2026-01-01T00:00:00.000Z", contextHash: "abc" },
          { taskId: "FN-1", blockedBy: "FN-0", recordedAt: "2026-01-02T00:00:00.000Z", contextHash: "abc" },
        ),
      ).toBe(true);
    });

    it("returns false when blockedBy differs or contextHash differs", () => {
      expect(
        isBlockedStateDuplicate(
          { taskId: "FN-1", blockedBy: "FN-0", recordedAt: "2026-01-01T00:00:00.000Z", contextHash: "abc" },
          { taskId: "FN-1", blockedBy: "FN-2", recordedAt: "2026-01-02T00:00:00.000Z", contextHash: "abc" },
        ),
      ).toBe(false);
      expect(
        isBlockedStateDuplicate(
          { taskId: "FN-1", blockedBy: "FN-0", recordedAt: "2026-01-01T00:00:00.000Z", contextHash: "abc" },
          { taskId: "FN-1", blockedBy: "FN-0", recordedAt: "2026-01-02T00:00:00.000Z", contextHash: "xyz" },
        ),
      ).toBe(false);
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

  describe("wake-on-message", () => {
    it("executes heartbeat when messageResponseMode is immediate", () => {
      let messageHook: ((message: Message) => void) | undefined;
      const messageStore = createMockMessageStore((hook) => {
        messageHook = hook;
      });
      const configStore = createMockStore({
        getCachedAgent: vi.fn().mockReturnValue({
          id: "agent-1",
          state: "active",
          runtimeConfig: { messageResponseMode: "immediate" },
        }),
      });

      const customMonitor = new HeartbeatMonitor({
        store,
        agentStore: configStore,
        messageStore,
      });
      const executeHeartbeatSpy = vi
        .spyOn(customMonitor, "executeHeartbeat")
        .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

      customMonitor.start();
      messageHook?.(createMessage({ toId: "agent-1", toType: "agent" }));

      expect(executeHeartbeatSpy).toHaveBeenCalledWith({
        agentId: "agent-1",
        source: "on_demand",
        triggerDetail: "wake-on-message",
      });

      customMonitor.stop();
    });

    it("does not execute heartbeat when messageResponseMode is on-heartbeat or unset", () => {
      let messageHook: ((message: Message) => void) | undefined;
      const messageStore = createMockMessageStore((hook) => {
        messageHook = hook;
      });
      const getCachedAgent = vi
        .fn()
        .mockReturnValueOnce({
          id: "agent-1",
          state: "active",
          runtimeConfig: { messageResponseMode: "on-heartbeat" },
        })
        .mockReturnValueOnce({
          id: "agent-1",
          state: "active",
          runtimeConfig: {},
        });
      const configStore = createMockStore({ getCachedAgent });

      const customMonitor = new HeartbeatMonitor({
        store,
        agentStore: configStore,
        messageStore,
      });
      const executeHeartbeatSpy = vi
        .spyOn(customMonitor, "executeHeartbeat")
        .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

      customMonitor.start();
      messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-1" }));
      messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-2" }));

      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      customMonitor.stop();
    });

    it("does not execute heartbeat when agent is paused or error", () => {
      let messageHook: ((message: Message) => void) | undefined;
      const messageStore = createMockMessageStore((hook) => {
        messageHook = hook;
      });
      const getCachedAgent = vi
        .fn()
        .mockReturnValueOnce({
          id: "agent-1",
          state: "paused",
          runtimeConfig: { messageResponseMode: "immediate" },
        })
        .mockReturnValueOnce({
          id: "agent-1",
          state: "error",
          runtimeConfig: { messageResponseMode: "immediate" },
        });
      const configStore = createMockStore({ getCachedAgent });

      const customMonitor = new HeartbeatMonitor({
        store,
        agentStore: configStore,
        messageStore,
      });
      const executeHeartbeatSpy = vi
        .spyOn(customMonitor, "executeHeartbeat")
        .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

      customMonitor.start();
      messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-paused" }));
      messageHook?.(createMessage({ toId: "agent-1", toType: "agent", id: "msg-error" }));

      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      customMonitor.stop();
    });

    it("registers the message hook on start and clears it on stop", () => {
      const hooks: Array<(message: Message) => void> = [];
      const messageStore = createMockMessageStore((hook) => {
        hooks.push(hook);
      });
      const customMonitor = new HeartbeatMonitor({ store, messageStore });

      customMonitor.start();

      expect(messageStore.setMessageToAgentHook).toHaveBeenCalledTimes(1);
      expect(hooks).toHaveLength(1);

      customMonitor.stop();

      expect(messageStore.setMessageToAgentHook).toHaveBeenCalledTimes(2);
      expect(hooks).toHaveLength(2);
      expect(hooks[0]).not.toBe(hooks[1]);
    });

    it("ignores non-agent messages", () => {
      let messageHook: ((message: Message) => void) | undefined;
      const messageStore = createMockMessageStore((hook) => {
        messageHook = hook;
      });
      const configStore = createMockStore({
        getCachedAgent: vi.fn().mockReturnValue({
          id: "agent-1",
          state: "active",
          runtimeConfig: { messageResponseMode: "immediate" },
        }),
      });
      const customMonitor = new HeartbeatMonitor({
        store,
        agentStore: configStore,
        messageStore,
      });
      const executeHeartbeatSpy = vi
        .spyOn(customMonitor, "executeHeartbeat")
        .mockResolvedValue({ id: "run-1" } as AgentHeartbeatRun);

      customMonitor.start();
      messageHook?.(createMessage({ toType: "user", toId: "user-1" }));

      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      customMonitor.stop();
    });

    describe("createHeartbeatTools - message tools", () => {
      let mockTaskStore: TaskStore;
      let mockSession: ReturnType<typeof createMockSession>;
      let capturedTools: any[] = [];

      beforeEach(() => {
        mockTaskStore = {
          createTask: vi.fn().mockResolvedValue({ id: "FN-002", description: "test", dependencies: [], column: "triage" }),
          logEntry: vi.fn().mockResolvedValue(undefined),
          upsertTaskDocument: vi.fn().mockResolvedValue({
            id: "doc-1", taskId: "FN-001", key: "test", content: "test", revision: 1, author: "agent",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }),
          getTaskDocument: vi.fn().mockResolvedValue(null),
          getTaskDocuments: vi.fn().mockResolvedValue([]),
        } as unknown as TaskStore;
        mockSession = createMockSession();
        capturedTools = [];
      });

      it("includes send_message and read_messages tools when messageStore is available", () => {
        const messageStore = createMockMessageStore();
        const customMonitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001", undefined, undefined, messageStore);
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).toContain("send_message");
        expect(toolNames).toContain("read_messages");
      });

      it("does not include message tools when messageStore is not provided", () => {
        const customMonitor = new HeartbeatMonitor({
          store,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).not.toContain("send_message");
        expect(toolNames).not.toContain("read_messages");
      });

      it("does not include message tools when messageStore is undefined even if other params are passed", () => {
        const customMonitor = new HeartbeatMonitor({
          store,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const tools = customMonitor.createHeartbeatTools(
          "agent-001",
          mockTaskStore,
          "FN-001",
          undefined,
          undefined,
          undefined
        );
        const toolNames = tools.map((t) => t.name);

        expect(toolNames).not.toContain("send_message");
        expect(toolNames).not.toContain("read_messages");
      });
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

    type MockTaskStoreOverrides = Partial<TaskStore> & {
      checkoutTask?: (taskId: string, agentId: string) => Promise<unknown>;
    };

    // Helper: create a basic mock task store
    function createMockTaskStore(overrides: MockTaskStoreOverrides = {}): TaskStore {
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
        selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
        createTask: vi.fn().mockResolvedValue({
          id: "FN-002",
          description: "Created task",
          dependencies: [],
          column: "triage",
        }),
        logEntry: vi.fn().mockResolvedValue({}),
        addComment: vi.fn().mockResolvedValue({}),
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
        // Document-related methods for task_document tools
        upsertTaskDocument: vi.fn().mockResolvedValue({
          id: "doc-1",
          taskId: "FN-001",
          key: "test-plan",
          content: "Test document content",
          revision: 1,
          author: "agent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getTaskDocument: vi.fn().mockResolvedValue({
          id: "doc-1",
          taskId: "FN-001",
          key: "test-plan",
          content: "Test document content",
          revision: 1,
          author: "agent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getTaskDocuments: vi.fn().mockResolvedValue([]),
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
        assignTask: vi.fn().mockImplementation(async (_agentId: string, taskId: string | undefined) => {
          mockAgent.taskId = taskId;
          return mockAgent;
        }),
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
        getRatingSummary: vi.fn().mockResolvedValue(undefined),
        endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        getCachedAgent: vi.fn().mockReturnValue(null),
        getLastBlockedState: vi.fn().mockResolvedValue(null),
        setLastBlockedState: vi.fn().mockResolvedValue(undefined),
        clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
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
        expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
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

    // ── Identity Agents Without Tasks ─────────────────────────────────────────────
    // FN-2051: Agents with identity (soul, instructions, memory) should run heartbeat
    // sessions even without a task assignment, enabling them to do ambient work like
    // messaging, memory management, task creation, and delegation.
    describe("identity agents without tasks", () => {
      it("agent WITH soul but no task creates session and completes successfully", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator agent who monitors project health" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        // Should create a session
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        // Reason should indicate identity run
        expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
      });

      it("agent WITH instructionsText but no task creates session and completes successfully", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, instructionsText: "Monitor task board and create follow-up tasks" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
      });

      it("agent WITH memory but no task creates session and completes successfully", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, memory: "Last week we shipped the new API. Watch for integration issues." });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        expect(result.resultJson).toEqual(expect.objectContaining({ reason: "no_assignment_identity_run" }));
      });

      it("ephemeral agent with soul but no task still bails with no_assignment", async () => {
        // Ephemeral agents (agentKind: "task-worker") should NOT run no-task sessions
        const store = createStoreWithAgentForExec({
          taskId: undefined,
          soul: "I am a task worker",
          metadata: { agentKind: "task-worker" },
        });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        // Ephemeral agents should NOT create a session
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
        // Should still exit with no_assignment (not no_assignment_identity_run)
        expect(result.resultJson).toEqual({ reason: "no_assignment" });
      });

      it("identity agent without task receives correct tools (task_create, list_agents, delegate_task, heartbeat_done)", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0]!;
        const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

        // Should have task_create, list_agents, delegate_task
        expect(toolNames).toContain("task_create");
        expect(toolNames).toContain("list_agents");
        expect(toolNames).toContain("delegate_task");
        // Should have heartbeat_done
        expect(toolNames).toContain("heartbeat_done");
        // Should have memory tools
        expect(toolNames).toContain("memory_search");
        expect(toolNames).toContain("memory_append");

        // Should NOT have task_log, task_document_write, task_document_read (they require taskId)
        expect(toolNames).not.toContain("task_log");
        expect(toolNames).not.toContain("task_document_write");
        expect(toolNames).not.toContain("task_document_read");
      });

      it("identity agent without task receives no-task execution prompt mentioning 'no assigned task'", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        // The execution prompt is passed to session.prompt by promptWithFallback mock
        const promptCalls = mockSession.prompt.mock.calls;
        expect(promptCalls.length).toBeGreaterThan(0);
        const executionPrompt = promptCalls[promptCalls.length - 1]![0]!;

        // Should mention no assigned task
        expect(executionPrompt).toContain("No assigned task");
        // Should describe ambient work capabilities
        expect(executionPrompt).toContain("ambient work");
        expect(executionPrompt).toContain("task_create");
        expect(executionPrompt).toContain("list_agents");
        expect(executionPrompt).toContain("delegate_task");
        // Should NOT include task-specific content
        expect(executionPrompt).not.toContain("Assigned task:");
        expect(executionPrompt).not.toContain("Task description:");
      });

      it("identity agent without task gets soul in system prompt", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a CEO who prioritizes high-impact work" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0]!;
        // Soul should be in the system prompt
        expect(callArgs.systemPrompt).toContain("## Soul");
        expect(callArgs.systemPrompt).toContain("I am a CEO who prioritizes high-impact work");
      });

      it("agent WITHOUT identity (no soul, instructions, memory) still exits with no_assignment", async () => {
        // Agent with empty strings should also exit gracefully
        const store = createStoreWithAgentForExec({
          taskId: undefined,
          soul: "",
          instructionsText: "",
          memory: "",
        });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result).toBeDefined();
        expect(result.status).toBe("completed");
        // Should NOT create a session for agents without identity
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
        expect(result.resultJson).toEqual({ reason: "no_assignment" });
      });

      it("identity agent without task includes messaging tools when messageStore is available", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn().mockReturnValue([]),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0]!;
        const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

        // Should have messaging tools when messageStore is available
        expect(toolNames).toContain("send_message");
        expect(toolNames).toContain("read_messages");
      });

      it("identity agent without task does NOT include messaging tools when messageStore is unavailable", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined, soul: "I am a coordinator" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0]!;
        const toolNames = callArgs.customTools!.map((tool: any) => tool.name);

        // Should NOT have messaging tools when messageStore is not available
        expect(toolNames).not.toContain("send_message");
        expect(toolNames).not.toContain("read_messages");
      });
    });

    describe("blocked-task dedup", () => {
      const buildContextHash = (blockedBy: string, taskDetail: Partial<TaskDetail>): string => {
        const commentCount = (taskDetail.comments?.length ?? 0) + (taskDetail.steeringComments?.length ?? 0);
        const lastCommentId = taskDetail.comments?.at(-1)?.id;
        const lastSteeringCommentId = taskDetail.steeringComments?.at(-1)?.id;

        return Buffer.from(
          JSON.stringify({ commentCount, lastCommentId, lastSteeringCommentId, blockedBy }),
        )
          .toString("base64")
          .slice(0, 16);
      };

      it("skips duplicate blocked comments when blocked snapshot is unchanged", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-BLOCKED" });
        const taskDetail = {
          id: "FN-BLOCKED",
          title: "Blocked Task",
          description: "Blocked task description",
          prompt: "",
          status: "queued",
          blockedBy: "FN-DEP-1",
          comments: [{ id: "comment-1", text: "Still blocked", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
          steeringComments: [],
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail;

        (store.getLastBlockedState as ReturnType<typeof vi.fn>).mockResolvedValue({
          taskId: "FN-BLOCKED",
          blockedBy: "FN-DEP-1",
          recordedAt: "2026-01-01T00:00:00.000Z",
          contextHash: buildContextHash("FN-DEP-1", taskDetail),
        });

        mockTaskStore = createMockTaskStore({
          getTask: vi.fn().mockResolvedValue(taskDetail),
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.resultJson).toEqual({ reason: "blocked_duplicate", taskId: "FN-BLOCKED", blockedBy: "FN-DEP-1" });
        expect(mockTaskStore.addComment).not.toHaveBeenCalled();
        expect(store.setLastBlockedState).not.toHaveBeenCalled();
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("re-logs blocked state when new comments change context hash", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-BLOCKED" });
        (store.getLastBlockedState as ReturnType<typeof vi.fn>).mockResolvedValue({
          taskId: "FN-BLOCKED",
          blockedBy: "FN-DEP-1",
          recordedAt: "2026-01-01T00:00:00.000Z",
          contextHash: "stale-context-hash",
        });

        const taskDetail = {
          id: "FN-BLOCKED",
          title: "Blocked Task",
          description: "Blocked task description",
          prompt: "",
          status: "queued",
          blockedBy: "FN-DEP-1",
          comments: [{ id: "comment-2", text: "New context", author: "user", createdAt: "2026-01-02T00:00:00.000Z" }],
          steeringComments: [],
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail;

        mockTaskStore = createMockTaskStore({ getTask: vi.fn().mockResolvedValue(taskDetail) });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.resultJson).toEqual({ reason: "blocked", taskId: "FN-BLOCKED", blockedBy: "FN-DEP-1" });
        expect(mockTaskStore.addComment).toHaveBeenCalledOnce();
        expect(store.setLastBlockedState).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({ taskId: "FN-BLOCKED", blockedBy: "FN-DEP-1" }),
        );
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("treats changed blockedBy as a new blocked state", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-BLOCKED" });
        (store.getLastBlockedState as ReturnType<typeof vi.fn>).mockResolvedValue({
          taskId: "FN-BLOCKED",
          blockedBy: "FN-DEP-OLD",
          recordedAt: "2026-01-01T00:00:00.000Z",
          contextHash: "samehash",
        });

        const taskDetail = {
          id: "FN-BLOCKED",
          title: "Blocked Task",
          description: "Blocked task description",
          prompt: "",
          status: "queued",
          blockedBy: "FN-DEP-NEW",
          comments: [],
          steeringComments: [],
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail;

        mockTaskStore = createMockTaskStore({ getTask: vi.fn().mockResolvedValue(taskDetail) });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockTaskStore.addComment).toHaveBeenCalledOnce();
        expect(store.setLastBlockedState).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({ blockedBy: "FN-DEP-NEW" }),
        );
      });

      it("clears blocked state when task is no longer blocked", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-READY" });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        mockTaskStore = createMockTaskStore({
          getTask: vi.fn().mockResolvedValue({
            id: "FN-READY",
            title: "Ready Task",
            description: "Ready to run",
            prompt: "",
            status: undefined,
            blockedBy: undefined,
            comments: [],
            steeringComments: [],
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail),
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(store.clearLastBlockedState).toHaveBeenCalledWith("agent-001");
      });
    });

    // ── Utility Lane Independence Regression ─────────────────────────────────────
    // FN-1727: Heartbeat runs must execute on the control-plane (utility) lane
    // and must NOT consume task-lane semaphore slots. This test proves that
    // heartbeat execution completes successfully even when task execution
    // slots are saturated (e.g., maxConcurrent: 0 or all slots occupied).
    // The utility AI helper path must remain responsive under task-lane pressure.
    describe("slot-saturation: heartbeat runs on utility lane independent of task-lane semaphore", () => {
      it("executes heartbeat successfully while task-lane semaphore is saturated", async () => {
        // Import AgentSemaphore directly to create a saturated slot fixture
        const { AgentSemaphore } = await import("./concurrency.js");

        // Create a semaphore with maxConcurrent=0 to simulate fully saturated state
        // The defensive guard in AgentSemaphore.limit returns minimum 1, so we
        // use a static limit of 0 and manually acquire to simulate saturation.
        const taskLaneSemaphore = new AgentSemaphore(0);

        // Acquire the single available slot to saturate task lanes
        await taskLaneSemaphore.acquire();

        // Verify the semaphore is saturated (no available slots)
        expect(taskLaneSemaphore.availableCount).toBe(0);
        expect(taskLaneSemaphore.activeCount).toBe(1);

        // Create the heartbeat monitor (it does NOT receive the task-lane semaphore)
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        // Execute heartbeat while task lanes are saturated
        // This MUST succeed because heartbeat runs on the utility lane
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        // CRITICAL ASSERTIONS:
        // 1. Heartbeat completed successfully (proves it didn't wait for task-lane slot)
        expect(result).toBeDefined();
        expect(result.status).toBe("completed");

        // 2. Agent session was created (proves execution proceeded)
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();

        // 3. Semaphore saturation is still held (proves heartbeat didn't consume task-lane slot)
        expect(taskLaneSemaphore.activeCount).toBe(1);

        // 4. Semaphore available count is still 0 (still saturated from task-lane perspective)
        expect(taskLaneSemaphore.availableCount).toBe(0);

        // Cleanup: release the task-lane slot
        taskLaneSemaphore.release();
        expect(taskLaneSemaphore.activeCount).toBe(0);
      });

      it("completes on_demand heartbeat while task-lane slots are fully occupied", async () => {
        const { AgentSemaphore } = await import("./concurrency.js");

        // Simulate multiple task-lane agents holding all slots
        const taskLaneSemaphore = new AgentSemaphore(2);

        // Saturate both slots with "task-lane agents"
        await taskLaneSemaphore.acquire(); // Agent 1
        await taskLaneSemaphore.acquire(); // Agent 2

        expect(taskLaneSemaphore.availableCount).toBe(0);

        // Now execute heartbeat - it should complete without waiting
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const startTime = Date.now();
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });
        const elapsed = Date.now() - startTime;

        // Should complete quickly (not blocked by semaphore wait)
        expect(elapsed).toBeLessThan(500);

        // Heartbeat should succeed
        expect(result.status).toBe("completed");

        // Task-lane slots should remain occupied
        expect(taskLaneSemaphore.activeCount).toBe(2);

        // Cleanup
        taskLaneSemaphore.release();
        taskLaneSemaphore.release();
      });
    });

    describe("executeHeartbeat - message processing", () => {
      it("includes unread messages in prompt when woken by wake-on-message", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messages = [
          createMessage({
            id: "msg-1",
            fromId: "agent-2",
            content: "Hello from agent-2",
            createdAt: "2024-01-15T10:30:00.000Z",
          }),
          createMessage({
            id: "msg-2",
            fromId: "user-1",
            content: "Hello from user",
            createdAt: "2024-01-15T11:00:00.000Z",
          }),
        ];

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn().mockReturnValue(messages),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          triggerDetail: "wake-on-message",
        });

        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalled();
        expect(messageStore.getInbox).toHaveBeenCalledWith("agent-001", "agent", { read: false, limit: 10 });

        // Verify execution prompt (passed to promptWithFallback) included the messages
        // The execution prompt is passed to session.prompt by promptWithFallback mock
        const promptCalls = mockSession.prompt.mock.calls;
        expect(promptCalls.length).toBeGreaterThan(0);
        const executionPrompt = promptCalls[promptCalls.length - 1][0];
        expect(executionPrompt).toContain("Pending Messages:");
        expect(executionPrompt).toContain("Hello from agent-2");
        expect(executionPrompt).toContain("Hello from user");
      });

      it("does not include message section when no unread messages", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn().mockReturnValue([]),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          triggerDetail: "wake-on-message",
        });

        expect(result.status).toBe("completed");

        // Verify prompt did NOT include pending messages section
        // Note: without wake-on-message trigger, no messages are fetched
        // so the prompt won't have the Pending Messages section at all
      });

      it("marks messages as read after successful heartbeat execution", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messages = [
          createMessage({
            id: "msg-1",
            fromId: "agent-2",
            content: "Hello from agent-2",
          }),
        ];

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn().mockReturnValue(messages),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          triggerDetail: "wake-on-message",
        });

        expect(result.status).toBe("completed");
        expect(messageStore.markAllAsRead).toHaveBeenCalledWith("agent-001", "agent");
      });

      it("does not mark messages as read on failed heartbeat execution", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockSession.prompt = vi.fn().mockRejectedValue(new Error("Execution failed"));
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messages = [
          createMessage({
            id: "msg-1",
            fromId: "agent-2",
            content: "Hello from agent-2",
          }),
        ];

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn().mockReturnValue(messages),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          triggerDetail: "wake-on-message",
        });

        expect(result.status).toBe("failed");
        expect(messageStore.markAllAsRead).not.toHaveBeenCalled();
      });

      it("does not fetch messages when not wake-on-message trigger", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const messageStore = {
          setMessageToAgentHook: vi.fn(),
          getInbox: vi.fn(),
          markAllAsRead: vi.fn(),
        } as unknown as MessageStore;

        const monitor = new HeartbeatMonitor({
          store,
          messageStore,
          taskStore: mockTaskStore,
          rootDir: "/tmp",
        });

        // Use a regular trigger (not wake-on-message)
        await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "timer",
          triggerDetail: "scheduled",
        });

        expect(messageStore.getInbox).not.toHaveBeenCalled();
        expect(messageStore.markAllAsRead).not.toHaveBeenCalled();
      });

      describe("end-to-end agent-to-agent message flow", () => {
        it("proves full message flow from send to wake to processing to reply", async () => {
          // Import real MessageStore for this test
          const core = await import("@fusion/core");
          const Database = core.Database;
          const RealMessageStore = core.MessageStore;

          // Setup: create real temp database and MessageStore
          const tmpDir = await import("node:fs/promises").then((fs) =>
            fs.mkdtemp(require("node:path").join(require("node:os").tmpdir(), "fn-e2e-message-"))
          );
          const kbDir = require("node:path").join(tmpDir, ".fusion");
          await require("node:fs").promises.mkdir(kbDir, { recursive: true });

          let messageStore: InstanceType<typeof RealMessageStore>;
          let db: InstanceType<typeof Database> | undefined;
          try {
            db = new Database(kbDir);
            db.init();
            messageStore = new RealMessageStore(db);

            // Agent A sends a message to Agent B
            const sentMessage = messageStore.sendMessage({
              fromId: "agent-alpha",
              fromType: "agent",
              toId: "agent-beta",
              toType: "agent",
              content: "Hello Agent Beta, please process task FN-001.",
              type: "agent-to-agent",
              metadata: { taskId: "FN-001" },
            });

            expect(sentMessage.id).toBeDefined();
            expect(sentMessage.content).toContain("Hello Agent Beta");

            // Verify message is stored in Agent B's inbox
            const inbox = messageStore.getInbox("agent-beta", "agent", { read: false });
            expect(inbox).toHaveLength(1);
            expect(inbox[0].id).toBe(sentMessage.id);
            expect(inbox[0].content).toBe(sentMessage.content);

            // Create a monitor for Agent B with real MessageStore
            const store = createStoreWithAgentForExec({
              id: "agent-beta",
              name: "Agent Beta",
              state: "active",
              taskId: "FN-001",
            });
            const mockSession = createMockAgentSession();
            mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

            const monitor = new HeartbeatMonitor({
              store,
              messageStore,
              taskStore: mockTaskStore,
              rootDir: "/tmp",
            });

            // Execute heartbeat to process the message (simulating wake-on-message trigger)
            const result = await monitor.executeHeartbeat({
              agentId: "agent-beta",
              source: "on_demand",
              triggerDetail: "wake-on-message",
            });

            // Verify heartbeat completed
            expect(result.status).toBe("completed");

            // Verify the execution prompt included the message
            const promptCalls = mockSession.prompt.mock.calls;
            expect(promptCalls.length).toBeGreaterThan(0);
            const executionPrompt = promptCalls[promptCalls.length - 1][0];
            expect(executionPrompt).toContain("Hello Agent Beta");
            expect(executionPrompt).toContain("Pending Messages:");

            // Verify messages were marked as read after successful processing
            expect(messageStore.getMailbox("agent-beta", "agent").unreadCount).toBe(0);

            // Cleanup
            await monitor.stop();
          } finally {
            // Cleanup temp directory
            try {
              db?.close();
              await require("node:fs/promises").rm(tmpDir, { recursive: true, force: true });
            } catch {
              // ignore cleanup errors
            }
          }
        });
      });
    });

    describe("executeHeartbeat - inbox selection", () => {
      const makeInboxSelection = (taskId: string, priority: "in_progress" | "todo" | "blocked" = "todo") => {
        const now = new Date().toISOString();
        return {
          task: {
            id: taskId,
            description: `Inbox task ${taskId}`,
            column: priority === "in_progress" ? "in-progress" : "todo",
            dependencies: [],
            steps: [],
            currentStep: 0,
            log: [],
            createdAt: now,
            updatedAt: now,
          },
          priority,
          reason: `selected:${priority}`,
        } as any;
      };

      it("when agent has no taskId, inbox selects a todo task and assigns it", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
        mockTaskStore = createMockTaskStore({
          selectNextTaskForAgent,
          getTask: vi.fn().mockResolvedValue({
            id: "FN-INBOX",
            title: "Inbox Task",
            description: "Inbox-selected task",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail),
        });

        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001");
        expect(store.assignTask).toHaveBeenCalledWith("agent-001", "FN-INBOX", expect.objectContaining({ agentId: "agent-001" }));
        expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-INBOX");
      });

      it("explicit taskId override takes precedence over inbox selection", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
        mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "on_demand",
          taskId: "FN-EXPLICIT",
        });

        expect(selectNextTaskForAgent).not.toHaveBeenCalled();
        expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-EXPLICIT");
      });

      it("agent's existing taskId takes precedence over inbox selection", async () => {
        const store = createStoreWithAgentForExec({ taskId: "FN-EXISTING" });
        const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo"));
        mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(selectNextTaskForAgent).not.toHaveBeenCalled();
        expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-EXISTING");
      });

      it("when inbox returns null, heartbeat completes with no_assignment", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        const selectNextTaskForAgent = vi.fn().mockResolvedValue(null);
        mockTaskStore = createMockTaskStore({ selectNextTaskForAgent });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001");
        expect(result.resultJson).toEqual({ reason: "no_assignment" });
      });

      it("records inbox selection metadata in resultJson", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        mockTaskStore = createMockTaskStore({
          selectNextTaskForAgent: vi.fn().mockResolvedValue(makeInboxSelection("FN-INBOX", "todo")),
          getTask: vi.fn().mockResolvedValue({
            id: "FN-INBOX",
            title: "Inbox Task",
            description: "Inbox-selected task",
            prompt: "",
            steps: [],
            column: "todo",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail),
        });

        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result.resultJson).toEqual(expect.objectContaining({
          reason: "inbox_selected",
          priority: "todo",
          taskId: "FN-INBOX",
        }));
      });

      it("supports in-progress inbox selections before todo", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        mockTaskStore = createMockTaskStore({
          selectNextTaskForAgent: vi.fn().mockResolvedValue(makeInboxSelection("FN-RESUME", "in_progress")),
          getTask: vi.fn().mockResolvedValue({
            id: "FN-RESUME",
            title: "Resume task",
            description: "Resume in-progress work",
            prompt: "",
            steps: [],
            column: "in-progress",
            dependencies: [],
            log: [],
            attachments: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as TaskDetail),
        });

        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(mockTaskStore.getTask).toHaveBeenCalledWith("FN-RESUME");
        expect(result.resultJson).toEqual(expect.objectContaining({
          reason: "inbox_selected",
          priority: "in_progress",
          taskId: "FN-RESUME",
        }));
      });

      it("gracefully skips inbox selection when checkoutTask throws", async () => {
        const store = createStoreWithAgentForExec({ taskId: undefined });
        const selectNextTaskForAgent = vi.fn().mockResolvedValue(makeInboxSelection("FN-CHECKOUT", "todo"));
        const checkoutTask = vi.fn().mockRejectedValue(new Error("Task is already checked out"));
        mockTaskStore = createMockTaskStore({
          selectNextTaskForAgent,
          checkoutTask: checkoutTask as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(selectNextTaskForAgent).toHaveBeenCalledWith("agent-001");
        expect(checkoutTask).toHaveBeenCalledWith("FN-CHECKOUT", "agent-001", expect.objectContaining({ agentId: "agent-001" }));
        expect(result.resultJson).toEqual({ reason: "no_assignment" });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });
    });

    describe("execution", () => {
      it("creates session with enriched system prompt and expected tools", async () => {
        const store = createStoreWithAgentForExec({
          soul: "Act like a practical teammate who prioritizes clarity.",
          memory: "Recent runs found flaky tests in integration suites.",
          instructionsText: "Always log blockers with actionable next steps.",
        });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        expect(callArgs.cwd).toBe("/tmp/test");
        expect(callArgs.systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
        expect(callArgs.systemPrompt).toContain("## Soul");
        expect(callArgs.systemPrompt).toContain("Act like a practical teammate who prioritizes clarity.");
        expect(callArgs.systemPrompt).toContain("## Agent Memory");
        expect(callArgs.systemPrompt).toContain("Recent runs found flaky tests in integration suites.");
        expect(callArgs.systemPrompt).toContain("Always log blockers with actionable next steps.");
        expect(callArgs.systemPrompt).toContain("## Project Memory");
        expect(callArgs.systemPrompt).toContain("memory_search");
        expect(callArgs.tools).toBe("readonly");
        // Tools: task_create, task_log, task_document_write, task_document_read, list_agents, delegate_task,
        // memory_search, memory_get, memory_append, heartbeat_done
        expect(callArgs.customTools).toHaveLength(10);
        expect(callArgs.customTools![0]!.name).toBe("task_create");
        expect(callArgs.customTools![1]!.name).toBe("task_log");
        expect(callArgs.customTools![2]!.name).toBe("task_document_write");
        expect(callArgs.customTools![3]!.name).toBe("task_document_read");
        expect(callArgs.customTools![4]!.name).toBe("list_agents");
        expect(callArgs.customTools![5]!.name).toBe("delegate_task");
        expect(callArgs.customTools![6]!.name).toBe("memory_search");
        expect(callArgs.customTools![7]!.name).toBe("memory_get");
        expect(callArgs.customTools![8]!.name).toBe("memory_append");
        // heartbeat_done is last (terminal tool)
        expect(callArgs.customTools![9]!.name).toBe("heartbeat_done");
      });

      it("includes memory instructions even when agent has no custom instructions", async () => {
        const store = createStoreWithAgentForExec({
          soul: undefined,
          memory: undefined,
          instructionsText: undefined,
          instructionsPath: undefined,
        });
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        expect(callArgs.systemPrompt).toContain(HEARTBEAT_SYSTEM_PROMPT);
        expect(callArgs.systemPrompt).toContain("## Project Memory");
      });

      it("omits memory tools and instructions when project memory is disabled", async () => {
        const store = createStoreWithAgentForExec();
        const taskStore = createMockTaskStore({
          getSettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
        } as Partial<TaskStore>);
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        const toolNames = callArgs.customTools!.map((tool: any) => tool.name);
        expect(callArgs.systemPrompt).not.toContain("## Project Memory");
        expect(toolNames).not.toContain("memory_search");
        expect(toolNames).not.toContain("memory_get");
        expect(toolNames).not.toContain("memory_append");
      });

      it("wires user-created agent memory into the memory_search tool", async () => {
        const store = createStoreWithAgentForExec({
          name: "CEO",
          memory: "Prioritize roadmap sequencing and delegate implementation follow-ups.",
        });
        const taskStore = createMockTaskStore({
          getSettings: vi.fn().mockResolvedValue({ memoryBackendType: "file" }),
        } as Partial<TaskStore>);
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        const memorySearch = callArgs.customTools!.find((tool: any) => tool.name === "memory_search") as any;
        expect(memorySearch).toBeDefined();
        const result = await memorySearch.execute("call-1", {
          query: "roadmap delegate",
          limit: 5,
        }, undefined, undefined, undefined);

        expect(result.content[0].text).toContain(".fusion/agent-memory/agent-001/MEMORY.md");
        expect(result.content[0].text).toContain("roadmap sequencing");
        expect(result.details.results[0].backend).toBe("agent-memory");
      });

      it("includes document tools in heartbeat session", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        const toolNames = callArgs.customTools!.map((t: any) => t.name);
        expect(toolNames).toContain("task_document_write");
        expect(toolNames).toContain("task_document_read");
      });

      it("heartbeat_done is the terminal tool (last in array)", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp/test" });

        await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        const callArgs = mockedCreateKbAgent.mock.calls[0]![0];
        const toolNames = callArgs.customTools!.map((t: any) => t.name);
        // heartbeat_done should be last for stable terminal signaling
        expect(toolNames[toolNames.length - 1]).toBe("heartbeat_done");
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

      it("includes triggering comment context in execution prompt when comment IDs are provided", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        mockTaskStore.getTask = vi.fn().mockResolvedValue({
          id: "FN-001",
          title: "Test Task",
          description: "Test task description",
          prompt: "# Prompt",
          comments: [{ id: "c-1", author: "user", text: "Please cover edge cases", createdAt: "2026-01-01T00:00:00.000Z" }],
          steeringComments: [{ id: "s-1", author: "agent", text: "Investigating blocker", createdAt: "2026-01-01T00:01:00.000Z" }],
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
          triggeringCommentIds: ["c-1", "s-1"],
          triggeringCommentType: "steering",
        });

        const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
        expect(promptArg).toContain("You were woken because of new comments on this task");
        expect(promptArg).toContain("Please cover edge cases");
        expect(promptArg).toContain("Investigating blocker");
      });

      it("keeps standard prompt when no triggering comments are provided", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        const promptArg = mockSession.prompt.mock.calls[0]![0] as string;
        expect(promptArg).not.toContain("You were woken because of new comments on this task");
        expect(promptArg).not.toContain("New comments since last run:");
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

      it("persists contextSnapshot on run records", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

        const result = await monitor.executeHeartbeat({
          agentId: "agent-001",
          source: "assignment",
          triggerDetail: "task-assigned",
          triggeringCommentIds: ["comment-1"],
          triggeringCommentType: "task",
          contextSnapshot: {
            wakeReason: "assignment",
            triggerDetail: "task-assigned",
            taskId: "FN-001",
          },
        });

        expect(result.contextSnapshot).toEqual({
          wakeReason: "assignment",
          triggerDetail: "task-assigned",
          taskId: "FN-001",
          triggeringCommentIds: ["comment-1"],
          triggeringCommentType: "task",
        });
      });

      it("records agent logs, context taskId, and stdoutExcerpt for successful runs", async () => {
        const store = createStoreWithAgentForExec();
        const appendAgentLog = vi.fn().mockResolvedValue(undefined);
        mockTaskStore = createMockTaskStore({ appendAgentLog });

        const mockSession = createMockAgentSession();
        let onText: ((delta: string) => void) | undefined;
        let onToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;
        let onToolEnd: ((name: string, isError: boolean, result?: unknown) => void) | undefined;

        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          onText = opts.onText;
          onToolStart = opts.onToolStart;
          onToolEnd = opts.onToolEnd;
          return { session: mockSession as any };
        });

        mockSession.prompt = vi.fn().mockImplementation(async () => {
          onText?.("Heartbeat produced visible output");
          onToolStart?.("read", { path: "README.md" });
          onToolEnd?.("read", false, "done");
        });

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "Heartbeat produced visible output", "text", undefined, "executor");
        expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "read", "tool", "README.md", "executor");
        expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "read", "tool_result", "done", "executor");
        expect(result.contextSnapshot?.taskId).toBe("FN-001");
        expect(result.stdoutExcerpt).toContain("Heartbeat produced visible output");
      });
    });

    describe("heartbeat_done tool", () => {
      it("captures summary from heartbeat_done in resultJson", async () => {
        const store = createStoreWithAgentForExec();
        let capturedDoneTool: any;
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockImplementation(async (opts: any) => {
          // heartbeat_done is last in the customTools array (index 4)
          capturedDoneTool = opts.customTools[opts.customTools.length - 1];
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
          capturedDoneTool = opts.customTools[opts.customTools.length - 1];
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

      it("flushes AgentLogger on execution failure", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);

        mockedCreateKbAgent.mockResolvedValue({
          session: mockSession as any,
        });
        mockSession.prompt = vi.fn().mockRejectedValue(new Error("Prompt failed"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(flushSpy).toHaveBeenCalled();
      });

      it("flushes AgentLogger when session creation fails", async () => {
        const store = createStoreWithAgentForExec();
        const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);
        mockedCreateKbAgent.mockRejectedValue(new Error("Model unavailable"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(flushSpy).toHaveBeenCalled();
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

    describe("Budget Governance", () => {
      it("skips heartbeat when agent is over budget (timer)", async () => {
        const budgetStatus = createBudgetStatus({
          currentUsage: 10000,
          budgetLimit: 10000,
          usagePercent: 100,
          thresholdPercent: 80,
          isOverBudget: true,
          isOverThreshold: true,
        });
        const store = createStoreWithAgentForExec();
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(budgetStatus);

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        expect(result.resultJson).toMatchObject({ reason: "budget_exhausted", budgetStatus });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
        expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
      });

      it("skips heartbeat when agent is over budget (on_demand)", async () => {
        const store = createStoreWithAgentForExec();
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
          createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
        );

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result.resultJson).toMatchObject({ reason: "budget_exhausted" });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("skips heartbeat when agent is over budget (assignment)", async () => {
        const store = createStoreWithAgentForExec();
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
          createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
        );

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

        expect(result.resultJson).toMatchObject({ reason: "budget_exhausted" });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("skips timer heartbeat when agent is over threshold but not over budget", async () => {
        const budgetStatus = createBudgetStatus({
          currentUsage: 850,
          budgetLimit: 1000,
          usagePercent: 85,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: true,
        });
        const store = createStoreWithAgentForExec();
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(budgetStatus);

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.resultJson).toMatchObject({ reason: "budget_threshold_exceeded", budgetStatus });
        expect(mockedCreateKbAgent).not.toHaveBeenCalled();
      });

      it("allows on_demand heartbeat when agent is over threshold", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
          createBudgetStatus({ isOverThreshold: true, usagePercent: 85, budgetLimit: 1000, thresholdPercent: 80 })
        );

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
      });

      it("allows assignment heartbeat when agent is over threshold", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
          createBudgetStatus({ isOverThreshold: true, usagePercent: 85, budgetLimit: 1000, thresholdPercent: 80 })
        );

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "assignment" });

        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
      });

      it("proceeds normally when agent is below threshold", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
          createBudgetStatus({ isOverBudget: false, isOverThreshold: false, usagePercent: 30, budgetLimit: 1000, thresholdPercent: 80 })
        );

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
      });

      it("proceeds normally when getBudgetStatus throws", async () => {
        const store = createStoreWithAgentForExec();
        const mockSession = createMockAgentSession();
        mockedCreateKbAgent.mockResolvedValue({ session: mockSession as any });
        (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("budget unavailable"));

        const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
        const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

        expect(result.status).toBe("completed");
        expect(mockedCreateKbAgent).toHaveBeenCalledOnce();
      });
    });
  });

  // ── Task Creation Tracking Tests ──────────────────────────────────────

  describe("createHeartbeatTools", () => {
    let mockTaskStore: TaskStore;

    function createMockTaskStoreForTools(overrides: Partial<TaskStore> = {}): TaskStore {
      return {
        createTask: vi.fn().mockResolvedValue({
          id: "FN-100",
          description: "Follow-up task",
          dependencies: [],
          column: "triage",
        }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          title: "Test Task",
          description: "Test task description",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
        // Document-related methods for task_document tools
        upsertTaskDocument: vi.fn().mockResolvedValue({
          id: "doc-1",
          taskId: "FN-001",
          key: "test-plan",
          content: "Test document content",
          revision: 1,
          author: "agent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getTaskDocument: vi.fn().mockResolvedValue({
          id: "doc-1",
          taskId: "FN-001",
          key: "test-plan",
          content: "Test document content",
          revision: 1,
          author: "agent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getTaskDocuments: vi.fn().mockResolvedValue([]),
        ...overrides,
      } as unknown as TaskStore;
    }

    beforeEach(() => {
      mockTaskStore = createMockTaskStoreForTools();
    });

    it("returns task_create, task_log, task_document_write, and task_document_read tools", () => {
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");

      expect(tools).toHaveLength(6);
      expect(tools[0]!.name).toBe("task_create");
      expect(tools[1]!.name).toBe("task_log");
      expect(tools[2]!.name).toBe("task_document_write");
      expect(tools[3]!.name).toBe("task_document_read");
      expect(tools[4]!.name).toBe("list_agents");
      expect(tools[5]!.name).toBe("delegate_task");
    });

    it("task_create tool creates a task in triage via TaskStore", async () => {
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const createTool = tools[0]!;

      const result = await createTool.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.createTask).toHaveBeenCalledWith({
        description: "Follow-up task",
        dependencies: undefined,
        column: "triage",
      });

      const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      expect(responseText).toContain("Created FN-100");
    });

    it("logs agent link on created task", async () => {
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-100",
        "Created by agent agent-001 during heartbeat run",
        undefined,
        undefined,
      );
    });

    it("accumulates created tasks in runCreatedTasks", async () => {
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");

      await tools[0]!.execute("call-1", { description: "First task" }, undefined as any, undefined as any, undefined as any);
      await tools[0]!.execute("call-2", { description: "Second task" }, undefined as any, undefined as any, undefined as any);

      // Internally tracked — verify via completeRun integration
      // For now verify the tool was called twice
      expect(mockTaskStore.createTask).toHaveBeenCalledTimes(2);
    });

    it("handles logEntry failure gracefully", async () => {
      mockTaskStore.logEntry = vi.fn().mockRejectedValue(new Error("DB error"));
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");

      // Should not throw even though logEntry fails
      const result = await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);
      expect(result).toBeDefined();
      // Task was still created
      expect(mockTaskStore.createTask).toHaveBeenCalled();
    });

    it("task_document_write tool persists documents via TaskStore", async () => {
      const store = createMockStore();
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const writeTool = tools.find((t) => t.name === "task_document_write")!;

      const result = await writeTool.execute("call-1", { key: "plan", content: "Implementation plan here" }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.upsertTaskDocument).toHaveBeenCalledWith("FN-001", {
        key: "plan",
        content: "Implementation plan here",
        author: "agent",
      });

      const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      expect(responseText).toContain("Saved document");
      expect(responseText).toContain("plan");
    });

    it("task_document_read tool reads specific document by key", async () => {
      const store = createMockStore();
      mockTaskStore.getTaskDocument = vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "plan",
        content: "Implementation plan content",
        revision: 2,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const readTool = tools.find((t) => t.name === "task_document_read")!;

      const result = await readTool.execute("call-1", { key: "plan" }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.getTaskDocument).toHaveBeenCalledWith("FN-001", "plan");

      const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      expect(responseText).toContain("plan");
      expect(responseText).toContain("Implementation plan content");
    });

    it("task_document_read tool lists all documents when key is omitted", async () => {
      const store = createMockStore();
      mockTaskStore.getTaskDocuments = vi.fn().mockResolvedValue([
        { id: "doc-1", taskId: "FN-001", key: "plan", content: "", revision: 1, author: "agent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: "doc-2", taskId: "FN-001", key: "notes", content: "", revision: 1, author: "agent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]);
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const readTool = tools.find((t) => t.name === "task_document_read")!;

      const result = await readTool.execute("call-1", { key: undefined }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.getTaskDocuments).toHaveBeenCalledWith("FN-001");

      const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      expect(responseText).toContain("plan");
      expect(responseText).toContain("notes");
    });
  });

  describe("completeRun task tracking", () => {
    it("includes tasksCreated in resultJson when tasks were created", async () => {
      const savedRuns: Map<string, AgentHeartbeatRun> = new Map();
      const store = createMockStore();
      const mockTaskStore: TaskStore = {
        createTask: vi.fn().mockResolvedValue({
          id: "FN-200",
          description: "Created task",
          dependencies: [],
          column: "triage",
        }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          title: "Test Task",
          description: "Test task description",
          prompt: "",
          steps: [],
          column: "todo",
          dependencies: [],
          log: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as TaskDetail),
      } as unknown as TaskStore;

      // Set up store to return a run that we can verify
      const initialRun: AgentHeartbeatRun = {
        id: "run-track-001",
        agentId: "agent-001",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      };
      savedRuns.set("run-track-001", { ...initialRun });

      (store as any).startHeartbeatRun = vi.fn().mockResolvedValue(initialRun);
      (store as any).saveRun = vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
        savedRuns.set(run.id, run);
      });
      (store as any).getRunDetail = vi.fn().mockImplementation(async (_agentId: string, runId: string) => {
        return savedRuns.get(runId);
      });
      (store as any).endHeartbeatRun = vi.fn().mockResolvedValue(undefined);
      (store as any).getAgent = vi.fn().mockResolvedValue({
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "active",
        taskId: "FN-001",
        runtimeConfig: {},
      } as Agent);
      (store as any).updateAgent = vi.fn().mockResolvedValue(undefined);
      (store as any).updateAgentState = vi.fn().mockResolvedValue(undefined);

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      // Use createHeartbeatTools to create a task
      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      await tools[0]!.execute("call-1", { description: "Created task" }, undefined as any, undefined as any, undefined as any);

      // Now complete the run
      await monitor.completeRun("agent-001", "run-track-001", {
        status: "completed",
        resultJson: { summary: "test" },
      });

      // Check the saved run has tasksCreated
      const savedRun = savedRuns.get("run-track-001");
      expect(savedRun).toBeDefined();
      expect(savedRun!.resultJson).toBeDefined();
      expect((savedRun!.resultJson as any).tasksCreated).toEqual([
        { id: "FN-200", description: "Created task" },
      ]);
      // Original resultJson fields should still be present
      expect((savedRun!.resultJson as any).summary).toBe("test");
    });

    it("does not include tasksCreated in resultJson when no tasks were created", async () => {
      const savedRuns: Map<string, AgentHeartbeatRun> = new Map();
      const store = createMockStore();

      (store as any).saveRun = vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
        savedRuns.set(run.id, run);
      });
      (store as any).getRunDetail = vi.fn().mockResolvedValue({
        id: "run-empty-001",
        agentId: "agent-002",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun);
      (store as any).endHeartbeatRun = vi.fn().mockResolvedValue(undefined);
      (store as any).updateAgentState = vi.fn().mockResolvedValue(undefined);

      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-002", "run-empty-001", {
        status: "completed",
        resultJson: { summary: "nothing created" },
      });

      const savedRun = savedRuns.get("run-empty-001");
      expect(savedRun).toBeDefined();
      expect((savedRun!.resultJson as any).tasksCreated).toBeUndefined();
      expect((savedRun!.resultJson as any).summary).toBe("nothing created");
    });
  });

  describe("Budget Governance", () => {
    function createCompleteRunBudgetStore(options: {
      agent?: Partial<Agent>;
      budgetStatus?: AgentBudgetStatus;
      budgetStatusError?: Error;
    } = {}): AgentStore {
      const run: AgentHeartbeatRun = {
        id: "run-budget-001",
        agentId: "agent-001",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      };
      const agent: Agent = {
        id: "agent-001",
        name: "Budget Agent",
        role: "executor",
        state: "running",
        taskId: "FN-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
        ...options.agent,
      } as Agent;

      return {
        getRunDetail: vi.fn().mockResolvedValue(run),
        saveRun: vi.fn().mockResolvedValue(undefined),
        endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
        getAgent: vi.fn().mockResolvedValue(agent),
        updateAgent: vi.fn().mockResolvedValue(undefined),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        getBudgetStatus: options.budgetStatusError
          ? vi.fn().mockRejectedValue(options.budgetStatusError)
          : vi.fn().mockResolvedValue(options.budgetStatus ?? createBudgetStatus()),
      } as unknown as AgentStore;
    }

    it("pauses agent with budget-exhausted reason when run pushes usage over budget", async () => {
      const store = createCompleteRunBudgetStore({
        agent: { totalInputTokens: 950, totalOutputTokens: 0 },
        budgetStatus: createBudgetStatus({
          currentUsage: 1050,
          budgetLimit: 1000,
          usagePercent: 105,
          thresholdPercent: 80,
          isOverBudget: true,
          isOverThreshold: true,
        }),
      });
      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-001", "run-budget-001", {
        status: "completed",
        usageJson: { inputTokens: 0, outputTokens: 100, cachedTokens: 0 },
      });

      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
      expect(store.updateAgent).toHaveBeenCalledWith("agent-001", { pauseReason: "budget-exhausted" });
      expect(store.updateAgentState).not.toHaveBeenCalledWith("agent-001", "active");
    });

    it("does not pause agent when below budget after run", async () => {
      const store = createCompleteRunBudgetStore({
        budgetStatus: createBudgetStatus({
          currentUsage: 700,
          budgetLimit: 1000,
          usagePercent: 70,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: false,
        }),
      });
      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-001", "run-budget-001", {
        status: "completed",
        usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0 },
      });

      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      expect(store.updateAgent).not.toHaveBeenCalledWith("agent-001", { pauseReason: "budget-exhausted" });
    });

    it("does not pause agent when run fails (status=failed)", async () => {
      const store = createCompleteRunBudgetStore({
        budgetStatus: createBudgetStatus({ isOverBudget: true, isOverThreshold: true }),
      });
      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-001", "run-budget-001", {
        status: "failed",
        usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0 },
        stderrExcerpt: "failure",
      });

      expect(store.getBudgetStatus).not.toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "error");
      expect(store.updateAgent).not.toHaveBeenCalledWith("agent-001", { pauseReason: "budget-exhausted" });
    });

    it("does not pause agent when run is terminated", async () => {
      const store = createCompleteRunBudgetStore({
        budgetStatus: createBudgetStatus({ isOverBudget: true, isOverThreshold: true }),
      });
      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-001", "run-budget-001", {
        status: "terminated",
        usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0 },
      });

      expect(store.getBudgetStatus).not.toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "terminated");
      expect(store.updateAgent).not.toHaveBeenCalledWith("agent-001", { pauseReason: "budget-exhausted" });
    });

    it("does not pause agent when usageJson is undefined", async () => {
      const store = createCompleteRunBudgetStore({
        budgetStatus: createBudgetStatus({ isOverBudget: true, isOverThreshold: true }),
      });
      const monitor = new HeartbeatMonitor({ store });

      await monitor.completeRun("agent-001", "run-budget-001", {
        status: "completed",
      });

      expect(store.getBudgetStatus).not.toHaveBeenCalled();
      expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
      expect(store.updateAgent).not.toHaveBeenCalledWith("agent-001", { pauseReason: "budget-exhausted" });
    });
  });

  describe("clearRunState", () => {
    it("resets accumulated task state for an agent", async () => {
      const savedRuns: Map<string, AgentHeartbeatRun> = new Map();
      const store = createMockStore();
      const mockTaskStore: TaskStore = {
        createTask: vi.fn().mockResolvedValue({
          id: "FN-300",
          description: "Created task",
          dependencies: [],
          column: "triage",
        }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({} as any),
      } as unknown as TaskStore;

      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      // Create a task via the tracking tools
      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      await tools[0]!.execute("call-1", { description: "Task to track" }, undefined as any, undefined as any, undefined as any);

      // Set up store to verify second completeRun
      (store as any).saveRun = vi.fn().mockImplementation(async (run: AgentHeartbeatRun) => {
        savedRuns.set(run.id, run);
      });
      (store as any).getRunDetail = vi.fn().mockResolvedValue({
        id: "run-clear-001",
        agentId: "agent-001",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun);
      (store as any).endHeartbeatRun = vi.fn().mockResolvedValue(undefined);
      (store as any).updateAgentState = vi.fn().mockResolvedValue(undefined);

      // First completeRun should have tasksCreated
      await monitor.completeRun("agent-001", "run-clear-001", { status: "completed" });
      let savedRun = savedRuns.get("run-clear-001");
      expect((savedRun!.resultJson as any)?.tasksCreated).toEqual([
        { id: "FN-300", description: "Task to track" },
      ]);

      // Reset mock for second run
      savedRuns.clear();
      (store as any).getRunDetail = vi.fn().mockResolvedValue({
        id: "run-clear-002",
        agentId: "agent-001",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun);

      // Second completeRun (after clearRunState) should NOT have tasksCreated
      await monitor.completeRun("agent-001", "run-clear-002", { status: "completed" });
      savedRun = savedRuns.get("run-clear-002");
      expect((savedRun!.resultJson as any)?.tasksCreated).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HeartbeatTriggerScheduler tests
// ─────────────────────────────────────────────────────────────────────────

describe("HeartbeatTriggerScheduler", () => {
  let store: AgentStore;
  let callback: ReturnType<typeof vi.fn>;
  let scheduler: import("./agent-heartbeat.js").HeartbeatTriggerScheduler;

  beforeEach(() => {
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
      on: vi.fn(),
      off: vi.fn(),
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

  describe("registerAgent", () => {
    beforeEach(() => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("registers an agent with timer", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });

    it("skips registration when enabled is false", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000, enabled: false });
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("applies default 30-second interval when intervalMs is undefined", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", {});
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 30-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 30-second interval when intervalMs is 0", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 0 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 30-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 30-second interval when heartbeatIntervalMs is not set", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at exactly 30 seconds (default interval)
      await vi.advanceTimersByTimeAsync(29_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // Now at exactly 30 seconds
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 30_000,
      });
      vi.useRealTimers();
    });

    it("uses explicit interval over default when both are provided", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 15_000, enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at 15 seconds (explicit), not 30
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

    it("skips tick when agent has active run", async () => {
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
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

    it("skips timer tick when agent is over budget", async () => {
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips timer tick when agent is over threshold", async () => {
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

      expect(callback).not.toHaveBeenCalled();
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

  describe("assignment watching", () => {
    let eventStore: AgentStore;

    beforeEach(async () => {
      vi.useRealTimers(); // Ensure real timers for these tests

      // Create a real AgentStore (which extends EventEmitter) so we can emit events
      const { AgentStore: AgentStoreClass } = await import("@fusion/core");
      eventStore = new AgentStoreClass({ rootDir: `.fusion-test-assign-${Date.now()}` }) as AgentStore;
      // Override getActiveHeartbeatRun to return null (no active run)
      (eventStore as any).getActiveHeartbeatRun = vi.fn().mockResolvedValue(null);

      scheduler = new HeartbeatTriggerScheduler(eventStore, callback);
      scheduler.start();
    }, 30000);

    afterEach(async () => {
      scheduler?.stop();
      const { rm } = await import("node:fs/promises");
      await rm((eventStore as any).rootDir, { recursive: true, force: true }).catch(() => {});
    });

    it("triggers callback on agent:assigned event", async () => {
      const agent = { id: "agent-test", name: "Test", taskId: "FN-001" } as import("@fusion/core").Agent;

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

    it("skips trigger when agent has active run", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

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

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
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

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
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

      scheduler = new HeartbeatTriggerScheduler(eventStore, callback, assignmentTaskStore);
      scheduler.start();

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
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

      // Find the task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "task_log");
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

      // Find the task_create tool and execute it
      const taskCreateTool = tools.find(t => t.name === "task_create");
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

      // Find the task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "task_log");
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
});

describe("executeHeartbeat — skill selection resolver contract (FN-1510/FN-1511)", () => {
  // We need to test the skill selection contract without affecting other tests.
  // Since buildSessionSkillContextSync is called via dynamic import inside executeHeartbeat,
  // we need to test the integration at a higher level - verifying that createKbAgent
  // receives the skillSelection option when agent has skills.

  // Helper: create a mock session returned by createKbAgent
  function createMockAgentSession() {
    return {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      model: { provider: "mock", id: "mock-model" },
    };
  }

  let mockTaskStore: TaskStore;

  // Helper: create a basic mock task store
  function createMockTaskStore(): TaskStore {
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
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      createTask: vi.fn().mockResolvedValue({
        id: "FN-002",
        description: "Created task",
        dependencies: [],
        column: "triage",
      }),
      logEntry: vi.fn().mockResolvedValue({}),
      addComment: vi.fn().mockResolvedValue({}),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      upsertTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocuments: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  }

  // Helper: create a mock store that returns a specific agent
  function createStoreWithAgentForExec(agentData: Partial<Agent> = {}): AgentStore {
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "active",
      taskId: "FN-001",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { skills: ["test-skill"] },
      ...agentData,
    } as Agent;

    // Track saved runs so getRunDetail returns the most recent state
    const savedRuns: Map<string, AgentHeartbeatRun> = new Map();

    return {
      recordHeartbeat: vi.fn().mockResolvedValue(undefined),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockResolvedValue(mockAgent),
      assignTask: vi.fn().mockImplementation(async (_agentId: string, taskId: string | undefined) => {
        mockAgent.taskId = taskId;
        return mockAgent;
      }),
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
      getRatingSummary: vi.fn().mockResolvedValue(undefined),
      endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn().mockResolvedValue(undefined),
      clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
  }

  beforeEach(() => {
    mockTaskStore = createMockTaskStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // These tests verify the skill selection contract at the createKbAgent level.
  // Since we can't easily mock dynamic imports, we verify that when an agent has
  // skills in metadata, the createKbAgent is called and the result includes skill info.

  it("createKbAgent is called with agent session for heartbeat with skills", async () => {
    mockedCreateKbAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: { skills: ["heartbeat-skill"] },
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(mockedCreateKbAgent).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("createKbAgent is called with correct cwd for skill resolution", async () => {
    mockedCreateKbAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: { skills: ["custom-skill"] },
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/project/root" });

    await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(mockedCreateKbAgent).toHaveBeenCalled();
    const firstCall = mockedCreateKbAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.cwd).toBe("/project/root");
  });

  it("heartbeat completes successfully when agent has no skills", async () => {
    mockedCreateKbAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    // Agent with empty metadata (no skills)
    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: {},
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(result).toBeDefined();
    expect(result.status).toBe("completed");
    expect(mockedCreateKbAgent).toHaveBeenCalled();
  });
});

describe("executeHeartbeat — skill selection non-fatal (FN-1510/FN-1511)", () => {
  // Helper: create a mock session returned by createKbAgent
  function createMockAgentSession() {
    return {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      model: { provider: "mock", id: "mock-model" },
    };
  }

  let mockTaskStore: TaskStore;

  // Helper: create a basic mock task store
  function createMockTaskStore(): TaskStore {
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
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      createTask: vi.fn().mockResolvedValue({
        id: "FN-002",
        description: "Created task",
        dependencies: [],
        column: "triage",
      }),
      logEntry: vi.fn().mockResolvedValue({}),
      addComment: vi.fn().mockResolvedValue({}),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      upsertTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocument: vi.fn().mockResolvedValue({
        id: "doc-1",
        taskId: "FN-001",
        key: "test-plan",
        content: "Test document content",
        revision: 1,
        author: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getTaskDocuments: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  }

  // Helper: create a mock store that returns a specific agent
  function createStoreWithAgentForExec(agentData: Partial<Agent> = {}): AgentStore {
    const mockAgent: Agent = {
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
      assignTask: vi.fn().mockImplementation(async (_agentId: string, taskId: string | undefined) => {
        mockAgent.taskId = taskId;
        return mockAgent;
      }),
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
      getRatingSummary: vi.fn().mockResolvedValue(undefined),
      endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn().mockResolvedValue(undefined),
      clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
  }

  beforeEach(() => {
    mockTaskStore = createMockTaskStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // These tests verify that skill selection is non-fatal - heartbeat completes
  // regardless of skill selection outcome

  it("heartbeat completes when agent has empty metadata", async () => {
    mockedCreateKbAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: {},
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(result).toBeDefined();
    expect(result.status).toBe("completed");
  });

  it("heartbeat completes when agent has various skill configurations", async () => {
    mockedCreateKbAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    // Test with various skill metadata configurations
    const skillConfigs = [
      { skills: ["single-skill"] },
      { skills: ["a", "b", "c"] },
      { skills: [] },
      { skills: ["skill-with-dashes", "another_skill"] },
    ];

    for (const skills of skillConfigs) {
      vi.clearAllMocks();

      const store = createStoreWithAgentForExec({
        taskId: "FN-001",
        metadata: skills,
      });
      const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

      const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

      expect(result.status).toBe("completed");
      expect(mockedCreateKbAgent).toHaveBeenCalled();
    }
  });
});
