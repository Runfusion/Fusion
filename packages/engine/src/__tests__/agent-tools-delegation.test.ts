import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent, AgentStore, TaskStore, Task, TaskCreateInput } from "@fusion/core";
import { createAgentTask, createListAgentsTool, createDelegateTaskTool, createTaskCreateTool } from "../agent-tools.js";

function createMockAgentStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    resolveCurrentTaskLink: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as AgentStore;
}

const APPROVED_LINEAGE = { mission_id: "M-001", slice_id: "SL-001", feature_id: "F-001" };

function createMockTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  const missionStore = {
    getFeature: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "triaged" }),
    getFeatureByTaskId: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "triaged" }),
    getSlice: vi.fn().mockResolvedValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
    getMilestone: vi.fn().mockResolvedValue({ id: "MS-001", missionId: "M-001", status: "active" }),
    getMission: vi.fn().mockResolvedValue({ id: "M-001", status: "active" }),
  };
  return {
    getMissionStore: vi.fn().mockReturnValue(missionStore),
    getSettings: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    getRootDir: vi.fn().mockReturnValue("/project"),
    searchTasks: vi.fn().mockResolvedValue([]),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    findRecentTasksByContentFingerprint: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    createTask: vi.fn().mockResolvedValue({
      id: "FN-001",
      description: "",
      dependencies: [],
      column: "triage" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    ...overrides,
  } as unknown as TaskStore;
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: "agent-001",
    name: "Test Agent",
    role: "executor",
    state: "idle",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

describe("createListAgentsTool", () => {
  let agentStore: AgentStore;

  beforeEach(() => {
    agentStore = createMockAgentStore();
  });

  it("returns formatted list of agents with their details", async () => {
    const agents = [
      createAgent({ id: "agent-001", name: "Alice", role: "executor", state: "idle", taskId: undefined }),
      createAgent({ id: "agent-002", name: "Bob", role: "reviewer", state: "running", taskId: "FN-100" }),
    ];
    vi.mocked(agentStore.listAgents).mockResolvedValue(agents);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    expect(result.content[0]).toHaveProperty("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Available agents:");
    expect(text).toContain("ID: agent-001");
    expect(text).toContain("Name: Alice");
    expect(text).toContain("Role: executor");
    expect(text).toContain("State: idle");
    expect(text).toContain("ID: agent-002");
    expect(text).toContain("Name: Bob");
    expect(text).toContain("Role: reviewer");
    expect(text).toContain("State: running");
    expect(text).toContain("Current Task: FN-100 (unresolved)");
  });

  it("shows linked task columns for triage and in-progress task links", async () => {
    const agents = [
      createAgent({ id: "agent-triage", name: "Planner", taskId: "FN-200" }),
      createAgent({ id: "agent-active", name: "Runner", taskId: "FN-201" }),
    ];
    vi.mocked(agentStore.listAgents).mockResolvedValue(agents);
    vi.mocked(agentStore.resolveCurrentTaskLink).mockImplementation(async (taskId: string) => {
      if (taskId === "FN-200") return { id: taskId, column: "triage" as const };
      if (taskId === "FN-201") return { id: taskId, column: "in-progress" as const };
      return null;
    });

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Current Task: FN-200 (triage)");
    expect(text).toContain("Current Task: FN-201 (in-progress)");
    expect(text).not.toMatch(/Current Task: FN-200(?! \()/);
    expect(text).not.toMatch(/Current Task: FN-201(?! \()/);
  });

  it("marks missing and terminal linked tasks without throwing", async () => {
    const agents = [
      createAgent({ id: "agent-missing", name: "Missing", taskId: "FN-300" }),
      createAgent({ id: "agent-done", name: "Done", taskId: "FN-301" }),
    ];
    vi.mocked(agentStore.listAgents).mockResolvedValue(agents);
    vi.mocked(agentStore.resolveCurrentTaskLink).mockImplementation(async (taskId: string) => {
      if (taskId === "FN-301") return { id: taskId, column: "done" as const };
      return null;
    });

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Current Task: FN-300 (unresolved)");
    expect(text).toContain("Current Task: FN-301 (not active — done)");
  });

  it("includes soul truncated to 200 chars when present", async () => {
    const longSoul = "A".repeat(300);
    const agent = createAgent({ id: "agent-001", soul: longSoul });
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent]);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Soul: " + "A".repeat(200));
    expect(text).not.toContain("Soul: " + "A".repeat(201));
  });

  it("includes title when present", async () => {
    const agent = createAgent({ id: "agent-001", title: "Senior Engineer" });
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent]);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Title: Senior Engineer");
  });

  it("includes instructionsText summary when present", async () => {
    const agent = createAgent({ id: "agent-001", instructionsText: "Be thorough and check edge cases." });
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent]);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Custom Instructions: Be thorough and check edge cases.");
  });

  it("includes instructionsText truncated to 100 chars with ellipsis", async () => {
    const longInstructions = "X".repeat(150);
    const agent = createAgent({ id: "agent-001", instructionsText: longInstructions });
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent]);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Custom Instructions: " + "X".repeat(100) + "…");
    expect(text).not.toContain("Custom Instructions: " + "X".repeat(101));
  });

  it("filters by role when provided", async () => {
    const tool = createListAgentsTool(agentStore);
    await tool.execute("session-1", { role: "executor" }, undefined as any, undefined as any, undefined as any);

    expect(agentStore.listAgents).toHaveBeenCalledWith({ role: "executor" });
  });

  it("filters by state when provided", async () => {
    const tool = createListAgentsTool(agentStore);
    await tool.execute("session-1", { state: "idle" }, undefined as any, undefined as any, undefined as any);

    expect(agentStore.listAgents).toHaveBeenCalledWith({ state: "idle" });
  });

  it("passes includeEphemeral when provided", async () => {
    const tool = createListAgentsTool(agentStore);
    await tool.execute("session-1", { includeEphemeral: true }, undefined as any, undefined as any, undefined as any);

    expect(agentStore.listAgents).toHaveBeenCalledWith({ includeEphemeral: true });
  });

  it("returns no-agents message when list is empty", async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([]);

    const tool = createListAgentsTool(agentStore);
    const result = await tool.execute("session-1", {}, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No agents found matching the specified filters.");
  });
});

