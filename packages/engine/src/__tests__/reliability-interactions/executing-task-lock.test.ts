/**
 * FN-4811 follow-up (FN-4809 production reproduction):
 *
 * After 82f80e72f's per-instance `this.executing.add()` synchronous claim,
 * production STILL produced two execute() invocations for the same task ID
 * that both reached "Executor detected stale merge state" (executor.ts:2661)
 * and both generated runIds within 1 second of each other (y2nb + 9gde for
 * FN-4809 at 02:48:17–18 UTC). The only viable explanation is that there is
 * more than one `TaskExecutor` instance in the process (e.g., engine restart
 * race, multi-project hybrid runtime, or test-helper-style code creating a
 * second instance).
 *
 * The fix is a process-wide singleton `executingTaskLock` in
 * `active-session-registry.ts`. This test covers the contract directly:
 *
 *   - Two distinct `TaskExecutor` instances calling `execute()` for the same
 *     task ID. Only one should actually run — the other must bail at the
 *     process-wide claim.
 *   - The lock is released when execute() completes, so a subsequent
 *     execute() on either instance is allowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { executingTaskLock } from "../../agents/active-session-registry.js";
import { mockedCreateFnAgent, createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4809",
    title: "Process-wide execute lock",
    description: "test",
    column: "in-progress",
    paused: false,
    worktree: "/tmp/test/.worktrees/rapid-fern",
    branch: "fusion/fn-4809",
    assignedAgentId: "agent-test-executor",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("FN-4811 follow-up (FN-4809): process-wide executingTaskLock", () => {
  beforeEach(() => {
    resetExecutorMocks();
    executingTaskLock._clearForTest();
  });

  it("fences a stale owner from releasing or mutating a successor", async () => {
    const first = executingTaskLock.claim("FN-312");
    expect(first).not.toBeNull();
    if (!first) throw new Error("first lease missing");

    expect(await executingTaskLock.invalidate(first)).toMatchObject({ executed: true });
    const second = executingTaskLock.claim("FN-312");
    expect(second).not.toBeNull();
    if (!second) throw new Error("second lease missing");

    executingTaskLock.release("FN-312", first);
    expect(executingTaskLock.owns(second)).toBe(true);
    const staleMutation = vi.fn();
    expect(await executingTaskLock.runIfOwner(first, staleMutation)).toEqual({ executed: false });
    expect(staleMutation).not.toHaveBeenCalled();

    executingTaskLock.release("FN-312", second);
    expect(executingTaskLock.has("FN-312")).toBe(false);
  });

  it("serializes mutation settlement with forced invalidation", async () => {
    const lease = executingTaskLock.claim("FN-312");
    if (!lease) throw new Error("lease missing");
    let settleMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { settleMutation = resolve; });
    const order: string[] = [];

    const mutation = executingTaskLock.runIfOwner(lease, async () => {
      order.push("mutation-entered");
      await mutationGate;
      order.push("mutation-settled");
    });
    await vi.waitFor(() => expect(order).toEqual(["mutation-entered"]));

    const invalidation = executingTaskLock.invalidate(lease).then((result) => {
      order.push("invalidated");
      return result;
    });
    await Promise.resolve();
    expect(order).toEqual(["mutation-entered"]);
    expect(executingTaskLock.claim("FN-312")).toBeNull();

    settleMutation();
    expect(await mutation).toMatchObject({ executed: true });
    expect(await invalidation).toMatchObject({ executed: true });
    expect(order).toEqual(["mutation-entered", "mutation-settled", "invalidated"]);

    const successor = executingTaskLock.claim("FN-312");
    expect(successor).not.toBeNull();
    if (successor) executingTaskLock.release("FN-312", successor);
  });

  it("publishes forced invalidation when its callback rejects", async () => {
    const lease = executingTaskLock.claim("FN-312-REJECTED-INVALIDATION");
    if (!lease) throw new Error("lease missing");

    await expect(executingTaskLock.invalidateWithSignal(
      lease,
      () => "signaled",
      async () => { throw new Error("auxiliary publication failed"); },
    )).rejects.toThrow("auxiliary publication failed");

    expect(executingTaskLock.owns(lease)).toBe(false);
    const successor = executingTaskLock.claim("FN-312-REJECTED-INVALIDATION");
    expect(successor).not.toBeNull();
    if (successor) executingTaskLock.release(successor.taskId, successor);
  });

  it("does not signal through a timer lease after a successor owns the task", async () => {
    const taskId = "FN-312-STALE-TIMER";
    const oldLease = executingTaskLock.claim(taskId);
    if (!oldLease) throw new Error("old lease missing");
    expect(await executingTaskLock.invalidate(oldLease)).toMatchObject({ executed: true });
    const successorLease = executingTaskLock.claim(taskId);
    if (!successorLease) throw new Error("successor lease missing");
    const signal = vi.fn(() => "abort-successor");
    const settle = vi.fn(async () => undefined);

    await expect(executingTaskLock.invalidateWithSignal(oldLease, signal, settle)).resolves.toEqual({
      executed: false,
    });

    expect(signal).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(executingTaskLock.owns(successorLease)).toBe(true);
    executingTaskLock.release(taskId, successorLease);
  });

  it("reserves forced invalidation before signaling and waits for an entered mutation", async () => {
    const lease = executingTaskLock.claim("FN-312-SIGNAL");
    if (!lease) throw new Error("lease missing");
    let settleMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { settleMutation = resolve; });
    const order: string[] = [];

    const mutation = executingTaskLock.runIfOwner(lease, async () => {
      order.push("mutation-entered");
      await mutationGate;
      order.push("mutation-settled");
    });
    await vi.waitFor(() => expect(order).toEqual(["mutation-entered"]));

    const invalidation = executingTaskLock.invalidateWithSignal(
      lease,
      () => {
        order.push("abort-signaled");
        return Promise.resolve();
      },
      async (abortSettlement) => {
        order.push("invalidation-entered");
        await abortSettlement;
        order.push("abort-settled");
      },
    );

    expect(order).toEqual(["mutation-entered", "abort-signaled"]);
    expect(executingTaskLock.claim("FN-312-SIGNAL")).toBeNull();
    settleMutation();
    expect(await mutation).toMatchObject({ executed: true });
    expect(await invalidation).toMatchObject({ executed: true });
    expect(order).toEqual([
      "mutation-entered",
      "abort-signaled",
      "mutation-settled",
      "invalidation-entered",
      "abort-settled",
    ]);

    const successor = executingTaskLock.claim("FN-312-SIGNAL");
    expect(successor).not.toBeNull();
    if (successor) executingTaskLock.release("FN-312-SIGNAL", successor);
  });

  it("two TaskExecutor instances racing execute() for the same task produce only one run", async () => {
    // Two stores, two executors — simulates engine restart race, multi-project
    // hybrid runtime, or any code path that creates a second TaskExecutor.
    const storeA = createMockStore();
    const storeB = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        session: {
          prompt: vi.fn(async () => undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          navigateTree: vi.fn(),
          state: {},
        },
      } as any;
    });

    const executorA = new TaskExecutor(storeA as any, "/tmp/test");
    const executorB = new TaskExecutor(storeB as any, "/tmp/test");
    const task = makeTask();

    const [resultA, resultB] = await Promise.allSettled([
      executorA.execute(task),
      executorB.execute(task),
    ]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    // Critical: exactly one instance progresses into real work; the other bails
    // at the process-wide claim before any work begins. Before this fix, each
    // instance had its own `executing` Set, so both proceeded past the per-instance
    // guard and both created agent sessions.
    //
    /*
    FNXC:EngineTests 2026-07-19-03:12 (U10b):
    Requirement unchanged: a single task ID may only have ONE run doing real implementation work in a process, no matter how many TaskExecutor instances exist. The FN-4809 production symptom was literally a DUPLICATE "Worktree created at /..." log pair inside the same second, so that log line is the invariant's ground truth.
    What changed: `execute()` now always enters the workflow graph, and the graph runs on BOTH executors. The loser still fails to claim `executingTaskLock` inside `runImplementation`, so it does no implementation work — but its graph wrapper does write step/status bookkeeping to its own store. "The losing store is completely untouched" is therefore no longer the contract; "the work happened exactly once" still is.
    */
    const worktreeCreatedLogs = [
      ...(storeA.logEntry as any).mock.calls,
      ...(storeB.logEntry as any).mock.calls,
    ].filter((call: any[]) => typeof call[1] === "string" && call[1].startsWith("Worktree created at "));
    expect(worktreeCreatedLogs).toHaveLength(1);
  });

  it("releases the lock after execute() finishes so subsequent calls proceed", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        navigateTree: vi.fn(),
        state: {},
      },
    }) as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(makeTask());
    expect(executingTaskLock.has("FN-4809")).toBe(false);

    // Second sequential call must be allowed.
    await executor.execute(makeTask());
    expect(executingTaskLock.has("FN-4809")).toBe(false);
  });
});
