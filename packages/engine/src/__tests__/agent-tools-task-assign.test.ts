import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { createTaskAssignTool } from "../agent-tools.js";

function agent(overrides: Partial<Agent> = {}): Agent {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    id: "agent-001", name: "Ari", role: "executor", state: "idle",
    createdAt: now, updatedAt: now, metadata: {}, ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001", description: "Implement fix", dependencies: [], column: "todo",
    steps: [], currentStep: 0, log: [], createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z", ...overrides,
  };
}

describe("createTaskAssignTool", () => {
  let agentStore: AgentStore;
  let taskStore: TaskStore;

  beforeEach(() => {
    agentStore = { getAgent: vi.fn().mockResolvedValue(null) } as unknown as AgentStore;
    taskStore = {
      getTask: vi.fn().mockResolvedValue(task()),
      updateTask: vi.fn().mockImplementation(async (id, updates) => task({ id, ...updates })),
    } as unknown as TaskStore;
  });

  it("assigns an existing task and truthfully confirms its owner", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent({ id: "agent-002", name: "Bea" }));
    const result = await createTaskAssignTool(agentStore, taskStore).execute("run", {
      task_id: "FN-001", agent_id: "agent-002",
    }, undefined as never, undefined as never, undefined as never);

    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-001", { assignedAgentId: "agent-002" });
    expect((result.content[0] as { text: string }).text).toBe("Assigned FN-001 to Bea (agent-002).");
  });

  it("reports missing tasks and agents", async () => {
    const tool = createTaskAssignTool(agentStore, taskStore);
    let result = await tool.execute("run", { task_id: "FN-missing", agent_id: "agent-missing" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("Agent agent-missing not found");

    vi.mocked(agentStore.getAgent).mockResolvedValue(agent());
    vi.mocked(taskStore.getTask).mockRejectedValue(new Error("missing"));
    result = await tool.execute("run", { task_id: "FN-missing", agent_id: "agent-001" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("Task FN-missing not found");
  });

  it("rejects ephemeral and assignmentPolicy none agents", async () => {
    const tool = createTaskAssignTool(agentStore, taskStore);
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent({ id: "executor-FN-1", metadata: { agentKind: "task-worker" } }));
    let result = await tool.execute("run", { task_id: "FN-001", agent_id: "executor-FN-1" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("Cannot assign to ephemeral/runtime agent");

    vi.mocked(agentStore.getAgent).mockResolvedValue(agent({ runtimeConfig: { assignmentPolicy: "none" } }));
    result = await tool.execute("run", { task_id: "FN-001", agent_id: "agent-001", override: true }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain('assignmentPolicy "none"');
    expect(taskStore.updateTask).not.toHaveBeenCalled();
  });

  it("requires override for a reviewer target", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent({ role: "reviewer" }));
    const tool = createTaskAssignTool(agentStore, taskStore);
    let result = await tool.execute("run", { task_id: "FN-001", agent_id: "agent-001" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("Pass override=true");

    result = await tool.execute("run", { task_id: "FN-001", agent_id: "agent-001", override: true }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("Assigned FN-001");
  });
});
