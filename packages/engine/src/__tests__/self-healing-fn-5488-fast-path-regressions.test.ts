import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANY_MUTATION_CONTEXT } from "./mutation-context-matchers.js";
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
  } as unknown as TaskStore;

  return { tasks, store };
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
      expect.stringContaining(`${AUDIT_PREFIX} cleared stale blockedBy`), undefined, ANY_MUTATION_CONTEXT);
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
      expect.stringContaining(`${AUDIT_PREFIX} cleared stale blockedBy`), undefined, ANY_MUTATION_CONTEXT);
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
      expect.stringContaining(`reason=${REASON_UNBACKED_MERGING}`), undefined, ANY_MUTATION_CONTEXT);
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
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`${AUDIT_PREFIX} preserved queued status`),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`reason=${REASON_FAILED_RETRY_EXHAUSTED}`),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`still blocked by file scope overlap with ${overlap.id}`),
    );
  });
});
