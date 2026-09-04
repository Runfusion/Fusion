import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const NOW_ISO = "2026-05-22T12:00:00.000Z";
const STALE_STATUS_MS = 5 * 60_000;
const STALE_FANOUT_MS = 15 * 60_000;
const FN_5488_GRACE_MS = 20_000;
const MAX_AUTO_MERGE_RETRIES = 3;

const AUDIT_PREFIX = "Auto-recovered (FN-5488):";
const REASON_FAILED_RETRY_EXHAUSTED = "failed-retry-exhausted";
const REASON_UNBACKED_MERGING = "unbacked-merging";

function createTask(id: string, overrides: Partial<Task> = {}): Task {
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
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as Task;
}

function makeStore(tasksInput: Task[]) {
  const tasks = new Map(tasksInput.map((task) => [task.id, task]));
  const settings: Settings = {
    globalPause: false,
    enginePaused: false,
    groupOverlappingFiles: true,
  } as Settings;

  const store = {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn().mockImplementation(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()];
      if (!opts?.column) return all;
      return all.filter((task) => task.column === opts.column);
    }),
    getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id) ?? null),
    /*
    FNXC:OverlapSelfHealing 2026-06-26-12:52:
    The FN-5488 overlap path calls every TaskStore seam in clearStaleBlockedBy(), and these fakes must stay complete so full-suite shard ordering cannot turn overlap-preservation invariants into fake drift. Use a non-empty shared scope so hasActiveFileScopeOverlapBlocker reaches pathsOverlap instead of short-circuiting before the branch this file guards.
    */
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue(["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const next = { ...current, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:QueuedTaskLogging 2026-08-23-18:30:
    The overlap-preservation path no longer writes its queued-episode line through `logEntry`: it
    goes through the atomic `transitionQueuedEpisode` seam (queue fields + episode signature + the
    single log entry in one transaction, deduped by signature). A fake store missing that method
    made the sweep throw into its own catch and report zero recoveries. This fake mirrors the
    production semantics: append only when the row is not already queued with the same blocker
    fields and signature.
    */
    transitionQueuedEpisode: vi.fn().mockImplementation(async (id: string, transition: {
      signature: string;
      blockedBy: string | null;
      overlapBlockedBy: string | null;
      action: string;
      outcome?: string;
    }) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} not found or archived while queuing`);
      const appended = !(
        current.status === "queued"
        && (current.blockedBy ?? null) === transition.blockedBy
        && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy
        && ((current as Task & { queuedLogEpisodeSignature?: string | null }).queuedLogEpisodeSignature ?? null) === transition.signature
      );
      const next = {
        ...current,
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
        log: appended
          ? [...(current.log ?? []), { timestamp: new Date().toISOString(), action: transition.action, outcome: transition.outcome }]
          : current.log,
      } as unknown as Task;
      tasks.set(id, next);
      return { appended, task: next };
    }),
  } as unknown as TaskStore;

  return { tasks, store };
}

function configureTaskWorkflowSelections(
  store: TaskStore,
  definitions: ReadonlyArray<{ id: string; ir: unknown }>,
  workflowIdByTaskId: Readonly<Record<string, string>>,
): void {
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const mutable = store as unknown as {
    listWorkflowDefinitions: ReturnType<typeof vi.fn>;
    getTaskWorkflowSelection: ReturnType<typeof vi.fn>;
    getTaskWorkflowSelectionAsync: ReturnType<typeof vi.fn>;
    getWorkflowDefinition: ReturnType<typeof vi.fn>;
  };
  mutable.listWorkflowDefinitions = vi.fn(async () => definitions);
  mutable.getTaskWorkflowSelection = vi.fn((taskId: string) => {
    const workflowId = workflowIdByTaskId[taskId];
    return workflowId ? { workflowId, stepIds: [] } : undefined;
  });
  mutable.getTaskWorkflowSelectionAsync = vi.fn(async (taskId: string) => {
    const workflowId = workflowIdByTaskId[taskId];
    return workflowId ? { workflowId, stepIds: [] } : undefined;
  });
  mutable.getWorkflowDefinition = vi.fn(async (workflowId: string) => definitionById.get(workflowId));
}

describe("SelfHealingManager FN-5488 fast-path regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears stale blocker for failed + retry-exhausted in-review blocker and logs reason code", async () => {
    const blocker = createTask("FN-5498-A-BLOCKER", {
      column: "in-review",
      status: "failed",
      mergeRetries: MAX_AUTO_MERGE_RETRIES,
      updatedAt: "2026-05-22T11:30:00.000Z",
    });
    const depOnlyBlocker = createTask("FN-5498-A-DEP-ONLY", {
      column: "todo",
      status: "queued",
      blockedBy: blocker.id,
      dependencies: [blocker.id],
    });
    const depDone = createTask("FN-5498-A-DEP-DONE", { column: "done" });
    const depWithDoneSibling = createTask("FN-5498-A-DEP-SIBLING", {
      column: "todo",
      status: "queued",
      blockedBy: blocker.id,
      dependencies: [blocker.id, depDone.id],
    });

    const { tasks, store } = makeStore([blocker, depOnlyBlocker, depDone, depWithDoneSibling]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: STALE_STATUS_MS,
      staleMergingFanoutMinAgeMs: STALE_FANOUT_MS,
      unbackedMergingFanoutGraceMs: FN_5488_GRACE_MS,
      getActiveMergeTaskId: () => null,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(2);
    expect(tasks.get(depOnlyBlocker.id)?.blockedBy).toBeNull();
    expect(tasks.get(depOnlyBlocker.id)?.status).toBeNull();
    expect(tasks.get(depWithDoneSibling.id)?.blockedBy).toBeNull();
    expect(tasks.get(depWithDoneSibling.id)?.status).toBeNull();

    expect(store.logEntry).toHaveBeenCalledWith(
      depOnlyBlocker.id,
      expect.stringContaining(`${AUDIT_PREFIX} cleared stale blockedBy`),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      depOnlyBlocker.id,
      expect.stringContaining(`reason=${REASON_FAILED_RETRY_EXHAUSTED}`),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      depWithDoneSibling.id,
      expect.stringContaining(`reason=${REASON_FAILED_RETRY_EXHAUSTED}`),
    );
  });

  it("recovers unbacked merging blocker after grace window and logs unbacked-merging reason", async () => {
    const blocker = createTask("FN-5498-B-BLOCKER", {
      column: "in-review",
      status: "merging",
      updatedAt: "2026-05-22T11:59:35.000Z",
    });
    const dependent = createTask("FN-5498-B-DEP", {
      column: "todo",
      status: "queued",
      blockedBy: blocker.id,
      dependencies: [blocker.id],
    });

    const { tasks, store } = makeStore([blocker, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: STALE_STATUS_MS,
      staleMergingFanoutMinAgeMs: STALE_FANOUT_MS,
      unbackedMergingFanoutGraceMs: FN_5488_GRACE_MS,
      getActiveMergeTaskId: () => null,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(tasks.get(dependent.id)?.blockedBy).toBeNull();
    expect(tasks.get(dependent.id)?.status).toBeNull();
    expect(tasks.get(blocker.id)?.status).toBe("merging");
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`${AUDIT_PREFIX} cleared stale blockedBy`),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`reason=${REASON_UNBACKED_MERGING}`),
    );
  });

  it("does not recover unbacked merging blocker before grace window, then recovers after boundary", async () => {
    const blocker = createTask("FN-5498-C-BLOCKER", {
      column: "in-review",
      status: "merging",
      updatedAt: NOW_ISO,
    });
    const dependent = createTask("FN-5498-C-DEP", {
      column: "todo",
      status: "queued",
      blockedBy: blocker.id,
      dependencies: [],
    });

    const { tasks, store } = makeStore([blocker, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: STALE_STATUS_MS,
      staleMergingFanoutMinAgeMs: STALE_FANOUT_MS,
      unbackedMergingFanoutGraceMs: FN_5488_GRACE_MS,
      getActiveMergeTaskId: () => null,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const earlyRecovered = await manager.clearStaleBlockedBy();
    expect(earlyRecovered).toBe(0);
    expect(tasks.get(dependent.id)?.blockedBy).toBe(blocker.id);
    expect(tasks.get(blocker.id)?.status).toBe("merging");
    expect(store.logEntry).not.toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`${AUDIT_PREFIX}`),
    );

    vi.setSystemTime(new Date(new Date(NOW_ISO).getTime() + FN_5488_GRACE_MS + 1));

    const lateRecovered = await manager.clearStaleBlockedBy();
    expect(lateRecovered).toBe(1);
    expect(tasks.get(dependent.id)?.blockedBy).toBeNull();
    expect(tasks.get(dependent.id)?.status).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`reason=${REASON_UNBACKED_MERGING}`),
    );
  });

  it("preserves overlapBlockedBy when a failed review holder still owns a worktree", async () => {
    const holder = createTask("FN-254-HOLDER", {
      column: "in-review",
      status: "failed",
      worktree: "/wt/fn-254-holder",
    });
    const dependent = createTask("FN-254-DEPENDENT", {
      column: "todo",
      status: "queued",
      overlapBlockedBy: holder.id,
    });
    const { tasks, store } = makeStore([holder, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)).toMatchObject({
      status: "queued",
      overlapBlockedBy: holder.id,
    });
    expect(store.transitionQueuedEpisode).toHaveBeenCalledWith(
      dependent.id,
      expect.objectContaining({ signature: `file-scope:${holder.id}` }),
    );
  });

  it("uses the holder workflow rather than a project-wide WIP column union", async () => {
    const holder = createTask("FN-254-HOLDER", {
      column: "shared",
      priority: "low",
      worktree: "/wt/fn-254-holder",
    });
    const dependent = createTask("FN-254-DEPENDENT", {
      column: "todo",
      priority: "high",
      status: "queued",
      overlapBlockedBy: holder.id,
    });
    const { tasks, store } = makeStore([holder, dependent]);
    configureTaskWorkflowSelections(
      store,
      [
        {
          id: "wf-holder",
          ir: {
            version: "v2",
            name: "holder-workflow",
            columns: [
              { id: "todo", name: "Todo", traits: [{ trait: "hold" }] },
              { id: "shared", name: "Shared", traits: [] },
              { id: "done", name: "Done", traits: [{ trait: "complete" }] },
            ],
            nodes: [],
            edges: [],
          },
        },
        {
          id: "wf-other",
          ir: {
            version: "v2",
            name: "other-workflow",
            columns: [
              { id: "shared", name: "Shared", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
            ],
            nodes: [],
            edges: [],
          },
        },
      ],
      { [holder.id]: "wf-holder" },
    );
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)).toMatchObject({
      status: null,
      overlapBlockedBy: null,
    });
    expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
  });

  it("clears overlapBlockedBy after a holder is terminal or a review worktree is gone", async () => {
    for (const holder of [
      createTask("FN-254-DONE", { column: "done", worktree: "/wt/fn-254-done" }),
      createTask("FN-254-CLEAN", { column: "in-review", status: "failed" }),
    ]) {
      const dependent = createTask(`FN-254-DEPENDENT-${holder.id}`, {
        column: "todo",
        status: "queued",
        overlapBlockedBy: holder.id,
      });
      const { tasks, store } = makeStore([holder, dependent]);
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

      await manager.clearStaleBlockedBy();

      expect(tasks.get(dependent.id)).toMatchObject({
        overlapBlockedBy: null,
        status: null,
      });
      expect(store.transitionQueuedEpisode).not.toHaveBeenCalled();
    }
  });

  it("does not rebound a WIP holder whose overlap lease is waived for its dependency", async () => {
    const dependency = createTask("FN-254-DEP", {
      column: "todo",
      status: "queued",
      overlapBlockedBy: "FN-254-HOLDER",
    });
    const holder = createTask("FN-254-HOLDER", {
      column: "in-progress",
      worktree: "/wt/fn-254-holder",
      dependencies: [dependency.id],
    });
    const { store } = makeStore([holder, dependency]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const rebound = vi.spyOn(manager as any, "reboundTask");

    await expect(manager.reconcileDependencyBlockingLeases()).resolves.toBe(0);

    expect(rebound).not.toHaveBeenCalled();
  });

  it("preserves overlapBlockedBy + queued status when failed-retry-exhausted blocker clears", async () => {
    const blocker = createTask("FN-5498-D-BLOCKER", {
      column: "in-review",
      status: "failed",
      mergeRetries: MAX_AUTO_MERGE_RETRIES,
      updatedAt: "2026-05-22T11:30:00.000Z",
    });
    const overlap = createTask("FN-5498-D-OVERLAP", {
      column: "in-progress",
    });
    const dependent = createTask("FN-5498-D-DEP", {
      column: "todo",
      status: "queued",
      blockedBy: blocker.id,
      overlapBlockedBy: overlap.id,
      dependencies: [blocker.id],
    });

    const { tasks, store } = makeStore([blocker, overlap, dependent]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: STALE_STATUS_MS,
      staleMergingFanoutMinAgeMs: STALE_FANOUT_MS,
      unbackedMergingFanoutGraceMs: FN_5488_GRACE_MS,
      getActiveMergeTaskId: () => null,
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(tasks.get(dependent.id)?.blockedBy).toBeNull();
    expect(tasks.get(dependent.id)?.status).toBe("queued");
    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(overlap.id);
    /*
     * FNXC:QueuedTaskLogging 2026-08-23-18:30:
     * The queued-episode line is now written atomically by `transitionQueuedEpisode`, so assert the
     * transition's `action` — the same audited text this test always owned — instead of a separate
     * `logEntry` call that no longer exists on this path.
     */
    const [, transition] = (store.transitionQueuedEpisode as ReturnType<typeof vi.fn>).mock.calls
      .find(([id]) => id === dependent.id) as [string, { action: string; signature: string }];
    expect(transition.action).toContain(`${AUDIT_PREFIX} preserved queued status`);
    expect(transition.action).toContain(`reason=${REASON_FAILED_RETRY_EXHAUSTED}`);
    expect(transition.action).toContain(`still blocked by file scope overlap with ${overlap.id}`);
    expect(transition.signature).toBe(`file-scope:${overlap.id}`);
  });
});
