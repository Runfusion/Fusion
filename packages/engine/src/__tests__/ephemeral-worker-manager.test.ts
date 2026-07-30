import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { EphemeralWorkerManager } from "../ephemeral-worker-manager.js";

const BASE_TIME = "2026-07-03T00:00:00.000Z";

type AgentPatch = Partial<Agent> & { metadata?: Record<string, unknown>; runtimeConfig?: Record<string, unknown> };

type FakeAgentStore = AgentStore & EventEmitter & {
  agents: Map<string, Agent>;
  createAgent: ReturnType<typeof vi.fn>;
  deleteAgent: ReturnType<typeof vi.fn>;
  assignTask: ReturnType<typeof vi.fn>;
  syncExecutionTaskLink: ReturnType<typeof vi.fn>;
  updateAgentState: ReturnType<typeof vi.fn>;
  findAgentByName: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
};

type Harness = {
  agentStore: FakeAgentStore;
  taskStore: TaskStore & { tasks: Map<string, Task>; getTask: ReturnType<typeof vi.fn> };
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  externalPending: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  manager: EphemeralWorkerManager;
};

function makeAgent(id: string, patch: AgentPatch = {}): Agent {
  return {
    id,
    name: patch.name ?? id,
    role: patch.role ?? "executor",
    state: patch.state ?? "idle",
    taskId: patch.taskId,
    createdAt: patch.createdAt ?? BASE_TIME,
    updatedAt: patch.updatedAt ?? BASE_TIME,
    metadata: patch.metadata ?? {},
    runtimeConfig: patch.runtimeConfig,
  } as Agent;
}

function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "test task",
    column: "in-progress",
    steps: [],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...patch,
  } as Task;
}

function createAgentStore(initialAgents: Agent[] = []): FakeAgentStore {
  const emitter = new EventEmitter() as FakeAgentStore;
  emitter.agents = new Map(initialAgents.map((agent) => [agent.id, structuredClone(agent)]));

  emitter.getAgent = vi.fn(async (agentId: string) => emitter.agents.get(agentId) ?? null);
  emitter.listAgents = vi.fn(async () => Array.from(emitter.agents.values()));
  emitter.findAgentByName = vi.fn(async (name: string) => Array.from(emitter.agents.values()).find((agent) => agent.name === name) ?? null);
  emitter.createAgent = vi.fn(async (input: Partial<Agent>) => {
    const id = `agent-${emitter.agents.size + 1}`;
    const agent = makeAgent(id, {
      name: input.name ?? id,
      role: input.role ?? "executor",
      state: input.state ?? "idle",
      metadata: input.metadata as Record<string, unknown> | undefined,
      runtimeConfig: input.runtimeConfig as Record<string, unknown> | undefined,
    });
    emitter.agents.set(agent.id, agent);
    emitter.emit("agent:created", agent);
    return agent;
  });
  emitter.assignTask = vi.fn(async (agentId: string, taskId: string) => {
    const agent = emitter.agents.get(agentId);
    if (agent) {
      agent.taskId = taskId;
      agent.updatedAt = BASE_TIME;
      emitter.emit("agent:assigned", agent, taskId);
    }
    return agent ?? null;
  });
  emitter.syncExecutionTaskLink = vi.fn(async (agentId: string, taskId?: string) => {
    const agent = emitter.agents.get(agentId);
    if (agent) {
      if (taskId) agent.taskId = taskId;
      else delete (agent as { taskId?: string }).taskId;
      agent.updatedAt = BASE_TIME;
    }
    return agent ?? null;
  });
  emitter.updateAgentState = vi.fn(async (agentId: string, state: Agent["state"]) => {
    const agent = emitter.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const from = agent.state;
    agent.state = state;
    agent.updatedAt = BASE_TIME;
    emitter.emit("agent:stateChanged", agentId, from, state);
    return agent;
  });
  emitter.deleteAgent = vi.fn(async (agentId: string) => {
    if (!emitter.agents.has(agentId)) throw new Error(`Agent ${agentId} not found`);
    emitter.agents.delete(agentId);
    emitter.emit("agent:deleted", agentId);
  });
  return emitter;
}

