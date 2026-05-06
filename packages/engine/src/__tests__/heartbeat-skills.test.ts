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
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
import { createFnAgent } from "../pi.js";
const mockedCreateFnAgent = vi.mocked(createFnAgent);

describe("executeHeartbeat — skill selection resolver contract (FN-1510/FN-1511)", () => {
  // We need to test the skill selection contract without affecting other tests.
  // Since buildSessionSkillContextSync is called via dynamic import inside executeHeartbeat,
  // we need to test the integration at a higher level - verifying that createFnAgent
  // receives the skillSelection option when agent has skills.

  // Helper: create a mock session returned by createFnAgent
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
      appendRunLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
  }

  beforeEach(() => {
    mockTaskStore = createMockTaskStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // These tests verify the skill selection contract at the createFnAgent level.
  // Since we can't easily mock dynamic imports, we verify that when an agent has
  // skills in metadata, the createFnAgent is called and the result includes skill info.

  it("createFnAgent is called with agent session for heartbeat with skills", async () => {
    mockedCreateFnAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: { skills: ["heartbeat-skill"] },
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("createFnAgent is called with correct cwd for skill resolution", async () => {
    mockedCreateFnAgent.mockResolvedValue({
      session: createMockAgentSession(),
    } as any);

    const store = createStoreWithAgentForExec({
      taskId: "FN-001",
      metadata: { skills: ["custom-skill"] },
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/project/root" });

    await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.cwd).toBe("/project/root");
  });

  it("heartbeat completes successfully when agent has no skills", async () => {
    mockedCreateFnAgent.mockResolvedValue({
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
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });
});

describe("executeHeartbeat — skill selection non-fatal (FN-1510/FN-1511)", () => {
  // Helper: create a mock session returned by createFnAgent
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
      appendRunLog: vi.fn().mockResolvedValue(undefined),
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
    mockedCreateFnAgent.mockResolvedValue({
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
    mockedCreateFnAgent.mockResolvedValue({
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
      expect(mockedCreateFnAgent).toHaveBeenCalled();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New observability tests (FN-3xxx sweep)
// ─────────────────────────────────────────────────────────────────────────────

describe("HeartbeatMonitor observability — prompt persistence + run-scoped logs", () => {
  // These tests use the same mock infrastructure as the main executeHeartbeat suite.
  let mockTaskStore: TaskStore;
  let mockAgent: Agent;

  function createMockAgentSession() {
    return {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      model: { provider: "mock", id: "mock-model" },
    };
  }

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
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      createTask: vi.fn().mockResolvedValue({ id: "FN-002", description: "Created task", dependencies: [], column: "triage" }),
      logEntry: vi.fn().mockResolvedValue({}),
      addComment: vi.fn().mockResolvedValue({}),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      upsertTaskDocument: vi.fn().mockResolvedValue({}),
      getTaskDocument: vi.fn().mockResolvedValue(null),
      getTaskDocuments: vi.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as TaskStore;
  }

  function createStoreWithAgent(agentData: Partial<Agent> = {}): AgentStore {
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
        id: "run-obs-001",
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
      appendRunLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
  }

  beforeEach(() => {
    mockTaskStore = createMockTaskStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-task heartbeat run persists systemPrompt and executionPrompt on the run record", async () => {
    // Identity agent (has soul) so a no-task run is triggered
    const store = createStoreWithAgent({ taskId: undefined, soul: "I am the ambient coordinator." });
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

    // saveRun should have been called with both prompt fields populated
    const saveRunCalls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    // Find the call that includes systemPrompt (the prompt-persistence saveRun)
    const promptRunCall = saveRunCalls.find(
      (args: unknown[]) => typeof (args[0] as AgentHeartbeatRun).systemPrompt === "string" && ((args[0] as AgentHeartbeatRun).systemPrompt?.length ?? 0) > 0
    );
    expect(promptRunCall).toBeDefined();
    const savedRun = promptRunCall![0] as AgentHeartbeatRun;
    expect(savedRun.systemPrompt).toBeDefined();
    expect(typeof savedRun.systemPrompt).toBe("string");
    expect(savedRun.executionPrompt).toBeDefined();
    expect(typeof savedRun.executionPrompt).toBe("string");
    // heartbeatProcedureSource should be "default" (no custom procedure file)
    expect(savedRun.heartbeatProcedureSource).toBe("default");

    // The execution prompt should contain the procedure text before the no-task action menu
    expect(savedRun.executionPrompt).toContain("Identity Snapshot");
    expect(savedRun.executionPrompt).toContain("Heartbeat Procedure");
    // The wake delta header should appear before the action menu items
    const procedureIdx = savedRun.executionPrompt!.indexOf("Heartbeat Procedure");
    const actionMenuIdx = savedRun.executionPrompt!.indexOf("No assigned task");
    expect(procedureIdx).toBeLessThan(actionMenuIdx);

    expect(result.status).toBe("completed");
  });

  it("no-task heartbeat run-scoped logs receive at least one entry after a simulated tick", async () => {
    const store = createStoreWithAgent({ taskId: undefined, soul: "I observe the project." });
    const mockSession = createMockAgentSession();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return { session: mockSession as any };
    });

    // Simulate the session emitting a text delta during prompt
    mockSession.prompt = vi.fn().mockImplementation(async () => {
      capturedOnText?.("I am reviewing the project state.");
    });

    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
    await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

    // appendRunLog should have been called on the AgentStore at least once
    const appendRunLogCalls = (store.appendRunLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendRunLogCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the entry shape: agentId, runId, entry
    const [callAgentId, callRunId, callEntry] = appendRunLogCalls[0] as [string, string, unknown];
    expect(callAgentId).toBe("agent-001");
    expect(callRunId).toBe("run-obs-001");
    expect(callEntry).toMatchObject({ type: expect.stringMatching(/^(text|thinking|tool|tool_result|tool_error)$/) });
  });

  it("task-scoped heartbeat persists systemPrompt and executionPrompt with procedure before task content", async () => {
    const store = createStoreWithAgent({ taskId: "FN-001" });
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
    const result = await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

    const saveRunCalls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    const promptRunCall = saveRunCalls.find(
      (args: unknown[]) => typeof (args[0] as AgentHeartbeatRun).systemPrompt === "string" && ((args[0] as AgentHeartbeatRun).systemPrompt?.length ?? 0) > 0
    );
    expect(promptRunCall).toBeDefined();
    const savedRun = promptRunCall![0] as AgentHeartbeatRun;

    // The execution prompt should have procedure before task description
    const procedureIdx = savedRun.executionPrompt!.indexOf("Heartbeat Procedure");
    const taskDescIdx = savedRun.executionPrompt!.indexOf("Task description:");
    expect(procedureIdx).toBeGreaterThanOrEqual(0);
    expect(taskDescIdx).toBeGreaterThanOrEqual(0);
    expect(procedureIdx).toBeLessThan(taskDescIdx);

    // Identity Snapshot should appear in the execution prompt
    expect(savedRun.executionPrompt).toContain("## Identity Snapshot");

    expect(result.status).toBe("completed");
  });

  it("does not register a fn_identity tool (removed in favor of inline snapshot)", async () => {
    const store = createStoreWithAgent({ soul: "I am a senior executor.", memory: "Always log blockers." });
    let capturedTools: any[] | undefined;
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools;
      return { session: mockSession as any };
    });

    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
    await monitor.executeHeartbeat({ agentId: "agent-001", source: "on_demand" });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.find((t) => t.name === "fn_identity")).toBeUndefined();
  });

  it("inlines the Identity Snapshot block into the execution prompt for runtime-agnostic delivery", async () => {
    const store = createStoreWithAgent({
      taskId: undefined,
      soul: "I keep momentum across stalled tasks.",
      memory: "Always log blockers with concrete next steps.",
    });
    const mockSession = createMockAgentSession();
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession as any });

    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });
    await monitor.executeHeartbeat({ agentId: "agent-001", source: "timer" });

    const saveRunCalls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    const promptRunCall = saveRunCalls.find(
      (args: unknown[]) => typeof (args[0] as AgentHeartbeatRun).executionPrompt === "string"
        && ((args[0] as AgentHeartbeatRun).executionPrompt?.length ?? 0) > 0
    );
    expect(promptRunCall).toBeDefined();
    const savedRun = promptRunCall![0] as AgentHeartbeatRun;
    const exec = savedRun.executionPrompt!;

    // Snapshot header + identity fields appear in the execution prompt body itself,
    // so non-pi runtimes (openclaw/hermes/paperclip) that may not propagate
    // customTools still see the agent's identity every tick. Snapshot carries
    // presence flags + content hashes only — full content lives in the system
    // prompt's Custom Instructions section.
    expect(exec).toContain("## Identity Snapshot");
    expect(exec).toContain("- agentId: agent-001");
    expect(exec).toMatch(/- soul: loaded \(\d+ chars, sha256:[0-9a-f]{8}\)/);
    expect(exec).toMatch(/- memory: loaded \(\d+ chars, sha256:[0-9a-f]{8}\)/);
    // Snapshot must NOT contain full preview content (that lives in the system prompt)
    expect(exec).not.toContain("I keep momentum across stalled tasks.");

    // Snapshot must precede the Wake Delta and the Heartbeat Procedure
    const snapIdx = exec.indexOf("## Identity Snapshot");
    const wakeIdx = exec.indexOf("## Wake Delta");
    const procIdx = exec.indexOf("Heartbeat Procedure");
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeLessThan(wakeIdx);
    expect(wakeIdx).toBeLessThan(procIdx);
  });
});

