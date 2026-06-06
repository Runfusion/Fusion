// Persistent column agents replace ephemeral workers (plan U4, R7).
//
// Under `experimentalFeatures.companyModel`, ALL task execution on a company-model
// board resolves to a PERSISTENT agent (the column's bound agent by default; an
// explicit advanced per-task `assignedAgentId` referencing a durable roster agent
// still wins). Ephemeral worker creation is bypassed entirely. Flag off →
// byte-identical to today (ephemeral workers spawn exactly as before).
//
// Two surfaces are exercised:
//   (1) EphemeralWorkerManager.onTaskStart — the OWNERSHIP path: the company
//       resolver binds the durable column agent instead of spawning an ephemeral
//       worker (the central U4 change). Kill-switch and per-task override live here.
//   (2) The executor seam path (mirroring executor-column-agent-principal.test.ts)
//       — the SESSION-PRINCIPAL path: the coding session runs under the column
//       agent identity (gating context, attribution), heartbeats key to it, and a
//       mid-flight agent swap lets the running session finish under the old
//       identity while the next dispatch uses the new one. That machinery is the
//       proven PR #1432 seam wiring; U4 extends it (company boards staff defer-mode
//       column agents) rather than reinventing it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import { EphemeralWorkerManager } from "../ephemeral-worker-manager.js";
import {
  COMPANY_BOARD_TEMPLATE_IR,
  resolveCompanyExecutionAgentId,
  type Agent,
  type Task,
  type WorkflowColumnAgent,
} from "@fusion/core";

// ─────────────────────────────────────────────────────────────────────────────
// (1) EphemeralWorkerManager — ownership-path bypass
// ─────────────────────────────────────────────────────────────────────────────

function durableAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    role: "executor",
    state: "idle",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Agent;
}

function companyTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-CO-1",
    description: "company task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/** A mock AgentStore with the surface EphemeralWorkerManager touches. */
function makeAgentStore(agentsById: Record<string, Agent>) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    getAgent: vi.fn(async (id: string) => agentsById[id] ?? null),
    findAgentByName: vi.fn(async (_name: string) => null),
    createAgent: vi.fn(async (input: Record<string, unknown>) => {
      const id = String(input.name ?? "spawned");
      const agent = durableAgent(id, { metadata: input.metadata as Record<string, unknown> });
      agentsById[id] = agent;
      created.push(input);
      return agent;
    }),
    assignTask: vi.fn(async () => undefined),
    deleteAgent: vi.fn(async () => undefined),
    syncExecutionTaskLink: vi.fn(async () => undefined),
    updateAgentState: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => Object.values(agentsById)),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeTaskStore() {
  return {
    getTask: vi.fn(async () => null),
  };
}

const NOISE_LOGGER = { log: vi.fn(), warn: vi.fn() };

/** The company-model resolver the runtime wires (see in-process-runtime.ts):
 *  flag-gated + company-board-gated + defer/override precedence. Mirrored here so
 *  the manager test exercises the exact contract the runtime supplies. */
function companyOwnerResolver(opts: {
  companyModelOn: boolean;
  ir?: typeof COMPANY_BOARD_TEMPLATE_IR;
}) {
  return async (task: Task): Promise<{ agentId: string } | null> => {
    if (!opts.companyModelOn) return null;
    const ir = opts.ir;
    if (!ir) return null;
    const hasOwnModelPair = Boolean(task.modelProvider && task.modelId);
    const agentId = resolveCompanyExecutionAgentId(ir, task.column, {
      ownAgentId: task.assignedAgentId ?? undefined,
      ownModelProvider: hasOwnModelPair ? task.modelProvider ?? undefined : undefined,
      ownModelId: hasOwnModelPair ? task.modelId ?? undefined : undefined,
    });
    return agentId ? { agentId } : null;
  };
}

/** A company board IR whose in-progress column binds the Executor agent (defer),
 *  matching the U2 board-team-seed shape. */
function companyIrWithExecutor(executorId: string): typeof COMPANY_BOARD_TEMPLATE_IR {
  const binding: WorkflowColumnAgent = { agentId: executorId, mode: "defer" };
  const base = COMPANY_BOARD_TEMPLATE_IR as { columns: Array<{ id: string }> };
  return {
    ...COMPANY_BOARD_TEMPLATE_IR,
    columns: base.columns.map((c) =>
      c.id === "in-progress" ? { ...c, agent: binding } : c,
    ),
  } as typeof COMPANY_BOARD_TEMPLATE_IR;
}

