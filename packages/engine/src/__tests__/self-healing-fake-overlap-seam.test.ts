import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createOverlapStore(seed: Task[]): { store: TaskStore; tasks: Map<string, Task> } {
  const tasks = new Map(seed.map((task) => [task.id, task]));
  const settings = {
    globalPause: false,
    enginePaused: false,
    mergeRequestContractShadowEnabled: true,
  } as Settings;

  const store = {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn().mockImplementation(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()];
      if (!opts?.column) return all;
      return all.filter((task) => task.column === opts.column);
    }),
    getTask: vi.fn().mockImplementation(async (id: string, opts?: { includeDeleted?: boolean }) => {
      const task = tasks.get(id);
      if (!task || (task.deletedAt && !opts?.includeDeleted)) return null;
      return task;
    }),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const next = { ...current, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:OverlapSelfHealing 2026-06-26-12:00:
    This regression intentionally drives a hand-rolled TaskStore through clearStaleBlockedBy's active file-scope-overlap branch. The fake must include parsed scope and completion-handoff methods so a missing method cannot silently turn a preserved-queued recovery into count 0.
    */
    parseFileScopeFromPrompt: vi.fn().mockImplementation(async () => ["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
  } as unknown as TaskStore;

  return { store, tasks };
}

describe("SelfHealingManager PostgreSQL soft-delete repair", () => {
  function createSoftDeleteRepairStore(settings: Pick<Settings, "globalPause" | "enginePaused">) {
    const reconcileSoftDeletedColumnDriftBackend = vi.fn().mockResolvedValue({ reconciled: 2 });
    const getDatabase = vi.fn(() => {
      throw new Error("SQLite must not be opened by PostgreSQL soft-delete repair");
    });
    const store = {
      getSettings: vi.fn().mockResolvedValue(settings),
      reconcileSoftDeletedColumnDriftBackend,
      getDatabase,
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    return { store, reconcileSoftDeletedColumnDriftBackend, getDatabase };
  }

  it("returns early while paused without invoking the backend repair", async () => {
    const { store, reconcileSoftDeletedColumnDriftBackend, getDatabase } = createSoftDeleteRepairStore({
      globalPause: true,
      enginePaused: false,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.reconcileSoftDeletedColumnDrift()).resolves.toEqual({ reconciled: 0 });

    expect(reconcileSoftDeletedColumnDriftBackend).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
    manager.stop();
  });

  it("delegates active repair to PostgreSQL without opening SQLite", async () => {
    const { store, reconcileSoftDeletedColumnDriftBackend, getDatabase } = createSoftDeleteRepairStore({
      globalPause: false,
      enginePaused: false,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.reconcileSoftDeletedColumnDrift()).resolves.toEqual({ reconciled: 2 });

    expect(reconcileSoftDeletedColumnDriftBackend).toHaveBeenCalledOnce();
    expect(getDatabase).not.toHaveBeenCalled();
    manager.stop();
  });
});

describe("SelfHealingManager fake TaskStore overlap seam", () => {
  it("preserves queued recovery through active overlap without missing-method drift", async () => {
    const staleBlocker = makeTask("FN-DONE-BLOCKER", { column: "done" });
    const overlapBlocker = makeTask("FN-ACTIVE-OVERLAP", { column: "in-progress" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "todo",
      status: "queued",
      blockedBy: staleBlocker.id,
      overlapBlockedBy: overlapBlocker.id,
      dependencies: [staleBlocker.id],
    });
    const { store, tasks } = createOverlapStore([staleBlocker, overlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set<string>() });

    await expect(manager.clearStaleBlockedBy()).resolves.toBe(1);

    expect(store.parseFileScopeFromPrompt).toHaveBeenCalledWith(dependent.id);
    expect(store.parseFileScopeFromPrompt).toHaveBeenCalledWith(overlapBlocker.id);
    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(overlapBlocker.id);
    expect(store.updateTask).toHaveBeenCalledWith(dependent.id, { blockedBy: null, status: "queued" });
    expect(tasks.get(dependent.id)?.blockedBy).toBeNull();
    expect(tasks.get(dependent.id)?.status).toBe("queued");
    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(overlapBlocker.id);
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`still blocked by file scope overlap with ${overlapBlocker.id}`),
    );

    manager.stop();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-22:25 (the shared lease predicate was HALF-converted):
`shouldHoldActiveFileScopeLease` is the scheduler's predicate, shared with self-healing on purpose so
the two cannot disagree about who holds a file-scope lease. Its role answers are optional parameters
defaulting to the legacy ids; the scheduler passes resolved answers and this sweep did not, so on a
renamed board the scheduler kept a lease that this sweep saw as absent — and released a dependent to
edit files another agent still holds.

The board below is renamed but otherwise identical to the legacy case above, which is the point: the
existing test passes either way because `in-progress` satisfies the literal default.
*/
const RENAMED_BOARD_IR = {
  version: "v2",
  id: "custom:renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
  ],
};

describe("SelfHealingManager stale-blocker cleanup on a RENAMED board", () => {
  function createRenamedBoardStore(seed: Task[]) {
    const tasks = new Map(seed.map((task) => [task.id, task]));
    const settings = {
      globalPause: false,
      enginePaused: false,
      mergeRequestContractShadowEnabled: true,
    } as Settings;
    const store = {
      getSettings: vi.fn().mockResolvedValue(settings),
      listTasks: vi.fn().mockImplementation(async (opts?: { column?: Task["column"] }) => {
        const all = [...tasks.values()];
        return opts?.column ? all.filter((task) => task.column === opts.column) : all;
      }),
      getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id) ?? null),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} missing`);
        const next = { ...current, ...patch } as Task;
        tasks.set(id, next);
        return next;
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue(["packages/engine/src/self-healing.ts"]),
      getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
      listWorkflowDefinitions: vi.fn().mockResolvedValue([{ ir: RENAMED_BOARD_IR }]),
      /* A real renamed board has a SELECTION; without it every card resolves to the built-in
         workflow and `shipped` is not recognised as complete, so the sweep finds nothing to do. */
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: RENAMED_BOARD_IR.id, stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: RENAMED_BOARD_IR.id, stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_BOARD_IR })),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    return { store, tasks };
  }


  it("preserves an overlap blocker resting in a RENAMED wip column", async () => {
    const staleBlocker = makeTask("FN-DONE-BLOCKER", { column: "shipped" });
    const overlapBlocker = makeTask("FN-ACTIVE-OVERLAP", { column: "building" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "drafting",
      status: "queued",
      blockedBy: staleBlocker.id,
      overlapBlockedBy: overlapBlocker.id,
      dependencies: [staleBlocker.id],
    });
    const { store, tasks } = createRenamedBoardStore([staleBlocker, overlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    await expect(manager.clearStaleBlockedBy()).resolves.toBe(1);

    /* The lease is still held, so the overlap blocker survives the stale-dependency clear. */
    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(overlapBlocker.id);
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`still blocked by file scope overlap with ${overlapBlocker.id}`),
    );

    manager.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-12:25 (u12 — the log-dedup memo, on a renamed hold lane):
  `clearStaleBlockedBy` remembers which overlap blocker it already logged per task so a sweep every few
  seconds does not repeat the same line forever. The memo was retained only while the card sat in a
  column matching the literal `todo`, so on a renamed board it was dropped on EVERY sweep and the
  "still blocked by file scope overlap" line was re-logged each time.

  Drives the sweep TWICE, because a single pass cannot observe a dedup memo at all.
  */
  it("does not re-log the same overlap blocker on a renamed HOLD lane", async () => {
    const staleBlocker = makeTask("FN-DONE-BLOCKER", { column: "shipped" });
    const overlapBlocker = makeTask("FN-ACTIVE-OVERLAP", { column: "building" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "drafting",
      status: "queued",
      blockedBy: staleBlocker.id,
      overlapBlockedBy: overlapBlocker.id,
      dependencies: [staleBlocker.id],
    });
    const { store } = createRenamedBoardStore([staleBlocker, overlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    await manager.clearStaleBlockedBy();
    await manager.clearStaleBlockedBy();

    const overlapLogs = vi.mocked(store.logEntry).mock.calls.filter(
      ([, message]) => typeof message === "string" && message.includes("still blocked by file scope overlap"),
    );
    /* Pre-fix this was 2: `memoTask?.column !== "todo"` was true for `drafting`, so the memo was
       cleared after the first sweep and the second re-logged the identical line. */
    expect(overlapLogs).toHaveLength(1);

    manager.stop();
  });

  it("preserves an overlap blocker resting in a RENAMED review column", async () => {
    /* The review half of the predicate, which takes a different branch (worktree + status). */
    const staleBlocker = makeTask("FN-DONE-BLOCKER", { column: "shipped" });
    const overlapBlocker = makeTask("FN-ACTIVE-OVERLAP", {
      column: "checking",
      worktree: "/tmp/wt-active",
    });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "drafting",
      status: "queued",
      blockedBy: staleBlocker.id,
      overlapBlockedBy: overlapBlocker.id,
      dependencies: [staleBlocker.id],
    });
    const { store, tasks } = createRenamedBoardStore([staleBlocker, overlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    await expect(manager.clearStaleBlockedBy()).resolves.toBe(1);

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(overlapBlocker.id);

    manager.stop();
  });
});
