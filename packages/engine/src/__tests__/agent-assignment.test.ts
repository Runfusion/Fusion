import type { Agent, Task } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { listEligibleExecutorAgents, selectPermanentAgentForTask } from "../agent-assignment.js";

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    name: overrides.name ?? overrides.id,
    role: overrides.role ?? "executor",
    state: overrides.state ?? "idle",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    column: overrides.column ?? "todo",
    priority: overrides.priority ?? "normal",
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    log: overrides.log ?? [],
    ...overrides,
  } as Task;
}

describe("selectPermanentAgentForTask", () => {
  it("returns null when no eligible permanent executor exists", async () => {
    const agent = makeAgent({ id: "ephemeral-1", metadata: { agentKind: "task-worker" } });
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-1" }),
      agentStore: {
        listAgents: async () => [agent],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });

    expect(selected).toBeNull();
  });

  it("filters out ephemeral, disabled, errored, and non-executor agents", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-2" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "ephemeral", metadata: { agentKind: "task-worker" } }),
          makeAgent({ id: "disabled", runtimeConfig: { enabled: false } }),
          makeAgent({ id: "errored", state: "error" }),
          makeAgent({ id: "reviewer", role: "reviewer" }),
          makeAgent({ id: "ok", createdAt: "2026-01-01T00:00:01.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });

    expect(selected?.id).toBe("ok");
  });

  it("selects least-loaded agent", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-3" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "b", createdAt: "2026-01-01T00:00:01.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: {
        listTasks: async () => [
          makeTask({ id: "T1", column: "in-progress", assignedAgentId: "a" }),
          makeTask({ id: "T2", column: "todo", assignedAgentId: "a" }),
          makeTask({ id: "T3", column: "in-review", assignedAgentId: "b" }),
          makeTask({ id: "T4", column: "done", assignedAgentId: "b" }),
        ],
      } as never,
    });

    expect(selected?.id).toBe("b");
  });

  it("uses createdAt then id for deterministic tie-break", async () => {
    const selectedByCreatedAt = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-4" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });
    expect(selectedByCreatedAt?.id).toBe("a");

    const selectedById = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-5" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async () => [],
      } as never,
      taskStore: { listTasks: async () => [] } as never,
    });
    expect(selectedById?.id).toBe("a");
  });

  it("prefers agents in reporting chain of mission/slice-linked assignees", async () => {
    const selected = await selectPermanentAgentForTask({
      task: makeTask({ id: "FN-6", missionId: "M-1", sliceId: "SL-1" }),
      agentStore: {
        listAgents: async () => [
          makeAgent({ id: "agent-a", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "agent-b", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeAgent({ id: "agent-c", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        getChainOfCommand: async (agentId: string) => (agentId === "agent-c" ? [makeAgent({ id: "agent-b" })] : []),
      } as never,
      taskStore: {
        listTasks: async () => [
          makeTask({ id: "FN-linked", missionId: "M-1", sliceId: "SL-1", assignedAgentId: "agent-c", column: "todo" }),
          makeTask({ id: "FN-other", missionId: "M-2", assignedAgentId: "agent-a", column: "todo" }),
        ],
      } as never,
    });

    expect(["agent-b", "agent-c"]).toContain(selected?.id);
    expect(selected?.id).toBe("agent-b");
  });
});

describe("listEligibleExecutorAgents", () => {
  it("returns empty when only custom-role (catalog-imported) agents exist", async () => {
    const eligible = await listEligibleExecutorAgents({
      listAgents: async () => [
        makeAgent({ id: "gstack-1", role: "custom" }),
        makeAgent({ id: "gstack-2", role: "custom" }),
      ],
    } as never);

    expect(eligible).toEqual([]);
  });

  it("excludes ephemeral, disabled, and errored executors but keeps healthy ones", async () => {
    const eligible = await listEligibleExecutorAgents({
      listAgents: async () => [
        makeAgent({ id: "ephemeral", metadata: { agentKind: "task-worker" } }),
        makeAgent({ id: "disabled", runtimeConfig: { enabled: false } }),
        makeAgent({ id: "errored", state: "error" }),
        makeAgent({ id: "reviewer", role: "reviewer" }),
        makeAgent({ id: "ok" }),
      ],
    } as never);

    expect(eligible.map((agent) => agent.id)).toEqual(["ok"]);
  });
});
