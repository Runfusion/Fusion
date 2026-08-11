import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { resolveWorktreesDir } from "../worktree/worktree-paths.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import { createMockStore, createWorkflowRoutingAgentStore, implementationSessionCalls, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, resetExecutorMocks, selectImplementationSessionCall } from "./executor-test-helpers.js";

/*
FNXC:WorkflowPrincipalRouting 2026-08-09-09:22:
Graph ownership requires principal routing before these liveness harnesses can open an agent
session. This local fixture supplies only the durable executor role and capacity leases without
bypassing graph admission; it returns routing for an intra-test guard that proves lifecycle
assertions reached the routing seam rather than failing vacuously.
*/
function createRoutingExecutor(store: any, options: any = {}) {
  const routing = createWorkflowRoutingAgentStore(store);
  const executor = new TaskExecutor(store, "/repo", { agentStore: routing.agentStore, ...options });
  return { executor, routing };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4114",
    title: "Liveness test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4114",
    // FNXC:WorkflowLifecycle 2026-07-01-19:58: workflowGraphExecutor graduated to default-on, so every task now traverses the built-in coding graph including the default-on plan-review/code-review gate groups. This suite only exercises the pre-workflow worktree liveness gate; a bare mock agent session never satisfies the gates, causing a spurious rebound moveTask(FN-4114, todo, preserveProgress) that broke the accept-path assertions. Disabling the optional groups keeps the graph at planning->execute->review->merge so the liveness invariant stays isolated.
    enabledWorkflowSteps: [],
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// FNXC:WorkflowLifecycle 2026-07-01-19:58: With workflowGraphExecutor default-on the execute node hands off to in-review only when the agent calls fn_task_done; a bare prompt session that resolves undefined trips the "finished without fn_task_done" rebound to todo, which would masquerade as a liveness-gate rejection. Accept-path assertions must drive a completing agent so the ONLY todo rebound under test is the liveness gate itself.
function mockCompletingAgent() {
  // FN-009 carve-out: fn_task_done's verifyWorktreeInvariants skips git validation when the
  // worktree dir does not exist. These liveness tests use fabricated worktree paths, so treating
  // them as absent lets the completing agent hand off to in-review without tripping the
  // wrong_toplevel invariant refusal (which would masquerade as a liveness-gate rebound to todo).
  mockedExistsSync.mockReturnValue(false);
  mockedCreateFnAgent.mockImplementation((async (opts: any) => {
    const customTools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
          if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    };
  }) as any);
}

