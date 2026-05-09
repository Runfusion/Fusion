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

  it("heartbeat task-scoped system prompt documents ambient coordination scope", () => {
    expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_log");
    expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_document_write");
    expect(HEARTBEAT_SYSTEM_PROMPT).toContain("executor");
  });

  it("heartbeat no-task system prompt documents coding-capable workspace access without task-scoped tools", () => {
    expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain("coding-capable workspace tools");
    expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_document_write");
    expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_document_read");
    expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).not.toContain("fn_task_log");
  });

  it("returns task, delegation, and agent-config tools", () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");

    expect(tools).toHaveLength(12);
    expect(tools[0]!.name).toBe("fn_task_create");
    expect(tools[1]!.name).toBe("fn_task_log");
    expect(tools[2]!.name).toBe("fn_task_document_write");
    expect(tools[3]!.name).toBe("fn_task_document_read");
    expect(tools[4]!.name).toBe("fn_list_agents");
    expect(tools[5]!.name).toBe("fn_delegate_task");
    expect(tools[6]!.name).toBe("fn_get_agent_config");
    expect(tools[7]!.name).toBe("fn_update_agent_config");
    expect(tools[8]!.name).toBe("fn_agent_create");
    expect(tools[9]!.name).toBe("fn_agent_delete");
    expect(tools[10]!.name).toBe("fn_read_evaluations");
    expect(tools[11]!.name).toBe("fn_update_identity");
  });

  it("fn_task_create tool creates a task in triage via TaskStore", async () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
    const createTool = tools[0]!;

    const result = await createTool.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

    expect(mockTaskStore.createTask).toHaveBeenCalledWith({
      description: "Follow-up task",
      dependencies: undefined,
      column: "triage",
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-001",
        sourceRunId: undefined,
      },
    }, expect.objectContaining({ settings: { autoSummarizeTitles: false } }));

    const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    expect(responseText).toContain("Created FN-100");
    expect((result.details as any).taskId).toBe("FN-100");
    expect(result.details).toEqual({ taskId: "FN-100" });
  });

  it("fn_task_create details includes taskId matching mock store return", async () => {
    const store = createMockStore();
    const matchingStore = createMockTaskStoreForTools({
      createTask: vi.fn().mockResolvedValue({
        id: "ZX-321",
        description: "Follow-up task",
        dependencies: [],
        column: "triage",
      }),
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: matchingStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", matchingStore, "FN-001");
    const result = await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

    expect((result.details as any).taskId).toBe("ZX-321");
  });

  it("fn_task_create tracking uses details.taskId for non-standard ID prefixes", async () => {
    const store = createMockStore();
    const prefixedTaskStore = createMockTaskStoreForTools({
      createTask: vi.fn().mockResolvedValue({
        id: "ABC-999",
        description: "Follow-up task",
        dependencies: [],
        column: "triage",
      }),
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: prefixedTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", prefixedTaskStore, "FN-001");
    await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

    expect(prefixedTaskStore.logEntry).toHaveBeenCalledWith(
      "ABC-999",
      "Created by agent agent-001 during heartbeat run",
      undefined,
      undefined,
    );
  });

  it("fn_task_create tracking falls back to unknown when details has no taskId", async () => {
    const store = createMockStore();
    const createTaskCreateToolSpy = vi.spyOn(agentTools, "createTaskCreateTool").mockReturnValue({
      name: "fn_task_create",
      label: "Create Task",
      description: "Create a task",
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Created PROJ-777: Follow-up task" }],
        details: {},
      }),
    } as any);
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    try {
      const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
      await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "unknown",
        "Created by agent agent-001 during heartbeat run",
        undefined,
        undefined,
      );
    } finally {
      createTaskCreateToolSpy.mockRestore();
    }
  });

  it("fn_task_create tracking handles missing details gracefully", async () => {
    const store = createMockStore();
    const missingDetailsTaskStore = createMockTaskStoreForTools({
      createTask: vi.fn().mockResolvedValue({
        id: undefined,
        description: "Follow-up task",
        dependencies: [],
        column: "triage",
      }),
    });
    const monitor = new HeartbeatMonitor({ store, taskStore: missingDetailsTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", missingDetailsTaskStore, "FN-001");
    const result = await tools[0]!.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

    expect(result).toBeDefined();
    expect(missingDetailsTaskStore.logEntry).toHaveBeenCalledWith(
      "unknown",
      "Created by agent agent-001 during heartbeat run",
      undefined,
      undefined,
    );
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

  it("fn_task_document_write tool persists documents via TaskStore", async () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
    const writeTool = tools.find((t) => t.name === "fn_task_document_write")!;

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

  it("fn_task_document_read tool reads specific document by key", async () => {
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
    const readTool = tools.find((t) => t.name === "fn_task_document_read")!;

    const result = await readTool.execute("call-1", { key: "plan" }, undefined as any, undefined as any, undefined as any);

    expect(mockTaskStore.getTaskDocument).toHaveBeenCalledWith("FN-001", "plan");

    const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    expect(responseText).toContain("plan");
    expect(responseText).toContain("Implementation plan content");
  });

  it("fn_task_document_read tool lists all documents when key is omitted", async () => {
    const store = createMockStore();
    mockTaskStore.getTaskDocuments = vi.fn().mockResolvedValue([
      { id: "doc-1", taskId: "FN-001", key: "plan", content: "", revision: 1, author: "agent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: "doc-2", taskId: "FN-001", key: "notes", content: "", revision: 1, author: "agent", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
    const readTool = tools.find((t) => t.name === "fn_task_document_read")!;

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

  it("keeps terminated as a run status while pausing the agent", async () => {
    const store = createCompleteRunBudgetStore({
      budgetStatus: createBudgetStatus({ isOverBudget: true, isOverThreshold: true }),
    });
    const monitor = new HeartbeatMonitor({ store });

    await monitor.completeRun("agent-001", "run-budget-001", {
      status: "terminated",
      usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0 },
    });

    expect(store.getBudgetStatus).not.toHaveBeenCalled();
    expect(store.updateAgentState).toHaveBeenCalledWith("agent-001", "paused");
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

// ─────────────────────────────────────────────────────────────────────────
// HeartbeatTriggerScheduler tests
// ─────────────────────────────────────────────────────────────────────────
