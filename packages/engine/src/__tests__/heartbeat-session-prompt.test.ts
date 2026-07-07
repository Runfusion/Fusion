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
  HEARTBEAT_NO_TASK_PROCEDURE_STRICT,
  HEARTBEAT_NO_TASK_PROCEDURE_LITE,
  HEARTBEAT_NO_TASK_PROCEDURE_OFF,
} from "../agent-heartbeat.js";
import { AgentLogger } from "../agent-logger.js";
import * as agentTools from "../agent-tools.js";
import * as sessionHelpers from "../agent-session-helpers.js";
import { AgentStore as RealAgentStore, TaskStore as RealTaskStore, ChatStore } from "@fusion/core";
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
  });

  it.each([
    ["task-scoped", HEARTBEAT_SYSTEM_PROMPT],
    ["no-task", HEARTBEAT_NO_TASK_SYSTEM_PROMPT],
  ])("FN-7188 keeps no-pause-on-failure guidance in %s heartbeat prompt", (_variant, promptText) => {
    expect(promptText).toMatch(/do NOT call fn_task_pause to handle/i);
    expect(promptText).toContain("Pausing is reserved for explicit user requests for manual control");
    expect(promptText).toMatch(/failed or blocked|failure or blocker/);
    expect(promptText).not.toContain("fn_task_retry");
  });

  describe("FN-5053 no-task heartbeat prompt/tool alignment", () => {
    const FORBIDDEN_NO_TASK_TOOLS = [
      "fn_task_log",
      "fn_task_document_write",
      "fn_task_document_read",
      "fn_task_update",
      "fn_task_done",
    ] as const;

    const REQUIRED_NO_TASK_TOOLS = [
      "fn_task_create",
      "fn_task_list",
      "fn_task_show",
      "fn_task_search",
      "fn_list_agents",
      "fn_delegate_task",
      "fn_get_agent_config",
      "fn_update_agent_config",
      "fn_agent_create",
      "fn_agent_delete",
      "fn_artifact_register",
      "fn_artifact_list",
      "fn_artifact_view",
      "fn_send_message",
      "fn_read_messages",
      "fn_post_room_message",
      "fn_memory_search",
      "fn_memory_get",
      "fn_memory_append",
      "fn_web_fetch",
      "fn_read_evaluations",
      "fn_update_identity",
      "fn_reflect_on_performance",
      "fn_workflow_list",
      "fn_workflow_get",
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_trait_list",
      "fn_research_run",
      "fn_research_list",
      "fn_research_get",
      "fn_research_cancel",
      "fn_ask_question",
      "fn_heartbeat_done",
    ] as const;

    const NO_TASK_PROMPT_VARIANTS = [
      HEARTBEAT_NO_TASK_SYSTEM_PROMPT,
      HEARTBEAT_NO_TASK_PROCEDURE_STRICT,
      HEARTBEAT_NO_TASK_PROCEDURE_LITE,
      HEARTBEAT_NO_TASK_PROCEDURE_OFF,
    ] as const;

    it.each(FORBIDDEN_NO_TASK_TOOLS)("FN-5053 excludes forbidden no-task tool reference %s", (toolName) => {
      for (const promptText of NO_TASK_PROMPT_VARIANTS) {
        expect(promptText).not.toContain(toolName);
      }
    });

    it.each(REQUIRED_NO_TASK_TOOLS)("FN-5053 keeps required no-task tool in inventory: %s", (toolName) => {
      expect(HEARTBEAT_NO_TASK_SYSTEM_PROMPT).toContain(toolName);
    });

    it("FN-5053 keeps no-task procedure persist-progress guidance on ambient tools", () => {
      const expectedPersistLine = "fn_task_create, fn_delegate_task, fn_send_message, fn_memory_append.";
      expect(HEARTBEAT_NO_TASK_PROCEDURE_STRICT).toContain(expectedPersistLine);
      expect(HEARTBEAT_NO_TASK_PROCEDURE_LITE).toContain(expectedPersistLine);
      expect(HEARTBEAT_NO_TASK_PROCEDURE_STRICT).toContain("fn_heartbeat_done");
      expect(HEARTBEAT_NO_TASK_PROCEDURE_LITE).toContain("fn_heartbeat_done");
      expect(HEARTBEAT_NO_TASK_PROCEDURE_OFF).toContain("fn_heartbeat_done");
    });

    it("FN-5053 keeps task-bound task-scoped guidance intact", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_log");
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("fn_task_document_write");
    });
  });

  it("returns task, delegation, and agent-config tools", () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");

    expect(tools).toHaveLength(34);
    expect(tools[0]!.name).toBe("fn_task_create");
    expect(tools[1]!.name).toBe("fn_task_log");
    expect(tools[2]!.name).toBe("fn_task_document_write");
    expect(tools[3]!.name).toBe("fn_task_document_read");
    expect(tools[4]!.name).toBe("fn_artifact_register");
    expect(tools[5]!.name).toBe("fn_artifact_list");
    expect(tools[6]!.name).toBe("fn_artifact_view");
    expect(tools[7]!.name).toBe("fn_list_agents");
    expect(tools[8]!.name).toBe("fn_delegate_task");
    expect(tools[9]!.name).toBe("fn_get_agent_config");
    expect(tools[10]!.name).toBe("fn_update_agent_config");
    expect(tools[11]!.name).toBe("fn_agent_create");
    expect(tools[12]!.name).toBe("fn_agent_delete");
    expect(tools[13]!.name).toBe("fn_goal_list");
    expect(tools[14]!.name).toBe("fn_goal_show");
    expect(tools[15]!.name).toBe("fn_read_evaluations");
    expect(tools[16]!.name).toBe("fn_update_identity");
    expect(tools.slice(17).map((tool) => tool.name)).toEqual([
      "fn_task_list",
      "fn_task_show",
      "fn_task_search",
      "fn_workflow_list",
      "fn_workflow_get",
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_trait_list",
      "fn_ask_question",
      "fn_research_run",
      "fn_research_list",
      "fn_research_get",
      "fn_research_cancel",
      "fn_workflow_select",
      "fn_task_promote",
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain("fn_run_verification");
    expect(tools.map((tool) => tool.name)).not.toContain("fn_acquire_repo_worktree");
  });

  it("heartbeat workflow create/update tools strip approval-bypass flags", async () => {
    const store = createMockStore();
    const captured: { createIr?: any; updateIr?: any } = {};
    const taskStore = createMockTaskStoreForTools({
      createWorkflowDefinition: vi.fn().mockImplementation(async (input: any) => {
        captured.createIr = input.ir;
        return { id: "WF-001", name: input.name };
      }),
      updateWorkflowDefinition: vi.fn().mockImplementation(async (_id: string, input: any) => {
        captured.updateIr = input.ir;
        return { id: "WF-001", name: input.name ?? "wf" };
      }),
    } as Partial<TaskStore>);
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", taskStore, "FN-001");
    const createTool = tools.find((tool) => tool.name === "fn_workflow_create")!;
    const updateTool = tools.find((tool) => tool.name === "fn_workflow_update")!;
    const irWithFlags = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "prompt", kind: "prompt", config: { cliSkipApproval: true } },
        {
          id: "foreach",
          kind: "foreach",
          config: {
            template: {
              nodes: [{ id: "inner", kind: "step-execute", config: { autoApprove: true } }],
              edges: [],
            },
          },
        },
      ],
      edges: [],
    };

    await createTool.execute("call-create", { name: "wf", ir: irWithFlags }, undefined as any, undefined as any, undefined as any);
    await updateTool.execute("call-update", { workflow_id: "WF-001", ir: irWithFlags }, undefined as any, undefined as any, undefined as any);

    expect(captured.createIr.nodes[0].config.cliSkipApproval).toBeUndefined();
    expect(captured.createIr.nodes[1].config.template.nodes[0].config.autoApprove).toBeUndefined();
    expect(captured.updateIr.nodes[0].config.cliSkipApproval).toBeUndefined();
    expect(captured.updateIr.nodes[1].config.template.nodes[0].config.autoApprove).toBeUndefined();
  });

  it("fn_task_create tool creates a task in triage via TaskStore", async () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
    const createTool = tools[0]!;

    const result = await createTool.execute("call-1", { description: "Follow-up task" }, undefined as any, undefined as any, undefined as any);

    // FN-7536+: createTask input no longer carries `column` (defaulted server-side to triage) and now forwards `githubTracking`; objectContaining tolerates the extra key.
    expect(mockTaskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "Follow-up task",
      dependencies: undefined,
      priority: undefined,
      summarize: true,
      source: expect.objectContaining({
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-001",
        sourceRunId: undefined,
        sourceParentTaskId: "FN-001",
        sourceMetadata: expect.objectContaining({
          contentFingerprint: expect.any(String),
        }),
      }),
    }), { settings: {} });

    const responseText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
    expect(responseText).toContain("Created FN-100");
    expect((result.details as any).taskId).toBe("FN-100");
    expect(result.details).toEqual({ taskId: "FN-100" });
  });

  it("fn_task_create forwards explicit priority to TaskStore.createTask", async () => {
    const store = createMockStore();
    const monitor = new HeartbeatMonitor({ store, taskStore: mockTaskStore, rootDir: "/tmp" });

    const tools = monitor.createHeartbeatTools("agent-001", mockTaskStore, "FN-001");
    await tools[0]!.execute("call-1", { description: "Follow-up task", priority: "urgent" }, undefined as any, undefined as any, undefined as any);

    expect(mockTaskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      priority: "urgent",
    }), expect.any(Object));
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
      usageJson: { inputTokens: 0, outputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0 },
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
      usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0 },
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
      usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0 },
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
      usageJson: { inputTokens: 10, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0 },
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

