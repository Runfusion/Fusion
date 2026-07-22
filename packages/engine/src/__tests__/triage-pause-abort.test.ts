import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

import { TriageProcessor } from "../triage.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

type Listener = (...args: any[]) => void;

function createEventedStore(overrides: Record<string, any> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const store = {
    getSettings: vi.fn().mockResolvedValue({ pollIntervalMs: 60_000, maxConcurrent: 1, maxWorktrees: 1, autoMerge: true }),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    ...overrides,
  } as any;

  return {
    store,
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

function createFinalizeStore(overrides: Partial<TaskStore> = {}): TaskStore {
  /*
  FNXC:EngineTests 2026-07-20-23:40:
  Finalization rewrites PROMPT under withTaskLock (FN-8361). Stubs that omit the lock
  surface fail closed and never reach moveTask / status-null pause parking assertions.
  */
  const store: any = {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(createTask()),
    getSettings: vi.fn().mockResolvedValue({ requirePlanApproval: false } as Settings),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:EngineTests 2026-07-20-23:50:
    Finalization releases via moveTaskIf; wire it to moveTask so happy-path assertions
    still observe the column transition while paused guards short-circuit earlier.
    */
    moveTaskIf: vi.fn(async (id: string, column: string, predicate: (t: Task) => boolean) => {
      const live = await store.getTask(id);
      if (!live || !predicate(live as Task)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: { ...live, column, status: null } };
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    readTaskForMove: vi.fn(async (id: string) => store.getTask(id)),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
  if (!(overrides as { withTaskLock?: unknown }).withTaskLock) {
    store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
  }
  if (!(overrides as { readTaskForMove?: unknown }).readTaskForMove) {
    store.readTaskForMove = vi.fn(async (id: string) => store.getTask(id));
  }
  if (!(overrides as { moveTaskIf?: unknown }).moveTaskIf) {
    store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (t: Task) => boolean) => {
      const live = await store.getTask(id);
      if (!live || !predicate(live as Task)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: { ...live, column, status: null } };
    });
  }
  return store as TaskStore;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-PAUSE-1",
    title: "Paused planning task",
    description: "desc",
    column: "triage",
    status: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [{ timestamp: new Date().toISOString(), action: "Spec review: APPROVE" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("TriageProcessor per-task pause aborts", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("does not start planning work for an already-paused triage task", async () => {
    const task = createTask({ id: "FN-PAUSE-START", paused: true, status: null });
    const { store } = createEventedStore({ listTasks: vi.fn().mockResolvedValue([task]) });
    const processor = new TriageProcessor(store, "/tmp/root");
    const specifyTask = vi.spyOn(processor as any, "specifyTask").mockResolvedValue(undefined);

    (processor as any).running = true;
    await (processor as any).poll();

    expect(specifyTask).not.toHaveBeenCalled();
    expect((processor as any).processing.has(task.id)).toBe(false);
  });

  it("aborts and disposes an active specify session on task:updated pause without moving to todo", async () => {
    const { store, emit } = createEventedStore();
    const stuckTaskDetector = { untrackTask: vi.fn() };
    const processor = new TriageProcessor(store, "/tmp/root", { stuckTaskDetector } as any);
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-PAUSE-2", { abort, dispose });

    emit("task:updated", { id: "FN-PAUSE-2", paused: true });
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((processor as any).activeSessions.has("FN-PAUSE-2")).toBe(false);
    expect((processor as any).pauseAborted.has("FN-PAUSE-2")).toBe(true);
    expect(stuckTaskDetector.untrackTask).toHaveBeenCalledWith("FN-PAUSE-2");
    expect(store.moveTask).not.toHaveBeenCalled();

    processor.stop();
  });

  it("treats userPaused task updates as pause aborts", async () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-USER-PAUSE", { abort, dispose });

    emit("task:updated", { id: "FN-USER-PAUSE", userPaused: true });
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((processor as any).pauseAborted.has("FN-USER-PAUSE")).toBe(true);

    processor.stop();
  });

  it("does not abort on non-paused updates or paused ids with no active session", () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-ACTIVE", { abort, dispose });

    expect(() => emit("task:updated", { id: "FN-ACTIVE", paused: false })).not.toThrow();
    expect(() => emit("task:updated", { id: "FN-MISSING", paused: true })).not.toThrow();

    expect(abort).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect((processor as any).activeSessions.has("FN-ACTIVE")).toBe(true);

    processor.stop();
  });

  it("detaches the task:updated pause listener on stop", () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-PAUSE-STOP", { abort, dispose });
    processor.stop();
    const abortCallsAfterStop = abort.mock.calls.length;
    const disposeCallsAfterStop = dispose.mock.calls.length;

    emit("task:updated", { id: "FN-PAUSE-STOP", paused: true });

    expect(abort).toHaveBeenCalledTimes(abortCallsAfterStop);
    expect(dispose).toHaveBeenCalledTimes(disposeCallsAfterStop);
  });
});

describe("TriageProcessor paused finalization guard", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("does not move an approved task to todo when the re-read task is paused", async () => {
    const task = createTask({ id: "FN-FINALIZE-PAUSED" });
    const store = createFinalizeStore({ getTask: vi.fn().mockResolvedValue({ ...task, paused: true }) });
    const processor = new TriageProcessor(store, "/tmp/root");

    await (processor as any).finalizeApprovedTask(
      task,
      "# Task: FN-FINALIZE-PAUSED\n\n## File Scope\n- packages/engine/src/triage.ts\n",
      { requirePlanApproval: false } as Settings,
    );

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenLastCalledWith(task.id, { status: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      "Specification approved but task is paused — leaving in triage, will resume on unpause",
    );
  });

  it("does not move to awaiting-approval when the re-read task is userPaused", async () => {
    const task = createTask({ id: "FN-FINALIZE-USER-PAUSED" });
    const store = createFinalizeStore({ getTask: vi.fn().mockResolvedValue({ ...task, userPaused: true }) });
    const processor = new TriageProcessor(store, "/tmp/root");

    await (processor as any).finalizeApprovedTask(
      task,
      "# Task: FN-FINALIZE-USER-PAUSED\n\n## File Scope\n- packages/engine/src/triage.ts\n",
      { requirePlanApproval: true } as Settings,
    );

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "awaiting-approval" }));
    expect(store.updateTask).toHaveBeenLastCalledWith(task.id, { status: null });
  });

  it("keeps the unpaused approved-spec happy path moving to todo", async () => {
    const task = createTask({ id: "FN-FINALIZE-HAPPY" });
    const store = createFinalizeStore({ getTask: vi.fn().mockResolvedValue({ ...task, paused: false, userPaused: false }) });
    const processor = new TriageProcessor(store, "/tmp/root");

    await (processor as any).finalizeApprovedTask(
      task,
      "# Task: FN-FINALIZE-HAPPY\n\n## File Scope\n- packages/engine/src/triage.ts\n",
      { requirePlanApproval: false } as Settings,
    );

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
  });

  it("does not recover an approved planning task while it is paused", async () => {
    const task = createTask({ id: "FN-RECOVER-PAUSED", paused: true });
    const store = createFinalizeStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    await expect(processor.recoverApprovedTask(task)).resolves.toBe(false);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