describe("EphemeralWorkerManager: company-model persistent-agent bypass (U4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag-on company board: binds the column Executor agent — NO ephemeral worker spawned", async () => {
    const agentStore = makeAgentStore({ "board-executor-1": durableAgent("board-executor-1") });
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      resolveCompanyExecutionOwner: companyOwnerResolver({
        companyModelOn: true,
        ir: companyIrWithExecutor("board-executor-1"),
      }),
    });

    const owner = await mgr.onTaskStart(companyTask());

    expect(owner).toEqual({ agentId: "board-executor-1", ephemeral: false });
    // The durable column agent was linked + flipped to running; no spawn happened.
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("board-executor-1", "FN-CO-1");
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("board-executor-1", "running");
    expect(agentStore.createAgent).not.toHaveBeenCalled();
  });

  it("two concurrent in-progress tasks both bind the SINGLE Executor identity (identity ≠ concurrency limit)", async () => {
    const agentStore = makeAgentStore({ "board-executor-1": durableAgent("board-executor-1") });
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      resolveCompanyExecutionOwner: companyOwnerResolver({
        companyModelOn: true,
        ir: companyIrWithExecutor("board-executor-1"),
      }),
    });

    const a = await mgr.onTaskStart(companyTask({ id: "FN-CO-A" }));
    const b = await mgr.onTaskStart(companyTask({ id: "FN-CO-B" }));

    expect(a).toEqual({ agentId: "board-executor-1", ephemeral: false });
    expect(b).toEqual({ agentId: "board-executor-1", ephemeral: false });
    expect(agentStore.createAgent).not.toHaveBeenCalled();
    expect(mgr.getOwner("FN-CO-A")?.agentId).toBe("board-executor-1");
    expect(mgr.getOwner("FN-CO-B")?.agentId).toBe("board-executor-1");
  });

  it("kill-switch: flag off → ephemeral worker spawned exactly as today (no column-agent resolution)", async () => {
    const agentStore = makeAgentStore({}); // no durable agents
    const resolver = companyOwnerResolver({ companyModelOn: false });
    const resolverSpy = vi.fn(resolver);
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      getSettings: async () => ({ ephemeralAgentsEnabled: true }),
      resolveCompanyExecutionOwner: resolverSpy,
    });

    const owner = await mgr.onTaskStart(companyTask());

    // Flag-off resolver yields null → the legacy ephemeral spawn path runs.
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(owner?.ephemeral).toBe(true);
    expect(agentStore.createAgent).toHaveBeenCalledTimes(1);
    expect(agentStore.created[0]).toMatchObject({
      name: "executor-FN-CO-1",
      metadata: { taskWorker: true, agentKind: "task-worker" },
    });
  });

  it("non-company board (resolver returns null) → ephemeral path, byte-identical to today", async () => {
    const agentStore = makeAgentStore({});
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      getSettings: async () => ({ ephemeralAgentsEnabled: true }),
      // Flag on, but the board is NOT a company board (no IR) → resolver returns null.
      resolveCompanyExecutionOwner: companyOwnerResolver({ companyModelOn: true, ir: undefined }),
    });

    const owner = await mgr.onTaskStart(companyTask());
    expect(owner?.ephemeral).toBe(true);
    expect(agentStore.createAgent).toHaveBeenCalledTimes(1);
  });

  it("per-task override: explicit durable assignedAgentId wins over the column agent, flag-on (never ephemeral)", async () => {
    const agentStore = makeAgentStore({
      "board-executor-1": durableAgent("board-executor-1"),
      "agent-override": durableAgent("agent-override"),
    });
    const resolver = companyOwnerResolver({
      companyModelOn: true,
      ir: companyIrWithExecutor("board-executor-1"),
    });
    const resolverSpy = vi.fn(resolver);
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      resolveCompanyExecutionOwner: resolverSpy,
    });

    // Task carries an explicit advanced per-task override.
    const owner = await mgr.onTaskStart(companyTask({ assignedAgentId: "agent-override" }));

    // The explicit assigned-agent branch short-circuits BEFORE the company resolver.
    expect(owner).toEqual({ agentId: "agent-override", ephemeral: false });
    expect(resolverSpy).not.toHaveBeenCalled();
    expect(agentStore.createAgent).not.toHaveBeenCalled();
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-override", "FN-CO-1");
  });

  it("defer precedence: even via the resolver, an own complete model pair suppresses the column agent (own settings win)", async () => {
    // No explicit assignedAgentId, but the task carries a complete own model pair —
    // under DEFER that is "own settings", so the column agent does NOT govern. The
    // resolver returns null and (with ephemeral enabled) the legacy path runs.
    const agentStore = makeAgentStore({ "board-executor-1": durableAgent("board-executor-1") });
    const mgr = new EphemeralWorkerManager({
      agentStore: agentStore as any,
      taskStore: makeTaskStore() as any,
      logger: NOISE_LOGGER,
      getSettings: async () => ({ ephemeralAgentsEnabled: true }),
      resolveCompanyExecutionOwner: companyOwnerResolver({
        companyModelOn: true,
        ir: companyIrWithExecutor("board-executor-1"),
      }),
    });

    const owner = await mgr.onTaskStart(
      companyTask({ modelProvider: "openai", modelId: "gpt-own" }),
    );

    expect(owner?.ephemeral).toBe(true);
    expect(agentStore.createAgent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Executor seam path — session principal / gating / heartbeat / hot-swap
//     (mirrors executor-column-agent-principal.test.ts patterns)
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTOR_BINDING: WorkflowColumnAgent = { agentId: "exec-agent", mode: "defer" };

function makeExecutorAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "exec-agent",
    name: "Board Executor",
    soul: "I am the Executor.",
    instructionsText: "Executor persona.",
    memory: undefined,
    permissionPolicy: { rules: {} },
    runtimeConfig: { model: "anthropic/claude-exec", allowParallelExecution: true },
    ...overrides,
  };
}

function seamTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-EXEC",
    title: "Build",
    description: "Build task",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    prompt: "# build\n## Steps\n### Step 0: Implement\n- [ ] implement",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function installTaskDoneAgent() {
  mockedCreateFnAgent.mockImplementation((async (opts: any) => {
    const tools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const done = tools.find((t: any) => t.name === "fn_task_done");
          if (done) await done.execute("tool-1", {});
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        setModel: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    };
  }) as any);
}

