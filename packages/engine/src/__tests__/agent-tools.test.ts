import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQmdAgentMemoryCollectionAddArgs,
  buildQmdAgentMemorySearchArgs,
  createMemoryTools,
  createTaskCreateTool,
  createAgentTask,
  createDelegateTaskTool,
  createTaskLogTool,
  createTaskLogToolWithContext,
  createSendMessageTool,
  createReadMessagesTool,
  createPostRoomMessageTool,
  createResearchTools,
  createWorkflowListTool,
  createWorkflowGetTool,
  createWorkflowSelectTool,
  createTaskPromoteTool,
  createWorkflowCreateTool,
  createWorkflowUpdateTool,
  createWorkflowDeleteTool,
  createTraitListTool,
  qmdAgentMemoryCollectionName,
  readAgentMemoryWorkspaceLongTerm,
  sendMessageParams,
  readMessagesParams,
} from "../agent-tools.js";
import * as core from "@fusion/core";
import { ChatStore, Database } from "@fusion/core";
import type { MessageStore, Message } from "@fusion/core";
import { getEnabledPluginTools, getResearchToolSurfaceStatus } from "../tool-availability.js";
import { promoteHeldTask } from "../hold-release.js";

vi.mock("../hold-release.js", () => ({
  promoteHeldTask: vi.fn(),
}));
const mockPromoteHeldTask = vi.mocked(promoteHeldTask);

const loggerSpies = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const execFileMock = vi.hoisted(() => vi.fn());
const readdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  readdirMock.mockImplementation(((...args: Parameters<typeof actual.readdir>) => actual.readdir(...args)) as typeof actual.readdir);
  return {
    ...actual,
    readdir: readdirMock,
  };
});

// Mock logger
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: loggerSpies.log,
    warn: loggerSpies.warn,
    error: loggerSpies.error,
  })),
  heartbeatLog: {
    log: loggerSpies.log,
    warn: loggerSpies.warn,
    error: loggerSpies.error,
  },
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

beforeEach(() => {
  vi.spyOn(core, "runDeterministicDuplicateGuard").mockResolvedValue({
    action: "proceed",
    fingerprint: null,
    releaseLock: vi.fn(),
  });
  vi.spyOn(core, "reconcileDeterministicDuplicate").mockImplementation(async (_store, args) => ({
    outcome: "kept",
    canonical: args.createdTask,
  }));
});

describe("tool availability helpers", () => {
  it("treats research surface as disabled when researchView experimental flag is off", () => {
    expect(getResearchToolSurfaceStatus({ experimentalFeatures: { researchView: false } } as any)).toEqual({
      enabled: false,
      reason: "experimental-disabled",
    });
  });

  it("treats research surface as enabled when researchView experimental flag is on", () => {
    expect(getResearchToolSurfaceStatus({ experimentalFeatures: { researchView: true } } as any)).toEqual({
      enabled: true,
      reason: "enabled",
    });
  });

  it("resolves legacy experimental feature aliases through core helper", () => {
    expect(core.isExperimentalFeatureEnabled({ experimentalFeatures: { devServer: true } } as any, "devServerView")).toBe(true);
  });

  it("returns no plugin tools when plugin runner is absent", () => {
    expect(getEnabledPluginTools(undefined)).toEqual([]);
  });
});

describe("createTaskCreateTool", () => {
  it("returns details.taskId and keeps Created <id> response text", async () => {
    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({
        id: "PROJ-042",
        description: "Follow-up task",
        dependencies: ["PROJ-001"],
        column: "triage",
      }),
    };

    const tool = createTaskCreateTool(store as any);
    const result = await tool.execute(
      "call-1",
      {
        description: "Follow-up task",
        dependencies: ["PROJ-001"],
      } as any,
      undefined,
      undefined,
      {} as any,
    );

    expect(store.createTask).toHaveBeenCalledWith({
      description: "Follow-up task",
      dependencies: ["PROJ-001"],
      column: "triage",
      priority: undefined,
      source: undefined,
    }, {
      settings: { autoSummarizeTitles: false },
      onSummarize: undefined,
    });
    expect(result.details).toEqual({ taskId: "PROJ-042" });
    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toContain("Created PROJ-042: Follow-up task");
    expect(responseText).toContain("(depends on: PROJ-001)");
  });

  it("passes explicit priority to store.createTask", async () => {
    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({ id: "PROJ-098", description: "Test", dependencies: [], column: "triage" }),
    };

    const tool = createTaskCreateTool(store as any);

    await tool.execute("call-1", { description: "Test", priority: "high" } as any, undefined, undefined, {} as any);

    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      priority: "high",
    }), expect.objectContaining({ settings: { autoSummarizeTitles: false } }));
  });

  it("passes explicit provenance to store.createTask", async () => {
    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({ id: "PROJ-099", description: "Test", dependencies: [], column: "triage" }),
    };

    const tool = createTaskCreateTool(store as any, {
      sourceType: "agent_heartbeat",
      sourceAgentId: "agent-123",
    });

    await tool.execute("call-1", { description: "Test" } as any, undefined, undefined, {} as any);

    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-123",
        sourceRunId: undefined,
        sourceParentTaskId: undefined,
      },
    }), expect.objectContaining({ settings: { autoSummarizeTitles: false } }));
  });

  it("threads sourceParentTaskId from provenance into store.createTask", async () => {
    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({ id: "PROJ-101", description: "Test", dependencies: [], column: "triage" }),
    };

    const tool = createTaskCreateTool(store as any, {
      sourceType: "agent_heartbeat",
      sourceAgentId: "agent-123",
      sourceRunId: "run-abc",
      sourceParentTaskId: "FN-5206",
    });

    await tool.execute("call-1", { description: "spawn follow-up" } as any, undefined, undefined, {} as any);

    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        sourceType: "agent_heartbeat",
        sourceAgentId: "agent-123",
        sourceRunId: "run-abc",
        sourceParentTaskId: "FN-5206",
      },
    }), expect.anything());
  });

  it("surfaces linked-existing text when deterministic duplicate is found", async () => {
    const existing = { id: "PROJ-500", description: "duplicate", dependencies: [], column: "triage" };
    vi.spyOn(core, "runDeterministicDuplicateGuard").mockResolvedValueOnce({
      action: "duplicate",
      fingerprint: "fp",
      existing: existing as any,
      releaseLock: vi.fn(),
    });

    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      getRootDir: vi.fn().mockReturnValue("/tmp"),
      createTask: vi.fn(),
    };

    const tool = createTaskCreateTool(store as any);
    const result = await tool.execute("call-1", { description: "duplicate" } as any, undefined, undefined, {} as any);

    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toContain("Linked existing PROJ-500: duplicate");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("createAgentTask returns existing task on deterministic duplicate", async () => {
    const created = { id: "FN-200", description: "duplicate", dependencies: [], column: "triage" };
    vi.spyOn(core, "runDeterministicDuplicateGuard")
      .mockResolvedValueOnce({ action: "proceed", fingerprint: "fp", releaseLock: vi.fn() })
      .mockResolvedValueOnce({ action: "duplicate", fingerprint: "fp", existing: created as any, releaseLock: vi.fn() });

    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      getRootDir: vi.fn().mockReturnValue("/tmp"),
      createTask: vi.fn().mockResolvedValue(created),
    };

    const first = await createAgentTask(store as any, { description: "duplicate" } as any);
    const second = await createAgentTask(store as any, { description: "duplicate" } as any);

    expect(first.task.id).toBe("FN-200");
    expect(second.task.id).toBe("FN-200");
    expect(second.wasDuplicate).toBe(true);
    expect(store.createTask).toHaveBeenCalledTimes(1);
  });
});

