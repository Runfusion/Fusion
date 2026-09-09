import { describe, expect, it, vi } from "vitest";

import { isEphemeralAgent, TaskDeletedError, TaskNotFoundError, type Agent, type AgentStore, type Task } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

function makeAgent(id: string, taskId: string, state: Agent["state"] = "active"): Agent {
  return { id, state, taskId, updatedAt: new Date(Date.now() - 120_000).toISOString() } as Agent;
}

describe("FN-4296: self-healing agent link drift", () => {
  function buildManager(agents: Agent[], tasks: Record<string, Task | null | Error>, hasActiveAgentExecution?: (agentId: string) => boolean) {
    const store = {
      getTask: vi.fn(async (taskId: string) => {
        const result = tasks[taskId] ?? null;
        if (result instanceof Error) throw result;
        return result;
      }),
      recordRunAuditEvent: vi.fn(async () => {}),
    } as any;

    const agentStore = {
      listAgents: vi.fn(async (filter?: { includeEphemeral?: boolean }) => {
        if (filter?.includeEphemeral === false) {
          return agents.filter((agent) => !isEphemeralAgent(agent));
        }
        return agents;
      }),
      getActiveHeartbeatRun: vi.fn(async () => null),
      updateAgentState: vi.fn(async (agentId: string, state: Agent["state"]) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.state = state;
      }),
      syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.taskId = taskId;
      }),
    } as unknown as AgentStore;

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore, hasActiveAgentExecution });
    return { manager, agentStore, store };
  }

  it("FN-4296: durable agent linked to done task is cleared by sweep", async () => {
    const agents = [makeAgent("agent-1", "FN-1")];
    const { manager } = buildManager(agents, { "FN-1": { id: "FN-1", column: "done" } as Task });
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

  it("FN-6954: running durable agent on dependency-only queued todo is made active and unlinked", async () => {
    const agents = [makeAgent("agent-backend", "FN-7000", "running")];
    const queuedTask = {
      id: "FN-7000",
      column: "todo",
      status: "queued",
      blockedBy: "FN-6999",
      overlapBlockedBy: null,
    } as Task;
    const { manager } = buildManager(agents, { "FN-7000": queuedTask }, () => false);

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect(queuedTask).toMatchObject({ status: "queued", blockedBy: "FN-6999", overlapBlockedBy: null });
    manager.stop();
  });

  it("FN-6954: running durable agent on overlap-queued triage task is made active and unlinked", async () => {
    const agents = [makeAgent("agent-backend", "FN-7001", "running")];
    const queuedTask = {
      id: "FN-7001",
      // FNXC:WorkflowResolvedColumns 2026-07-30-17:40: the intake column post-U11 is `todo`.
      column: "todo",
      status: "queued",
      overlapBlockedBy: "FN-6827",
    } as Task;
    const { manager } = buildManager(agents, { "FN-7001": queuedTask }, () => false);

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect(queuedTask).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
    manager.stop();
  });

  it("FN-6954: duplicate durable agents linked to one parked task preserve only live proof", async () => {
    const agents = [
      makeAgent("agent-stale", "FN-7002", "running"),
      makeAgent("agent-live", "FN-7002", "running"),
    ];
    const queuedTask = { id: "FN-7002", column: "todo", status: "queued", overlapBlockedBy: "FN-6827" } as Task;
    const { manager } = buildManager(agents, { "FN-7002": queuedTask }, (agentId) => agentId === "agent-live");

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect(agents[1]).toMatchObject({ state: "running", taskId: "FN-7002" });
    expect(queuedTask).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
    manager.stop();
  });

  it("FN-6954: running durable agent on lease-queued todo is made active and audited without clearing the lease", async () => {
    const agents = [makeAgent("agent-backend", "FN-6709", "running")];
    const queuedTask = {
      id: "FN-6709",
      column: "todo",
      status: "queued",
      overlapBlockedBy: "FN-6827",
      blockedBy: null,
    } as Task;
    const blockerTask = { id: "FN-6827", column: "in-progress", assignedAgentId: "agent-other" } as Task;
    const { manager, agentStore, store } = buildManager(
      agents,
      { "FN-6709": queuedTask, "FN-6827": blockerTask },
      () => false,
    );

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect(queuedTask).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
    expect((agentStore as any).updateAgentState).toHaveBeenCalledWith("agent-backend", "active");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-stale-agent-assignment",
      target: "agent-backend",
      metadata: expect.objectContaining({
        agentId: "agent-backend",
        taskId: "FN-6709",
        taskColumn: "todo",
        agentState: "running",
        status: "queued",
        overlapBlockedBy: "FN-6827",
        hadFreshRun: false,
        hadActiveExecution: false,
        reason: expect.stringContaining("without fresh run or active execution"),
      }),
    }));
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

  it("FN-8919: a throwing task miss clears itself and later stale links", async () => {
    const agents = [makeAgent("agent-poison", "ERR-024"), makeAgent("agent-stale", "FN-2")];
    const { manager, agentStore, store } = buildManager(agents, {
      "ERR-024": new TaskNotFoundError("ERR-024"),
      "FN-2": null,
    });

    await expect(manager.recoverDriftedAgentTaskLinks()).resolves.toBe(2);

    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-poison", undefined);
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-stale", undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      target: "agent-poison",
      metadata: expect.objectContaining({ reason: "linked task missing" }),
    }));
    manager.stop();
  });

  it("FN-8919: TaskDeletedError is a missing task and transient errors isolate one agent", async () => {
    const agents = [
      makeAgent("agent-transient", "FN-connection"),
      makeAgent("agent-deleted", "KB-1"),
      makeAgent("agent-stale", "FN-2"),
    ];
    const { manager, agentStore, store } = buildManager(agents, {
      "FN-connection": new Error("connection terminated unexpectedly"),
      "KB-1": new TaskDeletedError("KB-1", "2026-08-10T00:00:00.000Z"),
      "FN-2": null,
    });

    await expect(manager.recoverDriftedAgentTaskLinks()).resolves.toBe(2);

    expect(agents[0].taskId).toBe("FN-connection");
    expect(agentStore.syncExecutionTaskLink).not.toHaveBeenCalledWith("agent-transient", undefined);
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-deleted", undefined);
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-stale", undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      target: "agent-deleted",
      metadata: expect.objectContaining({ reason: "linked task missing" }),
    }));
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-19:20:
  #3078 converted this sweep's terminal check to the role pair and merged before any test covered it.
  Measured then: with the conversion reverted, all 204 self-healing tests still passed — every case in
  this file uses `done`/`archived`, where the literal is correct, so none of them could see it.

  What the literal cost on a renamed board: a durable agent stayed LINKED to a finished task forever.
  The agent is not free to pick up new work while it is linked, so the drift this sweep exists to
  clear is exactly the drift it stopped clearing.
  */
  const RENAMED_IR = {
    version: "v2", id: "custom:renamed", nodes: [], edges: [],
    columns: [
      /*  carries HOLD so a card can be pre-wip on this board — the preservation branch
         below is only reachable for a parked card, and without this the case is vacuous. */
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  };

  function buildRenamedManager(agents: Agent[], tasks: Record<string, Task | null>) {
    const store = {
      getTask: vi.fn(async (taskId: string) => tasks[taskId] ?? null),
      recordRunAuditEvent: vi.fn(async () => {}),
      listWorkflowDefinitions: vi.fn(async () => [{ id: "custom:renamed", ir: RENAMED_IR }]),
      /* `isPreWipColumn` resolves the card's OWN workflow, so the per-task selection readers are
         required — with only the project list it resolves the default IR, the preservation branch is
         never entered, and a case asserting on that branch passes for the wrong reason. */
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "custom:renamed", stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "custom:renamed", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_IR })),
    } as any;
    const agentStore = {
      listAgents: vi.fn(async (filter?: { includeEphemeral?: boolean }) =>
        filter?.includeEphemeral === false ? agents.filter((a) => !isEphemeralAgent(a)) : agents),
      getActiveHeartbeatRun: vi.fn(async () => null),
      updateAgentState: vi.fn(async (agentId: string, state: Agent["state"]) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.state = state;
      }),
      syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent) agent.taskId = taskId;
      }),
    } as unknown as AgentStore;
    return new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });
  }

  it("clears a durable agent linked to a task in a RENAMED complete lane", async () => {
    const agents = [makeAgent("agent-1", "FN-9")];
    const manager = buildRenamedManager(agents, { "FN-9": { id: "FN-9", column: "shipped" } as Task });

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0].taskId).toBeUndefined();
    manager.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-17:40:
  THE PRESERVATION BRANCH WAS DECIDED ON LEGACY IDS while its GATE was already resolved.

  `recoverDriftedAgentTaskLinks` enters this branch via `isPreWipColumn` (resolved) and then called
  `evaluateParkedAgentTaskLink` WITHOUT `parkedColumns`, so parked-ness fell back to todo/triage. On a
  renamed board the card is pre-wip, `isParkedTaskColumn` says no, `shouldPreserveParkedLink` is
  false, and a live agent WITH a fresh heartbeat run has its task link cleared.

  The sibling sweep passes the resolved set; this call site did not. One wired, one not — the missed
  pair this whole effort keeps finding, and `task-agent-sync.ts` predicted it in writing when the
  parameter was introduced.
  */
  it("preserves a live agent's link on a card parked in a RENAMED hold lane", async () => {
    const agents = [makeAgent("agent-live", "FN-PARKED")];
    const manager = buildRenamedManager(agents, {
      "FN-PARKED": { id: "FN-PARKED", column: "drafting" } as Task,
    });
    /* A FRESH run is live execution proof: the link must survive precisely because of it. */
    const agentStore = (manager as unknown as { options: { agentStore: { getActiveHeartbeatRun: unknown } } }).options.agentStore;
    (agentStore as { getActiveHeartbeatRun: unknown }).getActiveHeartbeatRun = vi.fn(async () => ({
      id: "run-live",
      agentId: "agent-live",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    }));

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0].taskId).toBe("FN-PARKED");
    manager.stop();
  });

  it("leaves a durable agent linked to a task still in a RENAMED wip lane", async () => {
    /* The sweep must narrow, not widen: an agent on live work keeps its link. */
    const agents = [makeAgent("agent-1", "FN-8")];
    const manager = buildRenamedManager(agents, { "FN-8": { id: "FN-8", column: "building" } as Task });

    await manager.recoverDriftedAgentTaskLinks();

    expect(agents[0].taskId).toBe("FN-8");
    manager.stop();
  });
});