describe("FN-4114 worktree liveness assertion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetExecutorMocks();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("abc123\n");
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      return Buffer.from("");
    });
  });

  // FNXC:ExecutorTests 2026-07-01-20:40: mockCompletingAgent flips the module-level existsSync mock to
  // false (FN-009 worktree-absent completion carve-out). resetExecutorMocks does NOT reset existsSync, so
  // without this restore the `false` leaks into later files sharing the vitest worker and silently breaks
  // their default (worktree-present) assumptions. Restore the module default (true) after each test.
  afterEach(() => {
    mockedExistsSync.mockReturnValue(true);
  });

  it("FN-4114 aborts before createFnAgent when worktree is missing", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-4114",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "missing", reason: "worktree directory does not exist" });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ sessionFile: null }));

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task({ sessionFile: null }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-6861 aborts with structured audit when worktree realpath collides with repo root", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo",
      branch: "fusion/fn-4114",
      source: "existing",
      hydrated: true,
      isResume: true,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    vi.spyOn(worktreePool, "describeRegisteredWorktrees").mockResolvedValue({
      rawOutput: "worktree /repo\nworktree /repo/.worktrees/swift-falcon\n",
      canonicalized: ["/repo", "/repo/.worktrees/swift-falcon"],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("abc123\n");
      return Buffer.from("");
    });
    const store = createMockStore();
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    store.getTask.mockResolvedValue(task({ worktree: "/repo" }));

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task({ worktree: "/repo" }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "git",
      mutationType: "worktree:incomplete-detected",
      target: "/repo",
      metadata: expect.objectContaining({
        classification: "repo-root",
        observed: "/repo",
        observedRealpath: "/repo",
        expected: "/repo/.worktrees/* (usable, registered)",
        registered: ["/repo", "/repo/.worktrees/swift-falcon"],
        registeredContainsObserved: true,
        invalidCheckoutPath: "repo-root",
        expectedPatternExcludesRepoRoot: true,
        terminalAction: "requeue-todo",
      }),
    }));
  });

  it("FN-6922 proceeds when acquisition self-heals a repo-root assignment to a fresh worktree", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/fn-6922-fresh",
      branch: "fusion/fn-4114",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "repo-root", reason: "would have been root before acquisition guard" });
    const store = createMockStore();
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    store.getTask.mockResolvedValue(task({ worktree: "/repo", sessionFile: null }));

    mockCompletingAgent();

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task({ worktree: "/repo", sessionFile: null }) as any);

    expect(implementationSessionCalls(
      mockedCreateFnAgent.mock.calls.map(([options]) => options as { customTools?: Array<{ name?: string }> }),
    )).not.toHaveLength(0);
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "repo-root", source: "executor-liveness-gate" }),
    }));
  });

  it.each([
    { name: "default worktreesDir", settings: {}, outsidePath: "/repo/not-a-worktree" },
    { name: "absolute worktreesDir", settings: { worktreesDir: "/custom/trees" }, outsidePath: "/repo/not-a-worktree" },
    { name: "relative worktreesDir", settings: { worktreesDir: "custom-trees" }, outsidePath: "/repo/not-a-worktree" },
  ])("FN-4114 enforces configured worktreesDir ($name)", async ({ settings, outsidePath }) => {
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    /*
    FNXC:WorktreeLiveness 2026-08-09-09:22:
    Real acquisition refreshes stale bases before returning and prevents this harness from reaching
    its configured-directory gate. Supply only each phase's acquired path through the file's
    established acquisition seam; the production containment gate still decides reject versus
    accept, preserving the fresh-store two-phase invariant below.
    */
    const acquireWorktree = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree");
    const store = createMockStore();
    const baseSettings = await store.getSettings();
    const mergedSettings = { ...baseSettings, ...settings };
    store.getSettings.mockResolvedValue(mergedSettings);

    const allowedWorktree = `${resolveWorktreesDir("/repo", mergedSettings as any)}/fn-4114`;
    acquireWorktree
      .mockResolvedValueOnce({ worktreePath: outsidePath, branch: "fusion/fn-4114", source: "pool", hydrated: true, isResume: false })
      .mockResolvedValueOnce({ worktreePath: allowedWorktree, branch: "fusion/fn-4114", source: "pool", hydrated: true, isResume: false });
    store.getTask.mockResolvedValue(task({ worktree: outsidePath }));

    const { executor: rejectExecutor } = createRoutingExecutor(store as any);
    await rejectExecutor.execute(task({ worktree: outsidePath }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });

    mockedCreateFnAgent.mockReset();
    mockCompletingAgent();

    /*
    FNXC:ExecutorTests 2026-07-23-21:20:
    The accept phase must model a task that is genuinely live in-progress with the allowed
    worktree. The helper store is write-through (updateTask/moveTask patches are readable back),
    so reusing the reject phase's store leaks its rebound residue — column "todo", worktree
    null — into the graph's live-row re-reads, and the graph now ends the run benignly when the
    live row has already left in-progress instead of dispatching the agent (graph-owned
    lifecycle cutover, #2342 line). A fresh store per phase keeps the ONLY variable under test
    the worktree path itself.
    */
    const acceptStore = createMockStore();
    acceptStore.getSettings.mockResolvedValue(mergedSettings);
    acceptStore.getTask.mockResolvedValue(task({ worktree: allowedWorktree }));

    const { executor: acceptExecutor } = createRoutingExecutor(acceptStore as any);
    await acceptExecutor.execute(task({ worktree: allowedWorktree }) as any);

    expect(implementationSessionCalls(
      mockedCreateFnAgent.mock.calls.map(([options]) => options as { customTools?: Array<{ name?: string }> }),
    )).not.toHaveLength(0);
    expect(acceptStore.moveTask).not.toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 accepts usable pool-acquired worktrees", async () => {
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-4114",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task());

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    }) as any);

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task() as any);

    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  it("FN-4935 skips liveness gate for fresh acquisition even with assigned worktree", async () => {
    const classifySpy = vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/new-path",
      branch: "fusion/fn-4114",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ worktree: "/repo/.worktrees/stale" }));

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    }) as any);

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task({ worktree: "/repo/.worktrees/stale" }) as any);

    expect(classifySpy).not.toHaveBeenCalled();
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowPrincipalRouting 2026-08-09-11:05:
  FN-8883 observed 34 vacuous failures when an unrouted graph run opened zero createFnAgent
  sessions and never exposed fn_task_done. These paired guards prove the accept path opens the
  implementation session and the missing-agent-store path stays suspended rather than tolerated.
  */
  it("opens an implementation session and hands routed work to graph review", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-4114",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ sessionFile: null }));
    mockCompletingAgent();
    const { executor, routing } = createRoutingExecutor(store as any);

    await executor.execute(task({ sessionFile: null }) as any);

    expect(selectImplementationSessionCall(
      mockedCreateFnAgent.mock.calls.map(([options]) => options as { customTools?: Array<{ name?: string }> }),
    )).toBeDefined();
    expect(routing.agentStore.listAgents).toHaveBeenCalledWith({ includeEphemeral: true });
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-4114",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
  });

  it("suspends an unrouted graph run before opening an implementation session", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-4114",
      source: "fresh",
      hydrated: true,
      isResume: false,
    });
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ sessionFile: null }));
    const executor = new TaskExecutor(store as any, "/repo", {});

    await executor.execute(task({ sessionFile: null }) as any);

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(
      "FN-4114",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
  });

  it("FN-4935 runs liveness gate for pooled/reused assigned worktree", async () => {
    const classifySpy = vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/repo/.worktrees/swift-falcon",
      branch: "fusion/fn-4114",
      source: "pool",
      hydrated: true,
      isResume: false,
    });
    const store = createMockStore();
    store.getTask.mockResolvedValue(task({ worktree: "/repo/.worktrees/swift-falcon", sessionFile: null }));

    const { executor } = createRoutingExecutor(store as any);
    await executor.execute(task({ worktree: "/repo/.worktrees/swift-falcon", sessionFile: null }) as any);

    expect(classifySpy).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });
});