describe("createDelegateTaskTool", () => {
  it("creates delegated tasks with api source provenance", async () => {
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
    };
    const taskStore = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({ id: "FN-100", dependencies: [], description: "Delegated" }),
    };

    const tool = createDelegateTaskTool(agentStore as any, taskStore as any);
    await tool.execute("call-1", { agent_id: "agent-1", description: "Delegated" } as any, undefined, undefined, {} as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: { sourceType: "api" },
    }), expect.objectContaining({
      settings: { autoSummarizeTitles: false },
    }));
  });

  it("forwards override=true marker in source metadata", async () => {
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-2", name: "Planner", role: "triage", state: "idle" }),
    };
    const taskStore = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      createTask: vi.fn().mockResolvedValue({ id: "FN-102", dependencies: [], description: "Delegated" }),
    };

    const tool = createDelegateTaskTool(agentStore as any, taskStore as any);
    await tool.execute("call-1", { agent_id: "agent-2", description: "Delegated", override: true } as any, undefined, undefined, {} as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
    }), expect.any(Object));
  });

  it("uses linked-existing wording when delegated task is a deterministic duplicate", async () => {
    vi.spyOn(core, "runDeterministicDuplicateGuard").mockResolvedValueOnce({
      action: "duplicate",
      fingerprint: "fp",
      existing: { id: "FN-200", dependencies: [], description: "Delegated", column: "todo" } as any,
      releaseLock: vi.fn(),
    });

    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
    };
    const taskStore = {
      getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
      getRootDir: vi.fn().mockReturnValue("/tmp"),
      createTask: vi.fn(),
    };

    const tool = createDelegateTaskTool(agentStore as any, taskStore as any);
    const result = await tool.execute("call-1", { agent_id: "agent-1", description: "Delegated" } as any, undefined, undefined, {} as any);
    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toContain("Linked existing FN-200");
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("wires title summarization callback when rootDir is provided", async () => {
    const summarizeSpy = vi.spyOn(core, "summarizeTitle").mockResolvedValue("Short title");
    const agentStore = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", name: "Worker", role: "executor", state: "idle" }),
    };
    const taskStore = {
      getSettings: vi.fn().mockResolvedValue({
        autoSummarizeTitles: true,
        titleSummarizerProvider: "openai",
        titleSummarizerModelId: "gpt-4o-mini",
      }),
      createTask: vi.fn().mockResolvedValue({ id: "FN-101", dependencies: [], description: "Delegated" }),
    };

    const tool = createDelegateTaskTool(agentStore as any, taskStore as any, { rootDir: "/repo" });
    await tool.execute("call-1", { agent_id: "agent-1", description: "Delegated" } as any, undefined, undefined, {} as any);

    const options = vi.mocked(taskStore.createTask).mock.calls[0]?.[1] as { onSummarize?: (description: string) => Promise<string | null> };
    expect(options.onSummarize).toBeTypeOf("function");
    await options.onSummarize?.("Long description");
    expect(summarizeSpy).toHaveBeenCalledWith("Long description", "/repo", "openai", "gpt-4o-mini");
    summarizeSpy.mockRestore();
  });
});

describe("createTaskLogTool", () => {
  it("returns a graceful archived read-only message instead of throwing", async () => {
    const store = {
      logEntry: vi.fn().mockRejectedValue(new Error("Task FN-100 is archived — logging is read-only")),
    };

    const tool = createTaskLogTool(store as any, "FN-100");
    const result = await tool.execute(
      "call-1",
      { message: "Important note", outcome: "none" } as any,
      undefined,
      undefined,
      {} as any,
    );

    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toBe("ERROR: Cannot log to archived task — this task is read-only");
  });
});

describe("createWorkflowListTool", () => {
  it("lists workflows with ids and surfaces them in details", async () => {
    const store = {
      listWorkflowDefinitions: vi.fn().mockResolvedValue([
        { id: "builtin:coding", name: "Coding (built-in)", description: "The standard pipeline" },
        { id: "WF-003", name: "QA", description: "" },
      ]),
    };
    const tool = createWorkflowListTool(store as any);
    const result = await tool.execute("call-1", {} as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("builtin:coding: Coding (built-in) — The standard pipeline");
    expect(text).toContain("WF-003: QA");
    expect(result.details).toEqual({ workflowIds: ["builtin:coding", "WF-003"] });
  });

  it("reports when no workflows exist", async () => {
    const store = { listWorkflowDefinitions: vi.fn().mockResolvedValue([]) };
    const tool = createWorkflowListTool(store as any);
    const result = await tool.execute("call-1", {} as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/no workflows/i);
  });
});

describe("createWorkflowGetTool", () => {
  it("returns the definition with builtin flag and full IR as JSON", async () => {
    const ir = {
      version: "v2",
      name: "QA",
      columns: [{ id: "intake", name: "Intake", traits: [] }],
      nodes: [{ id: "n1", kind: "step-execute" }],
      edges: [],
      fields: [{ id: "severity", name: "Severity", type: "enum", options: [{ value: "low", label: "Low" }] }],
    };
    const store = {
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-003", name: "QA", description: "QA flow", ir }),
    };
    const tool = createWorkflowGetTool(store as any);
    const result = await tool.execute("call-1", { workflow_id: "WF-003" } as any, undefined, undefined, {} as any);
    expect(store.getWorkflowDefinition).toHaveBeenCalledWith("WF-003");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ id: "WF-003", name: "QA", description: "QA flow", builtin: false });
    expect(parsed.ir.fields[0].id).toBe("severity");
    expect(result.details).toMatchObject({ workflowId: "WF-003", builtin: false });
  });

  it("marks a builtin id as builtin", async () => {
    const store = {
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        id: "builtin:coding",
        name: "Coding",
        description: "Standard",
        ir: { version: "v2", name: "Coding", columns: [], nodes: [], edges: [] },
      }),
    };
    const tool = createWorkflowGetTool(store as any);
    const result = await tool.execute("call-1", { workflow_id: "builtin:coding" } as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text).builtin).toBe(true);
    expect(result.details).toMatchObject({ builtin: true });
  });

  it("includes layout when the definition carries editor positions", async () => {
    const layout = { n1: { x: 10, y: 20 } };
    const store = {
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        id: "WF-005",
        name: "Laid out",
        description: "",
        ir: { version: "v2", name: "Laid out", columns: [], nodes: [{ id: "n1", kind: "step-execute" }], edges: [] },
        layout,
      }),
    };
    const tool = createWorkflowGetTool(store as any);
    const result = await tool.execute("call-1", { workflow_id: "WF-005" } as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text).layout).toEqual(layout);
    expect(result.details).toMatchObject({ workflowId: "WF-005", layout });
  });

  it("omits layout when the definition has none", async () => {
    const store = {
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        id: "WF-006",
        name: "No layout",
        description: "",
        ir: { version: "v2", name: "No layout", columns: [], nodes: [], edges: [] },
      }),
    };
    const tool = createWorkflowGetTool(store as any);
    const result = await tool.execute("call-1", { workflow_id: "WF-006" } as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).not.toHaveProperty("layout");
    expect(result.details).not.toHaveProperty("layout");
  });

  it("returns an error result for an unknown id", async () => {
    const store = { getWorkflowDefinition: vi.fn().mockResolvedValue(undefined) };
    const tool = createWorkflowGetTool(store as any);
    const result = await tool.execute("call-1", { workflow_id: "WF-404" } as any, undefined, undefined, {} as any);
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/Unknown workflow id 'WF-404'/);
  });
});

