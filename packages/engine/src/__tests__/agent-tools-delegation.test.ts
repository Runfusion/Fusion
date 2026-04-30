import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent, AgentStore, TaskStore, Task } from "@fusion/core";
import { createListAgentsTool, createDelegateTaskTool } from "../agent-tools.js";

function createMockAgentStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as AgentStore;
}

function createMockTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
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
    expect(text).toContain("Current Task: FN-100");
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
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith({
      description: "Write tests",
      dependencies: undefined,
      column: "todo",
      assignedAgentId: "agent-001",
      source: { sourceType: "api" },
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Delegated to Bob (agent-001)");
    expect(text).toContain("Created FN-050");
    expect(text).toContain("picked up by Bob on their next heartbeat cycle");
  });

  it("returns success message with task ID and agent name", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-051",
      description: "Write tests",
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

  it("passes dependencies through to task creation", async () => {
    const agent = createAgent({ id: "agent-001", name: "Bob" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent);
    vi.mocked(taskStore.createTask).mockResolvedValue({
      id: "FN-052",
      description: "Integration test",
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
      dependencies: ["FN-010"],
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith({
      description: "Integration test",
      dependencies: ["FN-010"],
      column: "todo",
      assignedAgentId: "agent-001",
      source: { sourceType: "api" },
    });

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
    }, undefined as any, undefined as any, undefined as any);

    expect(taskStore.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ dependencies: undefined }),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("depends on:");
  });
});
