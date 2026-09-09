import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore as CoreTaskStore } from "@fusion/core";
import type { Settings, Task, TaskDetail, TaskStore, WorkflowIrNode, WorkspaceConfig } from "@fusion/core";
import { prepareGraphNodeExecution } from "../executor/prepare-graph-node-execution.js";
import { ensureGraphCustomNodeWorktree } from "../executor/ensure-graph-custom-node-worktree.js";
import { blockOuterDispatchWhenFileScopeLeaseHeld } from "../executor/file-scope-lease-dispatch-gate.js";
import { GridlockDetector } from "../healing/gridlock-detector.js";
import { Scheduler } from "../scheduler.js";
import { SelfHealingManager } from "../self-healing.js";
import { acquireWorkspaceTaskWorktrees } from "../worktree/worktree-acquisition.js";

vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-acquisition.js")>();
  return {
    ...actual,
    acquireWorkspaceTaskWorktrees: vi.fn(actual.acquireWorkspaceTaskWorktrees),
  };
});

const mockedAcquireWorkspaceTaskWorktrees = vi.mocked(acquireWorkspaceTaskWorktrees);

function task(overrides: Record<string, unknown> = {}): TaskDetail {
  return {
    id: "FN-273",
    title: "Workspace refresh",
    description: "Workspace refresh",
    column: "in-progress",
    dependencies: [],
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

const workspaceConfig: WorkspaceConfig = { repos: ["repo-a"] };
const settings = {} as Settings;
const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

const REPAIR_WORKFLOW = {
  version: "v2",
  id: "workspace-overlap-repair",
  name: "Workspace overlap repair",
  nodes: [],
  edges: [],
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "In review", traits: [{ trait: "merge" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
};

function overlapTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workflowStepResults: [PASSED_PLAN_REVIEW],
    ...overrides,
  } as Task;
}

function createOverlapStore(tasks: Task[], scopes: Record<string, string[]>): { store: TaskStore; byId: Map<string, Task> } {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const settings = { maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true, globalPause: false, enginePaused: false } as Settings;
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const current = byId.get(id);
    if (!current) throw new Error(`missing ${id}`);
    const next = { ...current, ...patch } as Task;
    byId.set(id, next);
    return next;
  });
  const transitionQueuedEpisode = vi.fn(async (id: string, transition: {
    signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string;
  }) => {
    const current = byId.get(id);
    if (!current) throw new Error(`missing ${id}`);
    const next = {
      ...current,
      status: "queued",
      blockedBy: transition.blockedBy,
      overlapBlockedBy: transition.overlapBlockedBy,
      queuedLogEpisodeSignature: transition.signature,
    } as Task;
    byId.set(id, next);
    return { appended: true, task: next };
  });
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => updateTask(id, { column }));
  const store = {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (options?: { column?: Task["column"] }) => {
      const all = [...byId.values()];
      return options?.column ? all.filter((entry) => entry.column === options.column) : all;
    }),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    parseFileScopeFromPrompt: vi.fn(async (id: string) => scopes[id] ?? []),
    updateTask,
    moveTask,
    moveTaskIf: vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>) => {
      const current = byId.get(id);
      if (!current || !(await predicate(current))) return { task: current, moved: false };
      return { task: await moveTask(id, column), moved: true };
    }),
    transitionQueuedEpisode,
    logEntry: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getRootDir: vi.fn(() => "/workspace"),
    getTasksDir: vi.fn(() => "/workspace/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { store, byId };
}

async function repairWorkspaceOverlap(
  tasks: Task[],
  scopes: Record<string, string[]>,
  subject: Task,
): Promise<{ reason?: string; repaired?: boolean }> {
  const selection = { workflowId: REPAIR_WORKFLOW.id, stepIds: [] as string[] };
  const self = {
    getTask: vi.fn(async (id: string) => tasks.find((entry) => entry.id === id) ?? null),
    listTasks: vi.fn(async () => tasks),
    getSettings: vi.fn(async () => ({ overlapIgnorePaths: [] })),
    parseFileScopeFromPrompt: vi.fn(async (taskId: string) => scopes[taskId] ?? []),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => unknown) => {
      const patch = await mutate(subject);
      return { ...subject, ...(patch as object) };
    }),
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => ({ ir: REPAIR_WORKFLOW }),
    logEntry: vi.fn(async () => undefined),
    emit: vi.fn(),
    isWatching: false,
    taskCache: new Map(),
  };
  (self as typeof self & { findCurrentOverlapBlockerForRepair: unknown }).findCurrentOverlapBlockerForRepair =
    CoreTaskStore.prototype["findCurrentOverlapBlockerForRepair" as keyof CoreTaskStore];

  return (CoreTaskStore.prototype as unknown as {
    repairOverlapBlocker: (this: unknown, id: string, options?: unknown) => Promise<{ reason?: string; repaired?: boolean }>;
  }).repairOverlapBlocker.call(self, subject.id, {});
}