describe("createWorkflowSelectTool", () => {
  it("selects for the current task by default and reports enabled step count", async () => {
    const store = {
      selectTaskWorkflowAndReconcile: vi.fn().mockResolvedValue({ enabledWorkflowSteps: ["workflow:WF-003:lint"] }),
    };
    const tool = createWorkflowSelectTool(store as any, "FN-200");
    const result = await tool.execute("call-1", { workflow_id: "WF-003" } as any, undefined, undefined, {} as any);
    expect(store.selectTaskWorkflowAndReconcile).toHaveBeenCalledWith("FN-200", "WF-003");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Selected workflow WF-003 for FN-200 (1 step enabled)");
    expect(result.details).toMatchObject({ taskId: "FN-200", workflowId: "WF-003" });
  });

  it("honors an explicit task_id override", async () => {
    const store = { selectTaskWorkflowAndReconcile: vi.fn().mockResolvedValue({ enabledWorkflowSteps: [] }) };
    const tool = createWorkflowSelectTool(store as any, "FN-200");
    await tool.execute("call-1", { workflow_id: "builtin:coding", task_id: "FN-999" } as any, undefined, undefined, {} as any);
    expect(store.selectTaskWorkflowAndReconcile).toHaveBeenCalledWith("FN-999", "builtin:coding");
  });

  it("surfaces the reconciliation re-home outcome", async () => {
    const store = {
      selectTaskWorkflowAndReconcile: vi.fn().mockResolvedValue({
        enabledWorkflowSteps: [],
        reconciliation: { preserved: false, fromColumn: "review", toColumn: "intake" },
      }),
    };
    const tool = createWorkflowSelectTool(store as any, "FN-200");
    const result = await tool.execute("call-1", { workflow_id: "WF-003" } as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Re-homed from 'review' to 'intake'");
    expect(result.details).toMatchObject({ reconciliation: { preserved: false, fromColumn: "review", toColumn: "intake" } });
  });

  it("returns an error result when selection fails", async () => {
    const store = { selectTaskWorkflowAndReconcile: vi.fn().mockRejectedValue(new Error("Workflow not found: WF-404")) };
    const tool = createWorkflowSelectTool(store as any, "FN-200");
    const result = await tool.execute("call-1", { workflow_id: "WF-404" } as any, undefined, undefined, {} as any);
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/Workflow not found: WF-404/);
  });
});

describe("createTaskPromoteTool", () => {
  beforeEach(() => mockPromoteHeldTask.mockReset());

  it("promotes the current task by default and reports the destination column", async () => {
    const store = {} as any;
    mockPromoteHeldTask.mockResolvedValue({ released: true, toColumn: "ready" });
    const tool = createTaskPromoteTool(store, "FN-200");
    const result = await tool.execute("c", {} as any, undefined, undefined, {} as any);
    expect(mockPromoteHeldTask).toHaveBeenCalledWith(store, "FN-200");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Promoted FN-200 to column 'ready'");
    expect(result.details).toMatchObject({ taskId: "FN-200", released: true, toColumn: "ready" });
  });

  it("honors an explicit task_id and surfaces a rejection as an error", async () => {
    const store = {} as any;
    mockPromoteHeldTask.mockResolvedValue({ released: false, rejection: "not-held" });
    const tool = createTaskPromoteTool(store, "FN-200");
    const result = await tool.execute("c", { task_id: "FN-999" } as any, undefined, undefined, {} as any);
    expect(mockPromoteHeldTask).toHaveBeenCalledWith(store, "FN-999");
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/not-held/);
  });
});

describe("createWorkflowCreateTool", () => {
  it("creates a workflow and returns the new id", async () => {
    const store = { createWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-010", name: "QA" }) };
    const tool = createWorkflowCreateTool(store as any);
    const result = await tool.execute("c", { name: "QA", ir: { columns: [] } } as any, undefined, undefined, {} as any);
    expect(store.createWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ name: "QA", ir: { columns: [] } }),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Created workflow WF-010 (QA)");
  });

  it("returns an error result when creation fails", async () => {
    const store = { createWorkflowDefinition: vi.fn().mockRejectedValue(new Error("Workflow name is required")) };
    const tool = createWorkflowCreateTool(store as any);
    const result = await tool.execute("c", { name: "", ir: {} } as any, undefined, undefined, {} as any);
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/name is required/);
  });

  // R13: the column-agent policy-escalation gate (shared with the dashboard
  // route) must also fire on the agent-tool write path. A binding to an agent
  // whose policy is broader than the project default is rejected unless the
  // tool is called with confirm_policy_escalation: true.
  it("rejects a binding to a more-privileged agent without confirm_policy_escalation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "wf-tool-ca-root-"));
    const globalDir = await mkdtemp(join(tmpdir(), "wf-tool-ca-global-"));
    const store = new core.TaskStore(rootDir, globalDir);
    try {
      await store.init();
      // Restrict the project default; the bound agent is unrestricted (broader).
      await store.updateSettings({ defaultAgentPermissionPolicy: { rules: { file_write_delete: "block" } } } as any);
      const agentStore = new core.AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();
      const agent = await agentStore.createAgent({
        name: "Privileged",
        role: "executor",
        permissionPolicy: { presetId: "unrestricted" },
      } as any);

      const ir = {
        version: "v2",
        name: "bound",
        columns: [
          { id: "triage", name: "Triage", traits: [{ trait: "intake" }], agent: { agentId: agent.id, mode: "override" } },
          { id: "done", name: "Done", traits: [{ trait: "complete" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "triage" },
          { id: "work", kind: "prompt", column: "triage", config: { prompt: "do" } },
          { id: "end", kind: "end", column: "done" },
        ],
        edges: [
          { from: "start", to: "work", condition: "success" },
          { from: "work", to: "end", condition: "success" },
        ],
      };
      const tool = createWorkflowCreateTool(store as any);

      const denied = await tool.execute("c", { name: "Esc", ir } as any, undefined, undefined, {} as any);
      expect((denied as { isError?: boolean }).isError).toBe(true);
      const text = denied.content[0]?.type === "text" ? denied.content[0].text : "";
      expect(text).toMatch(/triage/);
      expect(text).toMatch(/confirm_policy_escalation: true/);
      expect(denied.details).toMatchObject({ columnId: "triage", agentId: agent.id, reason: "policy-escalation" });

      // With the flag set, the gate passes and the store write proceeds.
      const ok = await tool.execute("c", { name: "Esc2", ir, confirm_policy_escalation: true } as any, undefined, undefined, {} as any);
      expect((ok as { isError?: boolean }).isError).toBeFalsy();
      const okText = ok.content[0]?.type === "text" ? ok.content[0].text : "";
      expect(okText).toMatch(/Created workflow/);
    } finally {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
      await rm(globalDir, { recursive: true, force: true });
    }
  });

  // FN-5893: the escalation invariant must hold on ALL workflow write surfaces —
  // the update tool is the second one (the dashboard route has its own tests).
  it("update tool enforces the same policy-escalation gate", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "wf-tool-ca-upd-root-"));
    const globalDir = await mkdtemp(join(tmpdir(), "wf-tool-ca-upd-global-"));
    const store = new core.TaskStore(rootDir, globalDir);
    try {
      await store.init();
      await store.updateSettings({ defaultAgentPermissionPolicy: { rules: { file_write_delete: "block" } } } as any);
      const agentStore = new core.AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();
      const agent = await agentStore.createAgent({
        name: "Privileged",
        role: "executor",
        permissionPolicy: { presetId: "unrestricted" },
      } as any);

      const boundIr = (name: string) => ({
        version: "v2",
        name,
        columns: [
          { id: "triage", name: "Triage", traits: [{ trait: "intake" }], agent: { agentId: agent.id, mode: "override" } },
          { id: "done", name: "Done", traits: [{ trait: "complete" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "triage" },
          { id: "work", kind: "prompt", column: "triage", config: { prompt: "do" } },
          { id: "end", kind: "end", column: "done" },
        ],
        edges: [
          { from: "start", to: "work", condition: "success" },
          { from: "work", to: "end", condition: "success" },
        ],
      });

      // Seed an unbound workflow to update.
      const unbound = { ...boundIr("plain"), columns: boundIr("plain").columns.map(({ agent: _a, ...c }) => c) };
      const created = await store.createWorkflowDefinition({ name: "plain", ir: unbound as any });

      const tool = createWorkflowUpdateTool(store as any);
      const denied = await tool.execute(
        "c",
        { workflow_id: created.id, ir: boundIr("bound") } as any,
        undefined,
        undefined,
        {} as any,
      );
      expect((denied as { isError?: boolean }).isError).toBe(true);
      const text = denied.content[0]?.type === "text" ? denied.content[0].text : "";
      expect(text).toMatch(/triage/);
      expect(text).toMatch(/confirm_policy_escalation: true/);
      expect(denied.details).toMatchObject({ columnId: "triage", agentId: agent.id, reason: "policy-escalation" });

      const ok = await tool.execute(
        "c",
        { workflow_id: created.id, ir: boundIr("bound"), confirm_policy_escalation: true } as any,
        undefined,
        undefined,
        {} as any,
      );
      expect((ok as { isError?: boolean }).isError).toBeFalsy();
      const okText = ok.content[0]?.type === "text" ? ok.content[0].text : "";
      expect(okText).toMatch(/Updated workflow/);
    } finally {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
      await rm(globalDir, { recursive: true, force: true });
    }
  });
});

