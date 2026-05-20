import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TriageProcessor } from "../triage.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

type Listener = (...args: any[]) => void;

function createEventedStore() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    store: {
      getSettings: vi.fn().mockResolvedValue({ pollIntervalMs: 60_000, maxConcurrent: 1, maxWorktrees: 1, autoMerge: true }),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
      }),
      off: vi.fn((event: string, listener: Listener) => {
        listeners.get(event)?.delete(listener);
      }),
    } as any,
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

describe("TriageProcessor soft-delete aborts", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("aborts and disposes an active specify session on task:deleted", async () => {
    const { store, emit } = createEventedStore();
    const stuckTaskDetector = { untrackTask: vi.fn() };
    const processor = new TriageProcessor(store, "/tmp/root", { stuckTaskDetector } as any);
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-TEST-1", { abort, dispose });

    emit("task:deleted", { id: "FN-TEST-1" });
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((processor as any).activeSessions.has("FN-TEST-1")).toBe(false);
    expect((processor as any).pauseAborted.has("FN-TEST-1")).toBe(true);
    expect(stuckTaskDetector.untrackTask).toHaveBeenCalledWith("FN-TEST-1");

    processor.stop();
  });

  it("disposes reviewer subagents for a soft-deleted task", () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const dispose = vi.fn();

    processor.start();
    (processor as any).registerSubagentSession("FN-TEST-2", { dispose });

    emit("task:deleted", { id: "FN-TEST-2" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect((processor as any).activeSubagentSessions.has("FN-TEST-2")).toBe(false);

    processor.stop();
  });

  it("is a no-op for unknown soft-deleted ids", () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    processor.start();
    expect(() => emit("task:deleted", { id: "FN-UNKNOWN" })).not.toThrow();
    processor.stop();
  });

  it("detaches the task:deleted listener on stop", () => {
    const { store, emit } = createEventedStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    processor.start();
    (processor as any).activeSessions.set("FN-TEST-3", { abort, dispose });
    processor.stop();
    const abortCallsAfterStop = abort.mock.calls.length;
    const disposeCallsAfterStop = dispose.mock.calls.length;

    emit("task:deleted", { id: "FN-TEST-3" });

    expect(abort).toHaveBeenCalledTimes(abortCallsAfterStop);
    expect(dispose).toHaveBeenCalledTimes(disposeCallsAfterStop);
  });
});
