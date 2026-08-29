import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  };
}

describe("TaskExecutor.abortAllInFlight", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("aborts and disposes all active surfaces and logs a summary", async () => {
    const { store } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const logSpy = vi.spyOn(executorLog, "log");

    const taskAbort = vi.fn().mockResolvedValue(undefined);
    const taskDispose = vi.fn();
    (executor as any).activeSessions.set("FN-1", {
      session: { abort: taskAbort, dispose: taskDispose },
      seenSteeringIds: new Set<string>(),
    });
    (executor as any).activeSessions.set("FN-2", {
      session: { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
      seenSteeringIds: new Set<string>(),
    });
    (executor as any).activeStepExecutors.set("FN-1", {
      abortAllSessionBash: vi.fn(),
      terminateAllSessions: vi.fn().mockResolvedValue(undefined),
    });
    (executor as any).activeWorkflowStepSessions.set("FN-3", {
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    });
    (executor as any).activeSubagentSessions.set("FN-4", new Set([{ dispose: vi.fn() }]));

    const childAbort = vi.fn().mockResolvedValue(undefined);
    const childDispose = vi.fn();
    (executor as any).childSessions.set("agent-1", { abort: childAbort, dispose: childDispose });

    await executor.abortAllInFlight("engine stop");

    expect(taskAbort).toHaveBeenCalledTimes(1);
    expect(taskDispose).toHaveBeenCalledTimes(1);
    expect(childAbort).toHaveBeenCalledTimes(1);
    expect(childDispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeSessions.size).toBe(0);
    expect((executor as any).activeStepExecutors.size).toBe(0);
    expect((executor as any).activeWorkflowStepSessions.size).toBe(0);
    expect((executor as any).activeSubagentSessions.size).toBe(0);
    expect((executor as any).childSessions.size).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("abortAllInFlight: aborted 4 task surface(s) — engine stop");
  });

  it("continues when one surface abort path rejects", async () => {
    const { store } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined as any);

    (executor as any).activeSessions.set("FN-ERR", {
      session: {
        abort: vi.fn().mockRejectedValue(new Error("boom")),
        dispose: vi.fn(),
      },
      seenSteeringIds: new Set<string>(),
    });

    const healthyAbort = vi.fn().mockResolvedValue(undefined);
    (executor as any).activeSessions.set("FN-OK", {
      session: { abort: healthyAbort, dispose: vi.fn() },
      seenSteeringIds: new Set<string>(),
    });

    await expect(executor.abortAllInFlight("engine stop")).resolves.toBeUndefined();
    expect(healthyAbort).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("is a no-op when there are no active surfaces", async () => {
    const { store } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const logSpy = vi.spyOn(executorLog, "log");

    await expect(executor.abortAllInFlight("engine stop")).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith("abortAllInFlight: aborted 0 task surface(s) — engine stop");
  });

  it("propagates reason into per-task abort path", async () => {
    const { store } = createEventedStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).activeSessions.set("FN-1", {
      session: { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
      seenSteeringIds: new Set<string>(),
    });

    const abortSpy = vi.spyOn(executor as any, "awaitAbortInFlightTaskWork");
    await executor.abortAllInFlight("engine stop");

    expect(abortSpy).toHaveBeenCalledWith("FN-1", "engine stop");
  });
});