function createHarness(initialAgents: Agent[] = []): Harness {
  const agentStore = createAgentStore(initialAgents);
  const tasks = new Map<string, Task>();
  const taskStore = {
    tasks,
    getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
  } as unknown as Harness["taskStore"];
  const logger = { log: vi.fn(), warn: vi.fn() };
  const externalPending = vi.fn(() => false);
  const getSettings = vi.fn(async () => ({ ephemeralAgentsEnabled: true }));
  const manager = new EphemeralWorkerManager({
    agentStore,
    taskStore,
    logger,
    isDeletionPendingExternal: externalPending,
    getSettings,
  });
  return { agentStore, taskStore, logger, externalPending, getSettings, manager };
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

describe("EphemeralWorkerManager", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createHarness();
  });

  describe("task ownership", () => {
    it("uses durable assigned agents without creating task workers", async () => {
      const durable = makeAgent("durable-1", { name: "Durable", state: "idle", metadata: {} });
      harness.agentStore.agents.set(durable.id, durable);

      const owner = await harness.manager.onTaskStart(makeTask("FN-DURABLE", { assignedAgentId: durable.id }));

      expect(owner).toEqual({ agentId: durable.id, ephemeral: false });
      expect(harness.agentStore.syncExecutionTaskLink).toHaveBeenCalledWith(durable.id, "FN-DURABLE");
      expect(harness.agentStore.createAgent).not.toHaveBeenCalled();
      expect(harness.agentStore.updateAgentState).toHaveBeenNthCalledWith(1, durable.id, "active");
      expect(harness.agentStore.updateAgentState).toHaveBeenNthCalledWith(2, durable.id, "running");
      expect(harness.manager.getOwner("FN-DURABLE")).toEqual(owner);
    });

    it("creates, assigns, and runs an ephemeral worker for unassigned tasks", async () => {
      const owner = await harness.manager.onTaskStart(makeTask("FN-EPHEMERAL"));

      expect(owner).toEqual({ agentId: "agent-1", ephemeral: true });
      expect(harness.agentStore.createAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: "executor-FN-EPHEMERAL",
        role: "executor",
        metadata: expect.objectContaining({ agentKind: "task-worker", taskWorker: true }),
        runtimeConfig: { enabled: false },
      }));
      expect(harness.agentStore.assignTask).toHaveBeenCalledWith("agent-1", "FN-EPHEMERAL");
      expect(harness.agentStore.updateAgentState).toHaveBeenNthCalledWith(1, "agent-1", "active");
      expect(harness.agentStore.updateAgentState).toHaveBeenNthCalledWith(2, "agent-1", "running");
    });

    it("reuses an existing cross-restart ephemeral worker for the same task", async () => {
      const existing = makeAgent("worker-1", {
        name: "executor-FN-REUSE",
        taskId: "FN-REUSE",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      harness = createHarness([existing]);

      const owner = await harness.manager.onTaskStart(makeTask("FN-REUSE"));

      expect(owner).toEqual({ agentId: existing.id, ephemeral: true });
      expect(harness.agentStore.createAgent).not.toHaveBeenCalled();
      expect(harness.logger.log).toHaveBeenCalledWith(expect.stringContaining("Reusing existing ephemeral worker"));
    });

    it("deletes stale same-name workers before respawning", async () => {
      const stale = makeAgent("worker-stale", {
        name: "executor-FN-RESPAWN",
        taskId: "FN-OLD",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      harness = createHarness([stale]);

      const owner = await harness.manager.onTaskStart(makeTask("FN-RESPAWN"));

      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith(stale.id);
      expect(owner).toEqual({ agentId: "agent-1", ephemeral: true });
      expect(harness.agentStore.agents.has(stale.id)).toBe(false);
    });

    it("refuses to spawn when ephemeral agents are disabled", async () => {
      harness.getSettings.mockResolvedValueOnce({ ephemeralAgentsEnabled: false });

      const owner = await harness.manager.onTaskStart(makeTask("FN-DISABLED"));

      expect(owner).toBeNull();
      expect(harness.agentStore.createAgent).not.toHaveBeenCalled();
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("ephemeralAgentsEnabled=false"));
    });

    it("falls back to task-worker ownership when assignedAgentId points to an ephemeral", async () => {
      const ephemeral = makeAgent("child-1", {
        name: "child",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      harness.agentStore.agents.set(ephemeral.id, ephemeral);

      const owner = await harness.manager.onTaskStart(makeTask("FN-ASSIGNED-EPHEMERAL", { assignedAgentId: ephemeral.id }));

      expect(owner).toEqual({ agentId: "agent-2", ephemeral: true });
      expect(harness.agentStore.syncExecutionTaskLink).not.toHaveBeenCalledWith(ephemeral.id, "FN-ASSIGNED-EPHEMERAL");
      expect(harness.agentStore.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: "executor-FN-ASSIGNED-EPHEMERAL" }));
    });
  });

  describe("completion and error cleanup", () => {
    it("returns durable owners to active and does not delete them on completion or error", async () => {
      const durable = makeAgent("durable-cleanup", { name: "Durable Cleanup", state: "active" });
      harness.agentStore.agents.set(durable.id, durable);

      await harness.manager.onTaskStart(makeTask("FN-DURABLE-COMPLETE", { assignedAgentId: durable.id }));
      await harness.manager.onTaskComplete("FN-DURABLE-COMPLETE");
      expect(harness.agentStore.syncExecutionTaskLink).toHaveBeenLastCalledWith(durable.id, undefined);
      expect(harness.agentStore.deleteAgent).not.toHaveBeenCalledWith(durable.id);
      expect((await harness.agentStore.getAgent(durable.id))?.state).toBe("active");
      expect((await harness.agentStore.getAgent(durable.id))?.taskId).toBeUndefined();

      await harness.manager.onTaskStart(makeTask("FN-DURABLE-ERROR", { assignedAgentId: durable.id }));
      await harness.manager.onTaskError("FN-DURABLE-ERROR");
      expect(harness.agentStore.deleteAgent).not.toHaveBeenCalledWith(durable.id);
      expect((await harness.agentStore.getAgent(durable.id))?.state).toBe("active");
    });

    it("deletes ephemeral owners on completion and error", async () => {
      await harness.manager.onTaskStart(makeTask("FN-COMPLETE"));
      await harness.manager.onTaskComplete("FN-COMPLETE");
      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith("agent-1");
      expect(harness.manager.isDeletionPending("agent-1")).toBe(false);

      await harness.manager.onTaskStart(makeTask("FN-ERROR"));
      await harness.manager.onTaskError("FN-ERROR");
      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith("agent-1");
    });

    it("recovers a cross-restart owner by name during completion cleanup", async () => {
      const existing = makeAgent("worker-disk", {
        name: "executor-FN-DISK",
        taskId: "FN-DISK",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      harness = createHarness([existing]);

      await harness.manager.onTaskComplete("FN-DISK");

      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith(existing.id);
      expect(harness.logger.log).toHaveBeenCalledWith(expect.stringContaining("Recovered ephemeral owner"));
    });

    it("logs genuine cleanup warnings and suppresses benign delete races", async () => {
      await harness.manager.onTaskStart(makeTask("FN-WARN"));
      harness.agentStore.deleteAgent.mockRejectedValueOnce(new Error("delete failed"));
      await harness.manager.onTaskError("FN-WARN");
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to delete agent agent-1 after error: delete failed"));

      harness.logger.warn.mockClear();
      const benignOwner = await harness.manager.onTaskStart(makeTask("FN-BENIGN"));
      expect(benignOwner).toBeDefined();
      harness.agentStore.deleteAgent.mockRejectedValueOnce(new Error(`Agent ${benignOwner!.agentId} not found`));
      await harness.manager.onTaskComplete("FN-BENIGN");
      expect(harness.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Failed to delete agent"));
    });
  });

  describe("halt listener cleanup", () => {
    it("deletes task-worker and spawned ephemerals that enter halted states", async () => {
      const taskWorker = makeAgent("worker-paused", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      const spawned = makeAgent("spawned-error", { metadata: { type: "spawned" }, runtimeConfig: { enabled: false } });
      harness.agentStore.agents.set(taskWorker.id, taskWorker);
      harness.agentStore.agents.set(spawned.id, spawned);
      harness.manager.attachStateChangeListener();

      harness.agentStore.emit("agent:stateChanged", taskWorker.id, "running", "paused");
      harness.agentStore.emit("agent:stateChanged", spawned.id, "running", "error");
      await flushMicrotasks();

      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith(taskWorker.id);
      expect(harness.agentStore.deleteAgent).toHaveBeenCalledWith(spawned.id);
    });

    it("ignores non-ephemeral agents, unchanged states, and externally pending deletes", async () => {
      const durable = makeAgent("durable-paused", { metadata: {}, runtimeConfig: { enabled: true } });
      const pending = makeAgent("pending-paused", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      harness.agentStore.agents.set(durable.id, durable);
      harness.agentStore.agents.set(pending.id, pending);
      harness.externalPending.mockImplementation((agentId: string) => agentId === pending.id);
      harness.manager.attachStateChangeListener();

      harness.agentStore.emit("agent:stateChanged", durable.id, "active", "paused");
      harness.agentStore.emit("agent:stateChanged", pending.id, "running", "paused");
      harness.agentStore.emit("agent:stateChanged", pending.id, "paused", "paused");
      await flushMicrotasks();

      expect(harness.agentStore.deleteAgent).not.toHaveBeenCalled();
    });

    it("prevents duplicate listener deletes and detaches cleanly", async () => {
      let resolveDelete: (() => void) | undefined;
      const worker = makeAgent("worker-dup", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      harness.agentStore.agents.set(worker.id, worker);
      harness.agentStore.deleteAgent.mockImplementationOnce(async (agentId: string) => {
        await new Promise<void>((resolve) => { resolveDelete = resolve; });
        harness.agentStore.agents.delete(agentId);
      });
      const listener = harness.manager.attachStateChangeListener();
      expect(harness.manager.attachStateChangeListener()).toBe(listener);

      harness.agentStore.emit("agent:stateChanged", worker.id, "running", "paused");
      harness.agentStore.emit("agent:stateChanged", worker.id, "running", "error");
      await flushMicrotasks();
      expect(harness.agentStore.deleteAgent).toHaveBeenCalledTimes(1);
      resolveDelete?.();
      await flushMicrotasks();

      harness.manager.detachStateChangeListener();
      const afterDetach = makeAgent("worker-detached", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      harness.agentStore.agents.set(afterDetach.id, afterDetach);
      harness.agentStore.emit("agent:stateChanged", afterDetach.id, "running", "paused");
      await flushMicrotasks();
      expect(harness.agentStore.deleteAgent).toHaveBeenCalledTimes(1);
    });

    it("suppresses benign halt-delete races but logs genuine failures", async () => {
      const benign = makeAgent("worker-benign", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      const genuine = makeAgent("worker-genuine", { metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
      harness.agentStore.agents.set(benign.id, benign);
      harness.agentStore.agents.set(genuine.id, genuine);
      harness.manager.attachStateChangeListener();
      harness.agentStore.deleteAgent
        .mockRejectedValueOnce(new Error(`Agent ${benign.id} not found`))
        .mockRejectedValueOnce(new Error("delete failed"));

      harness.agentStore.emit("agent:stateChanged", benign.id, "running", "paused");
      harness.agentStore.emit("agent:stateChanged", genuine.id, "running", "paused");
      await flushMicrotasks();

      expect(harness.logger.warn).toHaveBeenCalledTimes(1);
      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to delete ephemeral agent ${genuine.id}`));
    });
  });

  describe("startup reconciliation", () => {
    it("returns zero for empty or all-durable agent lists", async () => {
      expect(await harness.manager.reconcileOrphaned()).toBe(0);

      harness.agentStore.agents.set("durable", makeAgent("durable", { metadata: {}, taskId: "FN-1" }));
      expect(await harness.manager.reconcileOrphaned()).toBe(0);
      expect(harness.agentStore.deleteAgent).not.toHaveBeenCalled();
    });

    it("keeps populated in-progress ephemeral workers and deletes stale task bindings", async () => {
      const live = makeAgent("live-worker", { metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" });
      const done = makeAgent("done-worker", { metadata: { agentKind: "task-worker" }, taskId: "FN-DONE" });
      const todo = makeAgent("todo-worker", { metadata: { agentKind: "task-worker" }, taskId: "FN-TODO" });
      harness.agentStore.agents.set(live.id, live);
      harness.agentStore.agents.set(done.id, done);
      harness.agentStore.agents.set(todo.id, todo);
      harness.taskStore.tasks.set("FN-LIVE", makeTask("FN-LIVE", { column: "in-progress" }));
      harness.taskStore.tasks.set("FN-DONE", makeTask("FN-DONE", { column: "done" }));
      harness.taskStore.tasks.set("FN-TODO", makeTask("FN-TODO", { column: "todo" }));

      expect(await harness.manager.reconcileOrphaned()).toBe(2);

      expect(harness.agentStore.agents.has(live.id)).toBe(true);
      expect(harness.agentStore.agents.has(done.id)).toBe(false);
      expect(harness.agentStore.agents.has(todo.id)).toBe(false);
    });

    it("deletes no-task, missing-task, paused, and error ephemerals", async () => {
      const agents = [
        makeAgent("no-task", { metadata: { agentKind: "task-worker" } }),
        makeAgent("missing-task", { metadata: { agentKind: "task-worker" }, taskId: "FN-MISSING" }),
        makeAgent("paused", { state: "paused", metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" }),
        makeAgent("error", { state: "error", metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" }),
      ];
      for (const agent of agents) harness.agentStore.agents.set(agent.id, agent);
      harness.taskStore.tasks.set("FN-LIVE", makeTask("FN-LIVE", { column: "in-progress" }));

      expect(await harness.manager.reconcileOrphaned()).toBe(4);
      for (const agent of agents) expect(harness.agentStore.agents.has(agent.id)).toBe(false);
    });

    it("counts benign delete races and continues past genuine delete failures", async () => {
      const benign = makeAgent("sweep-benign", { metadata: { agentKind: "task-worker" } });
      const failing = makeAgent("sweep-failing", { metadata: { agentKind: "task-worker" } });
      const next = makeAgent("sweep-next", { metadata: { agentKind: "task-worker" } });
      harness.agentStore.agents.set(benign.id, benign);
      harness.agentStore.agents.set(failing.id, failing);
      harness.agentStore.agents.set(next.id, next);
      harness.agentStore.deleteAgent
        .mockRejectedValueOnce(new Error(`Agent ${benign.id} not found`))
        .mockRejectedValueOnce(new Error("delete failed"))
        .mockImplementationOnce(async (agentId: string) => { harness.agentStore.agents.delete(agentId); });

      expect(await harness.manager.reconcileOrphaned()).toBe(2);

      expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Startup sweep failed to delete ephemeral agent ${failing.id}`));
      expect(harness.agentStore.agents.has(next.id)).toBe(false);
      expect(harness.logger.log).toHaveBeenCalledWith(expect.stringContaining("Startup ephemeral sweep cleaned 2 orphaned agent(s)"));
    });
  });

  it("reset clears owners and pending deletions", async () => {
    await harness.manager.onTaskStart(makeTask("FN-RESET"));
    expect(harness.manager.getOwner("FN-RESET")).toBeDefined();

    harness.manager.reset();

    expect(harness.manager.getOwner("FN-RESET")).toBeUndefined();
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-06:10 (engine feed):

THE INVARIANT: the zombie sweep asks the task's OWN workflow whether its worker is still working.

A LIVE WORKER WAS REAPED ON A RENAMED BOARD, and the two guards compounded in the worst possible
order. `shouldDeleteOnSweep` tested a hard-coded terminal Set first, then fell through to
`return task.column !== "in-progress"`. On a renamed board the terminal test missed, and the fallthrough
is TRUE for a renamed wip lane — so an ephemeral worker ACTIVELY EXECUTING a task was classified as a
zombie and deleted, destroying work in flight.

Census-invisible on both halves: the terminal check is a `Set` literal (a definition, not a
comparison), and the wip check was reached only after it. Found by grepping for lane-shaped list
literals, not by the backlog.

THE FALLBACK IS DELIBERATELY ASYMMETRIC. An unresolvable workflow keeps the legacy literals rather
than guessing: failing to reap a dead worker costs a slot, reaping a live one destroys work. Those
are not symmetric, so the uncertain case must fail toward keeping the worker.

REVERT PROOF, measured: restore the literal pair and the renamed-wip case fails — the live worker is
deleted.
*/
describe("ephemeral zombie sweep resolves the board's own lanes", () => {
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };

  function renamedHarness() {
    const harness = createHarness();
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    Object.assign(harness.taskStore as unknown as Record<string, unknown>, {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
    });
    return harness;
  }

  it("KEEPS a worker whose task sits in a RENAMED wip lane", async () => {
    const harness = renamedHarness();
    const live = makeAgent("renamed-live", { metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" });
    harness.agentStore.agents.set(live.id, live);
    harness.taskStore.tasks.set("FN-LIVE", makeTask("FN-LIVE", { column: "building" }));

    await harness.manager.reconcileOrphaned();

    expect(harness.agentStore.agents.has(live.id)).toBe(true);
  });

  it("still reaps a worker whose task reached a RENAMED complete lane", async () => {
    // The sweep must keep sweeping — keeping everything would be its own leak.
    const harness = renamedHarness();
    const done = makeAgent("renamed-done", { metadata: { agentKind: "task-worker" }, taskId: "FN-DONE" });
    harness.agentStore.agents.set(done.id, done);
    harness.taskStore.tasks.set("FN-DONE", makeTask("FN-DONE", { column: "shipped" }));

    await harness.manager.reconcileOrphaned();

    expect(harness.agentStore.agents.has(done.id)).toBe(false);
  });

  it("still reaps a worker parked in a RENAMED hold lane", async () => {
    const harness = renamedHarness();
    const parked = makeAgent("renamed-parked", { metadata: { agentKind: "task-worker" }, taskId: "FN-PARKED" });
    harness.agentStore.agents.set(parked.id, parked);
    harness.taskStore.tasks.set("FN-PARKED", makeTask("FN-PARKED", { column: "backlog" }));

    await harness.manager.reconcileOrphaned();

    expect(harness.agentStore.agents.has(parked.id)).toBe(false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-09:30 (#2787 review — greptile P1):
A SECOND wip lane must keep its worker too.

`resolveLifecycleColumns` returns the FIRST column carrying each trait, so the first version of this
fix recognised only one implementation lane. A board declaring two — a common shape once a workflow
splits implementation from, say, an integration lane — still reaped a live worker in the second. The
same defect this suite exists to prevent, one degree narrower, and it would have surfaced the first
time someone added that column rather than at conversion time.

The guard now unions `columnsWithFlag(ir, "countsTowardWip")`, which is every wip-bearing column.

REVERT PROOF, measured: narrow the check back to `lanes.wip` and the second-lane case below fails.
*/
describe("the zombie sweep honours EVERY wip lane, not the first", () => {
  const TWO_WIP_IR = {
    version: "v2", id: "wf-two-wip", name: "two wip", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "integrating", name: "Integrating", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  };

  function twoWipHarness() {
    const harness = createHarness();
    const selection = { workflowId: "wf-two-wip", stepIds: [] as string[] };
    Object.assign(harness.taskStore as unknown as Record<string, unknown>, {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ ir: TWO_WIP_IR }),
    });
    return harness;
  }

  it("KEEPS a worker whose task sits in the SECOND wip lane", async () => {
    const harness = twoWipHarness();
    const live = makeAgent("second-lane-live", { metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" });
    harness.agentStore.agents.set(live.id, live);
    harness.taskStore.tasks.set("FN-LIVE", makeTask("FN-LIVE", { column: "integrating" }));

    await harness.manager.reconcileOrphaned();

    expect(harness.agentStore.agents.has(live.id)).toBe(true);
  });

  it("still keeps a worker in the FIRST wip lane", async () => {
    const harness = twoWipHarness();
    const live = makeAgent("first-lane-live", { metadata: { agentKind: "task-worker" }, taskId: "FN-LIVE" });
    harness.agentStore.agents.set(live.id, live);
    harness.taskStore.tasks.set("FN-LIVE", makeTask("FN-LIVE", { column: "building" }));

    await harness.manager.reconcileOrphaned();

    expect(harness.agentStore.agents.has(live.id)).toBe(true);
  });
});
