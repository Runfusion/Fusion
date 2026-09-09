import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const NOW = "2026-09-01T12:00:00.000Z";
const SHARED_SCOPE = ["packages/engine/src/self-healing.ts"];

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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

function createStore(tasksInput: Task[], settingsOverrides: Partial<Settings> = {}) {
  const tasks = new Map(tasksInput.map((task) => [task.id, { ...task }]));
  const settings = {
    globalPause: false,
    enginePaused: false,
    groupOverlappingFiles: true,
    ...settingsOverrides,
  } as Settings;
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const updateTaskAtomic = vi.fn(async (
    id: string,
    updater: (live: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
  ) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`Task ${id} missing`);
    const patch = await updater(current);
    if (!patch || Object.values(patch).every((value) => value === undefined)) return current;
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const logEntry = vi.fn(async () => undefined);
  const store = {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (options?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()].filter((task) => !task.deletedAt);
      return options?.column ? all.filter((task) => task.column === options.column) : all;
    }),
    getTask: vi.fn(async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Task ${id} missing`);
      return task;
    }),
    parseFileScopeFromPrompt: vi.fn(async () => SHARED_SCOPE),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    updateTask,
    updateTaskAtomic,
    logEntry,
    transitionQueuedEpisode: vi.fn(async (id: string, transition: {
      signature: string;
      blockedBy: string | null;
      overlapBlockedBy: string | null;
      action: string;
      outcome?: string;
    }) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const appended = !(
        current.status === "queued"
        && (current.blockedBy ?? null) === transition.blockedBy
        && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy
        && current.queuedLogEpisodeSignature === transition.signature
      );
      const next = {
        ...current,
        status: "queued",
        blockedBy: transition.blockedBy,
        overlapBlockedBy: transition.overlapBlockedBy,
        queuedLogEpisodeSignature: transition.signature,
      } as Task;
      tasks.set(id, next);
      return { appended, task: next };
    }),
  } as unknown as TaskStore;

  return { logEntry, settings, store, tasks, updateTask, updateTaskAtomic };
}

describe("SelfHealingManager stale overlap blocker reconciliation", () => {
  it("clears a done overlap blocker while preserving an unresolved dependency hold", async () => {
    const dependency = createTask("FN-DEP", { column: "in-progress" });
    const finishedOverlapBlocker = createTask("MRG-064", { column: "done" });
    const dependent = createTask("FN-D", {
      status: "queued",
      blockedBy: dependency.id,
      overlapBlockedBy: finishedOverlapBlocker.id,
      dependencies: [dependency.id],
    });
    const { store, tasks } = createStore([dependency, finishedOverlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)).toMatchObject({
      status: "queued",
      blockedBy: dependency.id,
      overlapBlockedBy: null,
    });
  });

  it.each([
    { name: "soft-deleted blocker", blocker: createTask("MRG-DELETED", { deletedAt: NOW }), dependentColumn: "todo" },
    { name: "missing blocker", blocker: null, dependentColumn: "todo" },
    { name: "non-queued hold card", blocker: createTask("MRG-DONE-HOLD", { column: "done" }), dependentColumn: "todo" },
    { name: "WIP card", blocker: createTask("MRG-DONE-WIP", { column: "done" }), dependentColumn: "in-progress" },
    { name: "unpaused review card", blocker: createTask("MRG-DONE-REVIEW", { column: "done" }), dependentColumn: "in-review" },
  ])("clears stale overlap state for a $name", async ({ blocker, dependentColumn }) => {
    const blockerId = blocker?.id ?? "MRG-MISSING";
    const dependent = createTask(`FN-D-${blockerId}`, {
      column: dependentColumn as Task["column"],
      status: null,
      overlapBlockedBy: blockerId,
    });
    const { store, tasks } = createStore(blocker ? [blocker, dependent] : [dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)).toMatchObject({
      column: dependentColumn,
      status: null,
      blockedBy: null,
      overlapBlockedBy: null,
    });
  });

  it("clears persisted overlap state when grouping is disabled", async () => {
    const activeBlocker = createTask("FN-ACTIVE-DISABLED", { column: "in-progress" });
    const dependent = createTask("FN-D-DISABLED", { overlapBlockedBy: activeBlocker.id });
    const { store, tasks } = createStore([activeBlocker, dependent], { groupOverlappingFiles: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBeNull();
  });

  it.each([
    createTask("FN-ACTIVE-WIP", { column: "in-progress" }),
    createTask("FN-ACTIVE-REVIEW", { column: "in-review", worktree: "/tmp/fn-active-review" }),
  ])("preserves an overlap blocker that still holds a lease ($id)", async (blocker) => {
    const dependent = createTask(`FN-D-${blocker.id}`, {
      status: "queued",
      overlapBlockedBy: blocker.id,
    });
    const { store, tasks, updateTask, updateTaskAtomic } = createStore([blocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(blocker.id);
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("does no reconciliation write when overlapBlockedBy is absent", async () => {
    const dependent = createTask("FN-D-NO-OVERLAP");
    const { store, updateTask, updateTaskAtomic } = createStore([dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });
});

describe("SelfHealingManager overlap reconciliation boundary", () => {
  it("does not clear or log when a fresh blocker id replaces the inspected id", async () => {
    const staleBlocker = createTask("MRG-OLD", { column: "done" });
    const freshBlocker = createTask("FN-FRESH", { column: "in-progress" });
    const dependent = createTask("FN-D-SWAP", { overlapBlockedBy: staleBlocker.id });
    const { logEntry, store, tasks, updateTask, updateTaskAtomic } = createStore([
      staleBlocker,
      freshBlocker,
      dependent,
    ]);
    updateTaskAtomic.mockImplementationOnce(async (
      id: string,
      updater: (live: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
    ) => {
      const live = tasks.get(id)!;
      live.overlapBlockedBy = freshBlocker.id;
      const patch = await updater(live);
      if (patch) tasks.set(id, { ...live, ...patch } as Task);
      return tasks.get(id)!;
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(freshBlocker.id);
    expect(updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("does not clear when the same blocker is revived before the fresh blocker read", async () => {
    const blocker = createTask("MRG-REVIVED", { column: "done" });
    const dependent = createTask("FN-D-REVIVED", { overlapBlockedBy: blocker.id });
    const { logEntry, store, tasks, updateTask, updateTaskAtomic } = createStore([blocker, dependent]);
    const getTask = store.getTask as ReturnType<typeof vi.fn>;
    const originalGetTask = getTask.getMockImplementation()!;
    let blockerReads = 0;
    getTask.mockImplementation(async (id: string, options?: unknown) => {
      if (id === blocker.id && ++blockerReads === 1) tasks.get(blocker.id)!.column = "in-progress";
      return await originalGetTask(id, options);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(blocker.id);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("does not clear when the dependent gains overlapping scope under the same blocker id", async () => {
    const blocker = createTask("MRG-SCOPE-RACE", { column: "in-progress" });
    const dependent = createTask("FN-D-SCOPE-RACE", { overlapBlockedBy: blocker.id });
    const { logEntry, store, tasks, updateTask, updateTaskAtomic } = createStore([blocker, dependent]);
    const parseFileScopeFromPrompt = store.parseFileScopeFromPrompt as ReturnType<typeof vi.fn>;
    let dependentScope = ["packages/dashboard/app/App.tsx"];
    parseFileScopeFromPrompt.mockImplementation(async (id: string) => (
      id === dependent.id ? dependentScope : SHARED_SCOPE
    ));
    const getTask = store.getTask as ReturnType<typeof vi.fn>;
    const originalGetTask = getTask.getMockImplementation()!;
    getTask.mockImplementation(async (id: string, options?: unknown) => {
      if (id === dependent.id) {
        dependentScope = SHARED_SCOPE;
        tasks.set(id, { ...tasks.get(id)!, description: "scope changed after sweep snapshot" });
      }
      return await originalGetTask(id, options);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(blocker.id);
    expect(parseFileScopeFromPrompt).toHaveBeenCalledTimes(4);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("does not apply a settings-off verdict after grouping is switched on", async () => {
    const blocker = createTask("MRG-SETTINGS", { column: "done" });
    const dependent = createTask("FN-D-SETTINGS", { overlapBlockedBy: blocker.id });
    const { logEntry, settings, store, tasks, updateTask, updateTaskAtomic } = createStore(
      [blocker, dependent],
      { groupOverlappingFiles: false },
    );
    const getSettings = store.getSettings as ReturnType<typeof vi.fn>;
    getSettings
      .mockResolvedValueOnce({ ...settings, groupOverlappingFiles: false })
      .mockResolvedValue({ ...settings, groupOverlappingFiles: true });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(blocker.id);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("does not clear or log when the dependent is soft-deleted before the atomic write", async () => {
    const blocker = createTask("MRG-SOFT-DELETE", { column: "done" });
    const dependent = createTask("FN-D-SOFT-DELETE", { overlapBlockedBy: blocker.id });
    const { logEntry, store, tasks, updateTask, updateTaskAtomic } = createStore([blocker, dependent]);
    updateTaskAtomic.mockImplementationOnce(async (
      id: string,
      updater: (live: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
    ) => {
      const live = tasks.get(id)!;
      live.deletedAt = NOW;
      const patch = await updater(live);
      if (patch) tasks.set(id, { ...live, ...patch } as Task);
      return tasks.get(id)!;
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)).toMatchObject({
      deletedAt: NOW,
      overlapBlockedBy: blocker.id,
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("clears through the fresh getTask fallback when updateTaskAtomic is unavailable", async () => {
    const blocker = createTask("MRG-FALLBACK", { column: "done" });
    const dependent = createTask("FN-D-FALLBACK", { overlapBlockedBy: blocker.id });
    const { store, tasks, updateTask } = createStore([blocker, dependent]);
    delete (store as unknown as { updateTaskAtomic?: unknown }).updateTaskAtomic;
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBeNull();
    expect(updateTask).toHaveBeenCalledWith(dependent.id, { overlapBlockedBy: null });
  });

  it("refuses the fallback write when the live blocker id changed", async () => {
    const staleBlocker = createTask("MRG-FALLBACK-OLD", { column: "done" });
    const freshBlocker = createTask("FN-FALLBACK-FRESH", { column: "in-progress" });
    const dependent = createTask("FN-D-FALLBACK-RACE", { overlapBlockedBy: staleBlocker.id });
    const { logEntry, store, tasks, updateTask } = createStore([staleBlocker, freshBlocker, dependent]);
    delete (store as unknown as { updateTaskAtomic?: unknown }).updateTaskAtomic;
    const getTask = store.getTask as ReturnType<typeof vi.fn>;
    const originalGetTask = getTask.getMockImplementation()!;
    getTask.mockImplementation(async (id: string, options?: unknown) => {
      if (id === dependent.id) tasks.get(id)!.overlapBlockedBy = freshBlocker.id;
      return await originalGetTask(id, options);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(freshBlocker.id);
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it.each([
    { name: "finished", blockerColumn: "done", expected: null },
    { name: "active", blockerColumn: "in-progress", expected: "FN-SHARED-BLOCKER" },
  ])("uses the same $name blocker verdict in the sweep and completion fan-out", async ({ blockerColumn, expected }) => {
    const sweepBlocker = createTask("FN-SHARED-BLOCKER", { column: blockerColumn as Task["column"] });
    const sweepDependent = createTask("FN-SWEEP-VERDICT", { overlapBlockedBy: sweepBlocker.id });
    const sweepFixture = createStore([sweepBlocker, sweepDependent]);
    await new SelfHealingManager(sweepFixture.store, { rootDir: "/tmp/test-project" }).clearStaleBlockedBy();

    const completed = createTask("FN-COMPLETE-VERDICT", { column: "done" });
    const fanoutBlocker = createTask("FN-SHARED-BLOCKER", { column: blockerColumn as Task["column"] });
    const fanoutDependent = createTask("FN-FANOUT-VERDICT", {
      column: "in-progress",
      blockedBy: completed.id,
      overlapBlockedBy: fanoutBlocker.id,
      dependencies: [completed.id],
    });
    const fanoutFixture = createStore([completed, fanoutBlocker, fanoutDependent]);
    await new SelfHealingManager(fanoutFixture.store, { rootDir: "/tmp/test-project" })
      .reconcileCompletedTask(completed.id);

    expect(sweepFixture.tasks.get(sweepDependent.id)?.overlapBlockedBy ?? null).toBe(expected);
    expect(fanoutFixture.tasks.get(fanoutDependent.id)?.overlapBlockedBy ?? null).toBe(expected);
  });
});

describe("SelfHealingManager completion fan-out overlap reconciliation", () => {
  it("clears a separate done overlap blocker while retaining the next dependency episode", async () => {
    const completed = createTask("FN-X", { column: "done" });
    const nextDependency = createTask("FN-DEP", { column: "in-progress" });
    const staleOverlap = createTask("MRG-064", { column: "done" });
    const dependent = createTask("FN-D", {
      status: "queued",
      blockedBy: completed.id,
      overlapBlockedBy: staleOverlap.id,
      dependencies: [completed.id, nextDependency.id],
    });
    const { store, tasks } = createStore([completed, nextDependency, staleOverlap, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.reconcileCompletedTask(completed.id);

    expect(tasks.get(dependent.id)).toMatchObject({
      status: "queued",
      blockedBy: nextDependency.id,
      overlapBlockedBy: null,
    });
  });

  it("preserves a live overlap blocker while retaining the next dependency episode", async () => {
    const completed = createTask("FN-X-LIVE", { column: "done" });
    const nextDependency = createTask("FN-DEP-LIVE", { column: "in-progress" });
    const activeOverlap = createTask("FN-ACTIVE-LIVE", { column: "in-progress" });
    const dependent = createTask("FN-D-LIVE", {
      status: "queued",
      blockedBy: completed.id,
      overlapBlockedBy: activeOverlap.id,
      dependencies: [completed.id, nextDependency.id],
    });
    const { store, tasks } = createStore([completed, nextDependency, activeOverlap, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.reconcileCompletedTask(completed.id);

    expect(tasks.get(dependent.id)).toMatchObject({
      status: "queued",
      blockedBy: nextDependency.id,
      overlapBlockedBy: activeOverlap.id,
    });
  });

  it("carries a different live blocker written after the fan-out snapshot", async () => {
    const completed = createTask("FN-X-RACE", { column: "done" });
    const nextDependency = createTask("FN-DEP-RACE", { column: "in-progress" });
    const staleOverlap = createTask("MRG-OLD-RACE", { column: "done" });
    const freshOverlap = createTask("FN-FRESH-RACE", { column: "in-progress" });
    const dependent = createTask("FN-D-RACE", {
      status: "queued",
      blockedBy: completed.id,
      overlapBlockedBy: staleOverlap.id,
      dependencies: [completed.id, nextDependency.id],
    });
    const { store, tasks } = createStore([completed, nextDependency, staleOverlap, freshOverlap, dependent]);
    const getTask = store.getTask as ReturnType<typeof vi.fn>;
    const originalGetTask = getTask.getMockImplementation()!;
    getTask.mockImplementation(async (id: string, options?: unknown) => {
      if (id === dependent.id) {
        const live = tasks.get(id)!;
        live.overlapBlockedBy = freshOverlap.id;
        return live;
      }
      return await originalGetTask(id, options);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.reconcileCompletedTask(completed.id);

    expect(tasks.get(dependent.id)).toMatchObject({
      status: "queued",
      blockedBy: nextDependency.id,
      overlapBlockedBy: freshOverlap.id,
    });
  });

  it("clears a third finished overlap blocker from a WIP dependent", async () => {
    const completed = createTask("FN-X-WIP", { column: "done" });
    const staleOverlap = createTask("MRG-THIRD-WIP", { column: "done" });
    const dependent = createTask("FN-D-WIP", {
      column: "in-progress",
      blockedBy: completed.id,
      overlapBlockedBy: staleOverlap.id,
      dependencies: [completed.id],
    });
    const { store, tasks } = createStore([completed, staleOverlap, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.reconcileCompletedTask(completed.id);

    expect(tasks.get(dependent.id)).toMatchObject({
      column: "in-progress",
      blockedBy: null,
      overlapBlockedBy: null,
    });
  });
});
