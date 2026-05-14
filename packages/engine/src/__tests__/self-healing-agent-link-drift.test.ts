import { describe, expect, it, vi } from "vitest";

import { isEphemeralAgent, type Agent, type AgentStore, type Task } from "@fusion/core";

import { SelfHealingManager } from "../self-healing";

function makeAgent(id: string, taskId: string, state: Agent["state"] = "active"): Agent {
  return { id, state, taskId, updatedAt: new Date(Date.now() - 120_000).toISOString() } as Agent;
}

describe("FN-4296: self-healing agent link drift", () => {
  function buildManager(agents: Agent[], tasks: Record<string, Task | null>, hasActiveAgentExecution?: (agentId: string) => boolean) {
    const store = {
      getTask: vi.fn(async (taskId: string) => tasks[taskId] ?? null),
    } as any;

    const agentStore = {
      listAgents: vi.fn(async (filter?: { includeEphemeral?: boolean }) => {
        if (filter?.includeEphemeral === false) {
          return agents.filter((agent) => !isEphemeralAgent(agent));
        }
        return agents;
      }),
      getActiveHeartbeatRun: vi.fn(async () => null),
      syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.taskId = taskId;
      }),
    } as unknown as AgentStore;

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore, hasActiveAgentExecution });
    return { manager, agentStore };
  }

  it("FN-4296: durable agent linked to done task is cleared by sweep", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "done" } as Task });
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  it("FN-4296: durable agent linked to archived task is cleared by sweep", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "archived" } as Task });
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  it("FN-4296: durable agent linked to queued todo task with no live run is cleared", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "todo" } as Task }, () => false);
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  it("FN-4296: durable agent linked to todo task with fresh active run is NOT cleared", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager, agentStore } = buildManager(agents, { "FN-1": { id: "FN-1", column: "todo" } as Task }, () => true);
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBe("FN-1");
    expect((agentStore as any).syncExecutionTaskLink).not.toHaveBeenCalled();
    manager.stop();
  });

  it("FN-4296: durable agent linked to in-progress task with matching assignedAgentId is NOT cleared", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "in-progress", assignedAgentId: "agent-1" } as Task });
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBe("FN-1");
    manager.stop();
  });

  it("FN-4296: durable agent linked to task assigned to different agent is cleared", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "in-progress", assignedAgentId: "agent-2" } as Task });
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  it("FN-4296: durable agent linked to nonexistent task id is cleared", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": null });
    await manager.recoverDriftedAgentTaskLinks();
    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  it("FN-4296: ephemeral agents are not touched", async () => {
    const durable = makeAgent("agent-1", "FN-1");
    const ephemeral = makeAgent("temp-worker", "FN-2");
    (ephemeral as Agent & { metadata?: { type: string } }).metadata = { type: "spawned" };
    const agents = [durable, ephemeral];
    const { manager, agentStore } = buildManager(agents, {
      "FN-1": { id: "FN-1", column: "done" } as Task,
      "FN-2": { id: "FN-2", column: "done" } as Task,
    });
    await manager.recoverDriftedAgentTaskLinks();
    expect(durable.taskId).toBeUndefined();
    expect(ephemeral.taskId).toBe("FN-2");
    expect((agentStore as any).syncExecutionTaskLink).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});
