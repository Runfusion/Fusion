import { describe, expect, it, vi } from "vitest";

import type { Agent, Task } from "@fusion/core";
import type { AgentStore } from "@fusion/core";

import { SelfHealingManager } from "../self-healing";

describe("FN-4296: self-healing agent link drift repro", () => {
  it("FN-4296: durable running agent linked to done task remains stale before fix", async () => {
    const agents: Agent[] = [
      {
        id: "agent-Y",
        state: "running",
        taskId: "FN-X",
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
      } as Agent,
    ];

    const store = {
      getTask: vi.fn(async (taskId: string) => (taskId === "FN-X" ? ({ id: "FN-X", column: "done" } as Task) : null)),
    } as any;

    const agentStore = {
      listAgents: vi.fn(async () => agents),
      getActiveHeartbeatRun: vi.fn(async () => null),
      updateAgentState: vi.fn(async () => undefined),
      syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.taskId = taskId;
      }),
    } as unknown as AgentStore;

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

    await manager.recoverAgentsRunningOnInactiveTasks();

    expect(agents[0].taskId).toBeUndefined();

    manager.stop();
  });
});