describe("createWorkflowUpdateTool", () => {
  it("updates a workflow and reports the name", async () => {
    const store = { updateWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-010", name: "QA v2" }) };
    const tool = createWorkflowUpdateTool(store as any);
    const result = await tool.execute("c", { workflow_id: "WF-010", name: "QA v2" } as any, undefined, undefined, {} as any);
    expect(store.updateWorkflowDefinition).toHaveBeenCalledWith("WF-010", expect.objectContaining({ name: "QA v2" }));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Updated workflow WF-010 (QA v2)");
  });

  it("forwards rehome_to as rehomeTo", async () => {
    const store = { updateWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-010", name: "QA" }) };
    const tool = createWorkflowUpdateTool(store as any);
    await tool.execute("c", { workflow_id: "WF-010", ir: { columns: [] }, rehome_to: "intake" } as any, undefined, undefined, {} as any);
    expect(store.updateWorkflowDefinition).toHaveBeenCalledWith("WF-010", expect.objectContaining({ rehomeTo: "intake" }));
  });

  it("surfaces an OccupiedColumnsError as a structured retryable response", async () => {
    const err = new core.OccupiedColumnsError("WF-010", [{ columnId: "review", count: 2 }]);
    const store = { updateWorkflowDefinition: vi.fn().mockRejectedValue(err) };
    const tool = createWorkflowUpdateTool(store as any);
    const result = await tool.execute("c", { workflow_id: "WF-010", ir: { columns: [] } } as any, undefined, undefined, {} as any);
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("review (2)");
    expect(text).toMatch(/rehome_to/);
    expect(result.details).toMatchObject({
      occupiedColumns: [{ columnId: "review", count: 2 }],
      workflowId: "WF-010",
      retryWith: "rehome_to",
    });
  });
});

describe("createWorkflowDeleteTool", () => {
  it("deletes a workflow", async () => {
    const store = { deleteWorkflowDefinition: vi.fn().mockResolvedValue(undefined) };
    const tool = createWorkflowDeleteTool(store as any);
    const result = await tool.execute("c", { workflow_id: "WF-010" } as any, undefined, undefined, {} as any);
    expect(store.deleteWorkflowDefinition).toHaveBeenCalledWith("WF-010");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Deleted workflow WF-010");
  });

  it("surfaces a built-in protection error", async () => {
    const store = {
      deleteWorkflowDefinition: vi.fn().mockRejectedValue(new Error("Built-in workflows cannot be deleted")),
    };
    const tool = createWorkflowDeleteTool(store as any);
    const result = await tool.execute("c", { workflow_id: "builtin:coding" } as any, undefined, undefined, {} as any);
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/cannot be deleted/);
  });
});

describe("createTraitListTool", () => {
  it("lists the trait catalog with ids, names, and flags in details", async () => {
    const tool = createTraitListTool();
    const result = await tool.execute("c", {} as any, undefined, undefined, {} as any);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/Available traits:/);
    const traits = (result.details as { traits?: Array<{ id: string; name: string; flags: unknown }> }).traits ?? [];
    expect(traits.length).toBeGreaterThan(0);
    expect(traits[0]).toHaveProperty("id");
    expect(traits[0]).toHaveProperty("name");
    expect(traits[0]).toHaveProperty("flags");
  });
});

describe("createTaskLogToolWithContext", () => {
  it("returns a graceful archived read-only message instead of throwing", async () => {
    const store = {
      logEntry: vi.fn().mockRejectedValue(new Error("Task FN-101 is ARCHIVED")),
    };
    const runContext = { runId: "run-1", agentId: "agent-1" };

    const tool = createTaskLogToolWithContext(store as any, "FN-101", runContext as any);
    const result = await tool.execute(
      "call-2",
      { message: "Important note", outcome: "none" } as any,
      undefined,
      undefined,
      {} as any,
    );

    const responseText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(responseText).toBe("ERROR: Cannot log to archived task — this task is read-only");
  });
});