describe("no-task heartbeat tool surface", () => {
  it("adds the approved workflow, research, and clarification tools without task-scoped duplicates", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "hb-no-task-tools-"));
    const globalDir = mkdtempSync(join(tmpdir(), "hb-no-task-global-"));
    const taskStore = new RealTaskStore(rootDir, globalDir, { inMemoryDb: true });
    await taskStore.init();
    const agentStore = new RealAgentStore({ rootDir: taskStore.getFusionDir(), taskStore, inMemoryDb: true });

    const agent = await agentStore.createAgent({
      name: "No Task Tool Agent",
      role: "engineer",
      soul: "Audits ambient project state.",
      runtimeConfig: { enabled: true },
    });

    let capturedCustomTools: string[] = [];
    const createSessionSpy = vi.spyOn(sessionHelpers, "createResolvedAgentSession").mockImplementation(async (options: any) => {
      capturedCustomTools = (options.customTools ?? []).map((tool: any) => tool.name);
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        },
        options,
      } as any;
    });

    try {
      const monitor = new HeartbeatMonitor({
        store: agentStore as unknown as AgentStore,
        taskStore: taskStore as unknown as TaskStore,
        rootDir,
      });

      await monitor.executeHeartbeat({ agentId: agent.id, source: "timer" as any });

      expect(capturedCustomTools).toEqual(expect.arrayContaining([
        "fn_artifact_register",
        "fn_artifact_list",
        "fn_artifact_view",
        "fn_workflow_list",
        "fn_workflow_get",
        "fn_workflow_create",
        "fn_workflow_update",
        "fn_workflow_delete",
        "fn_workflow_settings",
        "fn_trait_list",
        "fn_ask_question",
        "fn_research_run",
        "fn_research_list",
        "fn_research_get",
        "fn_research_cancel",
      ]));
      expect(capturedCustomTools).not.toEqual(expect.arrayContaining([
        "fn_task_log",
        "fn_task_document_write",
        "fn_task_document_read",
        "fn_run_verification",
        "fn_acquire_repo_worktree",
        "fn_workflow_select",
        "fn_task_promote",
      ]));
    } finally {
      createSessionSpy.mockRestore();
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

describe("room-message prompt injection", () => {
  it("includes pending room messages and excludes self-authored room traffic", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "hb-room-prompt-"));
    const globalDir = mkdtempSync(join(tmpdir(), "hb-room-global-"));
    const taskStore = new RealTaskStore(rootDir, globalDir, { inMemoryDb: true });
    await taskStore.init();
    const agentStore = new RealAgentStore({ rootDir: taskStore.getFusionDir(), taskStore, inMemoryDb: true });
    const chatStore = new ChatStore(taskStore.getFusionDir(), taskStore.getDatabase());

    const agent = await agentStore.createAgent({
      name: "Room Prompt Agent",
      role: "engineer",
      soul: "Responds to relevant room updates.",
      runtimeConfig: { enabled: true },
    });
    const room = chatStore.createRoom({ name: "engineering", memberAgentIds: [agent.id] });
    chatStore.addRoomMessage(room.id, { role: "assistant", senderAgentId: agent.id, content: "self message" });
    const otherMessage = chatStore.addRoomMessage(room.id, { role: "user", content: "please investigate the queue" });

    let capturedPrompt = "";
    const createSessionSpy = vi.spyOn(sessionHelpers, "createResolvedAgentSession").mockImplementation(async (options: any) => ({
      session: {
        prompt: async (prompt: string) => {
          capturedPrompt = prompt;
        },
        dispose: vi.fn(),
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      },
      options,
    }) as any);

    try {
      const monitor = new HeartbeatMonitor({
        store: agentStore as unknown as AgentStore,
        taskStore: taskStore as unknown as TaskStore,
        rootDir,
        chatStore,
      });

      await monitor.executeHeartbeat({ agentId: agent.id, source: "timer" as any });

      expect(capturedPrompt).toContain("Pending Room Messages:");
      expect(capturedPrompt).toContain(room.name);
      expect(capturedPrompt).toContain(otherMessage.id);
      expect(capturedPrompt).not.toContain("self message");
    } finally {
      createSessionSpy.mockRestore();
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HeartbeatTriggerScheduler tests
// ─────────────────────────────────────────────────────────────────────────
