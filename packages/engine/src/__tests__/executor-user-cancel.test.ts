import { describe, it, expect, vi } from "vitest";
import "./executor-test-helpers.js";
import { getTaskMoveDisposer } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

describe("TaskExecutor user cancel handling", () => {
  it("registers an awaited user-move disposer that aborts all active work before Todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const terminateChildren = vi.spyOn(executor as any, "terminateAllChildren").mockResolvedValue(undefined);
    let resolveAbort: (() => void) | undefined;
    const abortPending = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => abortPending),
      dispose: vi.fn(),
    } as any;
    (executor as any).activeSessions.set("FN-AWAITED", {
      session,
      seenSteeringIds: new Set<string>(),
    });

    const disposer = getTaskMoveDisposer(store as any);
    expect(disposer).toBeTypeOf("function");
    let disposed = false;
    const disposal = disposer!({ id: "FN-AWAITED" } as any).then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(terminateChildren).toHaveBeenCalledWith("FN-AWAITED");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    resolveAbort?.();
    await disposal;
    expect(session.dispose).toHaveBeenCalledOnce();
    expect((executor as any).userCanceledTaskIds.has("FN-AWAITED")).toBe(true);
  });

  it("aborts before dispose when user moves in-progress task back to todo", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const callOrder: string[] = [];
    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => {
        callOrder.push("abort");
        return Promise.resolve();
      }),
      dispose: vi.fn(() => {
        callOrder.push("dispose");
      }),
    } as any;

    (executor as any).activeSessions.set("FN-001", {
      session,
      seenSteeringIds: new Set<string>(),
    });

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-001",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "user",
    });

    await (executor as any).pendingTaskDisposals.get("FN-001");

    expect(callOrder[0]).toBe("abort");
    expect(callOrder[1]).toBe("dispose");
    expect((executor as any).activeSessions.has("FN-001")).toBe(false);
    expect((executor as any).userCanceledTaskIds.has("FN-001")).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not mark engine-initiated move as user cancel", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-002",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "in-progress",
      to: "todo",
      source: "engine",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-002")).toBe(false);
  });

  it("clears userCanceled marker when task is moved back to in-progress", () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    (executor as any).userCanceledTaskIds.add("FN-003");

    (store as any)._trigger("task:moved", {
      task: {
        id: "FN-003",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
      },
      from: "todo",
      to: "in-progress",
      source: "user",
    });

    expect((executor as any).userCanceledTaskIds.has("FN-003")).toBe(false);
  });

  it("re-dispatch (task:moved → in-progress) awaits prior disposal before execute()", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const callOrder: string[] = [];
    let resolveAbort: (() => void) | null = null;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = () => {
        callOrder.push("abort-resolved");
        resolve();
      };
    });

    const session = {
      prompt: vi.fn(),
      abort: vi.fn(() => {
        callOrder.push("abort-started");
        return abortPromise;
      }),
      dispose: vi.fn(() => {
        callOrder.push("dispose");
      }),
    } as any;

    (executor as any).activeSessions.set("FN-RACE", {
      session,
      seenSteeringIds: new Set<string>(),
    });
    const executeSpy = vi.spyOn(executor, "execute" as any).mockImplementation(async () => {
      callOrder.push("execute");
    });

    // Move away first — kicks off async disposal.
    (store as any)._trigger("task:moved", {
      task: { id: "FN-RACE", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [] },
      from: "in-progress",
      to: "todo",
      source: "user",
    });
    // Immediate re-dispatch — must wait for the disposal above.
    (store as any)._trigger("task:moved", {
      task: { id: "FN-RACE", column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [] },
      from: "todo",
      to: "in-progress",
      source: "user",
    });

    // execute() must not run yet — abort is still pending.
    await Promise.resolve();
    expect(callOrder).toEqual(["abort-started"]);

    // Resolve abort. Dispose + execute should follow in order.
    resolveAbort!();
    await (executor as any).pendingTaskDisposals.get("FN-RACE");
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder.indexOf("execute")).toBeGreaterThan(callOrder.indexOf("dispose"));
    executeSpy.mockRestore();
  });
});