describe("createMemoryTools", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return undefined;
    });
    tempDir = await mkdtemp(join(tmpdir(), "agent-memory-tools-"));
  });

  afterEach(async () => {
    delete process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("omits memory tools when memory is disabled", () => {
    expect(createMemoryTools("/repo", { memoryEnabled: false }).map((tool) => tool.name)).toEqual([]);
  });

  it("omits fn_memory_append for read-only memory backends", () => {
    expect(createMemoryTools("/repo", { memoryBackendType: "readonly" }).map((tool) => tool.name)).toEqual([
      "fn_memory_search",
      "fn_memory_get",
    ]);
  });

  it("includes fn_memory_append for writable memory backends", () => {
    const tools = createMemoryTools("/repo", { memoryBackendType: "file" });
    expect(tools.map((tool) => tool.name)).toEqual([
      "fn_memory_search",
      "fn_memory_get",
      "fn_memory_append",
    ]);
    const appendTool = tools.find((tool) => tool.name === "fn_memory_append");
    expect(appendTool?.description).toContain('scope="agent"');
    expect(appendTool?.description).toContain('scope="project"');
  });

  it("searches per-agent memory through the fn_memory_search tool", async () => {
    const [searchTool, getTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });

    const searchResult = await (searchTool as any).execute("call-1", {
      query: "roadmap delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(searchResult.content[0]!.text).toContain(".fusion/agent-memory/ceo-agent/MEMORY.md");
    expect(searchResult.details.results[0].backend).toBe("agent-memory");

    const getResult = await (getTool as any).execute("call-2", {
      path: ".fusion/agent-memory/ceo-agent/MEMORY.md",
      startLine: 1,
      lineCount: 20,
    }, undefined, undefined, undefined);

    expect(getResult.content[0]!.text).toContain("Agent Memory: CEO");
    expect(getResult.content[0]!.text).toContain("roadmap sequencing");
  });

  it("uses project memory backend for fn_memory_search/fn_memory_get when agent memory is absent", async () => {
    await core.ensureOpenClawMemoryFiles(tempDir);
    await appendFile(
      join(tempDir, ".fusion", "memory", "MEMORY.md"),
      "\n- Runtime import regressions should be caught in bundle tests.\n",
      "utf-8",
    );

    const [searchTool, getTool] = createMemoryTools(tempDir, { memoryBackendType: "file" });

    const searchResult = await (searchTool as any).execute("call-project-search", {
      query: "runtime import regressions",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(searchResult.details.results.length).toBeGreaterThan(0);
    expect(searchResult.details.results.some((hit: any) => hit.path === ".fusion/memory/MEMORY.md")).toBe(true);

    const getResult = await (getTool as any).execute("call-project-get", {
      path: ".fusion/memory/MEMORY.md",
      startLine: 1,
      lineCount: 30,
    }, undefined, undefined, undefined);

    expect(getResult.content[0]!.text).toContain(".fusion/memory/MEMORY.md");
    expect(getResult.content[0]!.text).toContain("Runtime import regressions");
    expect(getResult.details.backend).toBe("file");
  });

  it("creates daily and dreams files for per-agent memory lookup", async () => {
    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });

    await (searchTool as any).execute("call-1", {
      query: "roadmap",
      limit: 5,
    }, undefined, undefined, undefined);

    const today = new Date().toISOString().slice(0, 10);
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", "MEMORY.md"), "utf-8"))
      .resolves.toContain("Agent Memory: CEO");
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", "DREAMS.md"), "utf-8"))
      .resolves.toContain("Agent Memory Dreams");
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", `${today}.md`), "utf-8"))
      .resolves.toContain("Agent Daily Memory");
  });

  it("appends to this agent's daily memory through fn_memory_append", async () => {
    const tools = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "fn_memory_append")!;

    const result = await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Follow up with execution agents after roadmap planning.",
    }, undefined, undefined, undefined);

    const today = new Date().toISOString().slice(0, 10);
    await expect(readFile(join(tempDir, ".fusion", "agent-memory", "ceo-agent", `${today}.md`), "utf-8"))
      .resolves.toContain("Follow up with execution agents");
    expect(result.details).toEqual({ scope: "agent", layer: "daily" });
  });

  it("fn_memory_get reads agent dreams returned by fn_memory_search", async () => {
    const [, getTool, appendTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "The CEO agent should prioritize roadmap sequencing and delegation.",
      },
    });
    await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Daily note",
    }, undefined, undefined, undefined);

    const getResult = await (getTool as any).execute("call-2", {
      path: ".fusion/agent-memory/ceo-agent/DREAMS.md",
      startLine: 1,
      lineCount: 10,
    }, undefined, undefined, undefined);

    expect(getResult.content[0]!.text).toContain("Agent Memory Dreams");
  });

  it("builds qmd collection and search args for separate agent memory", () => {
    expect(buildQmdAgentMemoryCollectionAddArgs(tempDir, "ceo-agent")).toEqual([
      "collection",
      "add",
      join(tempDir, ".fusion", "agent-memory", "ceo-agent"),
      "--name",
      qmdAgentMemoryCollectionName(tempDir, "ceo-agent"),
      "--mask",
      "**/*.md",
    ]);
    expect(buildQmdAgentMemorySearchArgs(tempDir, "ceo-agent", "delegation", 7)).toEqual([
      "search",
      "delegation",
      "--json",
      "--collection",
      qmdAgentMemoryCollectionName(tempDir, "ceo-agent"),
      "-n",
      "7",
    ]);
  });

  it("readAgentMemoryWorkspaceLongTerm returns empty string when MEMORY.md is missing", async () => {
    await expect(readAgentMemoryWorkspaceLongTerm(tempDir, "ceo-agent")).resolves.toBe("");
  });

  it("readAgentMemoryWorkspaceLongTerm returns trimmed MEMORY.md contents", async () => {
    const tools = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "fn_memory_append")!;
    await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "long-term",
      content: "  durable memory content  ",
    }, undefined, undefined, undefined);

    await expect(readAgentMemoryWorkspaceLongTerm(tempDir, "ceo-agent")).resolves.toContain("durable memory content");
  });

  it("readAgentMemoryWorkspaceLongTerm reads sanitized agent ids", async () => {
    const tools = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "Agent X/1",
        agentName: "CEO",
        memory: "",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "fn_memory_append")!;
    await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "long-term",
      content: "- sanitized id memory",
    }, undefined, undefined, undefined);

    await expect(readAgentMemoryWorkspaceLongTerm(tempDir, "Agent X/1")).resolves.toContain("sanitized id memory");
  });

  it("logs a warning and continues when agent memory directory read fails", async () => {
    readdirMock.mockRejectedValueOnce(new Error("EACCES"));

    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "file" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });

    const result = await (searchTool as any).execute("call-1", {
      query: "delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(result.content[0]!.text).toContain(".fusion/agent-memory/ceo-agent/MEMORY.md");
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to read agent memory directory"));
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("normalizes qmd agent-memory result paths so fn_memory_get can read dreams and daily layers", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    vi.spyOn(core, "shouldSkipBackgroundQmdRefresh").mockReturnValue(false);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      const commandArgs = args[1] as string[];
      if (typeof callback === "function") {
        if (Array.isArray(commandArgs) && commandArgs[0] === "search") {
          callback(null, JSON.stringify([
            {
              path: "qmd://fusion-agent-memory/.fusion/agent-memory/ceo-agent/DREAMS.md",
              snippet: "Dream insight about delegation confidence",
              lineStart: 1,
              lineEnd: 2,
              score: 0.8,
            },
            {
              path: join(tempDir, ".fusion", "agent-memory", "ceo-agent", "2026-05-01.md"),
              snippet: "Daily note about delegation follow-up",
              lineStart: 1,
              lineEnd: 2,
              score: 0.7,
            },
          ]), "");
          return undefined;
        }
        callback(null, "", "");
      }
      return undefined;
    });

    const [searchTool, getTool, appendTool] = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "",
      },
    });

    await (appendTool as any).execute("call-append-1", {
      scope: "agent",
      layer: "daily",
      content: "- Seed agent memory files",
    }, undefined, undefined, undefined);
    await appendFile(
      join(tempDir, ".fusion/agent-memory/ceo-agent/DREAMS.md"),
      "\n- Dream insight about delegation confidence\n",
      "utf-8",
    );
    await (appendTool as any).execute("call-append-2", {
      scope: "agent",
      layer: "daily",
      content: "- Daily note about delegation follow-up",
    }, undefined, undefined, undefined);

    const result = await (searchTool as any).execute("call-1", {
      query: "delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    const paths = result.details.results.map((hit: any) => hit.path);
    expect(paths.every((path: string) => !path.startsWith("qmd://"))).toBe(true);

    const qmdAgentPaths = result.details.results
      .filter((hit: any) => hit.backend === "qmd-agent-memory")
      .map((hit: any) => hit.path);
    if (qmdAgentPaths.length > 0) {
      expect(qmdAgentPaths).toContain(".fusion/agent-memory/ceo-agent/DREAMS.md");
      expect(qmdAgentPaths.some((path: string) => /\.fusion\/agent-memory\/ceo-agent\/\d{4}-\d{2}-\d{2}\.md$/.test(path))).toBe(true);
    }

    const dreamsRead = await (getTool as any).execute("call-2", {
      path: ".fusion/agent-memory/ceo-agent/DREAMS.md",
      startLine: 1,
      lineCount: 20,
    }, undefined, undefined, undefined);
    expect(dreamsRead.content[0]!.text).toContain("Dream insight about delegation confidence");

    const today = new Date().toISOString().slice(0, 10);
    const dailyRead = await (getTool as any).execute("call-3", {
      path: `.fusion/agent-memory/ceo-agent/${today}.md`,
      startLine: 1,
      lineCount: 20,
    }, undefined, undefined, undefined);
    expect(dailyRead.content[0]!.text).toContain("Daily note about delegation follow-up");
  });

  it("does not short-circuit qmd-backed agent search when inline long-term memory is empty", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    vi.spyOn(core, "shouldSkipBackgroundQmdRefresh").mockReturnValue(false);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      const commandArgs = args[1] as string[];
      if (typeof callback === "function") {
        if (Array.isArray(commandArgs) && commandArgs[0] === "search") {
          callback(null, JSON.stringify([
            {
              path: "DREAMS.md",
              snippet: "Dream-only insight with empty inline memory",
              lineStart: 1,
              lineEnd: 2,
              score: 0.9,
            },
          ]), "");
          return undefined;
        }
        callback(null, "", "");
      }
      return undefined;
    });

    const [searchTool, _getTool, appendTool] = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "   ",
      },
    });

    await (appendTool as any).execute("call-append-seed", {
      scope: "agent",
      layer: "daily",
      content: "- Seed files for dream search",
    }, undefined, undefined, undefined);
    await appendFile(
      join(tempDir, ".fusion/agent-memory/ceo-agent/DREAMS.md"),
      "\n- Dream-only insight with empty inline memory\n",
      "utf-8",
    );

    const result = await (searchTool as any).execute("call-1", {
      query: "dream-only",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(execFileMock).toHaveBeenCalledWith(
      "qmd",
      expect.arrayContaining(["search", "dream-only"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.details.results.length).toBeGreaterThan(0);
    expect(result.details.results.some((hit: any) => String(hit.path).startsWith("qmd://"))).toBe(false);
  });

  it("logs a warning and falls back to file search when qmd search fails", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      const commandArgs = args[1] as string[];
      if (typeof callback === "function") {
        if (Array.isArray(commandArgs) && commandArgs[0] === "search") {
          callback(new Error("qmd search failed"), "", "");
          return undefined;
        }
        callback(null, "", "");
      }
      return undefined;
    });

    const [searchTool] = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });

    const result = await (searchTool as any).execute("call-1", {
      query: "delegation",
      limit: 5,
    }, undefined, undefined, undefined);

    expect(result.details.results[0].backend).toBe("agent-memory");
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("QMD agent memory search failed for agent ceo-agent"));
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("qmd search failed"));
  });

  it("logs a warning when background qmd refresh fails after memory append", async () => {
    process.env.FUSION_ENABLE_QMD_REFRESH_IN_TESTS = "1";
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        callback(new Error("qmd refresh failed"), "", "");
      }
      return undefined;
    });

    const tools = createMemoryTools(tempDir, { memoryBackendType: "qmd" }, {
      agentMemory: {
        agentId: "ceo-agent",
        agentName: "CEO",
        memory: "Roadmap delegation priorities are tracked here.",
      },
    });
    const appendTool = tools.find((tool) => tool.name === "fn_memory_append")!;

    const result = await (appendTool as any).execute("call-1", {
      scope: "agent",
      layer: "daily",
      content: "- Follow up on delegated roadmap work.",
    }, undefined, undefined, undefined);

    expect(result.content[0]!.text).toContain("Appended to agent daily memory.");
    await vi.waitFor(() => {
      expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("Agent memory QMD index refresh failed for ceo-agent"));
    });
    expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringContaining("qmd refresh failed"));
  });
});

function createMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: "msg-001",
    fromId: "user-1",
    fromType: "user",
    toId: "agent-1",
    toType: "agent",
    content: "Test message",
    type: "agent-to-agent",
    read: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockMessageStore(overrides: Partial<MessageStore> = {}): MessageStore {
  return {
    sendMessage: vi.fn(),
    getInbox: vi.fn().mockReturnValue([]),
    getMessage: vi.fn().mockReturnValue(null),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    ...overrides,
  } as unknown as MessageStore;
}

describe("createSendMessageTool", () => {
  let messageStore: ReturnType<typeof createMockMessageStore>;
  let tool: ReturnType<typeof createSendMessageTool>;

  beforeEach(() => {
    messageStore = createMockMessageStore();
    tool = createSendMessageTool(messageStore, "agent-sender");
  });

  // Helper to call tool execute with correct signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeTool = async (tool: any, params: unknown) => {
    return tool.execute("call-1", params, undefined, undefined, undefined);
  };

  it("creates a tool with name 'fn_send_message'", () => {
    expect(tool.name).toBe("fn_send_message");
  });

  it("creates a tool with correct label", () => {
    expect(tool.label).toBe("Send Message");
  });

  it("creates a tool with a description mentioning recipient waking and reply linking", () => {
    expect(tool.description).toContain("messageResponseMode");
    expect(tool.description).toContain("reply_to_message_id");
  });

  it("calls messageStore.sendMessage with correct parameters", async () => {
    const mockMessage = createMessage({ id: "msg-123" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    const result = await executeTool(tool, {
      to_id: "agent-recipient",
      content: "Hello, world!",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith({
      fromId: "agent-sender",
      fromType: "agent",
      toId: "agent-recipient",
      toType: "agent",
      content: "Hello, world!",
      type: "agent-to-agent",
    });
    expect(result.content[0]).toEqual({ type: "text", text: "Message sent to agent-recipient (ID: msg-123)" });
    expect(result.details).toEqual({ messageId: "msg-123" });
  });

  it("defaults type to 'agent-to-agent' when not specified", async () => {
    const mockMessage = createMessage();
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-agent" })
    );
  });

  it.each(["dashboard", "user:dashboard", "User: user:dashboard"])(
    "infers agent-to-user when type is omitted for dashboard alias '%s'",
    async (dashboardAlias) => {
      const mockMessage = createMessage({ toId: "dashboard", toType: "user", type: "agent-to-user" });
      vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

      await executeTool(tool, {
        to_id: dashboardAlias,
        content: "Test",
      });

      expect(messageStore.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ toId: "dashboard", toType: "user", type: "agent-to-user" }),
      );
    },
  );

  it("uses provided type when specified and maps recipient type for agent-to-user", async () => {
    const mockMessage = createMessage({ toType: "user", type: "agent-to-user" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "user-1",
      content: "Test",
      type: "agent-to-user",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-user", toType: "user" })
    );
  });

  it.each(["dashboard", "user:dashboard", "User: user:dashboard"])(
    "canonicalizes dashboard alias '%s' for agent-to-user sends",
    async (dashboardAlias) => {
      const mockMessage = createMessage({ toId: "dashboard", toType: "user", type: "agent-to-user" });
      vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

      await executeTool(tool, {
        to_id: dashboardAlias,
        content: "Status",
        type: "agent-to-user",
      });

      expect(messageStore.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ toId: "dashboard", toType: "user", type: "agent-to-user" }),
      );
    },
  );

  it("maps recipient type to agent for agent-to-agent messages", async () => {
    const mockMessage = createMessage({ toType: "agent", type: "agent-to-agent" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
      type: "agent-to-agent",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent-to-agent", toType: "agent" })
    );
  });

  it("persists reply metadata when reply_to_message_id is provided", async () => {
    const mockMessage = createMessage({ id: "msg-reply" });
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    await executeTool(tool, {
      to_id: "agent-2",
      content: "Following up",
      reply_to_message_id: "msg-original",
    });

    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { replyTo: { messageId: "msg-original" } } })
    );
  });

  it("rejects blank reply_to_message_id", async () => {
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "Following up",
      reply_to_message_id: "   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: reply_to_message_id must be a non-empty string" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error for empty content", async () => {
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Message content cannot be empty" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error for content exceeding 2000 characters", async () => {
    const longContent = "a".repeat(2001);
    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: longContent,
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Message content exceeds 2000 character limit" });
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("returns error when messageStore.sendMessage throws", async () => {
    vi.mocked(messageStore.sendMessage).mockImplementation(() => {
      throw new Error("Database error");
    });

    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "Test",
    });

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Failed to send message: Database error" });
  });

  it("trims content before validation", async () => {
    const mockMessage = createMessage();
    vi.mocked(messageStore.sendMessage).mockReturnValue(mockMessage);

    const result = await executeTool(tool, {
      to_id: "agent-2",
      content: "   test   ",
    });

    expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("Message sent") });
    expect(messageStore.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "test" })
    );
  });
});