afterEach(() => vi.clearAllMocks());

describe("workspace implementation base-refresh enablement", () => {
  it("forwards refresh from write-capable code and skips read-only graph preparation", async () => {
    const live = task();
    const ensureGraphCustomNodeWorktree = vi.fn(async (value: TaskDetail) => value);
    const deps = {
      store: { getTask: vi.fn(async () => live), logEntry: vi.fn(async () => undefined) } as unknown as TaskStore,
      rootDir: "/workspace",
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => null,
      setWorkspaceConfig: vi.fn(),
      getRunContextFor: () => undefined,
      ensureGraphCustomNodeWorktree,
    };

    await prepareGraphNodeExecution(
      deps,
      { id: "implementation", kind: "code", config: { toolMode: "coding" } } as WorkflowIrNode,
      live,
      settings,
      { requiresWorktree: true },
    );
    await prepareGraphNodeExecution(
      deps,
      { id: "review", kind: "prompt" } as WorkflowIrNode,
      live,
      settings,
      { requiresWorktree: false },
    );

    expect(ensureGraphCustomNodeWorktree).toHaveBeenCalledOnce();
    expect(ensureGraphCustomNodeWorktree).toHaveBeenCalledWith(live, settings, "implementation", true);
  });

  it("passes the graph refresh flag into workspace acquisition", async () => {
    const live = task({ workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/.fusion/worktrees/fn-273/repo-a" } } });
    mockedAcquireWorkspaceTaskWorktrees.mockResolvedValue({ task: live, taskWorktreeDir: "/workspace/.fusion/worktrees/fn-273" });
    const deps = {
      store: { logEntry: vi.fn(async () => undefined) } as unknown as TaskStore,
      rootDir: "/workspace",
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => workspaceConfig,
      setWorkspaceConfig: vi.fn(),
      getRunContextFor: () => undefined,
      createWorktree: vi.fn(),
      runConfiguredCommand: vi.fn(),
      addActiveWorktree: vi.fn(),
      registerConfiguredCommandController: vi.fn(),
      unregisterConfiguredCommandController: vi.fn(),
    };

    await ensureGraphCustomNodeWorktree(deps, live, settings, "implementation", true);

    expect(mockedAcquireWorkspaceTaskWorktrees).toHaveBeenCalledWith(expect.objectContaining({
      task: live,
      workspaceConfig,
      refreshStaleBase: true,
    }));
  });

  it("keeps graph workspace refresh disabled when the caller does not opt in", async () => {
    const live = task({ workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/.fusion/worktrees/fn-273/repo-a" } } });
    mockedAcquireWorkspaceTaskWorktrees.mockResolvedValue({ task: live, taskWorktreeDir: "/workspace/.fusion/worktrees/fn-273" });
    const deps = {
      store: { logEntry: vi.fn(async () => undefined) } as unknown as TaskStore,
      rootDir: "/workspace",
      workspaceConfigOwner: {},
      getWorkspaceConfig: () => workspaceConfig,
      setWorkspaceConfig: vi.fn(),
      getRunContextFor: () => undefined,
      createWorktree: vi.fn(),
      runConfiguredCommand: vi.fn(),
      addActiveWorktree: vi.fn(),
      registerConfiguredCommandController: vi.fn(),
      unregisterConfiguredCommandController: vi.fn(),
    };

    await ensureGraphCustomNodeWorktree(deps, live, settings, "review", false);

    expect(mockedAcquireWorkspaceTaskWorktrees).toHaveBeenCalledWith(expect.objectContaining({ refreshStaleBase: false }));
  });
});

describe("workspace overlap consumer parity", () => {
  it("does not serialize overlapping workspace planners when neither has acquired a repository checkout", async () => {
    const first = overlapTask("FN-WORKSPACE-PLAN-1", { status: "planning", workspaceWorktrees: {} });
    const second = overlapTask("FN-WORKSPACE-PLAN-2", {
      status: "planning",
      workspaceWorktrees: {},
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const { store, byId } = createOverlapStore([first, second], {
      [first.id]: ["repo-a/src/shared.ts"],
      [second.id]: ["repo-a/src/shared.ts"],
    });
    vi.spyOn(Scheduler.prototype as never, "validateTaskFilesystem" as never).mockResolvedValue({ valid: true } as never);
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    try {
      await scheduler.schedule();
    } finally {
      scheduler.stop();
    }

    expect(byId.get(first.id)).toMatchObject({ column: "todo", status: "planning" });
    expect(byId.get(second.id)).toMatchObject({ column: "todo", status: "planning" });
    expect(byId.get(first.id)?.overlapBlockedBy).toBeFalsy();
    expect(byId.get(second.id)?.overlapBlockedBy).toBeFalsy();
    expect(vi.mocked(store.logEntry).mock.calls.flat().join("\n")).not.toContain("file-scope overlap");
  });

  it("lets outer dispatch and core repair clear a checkout-free workspace planning blocker", async () => {
    const holder = overlapTask("FN-WORKSPACE-PLAN-HOLDER", { status: "planning", workspaceWorktrees: {} });
    const candidate = overlapTask("FN-WORKSPACE-PLAN-CANDIDATE", {
      status: "queued",
      workspaceWorktrees: {},
      overlapBlockedBy: holder.id,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const scopes = {
      [holder.id]: ["repo-a/src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    };
    const { store } = createOverlapStore([holder, candidate], scopes);

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(false);
    await expect(repairWorkspaceOverlap([candidate, holder], scopes, candidate)).resolves.toMatchObject({ repaired: true });
  });

  it("adds a workspace review holder to the scheduler's active registry and queues its qualified overlap", async () => {
    const holder = overlapTask("FN-WORKSPACE-HOLDER", {
      column: "in-review",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const candidate = overlapTask("FN-WORKSPACE-CANDIDATE", {
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const { store, byId } = createOverlapStore([holder, candidate], {
      [holder.id]: ["src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });
    vi.spyOn(Scheduler.prototype as never, "validateTaskFilesystem" as never).mockResolvedValue({ valid: true } as never);
    const scheduler = new Scheduler(store);
    (scheduler as unknown as { running: boolean }).running = true;

    try {
      await scheduler.schedule();
    } finally {
      scheduler.stop();
    }

    expect(byId.get(candidate.id)).toMatchObject({
      status: "queued",
      overlapBlockedBy: holder.id,
    });
  });

  it("normalizes both outer-dispatch scopes before a workspace holder queues a fresh candidate", async () => {
    const holder = overlapTask("FN-DISPATCH-HOLDER", {
      column: "in-review",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const candidate = overlapTask("FN-DISPATCH-CANDIDATE");
    const { store, byId } = createOverlapStore([holder, candidate], {
      [holder.id]: ["src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });

    await expect(blockOuterDispatchWhenFileScopeLeaseHeld({ store, getRunContextFor: () => undefined }, candidate)).resolves.toBe(true);
    expect(byId.get(candidate.id)).toMatchObject({ status: "queued", overlapBlockedBy: holder.id });
  });

  it("makes core overlap repair retain the same normalized workspace pair", async () => {
    const holder = overlapTask("FN-REPAIR-HOLDER", {
      column: "in-review",
      status: "failed",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const candidate = overlapTask("FN-REPAIR-CANDIDATE", {
      column: "todo",
      status: "queued",
      overlapBlockedBy: holder.id,
    });

    await expect(repairWorkspaceOverlap([candidate, holder], {
      [holder.id]: ["src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    }, candidate)).resolves.toMatchObject({ reason: "scopes-still-overlap" });
  });

  it("normalizes the gridlock holder and candidate scopes for the same workspace pair", async () => {
    const holder = overlapTask("FN-GRIDLOCK-HOLDER", {
      column: "in-review",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const candidate = overlapTask("FN-GRIDLOCK-CANDIDATE");
    const { store } = createOverlapStore([holder, candidate], {
      [holder.id]: ["src/shared.ts"],
      [candidate.id]: ["repo-a/src/shared.ts"],
    });
    const detector = new GridlockDetector(store);

    try {
      await expect(detector.detectGridlock()).resolves.toMatchObject({
        reasons: { [candidate.id]: "overlap" },
        blockingTaskIds: [holder.id],
      });
    } finally {
      detector.stop();
    }
  });

  it("preserves then releases a queued overlap through the completion fan-out as workspace checkouts remain or disappear", async () => {
    const completed = overlapTask("FN-COMPLETED", { column: "done" });
    const holder = overlapTask("FN-WORKSPACE-HOLDER", {
      column: "in-review",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const dependent = overlapTask("FN-DEPENDENT", {
      status: "queued",
      blockedBy: completed.id,
      overlapBlockedBy: holder.id,
    });
    const { store, byId } = createOverlapStore([completed, holder, dependent], {
      [holder.id]: ["src/shared.ts"],
      [dependent.id]: ["repo-a/src/shared.ts"],
    });
    const manager = new SelfHealingManager(store, { rootDir: "/workspace" });
    vi.spyOn(manager as never, "reconcileTaskWorktreeMetadata" as never).mockResolvedValue(undefined as never);

    await manager.reconcileCompletedTask(completed.id);
    expect(byId.get(dependent.id)).toMatchObject({ status: "queued", overlapBlockedBy: holder.id });

    /*
    FNXC:WorkspaceFileOverlap 2026-08-31-14:44:
    Completion fan-out owns only rows that still name the completed task as their dependency blocker.
    Recreate that durable input with the workspace checkout removed to prove its no-holder branch releases it.
    */
    await store.updateTask(holder.id, { workspaceWorktrees: {} });
    await store.updateTask(dependent.id, { blockedBy: completed.id, overlapBlockedBy: holder.id, status: "queued" });
    await manager.reconcileCompletedTask(completed.id);
    expect(byId.get(dependent.id)).toMatchObject({ status: null, overlapBlockedBy: null, blockedBy: null });
  });

  it("self-healing clears a stale blocker that points at checkout-free workspace planning", async () => {
    const planner = overlapTask("FN-WORKSPACE-PLANNER", { status: "planning", workspaceWorktrees: {} });
    const dependent = overlapTask("FN-WORKSPACE-DEPENDENT", {
      status: "queued",
      overlapBlockedBy: planner.id,
      workspaceWorktrees: {},
    });
    const { store, byId } = createOverlapStore([planner, dependent], {
      [planner.id]: ["repo-a/src/shared.ts"],
      [dependent.id]: ["repo-a/src/shared.ts"],
    });
    const manager = new SelfHealingManager(store, { rootDir: "/workspace" });

    await manager.clearStaleBlockedBy();

    expect(byId.get(dependent.id)).toMatchObject({ status: null, overlapBlockedBy: null });
  });

  it("uses the normalized workspace scope in stale-block cleanup", async () => {
    const holder = overlapTask("FN-WORKSPACE-HOLDER", {
      column: "in-review",
      status: "failed",
      workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/holder/repo-a" } } as Task["workspaceWorktrees"],
    });
    const dependent = overlapTask("FN-STALE-DEPENDENT", {
      status: "queued",
      overlapBlockedBy: holder.id,
    });
    const { store, byId } = createOverlapStore([holder, dependent], {
      [holder.id]: ["src/shared.ts"],
      [dependent.id]: ["repo-a/src/shared.ts"],
    });
    const staleManager = new SelfHealingManager(store, { rootDir: "/workspace" });

    await staleManager.clearStaleBlockedBy();

    expect(byId.get(dependent.id)).toMatchObject({ status: "queued", overlapBlockedBy: holder.id });
  });

  it("detects a normalized dependency overlap before its targeted waiver keeps the workspace holder in place", async () => {
    const pathsOverlap = vi.fn((left: string[], right: string[]) =>
      left.some((path) => right.some((other) => path === other)),
    );
    vi.doMock("../scheduler.js", async () => {
      const actual = await vi.importActual<typeof import("../scheduler.js")>("../scheduler.js");
      return { ...actual, pathsOverlap };
    });
    vi.resetModules();
    try {
      const { SelfHealingManager: ReloadedSelfHealingManager } = await import("../self-healing.js");
      const wipHolder = overlapTask("FN-WIP-WORKSPACE", {
        column: "in-progress",
        dependencies: ["FN-WAITING-DEPENDENCY"],
        workspaceWorktrees: { "repo-a": { worktreePath: "/worktrees/wip/repo-a" } } as Task["workspaceWorktrees"],
      });
      const waitingDependency = overlapTask("FN-WAITING-DEPENDENCY", { status: "queued" });
      const recovery = createOverlapStore([wipHolder, waitingDependency], {
        [wipHolder.id]: ["src/shared.ts"],
        [waitingDependency.id]: ["repo-a/src/shared.ts"],
      });
      const recoveryManager = new ReloadedSelfHealingManager(recovery.store, { rootDir: "/workspace" });
      const proof = vi.spyOn(recoveryManager as never, "evaluateBackwardMoveTripleProof" as never)
        .mockResolvedValue({ ok: true } as never);

      await expect(recoveryManager.reconcileDependencyBlockingLeases()).resolves.toBe(0);

      expect(pathsOverlap).toHaveBeenCalledWith(
        ["repo-a/src/shared.ts", "src/shared.ts"],
        ["repo-a/src/shared.ts"],
      );
      expect(pathsOverlap).toHaveLastReturnedWith(true);
      expect(proof).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../scheduler.js");
      vi.resetModules();
    }
  });
});
