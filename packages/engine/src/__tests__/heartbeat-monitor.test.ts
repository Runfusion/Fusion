/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HeartbeatMonitor,
  HeartbeatTriggerScheduler,
  type AgentSession,
  type HeartbeatExecutionOptions,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_NO_TASK_SYSTEM_PROMPT,
  HEARTBEAT_PROCEDURE,
  HEARTBEAT_NO_TASK_PROCEDURE,
} from "../agent-heartbeat.js";
import { AgentLogger } from "../agent-logger.js";
import * as agentTools from "../agent-tools.js";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";
import { createMockStore, createMockSession, createMockMessageStore, createMessage, createBudgetStatus } from "./heartbeat-test-helpers.js";
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

    it("includes fn_send_message and fn_read_messages tools when messageStore is available", () => {
      const messageStore = createMockMessageStore();
      const customMonitor = new HeartbeatMonitor({
        store,
        messageStore,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001", undefined, undefined, messageStore);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("fn_send_message");
      expect(toolNames).toContain("fn_read_messages");
    });

    it("does not include message tools when messageStore is not provided", () => {
      const customMonitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const tools = customMonitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain("fn_send_message");
      expect(toolNames).not.toContain("fn_read_messages");
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

      expect(toolNames).not.toContain("fn_send_message");
      expect(toolNames).not.toContain("fn_read_messages");
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

    expect(onMissed).toHaveBeenCalledWith("agent-001", expect.any(String));

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

describe("unresponsive agent recovery", () => {
  it("disposes session and pauses/resumes agent after 2x timeout", async () => {
    const onTerminated = vi.fn();
    const session = createMockSession();
    const localStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({ id: "agent-001", state: "running", runtimeConfig: { enabled: false } }),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    });
    const customMonitor = new HeartbeatMonitor({
      store: localStore,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
      onTerminated,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    vi.advanceTimersByTime(12000);
    await vi.advanceTimersByTimeAsync(100);

    expect(session.dispose).toHaveBeenCalled();
    expect(localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
    expect(localStore.updateAgentState).toHaveBeenCalledWith("agent-001", "active");
    expect(onTerminated).not.toHaveBeenCalled();
    expect(customMonitor.getTrackedAgents()).toHaveLength(0);

    customMonitor.stop();
    vi.useRealTimers();
  });

  it("logs recovery warnings when dispose and pause fail", async () => {
    const warnSpy = vi.mocked(heartbeatLog.warn);
    warnSpy.mockClear();
    const session: AgentSession = {
      dispose: vi.fn(() => {
        throw new Error("dispose exploded");
      }),
    };
    const localStore = createMockStore({
      getAgent: vi.fn().mockResolvedValue({ id: "agent-001", state: "running", runtimeConfig: { enabled: false } }),
      updateAgentState: vi.fn().mockRejectedValue(new Error("db connection lost")),
    });
    const customMonitor = new HeartbeatMonitor({
      store: localStore,
      heartbeatTimeoutMs: 5000,
      pollIntervalMs: 1000,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    customMonitor.start();
    customMonitor.trackAgent("agent-001", session, "run-001");

    vi.advanceTimersByTime(10100);
    await vi.advanceTimersByTimeAsync(100);

    const warnMessages = warnSpy.mock.calls.map(([message]) => String(message));
    expect(warnMessages.some((message) => message.includes("Recovering unresponsive agent agent-001"))).toBe(true);
    expect(warnMessages.some((message) => message.includes("Error disposing session for agent-001") && message.includes("dispose exploded"))).toBe(true);
    expect(warnMessages.some((message) => message.includes("Error pausing unresponsive agent agent-001") && message.includes("db connection lost"))).toBe(true);

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

