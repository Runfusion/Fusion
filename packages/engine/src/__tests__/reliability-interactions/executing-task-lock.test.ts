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
import { executingTaskLock } from "../../active-session-registry.js";
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