describe("createDelegateTaskTool", () => {
  let agentStore: AgentStore;
  let taskStore: TaskStore;

  beforeEach(() => {
    agentStore = createMockAgentStore();
    taskStore = createMockTaskStore();
  });

  it("creates task with correct assignedAgentId, column todo, and description", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-050",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: [],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-001",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "Write tests",
      dependencies: undefined,
      column: "todo",
      assignedAgentId: "agent-001",
      source: expect.objectContaining({ sourceType: "api" }),
    }), expect.objectContaining({ settings: { autoSummarizeTitles: false } }));

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Delegated to Bob (agent-001)");
    expect(text).toContain("Created FN-050");
    expect(text).toContain("picked up by Bob on their next heartbeat cycle");
  });

  it("reassigns and moves a duplicate canonical task before reporting delegation", async () => {
    const agent = createAgent({ id: "agent-002", name: "Rita" });
    const existing = {
      id: "FN-duplicate",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: [],
      column: "triage" as const,
      assignedAgentId: "agent-001",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const reassigned = { ...existing, assignedAgentId: "agent-002" };
    const moved = { ...reassigned, column: "todo" as const };
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.findRecentTasksByContentFingerprint).mockResolvedValue([existing]);
    vi.mocked(taskStore.updateTask).mockResolvedValue(reassigned);
    vi.mocked(taskStore.moveTask).mockResolvedValue(moved);

    const result = await createDelegateTaskTool(agentStore, taskStore).execute("session-1", {
      agent_id: "agent-002",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-duplicate", { assignedAgentId: "agent-002" });
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-duplicate", "todo");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Delegated to Rita (agent-002): Linked existing FN-duplicate");
    expect(text).toContain("picked up by Rita on their next heartbeat cycle");
  });

  it("does not mutate a same-owner duplicate canonical task", async () => {
    const existing = {
      id: "FN-duplicate",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: [],
      column: "todo" as const,
      assignedAgentId: "agent-001",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.mocked(taskStore.findRecentTasksByContentFingerprint).mockResolvedValue([existing]);

    const result = await createAgentTask(taskStore, {
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      column: "todo",
      assignedAgentId: "agent-001",
    });

    expect(result.task).toBe(existing);
    expect(taskStore.updateTask).not.toHaveBeenCalled();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("reuses paraphrased follow-ups from the same parent without collapsing distinct sibling intents", async () => {
    const tasks: Task[] = [];
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockImplementation(async () => tasks);
    vi.mocked(taskStore.createTask).mockImplementation(async (input) => {
      const created = {
        id: `FN-${tasks.length + 1}`, title: input.title, description: input.description,
        dependencies: input.dependencies ?? [], column: "triage" as const,
        sourceType: input.source?.sourceType, sourceAgentId: input.source?.sourceAgentId,
        sourceParentTaskId: input.source?.sourceParentTaskId,
        steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as Task;
      tasks.push(created);
      return created;
    });
    const descriptions = [
      "Add optional screenshot and short activity-trace context capture to in-app agentic reports, preserving the scrub-before-egress boundary.",
      "Add GitHub Discussions as a selectable filing target for in-app agentic reports.",
      "Add public-roadmap (FR-30) as a deduplication source for in-app agentic reports.",
    ];
    for (const description of descriptions) {
      expect((await createAgentTask(taskStore, { description }, { sourceTaskId: "FN-PARENT" })).wasDuplicate).toBe(false);
    }
    const replay = await createAgentTask(taskStore, {
      description: "Add screenshot and activity-trace context capture to in-app Bug/Feedback/Idea/Help reports, with privacy scrub coverage before GitHub egress.",
    }, { sourceTaskId: "FN-PARENT" });
    expect(replay.wasDuplicate).toBe(true);
    expect(replay.task.id).toBe("FN-1");
    expect(tasks).toHaveLength(3);
  });

  it("keeps identical follow-ups from different parent tasks separate", async () => {
    const foreign = {
      id: "FN-A",
      title: "",
      description: "Write the regression test",
      dependencies: [],
      column: "triage" as const,
      sourceParentTaskId: "FN-PARENT-A",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Task;
    const created = {
      ...foreign,
      id: "FN-B",
      sourceParentTaskId: "FN-PARENT-B",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    } as Task;
    vi.mocked(taskStore.findRecentTasksByContentFingerprint)
      .mockResolvedValueOnce([foreign])
      .mockResolvedValueOnce([foreign, created]);
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockResolvedValue([]);
    vi.mocked(taskStore.createTask).mockResolvedValue(created);

    const result = await createAgentTask(taskStore, {
      description: "Write the regression test",
    }, { sourceTaskId: "FN-PARENT-B" });

    expect(result).toEqual({ task: created, wasDuplicate: false });
    expect(taskStore.createTask).toHaveBeenCalled();
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("reuses one active diagnostic follow-up across different parent tasks", async () => {
    const tasks: Task[] = [];
    vi.mocked(taskStore.searchTasks).mockImplementation(async () => tasks);
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockImplementation(async (parentId) =>
      tasks.filter((task) => task.sourceParentTaskId === parentId),
    );
    vi.mocked(taskStore.createTask).mockImplementation(async (input) => {
      await Promise.resolve();
      const now = new Date().toISOString();
      const created = {
        id: `FN-${tasks.length + 1}`,
        description: input.description,
        dependencies: [],
        column: "triage" as const,
        sourceParentTaskId: input.source?.sourceParentTaskId,
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: now,
        updatedAt: now,
      } as Task;
      tasks.push(created);
      return created;
    });

    const [first, replay] = await Promise.all([
      createAgentTask(taskStore, {
        description: "Investigate and repair dashboard typecheck failure: app/utils/capture-screenshot.ts imports unresolved `html2canvas`, causing `pnpm verify:fast` to fail.",
      }, { sourceTaskId: "FN-8343", rootDir: "/worktrees/FN-8343" }),
      createAgentTask(taskStore, {
        description: "Restore the missing `html2canvas` dependency declaration/lock entry for dashboard screenshot capture so @fusion/dashboard typecheck passes.",
      }, { sourceTaskId: "FN-8348", rootDir: "/worktrees/FN-8348" }),
    ]);

    expect(first.wasDuplicate).toBe(false);
    expect(replay).toMatchObject({ wasDuplicate: true, task: { id: first.task.id } });
    expect(tasks).toHaveLength(1);
    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          crossParentDiagnosticClaimId: expect.stringMatching(/^agent-diagnostic-intent:/),
        }),
      }),
    }), expect.anything());
  });

  it("does not let a completed diagnostic suppress newly required work", async () => {
    const completed = {
      id: "FN-DONE",
      description: "Fix unresolved `html2canvas` typecheck failure.",
      dependencies: [],
      column: "done" as const,
      sourceParentTaskId: "FN-OLD-PARENT",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    const created = {
      ...completed,
      id: "FN-NEW",
      column: "triage" as const,
      sourceParentTaskId: "FN-NEW-PARENT",
    } as Task;
    vi.mocked(taskStore.searchTasks).mockResolvedValue([completed]);
    vi.mocked(taskStore.createTask).mockResolvedValue(created);

    const result = await createAgentTask(taskStore, {
      description: "Restore the missing html2canvas dependency so dashboard typecheck passes.",
    }, { sourceTaskId: "FN-NEW-PARENT" });

    expect(result).toEqual({ task: created, wasDuplicate: false });
    expect(taskStore.createTask).toHaveBeenCalledOnce();
  });

  it("fails closed when cross-parent diagnostic lookup is unavailable", async () => {
    vi.mocked(taskStore.searchTasks).mockRejectedValue(new Error("database unavailable"));

    await expect(createAgentTask(taskStore, {
      description: "Fix unresolved `html2canvas` typecheck failure.",
    }, { sourceTaskId: "FN-PARENT" })).rejects.toThrow("Unable to verify cross-parent diagnostic task uniqueness");

    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("persists option-based parent provenance on the step-session fn_task_create surface", async () => {
    const tool = createTaskCreateTool(taskStore, undefined, { sourceTaskId: "FN-PARENT", sourceAgentId: "agent-worker" });
    await tool.execute("call-1", { description: "Capture optional report screenshots", mission_lineage: APPROVED_LINEAGE }, undefined as any, undefined as any, undefined as any);
    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ sourceType: "api", sourceAgentId: "agent-worker", sourceParentTaskId: "FN-PARENT" }),
    }), expect.anything());
  });

  it("requires an explicit lineage when a no-task heartbeat cannot inherit one", async () => {
    const tool = createTaskCreateTool(taskStore, undefined, {
      sourceTaskId: "FN-PARENT",
      requireMissionLineage: true,
    });

    const result = await tool.execute("call-1", { description: "Capture optional report screenshots" }, undefined as any, undefined as any, undefined as any);

    expect(result).toMatchObject({ isError: true, details: { rule: "mission-lineage-required" } });
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:EngineTests 2026-07-22-13:07:
  Chat/user-directed freeform intake omits mission_lineage. Schema marks it optional;
  the tool factory must create the task without mission fields rather than hard-fail.
  */
  it("creates freeform chat-style tasks when mission_lineage is omitted", async () => {
    const tool = createTaskCreateTool(taskStore, { sourceType: "api" }, { rootDir: "/project" });

    const result = await tool.execute(
      "call-1",
      { description: "Create a red button", priority: "high" },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect(taskStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Create a red button",
        priority: "high",
        source: expect.objectContaining({ sourceType: "api" }),
      }),
      expect.anything(),
    );
    const createInput = vi.mocked(taskStore.createTask).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createInput.missionId).toBeUndefined();
    expect(createInput.sliceId).toBeUndefined();
  });

  it("delegates freeform tasks when mission_lineage is omitted", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-060",
      description: "Create a red button",
      dependencies: [],
      column: "todo" as const,
      assignedAgentId: "agent-001",
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Task);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute(
      "call-1",
      { agent_id: "agent-001", description: "Create a red button" },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    expect(result).not.toMatchObject({ isError: true });
    const createInput = vi.mocked(taskStore.createTask).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createInput.missionId).toBeUndefined();
    expect(createInput.sliceId).toBeUndefined();
  });

  it("bootstraps a defined feature by linking and promoting its first created task", async () => {
    const missionStore = {
      getFeature: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "defined" }),
      getSlice: vi.fn().mockResolvedValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
      getMilestone: vi.fn().mockResolvedValue({ id: "MS-001", missionId: "M-001", status: "active" }),
      getMission: vi.fn().mockResolvedValue({ id: "M-001", status: "active" }),
      claimDefinedFeatureTaskInTransaction: vi.fn().mockResolvedValue({ id: "F-001", taskId: "FN-001", status: "triaged" }),
      claimDefinedFeatureTask: vi.fn().mockResolvedValue({ id: "F-001", taskId: "FN-001", status: "triaged" }),
      archiveDefinedFeatureBootstrapDuplicate: vi.fn().mockResolvedValue(undefined),
    };
    const store = createMockTaskStore({
      getMissionStore: vi.fn().mockReturnValue(missionStore),
      createTask: vi.fn().mockImplementation(async (input) => {
        const task = { id: "FN-001", dependencies: [], column: "triage", steps: [], currentStep: 0, log: [], createdAt: "", updatedAt: "" } as Task;
        await (input as { afterTaskInsert?: (tx: object, created: Task) => Promise<void> }).afterTaskInsert?.({}, task);
        return task;
      }),
    });
    const result = await createTaskCreateTool(store).execute(
      "call-1", { description: "Bootstrap the hand-authored feature", mission_lineage: APPROVED_LINEAGE },
      undefined as any, undefined as any, undefined as any,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect(missionStore.claimDefinedFeatureTaskInTransaction).toHaveBeenCalledWith({}, { featureId: "F-001", taskId: "FN-001", missionId: "M-001", sliceId: "SL-001" });
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ missionId: "M-001", sliceId: "SL-001" }), expect.anything());
  });

  it("keeps a claimed defined-feature task canonical when a late duplicate appears", async () => {
    const missionStore = {
      getFeature: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "defined" }),
      getSlice: vi.fn().mockResolvedValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
      getMilestone: vi.fn().mockResolvedValue({ id: "MS-001", missionId: "M-001", status: "active" }),
      getMission: vi.fn().mockResolvedValue({ id: "M-001", status: "active" }),
      claimDefinedFeatureTaskInTransaction: vi.fn().mockResolvedValue({ id: "F-001", taskId: "FN-new", status: "triaged" }),
      claimDefinedFeatureTask: vi.fn(),
      archiveDefinedFeatureBootstrapDuplicate: vi.fn().mockResolvedValue(undefined),
    };
    const created = { id: "FN-new", description: "Bootstrap feature", dependencies: [], column: "triage" as const, steps: [], currentStep: 0, log: [], createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } as Task;
    const older = { ...created, id: "FN-old", createdAt: "2026-01-01T00:00:00.000Z" };
    const store = createMockTaskStore({
      getMissionStore: vi.fn().mockReturnValue(missionStore),
      createTask: vi.fn().mockImplementation(async (input) => {
        await (input as { afterTaskInsert?: (tx: object, created: Task) => Promise<void> }).afterTaskInsert?.({}, created);
        return created;
      }),
      findRecentTasksByContentFingerprint: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([older, created]),
    });

    const result = await createTaskCreateTool(store).execute(
      "call-1", { description: "Bootstrap feature", mission_lineage: APPROVED_LINEAGE },
      undefined as any, undefined as any, undefined as any,
    );

    expect(result).not.toMatchObject({ isError: true });
    expect((result.details as { taskId: string }).taskId).toBe("FN-new");
    expect(missionStore.claimDefinedFeatureTaskInTransaction).toHaveBeenCalledOnce();
    /* FNXC:MissionAdmission 2026-07-23-19:00: a task that atomically claimed feature.taskId must never be archived by post-create duplicate reconciliation. */
    expect(store.findRecentTasksByContentFingerprint).toHaveBeenCalledTimes(2);
    expect(missionStore.archiveDefinedFeatureBootstrapDuplicate).toHaveBeenCalledWith({
      featureId: "F-001", taskId: "FN-new", duplicateTaskId: "FN-old",
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-new", "archived");
  });

  it("rolls back a newly-created task when defined-feature bootstrap cannot link", async () => {
    const missionStore = {
      getFeature: vi.fn().mockResolvedValue({ id: "F-001", sliceId: "SL-001", status: "defined" }),
      getSlice: vi.fn().mockResolvedValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
      getMilestone: vi.fn().mockResolvedValue({ id: "MS-001", missionId: "M-001", status: "active" }),
      getMission: vi.fn().mockResolvedValue({ id: "M-001", status: "active" }),
      claimDefinedFeatureTaskInTransaction: vi.fn().mockRejectedValue(new Error("Feature F-001 is already linked to task FN-OTHER")),
      claimDefinedFeatureTask: vi.fn(),
      archiveDefinedFeatureBootstrapDuplicate: vi.fn().mockResolvedValue(undefined),
    };
    const store = createMockTaskStore({
      getMissionStore: vi.fn().mockReturnValue(missionStore),
      createTask: vi.fn().mockImplementation(async (input) => {
        await (input as { afterTaskInsert?: (tx: object, created: Task) => Promise<void> }).afterTaskInsert?.({}, { id: "FN-001" } as Task);
        throw new Error("bootstrap hook unexpectedly succeeded");
      }),
    });
    const result = createTaskCreateTool(store).execute(
      "call-1", { description: "Bootstrap conflicting feature", mission_lineage: APPROVED_LINEAGE },
      undefined as any, undefined as any, undefined as any,
    );

    await expect(result).rejects.toThrow("Feature F-001 is already linked to task FN-OTHER");
    expect(missionStore.claimDefinedFeatureTaskInTransaction).toHaveBeenCalledOnce();
  });

  it("rejects a pre-existing same-agent bootstrap duplicate before claiming or creating", async () => {
    const canonical = {
      id: "FN-existing", title: "Bootstrap feature", description: "Bootstrap the hand-authored feature",
      sourceAgentId: "agent-001", dependencies: [], column: "triage" as const, steps: [], currentStep: 0,
      log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Task;
    const store = createMockTaskStore({ listTasks: vi.fn().mockResolvedValue([canonical]) });
    const validate = vi.fn().mockRejectedValue(new Error("pre-existing task is not linked to this feature"));

    await expect(createAgentTask(store, {
      title: "Bootstrap feature",
      description: "Bootstrap the hand-authored feature",
      source: { sourceType: "api", sourceAgentId: "agent-001" },
      preflightSameAgentDuplicate: true,
      validateDuplicateCanonical: validate,
    } as TaskCreateInput & { preflightSameAgentDuplicate: boolean; validateDuplicateCanonical: (task: Task) => Promise<void> }))
      .rejects.toThrow("pre-existing task is not linked to this feature");

    expect(validate).toHaveBeenCalledWith(canonical);
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("does not select an archived same-agent task as a defined-feature bootstrap canonical", async () => {
    const archived = {
      id: "FN-archived", title: "Bootstrap feature", description: "Bootstrap the hand-authored feature",
      sourceAgentId: "agent-001", dependencies: [], column: "archived" as const, steps: [], currentStep: 0,
      log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Task;
    const store = createMockTaskStore({ listTasks: vi.fn().mockResolvedValue([archived]) });
    const validate = vi.fn().mockResolvedValue(undefined);

    const result = await createAgentTask(store, {
      title: "Bootstrap feature",
      description: "Bootstrap the hand-authored feature",
      source: { sourceType: "api", sourceAgentId: "agent-001" },
      preflightSameAgentDuplicate: true,
      validateDuplicateCanonical: validate,
    } as TaskCreateInput & { preflightSameAgentDuplicate: boolean; validateDuplicateCanonical: (task: Task) => Promise<void> });

    /* FNXC:MissionAdmission 2026-07-23-21:10: archived tasks are not live bootstrap canonicals and must not block a valid first task. */
    expect(result.wasDuplicate).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(store.createTask).toHaveBeenCalledOnce();
  });

  it("serializes three concurrent paraphrased creates from one parent", async () => {
    const tasks: Task[] = [];
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockImplementation(async () => tasks);
    vi.mocked(taskStore.createTask).mockImplementation(async (input) => {
      await Promise.resolve();
      const created = { id: `FN-${tasks.length + 1}`, description: input.description, dependencies: [], column: "triage" as const,
        sourceParentTaskId: input.source?.sourceParentTaskId, steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Task;
      tasks.push(created); return created;
    });
    const results = await Promise.all([
      "Add screenshot and activity-trace capture with privacy scrub coverage.",
      "Add screenshot and activity-trace capture while preserving privacy scrubbing.",
      "Capture screenshots and activity traces with mandatory privacy scrubbing.",
    ].map((description) => createAgentTask(taskStore, { description }, { sourceTaskId: "FN-PARENT" })));
    expect(results.filter((result) => result.wasDuplicate)).toHaveLength(2);
    expect(tasks).toHaveLength(1);
  });

  it("fails closed when parent-scoped duplicate lookup is unavailable", async () => {
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockRejectedValue(new Error("database unavailable"));
    await expect(createAgentTask(taskStore, {
      description: "Add screenshot and activity-trace capture",
    }, { sourceTaskId: "FN-PARENT" })).rejects.toThrow("Unable to verify parent-scoped task uniqueness");
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("normalizes parent provenance and reports database claim reuse as a duplicate", async () => {
    const canonical = {
      id: "FN-1", title: "", description: "Add new support", dependencies: [], column: "triage" as const,
      sourceParentTaskId: "FN-PARENT", proposalClaimId: "claim", steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Task;
    vi.mocked(taskStore.findRecentTasksBySourceParentTaskId).mockResolvedValue([]);
    vi.mocked(taskStore.createTask).mockImplementation(async (_input, options) => {
      options?.onProposalClaimConflict?.(canonical);
      return canonical;
    });

    const validateDuplicateCanonical = vi.fn().mockResolvedValue(undefined);
    const result = await createAgentTask(taskStore, {
      description: "Add new support",
      validateDuplicateCanonical,
    } as TaskCreateInput & { validateDuplicateCanonical: (task: Task) => Promise<void> }, { sourceTaskId: "fn-parent" });

    expect(taskStore.findRecentTasksBySourceParentTaskId).toHaveBeenCalledWith("FN-PARENT");
    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ sourceParentTaskId: "FN-PARENT" }),
      proposalClaimId: expect.stringMatching(/^agent-parent-intent:FN-PARENT:/),
    }), expect.anything());
    expect(result).toMatchObject({ task: canonical, wasDuplicate: true });
    /* FNXC:MissionAdmission 2026-07-23-17:20: proposal-claim reuse must validate the final canonical, not only pre-create duplicate probes. */
    expect(validateDuplicateCanonical).toHaveBeenCalledWith(canonical);
  });

  it("carries delegation routing onto the reconcile canonical task", async () => {
    const created = {
      id: "FN-new",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: [],
      column: "todo" as const,
      steps: [], currentStep: 0, log: [],
      createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const canonical = { ...created, id: "FN-old", assignedAgentId: "agent-old", column: "triage" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const reassigned = { ...canonical, assignedAgentId: "agent-002" };
    const moved = { ...reassigned, column: "todo" as const };
    vi.mocked(taskStore.createTask).mockResolvedValue(created);
    vi.mocked(taskStore.findRecentTasksByContentFingerprint)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([canonical, created]);
    vi.mocked(taskStore.updateTask).mockImplementation(async (id, updates) =>
      id === "FN-old" ? reassigned : { ...created, ...updates },
    );
    vi.mocked(taskStore.moveTask).mockImplementation(async (id, column) =>
      id === "FN-old" ? moved : { ...created, id, column },
    );

    const validateDuplicateCanonical = vi.fn().mockResolvedValue(undefined);
    const result = await createAgentTask(taskStore, {
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      column: "todo",
      assignedAgentId: "agent-002",
      validateDuplicateCanonical,
    } as TaskCreateInput & { validateDuplicateCanonical: (task: Task) => Promise<void> });

    expect(result.wasDuplicate).toBe(true);
    expect(result.task).toBe(moved);
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-old", { assignedAgentId: "agent-002" });
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-old", "todo");
    /* FNXC:MissionAdmission 2026-07-23-17:20: post-create archival reconciliation must validate its returned canonical before duplicate success. */
    expect(validateDuplicateCanonical).toHaveBeenCalledWith(moved);
  });

  it("returns success message with task ID and agent name", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-051",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: [],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-001",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("FN-051");
    expect(text).toContain("Bob");
    expect(result.details).toEqual({ taskId: "FN-051", agentId: "agent-001", agentName: "Bob" });
  });

  it("returns error when target agent not found", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "nonexistent-agent",
      description: "Do something",
    }, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ERROR: Agent nonexistent-agent not found");
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("returns error when target agent is ephemeral", async () => {
    const ephemeralAgent = createAgent({
      id: "executor-FN-100",
      metadata: { agentKind: "task-worker" },
    });
    vi.mocked(agentStore.getAgent).mockResolvedValue(ephemeralAgent);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "executor-FN-100",
      description: "Do something",
    }, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ERROR: Cannot delegate to ephemeral/runtime agent executor-FN-100");
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("returns explicit collision error when delegated createTask hits existing id", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockRejectedValue(new Error("Task ID already exists: FN-050"));

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-001",
      description: "Write tests",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("ERROR: Task ID already exists: FN-050");
    expect(result.details).toEqual({});
  });

  it("allows durable engineer target without override", async () => {
    const engineer = createAgent({ id: "agent-009", name: "Eli", role: "engineer" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(engineer);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-053",
      description: "Do something",
      dependencies: [],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    await tool.execute("session-1", {
      agent_id: "agent-009",
      description: "Do something",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      assignedAgentId: "agent-009",
      source: expect.objectContaining({ sourceType: "api" }),
    }), expect.anything());
  });

  it("rejects reviewer target without override", async () => {
    const reviewer = createAgent({ id: "agent-002", name: "Rita", role: "reviewer" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(reviewer);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-002",
      description: "Do something",
    }, undefined as any, undefined as any, undefined as any);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ERROR: Agent agent-002 has role \"reviewer\"");
    expect(text).toContain("Pass override=true to bypass");
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("allows non-executor target with override", async () => {
    const reviewer = createAgent({ id: "agent-002", name: "Rita", role: "reviewer" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(reviewer);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-054",
      description: "Do something",
      dependencies: [],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    await tool.execute("session-1", {
      agent_id: "agent-002",
      description: "Do something",
      mission_lineage: APPROVED_LINEAGE,
      override: true,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceType: "api",
        sourceMetadata: expect.objectContaining({ executorRoleOverride: true }),
      }),
    }), expect.objectContaining({ settings: { autoSummarizeTitles: false } }));
  });

  /*
  FNXC:AgentRouting 2026-07-12-13:25:
  Issue #2015: delegation must honor per-agent assignmentPolicy. "none" is the liaison guarantee —
  not even override=true can delegate implementation work to such an agent; "explicit-only" accepts delegation.
  */
  it("rejects a policy-'none' executor target even with override=true", async () => {
    const liaison = createAgent({
      id: "agent-liaison",
      name: "Platform Liaison",
      role: "executor",
      runtimeConfig: { assignmentPolicy: "none" },
    });
    vi.mocked(agentStore.getAgent).mockResolvedValue(liaison);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    for (const override of [false, true]) {
      const result = await tool.execute("session-1", {
        agent_id: "agent-liaison",
        description: "Do something",
        override,
      }, undefined as any, undefined as any, undefined as any);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("assignmentPolicy \"none\"");
    }
    expect(taskStore.createTask).not.toHaveBeenCalled();
  });

  it("allows delegation to an 'explicit-only' executor without override", async () => {
    const explicitOnly = createAgent({
      id: "agent-explicit",
      name: "Explicit Only",
      role: "executor",
      runtimeConfig: { assignmentPolicy: "explicit-only" },
    });
    vi.mocked(agentStore.getAgent).mockResolvedValue(explicitOnly);

    const tool = createDelegateTaskTool(agentStore, taskStore);
    await tool.execute("session-1", {
      agent_id: "agent-explicit",
      description: "Do something",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAgentId: "agent-explicit" }),
      expect.anything(),
    );
  });

  it("passes dependencies through to task creation", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-052",
      description: "Integration test",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: ["FN-010"],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-001",
      description: "Integration test",
      mission_lineage: APPROVED_LINEAGE,
      dependencies: ["FN-010"],
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "Integration test",
      dependencies: ["FN-010"],
      column: "todo",
      assignedAgentId: "agent-001",
      source: expect.objectContaining({ sourceType: "api" }),
    }), expect.objectContaining({ settings: { autoSummarizeTitles: false } }));

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("depends on: FN-010");
  });

  it("creates task without dependencies when none specified", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-053",
      description: "Simple task",
      dependencies: [],
      column: "todo" as const,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const tool = createDelegateTaskTool(agentStore, taskStore);
    const result = await tool.execute("session-1", {
      agent_id: "agent-001",
      description: "Simple task",
      mission_lineage: APPROVED_LINEAGE,
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ dependencies: undefined }),
      expect.objectContaining({ settings: { autoSummarizeTitles: false } }),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("depends on:");
  });
});