function makeExecutor(store: ReturnType<typeof createMockStore>, agentsById: Record<string, unknown>) {
  const agentStore = {
    getAgent: vi.fn(async (id: string) => agentsById[id] ?? null),
    getActiveHeartbeatRun: vi.fn(async () => null),
  };
  const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
  return { executor, agentStore };
}

function seedSeam(
  executor: TaskExecutor,
  taskId: string,
  governingNodeId: string,
  binding: WorkflowColumnAgent | undefined,
) {
  (executor as any).graphSeamGoverningNodeId.set(taskId, governingNodeId);
  (executor as any).graphColumnAgentResolver.set(taskId, (nodeId: string) =>
    nodeId === governingNodeId ? binding : undefined,
  );
}

function lastFnAgentOpts() {
  const calls = mockedCreateFnAgent.mock.calls;
  return calls[calls.length - 1]?.[0] as any;
}

describe("company-board execution principal (seam path, U4)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("flag-on company task entering in-progress runs under the board Executor identity (gating context keyed to it)", async () => {
    const store = createMockStore();
    const task = seamTask(); // no assignedAgentId → column agent governs (defer)
    store.getTask.mockResolvedValue(task as any);
    const { executor } = makeExecutor(store, { "exec-agent": makeExecutorAgent() });
    installTaskDoneAgent();

    seedSeam(executor, task.id, "execute", EXECUTOR_BINDING);
    // The map is cleared in deleteActiveSession at the end of the run, so observe
    // the set() during the session (mirrors executor-column-agent-principal.test.ts).
    const setSpy = vi.spyOn((executor as any).effectiveColumnAgentByTask, "set");
    await (executor as any).runImplementationPhase(task);

    const opts = lastFnAgentOpts();
    // Permission gating + session attribution key to the EFFECTIVE column agent.
    expect(opts.actionGateContext?.agentId).toBe("exec-agent");
    expect(opts.permanentAgentGating?.requester?.actorId).toBe("exec-agent");
    // The reverse heartbeat guard was armed for the Executor while the session ran.
    expect(setSpy).toHaveBeenCalledWith(task.id, "exec-agent");
  });

  it("two tasks in in-progress both resolve to the single Executor principal", () => {
    const store = createMockStore();
    const { executor } = makeExecutor(store, {});
    const taskA = seamTask({ id: "FN-A" });
    const taskB = seamTask({ id: "FN-B" });
    seedSeam(executor, "FN-A", "execute", EXECUTOR_BINDING);
    seedSeam(executor, "FN-B", "execute", EXECUTOR_BINDING);
    expect((executor as any).resolveEffectivePrincipalId(taskA, taskA)).toBe("exec-agent");
    expect((executor as any).resolveEffectivePrincipalId(taskB, taskB)).toBe("exec-agent");
  });

  it("per-task override (own assigned agent) wins over the column agent under defer", () => {
    const store = createMockStore();
    const { executor } = makeExecutor(store, {});
    const task = seamTask({ assignedAgentId: "agent-override" });
    seedSeam(executor, task.id, "execute", EXECUTOR_BINDING);
    // defer + own assigned agent → own settings win → principal is the override.
    expect((executor as any).resolveEffectivePrincipalId(task, task)).toBe("agent-override");
  });

  it("agent replaced mid-flight: running session keeps the OLD model; next dispatch resolves the NEW agent", async () => {
    // The restart watcher hot-swaps the running session's model when the column's
    // bound agent is re-pointed mid-flight (workflow edit / staffing change).
    const store = createMockStore();
    const find = vi.fn().mockReturnValue({ provider: "anthropic", modelId: "claude-exec-v2" });
    const task = seamTask();
    const { executor } = makeExecutor(store, {
      // The column now binds a DIFFERENT effective agent advertising a new model.
      "exec-agent-v2": makeExecutorAgent({
        id: "exec-agent-v2",
        runtimeConfig: { model: "anthropic/claude-exec-v2", allowParallelExecution: true },
      }),
    });
    (executor as any)._modelRegistry = { find };

    const setModel = vi.fn();
    seedSeam(executor, task.id, "execute", { agentId: "exec-agent-v2", mode: "override" });
    (executor as any).activeSessions.set(task.id, {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set<string>(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-exec", // the OLD model the session is running under
      lastTaskModelProvider: undefined,
      lastTaskModelId: undefined,
      lastAssignedAgentId: undefined,
      lastEffectiveColumnAgentId: "exec-agent", // the OLD effective principal
    });

    store._trigger("task:updated", task);
    await vi.waitFor(() => expect(setModel).toHaveBeenCalled());

    // The next dispatch resolves the NEW agent's model and hot-swaps the session.
    expect(find).toHaveBeenCalledWith("anthropic", "claude-exec-v2");
    // The watcher re-keys the tracked principal to the new agent.
    expect((executor as any).activeSessions.get(task.id).lastEffectiveColumnAgentId).toBe("exec-agent-v2");
  });

  it("two sequential turns through the SAME persistent agent: no latched per-session state leaks between them", async () => {
    // The ACP learning: persistent agents fail via state latched on the first turn
    // that single-turn tests miss. Run runImplementationPhase TWICE for the same
    // task+agent and assert the second turn builds a CLEAN session under the same
    // identity (a fresh createFnAgent call, same effective principal, no stale
    // session reused).
    const store = createMockStore();
    const task = seamTask();
    store.getTask.mockResolvedValue(task as any);
    const { executor } = makeExecutor(store, { "exec-agent": makeExecutorAgent() });
    installTaskDoneAgent();

    seedSeam(executor, task.id, "execute", EXECUTOR_BINDING);

    // Turn 1.
    await (executor as any).runImplementationPhase(task);
    const turn1 = lastFnAgentOpts();
    expect(turn1.actionGateContext?.agentId).toBe("exec-agent");
    const turn1Calls = mockedCreateFnAgent.mock.calls.length;

    // Turn 2 — same task, same persistent agent. Re-seed the seam (a real dispatch
    // re-stamps it) and re-run.
    seedSeam(executor, task.id, "execute", EXECUTOR_BINDING);
    await (executor as any).runImplementationPhase(task);
    const turn2 = lastFnAgentOpts();

    // A fresh session was built for turn 2 (no stale reuse) under the SAME identity.
    expect(mockedCreateFnAgent.mock.calls.length).toBe(turn1Calls + 1);
    expect(turn2.actionGateContext?.agentId).toBe("exec-agent");
    expect(turn2.permanentAgentGating?.requester?.actorId).toBe("exec-agent");
    expect(turn2).not.toBe(turn1);
  });
});