describe("createPostRoomMessageTool", () => {
  let roomDir: string;
  let fusionDir: string;
  let db: Database;
  let chatStore: ChatStore;

  beforeEach(() => {
    roomDir = join(tmpdir(), `fusion-room-tool-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fusionDir = join(roomDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    chatStore = new ChatStore(fusionDir, db);
  });

  afterEach(() => {
    db.close();
  });

  it("posts to a room when the agent is a member", async () => {
    const room = chatStore.createRoom({ name: "ops", memberAgentIds: ["agent-sender"] });
    const tool = createPostRoomMessageTool(chatStore, "agent-sender");

    const result = await tool.execute("call-1", {
      roomId: room.id,
      content: "  Ready to help  ",
      mentions: ["agent-2"],
    } as any, undefined, undefined, {} as any);

    const messages = chatStore.getRoomMessages(room.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      senderAgentId: "agent-sender",
      content: "Ready to help",
      mentions: ["agent-2"],
    });
    expect(result.details).toEqual({ messageId: messages[0]!.id });
  });

  it("blocks non-members from posting", async () => {
    const room = chatStore.createRoom({ name: "ops", memberAgentIds: ["agent-other"] });
    const tool = createPostRoomMessageTool(chatStore, "agent-sender");

    const result = await tool.execute("call-1", {
      roomId: room.id,
      content: "Hello",
    } as any, undefined, undefined, {} as any);

    expect(result.content[0]).toEqual({
      type: "text",
      text: `ERROR: Agent agent-sender is not a member of room ${room.id}`,
    });
    expect(chatStore.getRoomMessages(room.id)).toHaveLength(0);
  });

  it("stores reply metadata when replyToMessageId is provided", async () => {
    const room = chatStore.createRoom({ name: "ops", memberAgentIds: ["agent-sender"] });
    const tool = createPostRoomMessageTool(chatStore, "agent-sender");

    await tool.execute("call-1", {
      roomId: room.id,
      content: "Replying",
      replyToMessageId: "rmsg-parent",
    } as any, undefined, undefined, {} as any);

    expect(chatStore.getRoomMessages(room.id)[0]?.metadata).toEqual({ replyToMessageId: "rmsg-parent" });
  });
});

describe("createResearchTools", () => {
  const baseSettings = {
    researchGlobalEnabled: true,
    researchGlobalMaxConcurrentRuns: 2,
    researchGlobalDefaultTimeout: 30_000,
    researchGlobalMaxSynthesisRounds: 2,
    researchGlobalWebSearchProvider: "builtin",
    researchSettings: { enabled: true },
  };

  function createStoreMock(overrides: Record<string, unknown> = {}) {
    const runs = new Map<string, any>();
    const researchStore = {
      createRun: vi.fn().mockImplementation((input: any) => {
        const run = {
          id: "RES-001",
          query: input.query,
          status: "pending",
          providerConfig: input.providerConfig,
          sources: [],
          events: [],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        runs.set(run.id, run);
        return run;
      }),
      getRun: vi.fn((id: string) => runs.get(id) ?? null),
      listRuns: vi.fn(() => [...runs.values()]),
      updateRun: vi.fn((id: string, updates: any) => {
        const existing = runs.get(id);
        if (!existing) return null;
        const next = { ...existing, ...updates, updatedAt: new Date().toISOString() };
        runs.set(id, next);
        return next;
      }),
      updateStatus: vi.fn((id: string, status: string) => {
        const existing = runs.get(id);
        if (!existing) return null;
        const next = { ...existing, status, updatedAt: new Date().toISOString() };
        runs.set(id, next);
        return next;
      }),
      addEvent: vi.fn(),
      addSource: vi.fn(),
      updateSource: vi.fn(),
      setResults: vi.fn(),
    };
    return {
      runs,
      store: {
        getResearchStore: vi.fn(() => researchStore),
        ...overrides,
      },
      researchStore,
    };
  }

  it("returns actionable disabled response when research is off", async () => {
    const { store } = createStoreMock();
    const tools = createResearchTools({
      store: store as any,
      rootDir: process.cwd(),
      getSettings: async () => ({ ...baseSettings, researchSettings: { enabled: false } } as any),
    });

    const runTool = tools.find((tool) => tool.name === "fn_research_run")!;
    const result = await (runTool as any).execute("call-1", { query: "fusion" }, undefined, undefined, undefined);

    expect(result.details.setup.code).toBe("feature-disabled");
    expect(result.content[0].text).toContain("Research is disabled");
  });

  it("starts research and returns structured run details", async () => {
    const { store, researchStore, runs } = createStoreMock();
    const tools = createResearchTools({
      store: store as any,
      rootDir: process.cwd(),
      getSettings: async () => ({ ...baseSettings, researchGlobalTavilyApiKey: "key", researchGlobalWebSearchProvider: "tavily" } as any),
    });

    const runTool = tools.find((tool) => tool.name === "fn_research_run")!;
    const result = await (runTool as any).execute("call-1", { query: "fusion roadmap" }, undefined, undefined, undefined);

    expect(researchStore.createRun).toHaveBeenCalled();
    expect(result.details).toMatchObject({ runId: "RES-001", status: "pending", findings: [], citations: [] });
    runs.set("RES-001", { ...runs.get("RES-001"), status: "completed", results: { summary: "Done", findings: [], citations: [] } });

    const getTool = tools.find((tool) => tool.name === "fn_research_get")!;
    const getResult = await (getTool as any).execute("call-2", { id: "RES-001" }, undefined, undefined, undefined);
    expect(getResult.details.summary).toBe("Done");
  });

  it("returns not-found metadata for missing runs", async () => {
    const { store } = createStoreMock();
    const tools = createResearchTools({
      store: store as any,
      rootDir: process.cwd(),
      getSettings: async () => ({ ...baseSettings } as any),
    });

    const getTool = tools.find((tool) => tool.name === "fn_research_get")!;
    const result = await (getTool as any).execute("call-1", { id: "RES-404" }, undefined, undefined, undefined);
    expect(result.details.status).toBe("missing");
  });
});

describe("createReadMessagesTool", () => {
  let messageStore: ReturnType<typeof createMockMessageStore>;
  let tool: ReturnType<typeof createReadMessagesTool>;

  beforeEach(() => {
    messageStore = createMockMessageStore();
    tool = createReadMessagesTool(messageStore, "agent-1");
  });

  // Helper to call tool execute with correct signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeTool = async (tool: any, params: unknown) => {
    return tool.execute("call-1", params, undefined, undefined, undefined);
  };

  it("creates a tool with name 'fn_read_messages'", () => {
    expect(tool.name).toBe("fn_read_messages");
  });

  it("creates a tool with correct label", () => {
    expect(tool.label).toBe("Read Messages");
  });

  it("creates a tool with description mentioning unread messages", () => {
    expect(tool.description).toContain("unread messages");
  });

  it("calls messageStore.getInbox with correct agent ID", async () => {
    await executeTool(tool, {});

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", expect.any(Object));
  });

  it("defaults to unread_only: true", async () => {
    await executeTool(tool, {});

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      read: false,
      limit: 20,
    });
  });

  it("uses provided unread_only value", async () => {
    await executeTool(tool, { unread_only: false });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      limit: 20,
    });
  });

  it("uses provided limit value", async () => {
    await executeTool(tool, { limit: 5 });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", {
      read: false,
      limit: 5,
    });
  });

  it("returns 'No messages' when inbox is empty", async () => {
    vi.mocked(messageStore.getInbox).mockReturnValue([]);

    const result = await executeTool(tool, {});

    expect(result.content[0]).toEqual({ type: "text", text: "No messages" });
  });

  it("returns formatted message list with message IDs, sender, content, and timestamp", async () => {
    const messages = [
      createMessage({
        id: "msg-1",
        fromId: "agent-2",
        fromType: "agent",
        content: "Hello there",
        createdAt: "2024-01-15T10:30:00.000Z",
        read: false,
      }),
      createMessage({
        id: "msg-2",
        fromId: "user-1",
        fromType: "user",
        content: "Another message",
        createdAt: "2024-01-15T11:00:00.000Z",
        read: true,
      }),
    ];
    vi.mocked(messageStore.getInbox).mockReturnValue(messages);

    const result = await executeTool(tool, {});

    const text = result.content[0];
    expect(text).toMatchObject({ type: "text" });
    expect((text as { text: string }).text).toContain("Messages (2)");
    expect((text as { text: string }).text).toContain("[unread] [id: msg-1] [from: agent:agent-2] Hello there");
    expect((text as { text: string }).text).toContain("[read] [id: msg-2] [from: user:user-1] Another message");
    expect(result.details).toEqual({ messages, threadContext: [] });
  });

  it("includes reply-parent context inline and in details when message links to a parent", async () => {
    const child = createMessage({
      id: "msg-child",
      content: "Follow-up question",
      metadata: { replyTo: { messageId: "msg-parent" } } as any,
    });
    const parent = createMessage({
      id: "msg-parent",
      fromId: "agent-9",
      fromType: "agent",
      content: "Parent message context",
    });
    vi.mocked(messageStore.getInbox).mockReturnValue([child]);
    vi.mocked(messageStore.getMessage).mockReturnValue(parent);

    const result = await executeTool(tool, {});
    const text = result.content[0] as { type: string; text: string };

    expect(text.text).toContain("↳ reply-to [id: msg-parent] [from: agent:agent-9] Parent message context");
    expect(result.details).toEqual({
      messages: [child],
      threadContext: [{
        messageId: "msg-child",
        replyTo: {
          parentMessageId: "msg-parent",
          parentMessage: parent,
          missingParent: false,
        },
      }],
    });
  });

  it("surfaces missing-parent context without changing base inbox behavior", async () => {
    const child = createMessage({
      id: "msg-child",
      content: "Follow-up question",
      metadata: { replyTo: { messageId: "msg-missing" } } as any,
    });
    vi.mocked(messageStore.getInbox).mockReturnValue([child]);
    vi.mocked(messageStore.getMessage).mockReturnValue(null);

    const result = await executeTool(tool, {});
    const text = result.content[0] as { type: string; text: string };

    expect(text.text).toContain("↳ reply-to [id: msg-missing] (missing parent message)");
    expect(result.details).toEqual({
      messages: [child],
      threadContext: [{
        messageId: "msg-child",
        replyTo: {
          parentMessageId: "msg-missing",
          parentMessage: null,
          missingParent: true,
        },
      }],
    });
    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", { read: false, limit: 20 });
  });

  it("returns error when messageStore.getInbox throws", async () => {
    vi.mocked(messageStore.getInbox).mockImplementation(() => {
      throw new Error("Database error");
    });

    const result = await executeTool(tool, {});

    expect(result.content[0]).toEqual({ type: "text", text: "ERROR: Failed to read messages: Database error" });
  });

  it("uses default limit of 20", async () => {
    vi.mocked(messageStore.getInbox).mockReturnValue([]);

    await executeTool(tool, { unread_only: false });

    expect(messageStore.getInbox).toHaveBeenCalledWith("agent-1", "agent", { limit: 20 });
  });
});

describe("sendMessageParams schema", () => {
  it("is defined and exported", () => {
    expect(sendMessageParams).toBeDefined();
  });
});

describe("readMessagesParams schema", () => {
  it("is defined and exported", () => {
    expect(readMessagesParams).toBeDefined();
  });
});
