import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { executorLog } from "../logger.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

type Listener = (...args: any[]) => void;

function createEventedStore() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    store: {
      on: vi.fn((event: string, listener: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
      }),
      off: vi.fn((event: string, listener: Listener) => {
        listeners.get(event)?.delete(listener);
      }),
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      listTasks: vi.fn().mockResolvedValue([]),
    } as any,
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

function makeTask(id: string): Task {
  return {
    id,
    title: id,
    description: "desc",
    status: "open",
    column: "in-progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dependencies: [],
    comments: [],
    steps: [],
    currentStep: 0,
    log: [],
  } as unknown as Task;
}

describe("TaskExecutor soft-delete aborts", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("aborts and disposes an active agent session on task:deleted", async () => {
    const { store, emit } = createEventedStore();
    const stuckTaskDetector = { untrackTask: vi.fn() };
    const executor = new TaskExecutor(store, "/tmp/test", { stuckTaskDetector } as any);
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    (executor as any).activeSessions.set("FN-TEST-1", {
      session: { abort, dispose },
      seenSteeringIds: new Set<string>(),
    });

    emit("task:deleted", makeTask("FN-TEST-1"));
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeSessions.has("FN-TEST-1")).toBe(false);
    expect((executor as any).pausedAborted.has("FN-TEST-1")).toBe(true);
    expect((executor as any).userCanceledTaskIds.has("FN-TEST-1")).toBe(true);
    expect(stuckTaskDetector.untrackTask).toHaveBeenCalledWith("FN-TEST-1");
  });

  it("aborts and removes an active step-session executor on task:deleted", async () => {
    const { store, emit } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const abortAllSessionBash = vi.fn();
    const terminateAllSessions = vi.fn().mockResolvedValue(undefined);

    (executor as any).activeStepExecutors.set("FN-TEST-2", {
      abortAllSessionBash,
      terminateAllSessions,
    });

    emit("task:deleted", makeTask("FN-TEST-2"));
    await Promise.resolve();

    expect(abortAllSessionBash).toHaveBeenCalledTimes(1);
    expect(terminateAllSessions).toHaveBeenCalledTimes(1);
    expect((executor as any).activeStepExecutors.has("FN-TEST-2")).toBe(false);
  });

  it("aborts and disposes an active workflow session on task:deleted", async () => {
    const { store, emit } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    (executor as any).activeWorkflowStepSessions.set("FN-TEST-3", { abort, dispose });

    emit("task:deleted", makeTask("FN-TEST-3"));
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeWorkflowStepSessions.has("FN-TEST-3")).toBe(false);
  });

  it("disposes reviewer subagents on task:deleted", () => {
    const { store, emit } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const dispose = vi.fn();

    (executor as any).registerSubagentSession("FN-TEST-4", { dispose });

    emit("task:deleted", makeTask("FN-TEST-4"));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeSubagentSessions.has("FN-TEST-4")).toBe(false);
  });

  it("is a silent no-op when the deleted task has no active surfaces", () => {
    const { store, emit } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const errorSpy = vi.spyOn(executorLog, "error");

    expect(() => emit("task:deleted", makeTask("FN-TEST-5"))).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
    expect((executor as any).pausedAborted.has("FN-TEST-5")).toBe(true);
    expect((executor as any).userCanceledTaskIds.has("FN-TEST-5")).toBe(true);
  });
});
