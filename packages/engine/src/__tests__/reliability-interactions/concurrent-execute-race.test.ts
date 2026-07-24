/**
 * FN-4811 follow-up (FN-4814 + FN-4811 production failures):
 *
 * `TaskExecutor.execute()` previously had a race window where two concurrent
 * `execute(task)` calls (e.g., scheduler dispatch + restart-recovery + task:moved
 * event handler) could both pass the `this.executing.has(task.id)` check, both
 * await `shouldDeferForHeartbeat`, and both proceed to create the same worktree
 * path — producing two parallel runs for the same task. Production log signature:
 *
 *   01:30:56  [runA-caoe]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
 *   01:30:56  [runB-w23q]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
 *   01:30:58  worktree liveness assertion failed: not_usable_task_worktree
 *
 * The fix: claim the executing slot SYNCHRONOUSLY immediately after the `has()`
 * check, before any await. This regression test issues two concurrent execute()
 * calls and asserts that only ONE actually runs (only one createFnAgent invocation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { mockedCreateFnAgent, createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4814",
    title: "Concurrent execute race",
    description: "test",
    column: "in-progress",
    paused: false,
    worktree: "/tmp/test/.worktrees/bright-mesa",
    branch: "fusion/fn-4814",
    // assignedAgentId is REQUIRED to actually exercise the race — it's the conditional
    // that gates the `await shouldDeferForHeartbeat(...)` which is the offending yield
    // point. Without it, the short-circuit `assignedAgentId && ...` evaluates to false
    // synchronously and no await happens, so the race window doesn't exist.
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

describe("FN-4811 follow-up (FN-4814): concurrent execute() must not produce parallel runs", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("two concurrent execute() calls for the same task produce no more sessions than one execute() call", async () => {
    // Establish baseline: how many createFnAgent invocations happen for ONE execute().
    // The mocked prompt never calls fn_task_done, so the retry loop fires; we don't care
    // about the exact count, only that concurrent calls don't AMPLIFY it.
    const baselineStore = createMockStore();
    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 5));
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        navigateTree: vi.fn(),
        state: {},
      },
    }) as any);
    const baselineExecutor = new TaskExecutor(baselineStore as any, "/tmp/test");
    await baselineExecutor.execute(makeTask());
    const baselineCount = mockedCreateFnAgent.mock.calls.length;
    expect(baselineCount).toBeGreaterThan(0);

    // Now exercise the race: two concurrent execute() calls in the same tick.
    resetExecutorMocks();
    mockedCreateFnAgent.mockImplementation(async () => {
      // Wider latency than baseline to make the race window deterministic.
      await new Promise((r) => setTimeout(r, 20));
      return {
        session: {
          prompt: vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20));
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          navigateTree: vi.fn(),
          state: {},
        },
      } as any;
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const task = makeTask();

    const [resultA, resultB] = await Promise.allSettled([
      executor.execute(task),
      executor.execute(task),
    ]);

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    // FN-4814: concurrent calls must NOT amplify createFnAgent invocations. Before the
    // fix, both calls passed `executing.has()`, awaited `shouldDeferForHeartbeat`, and
    // BOTH proceeded — doubling the createFnAgent count. After the fix, the second
    // call returns immediately because the first synchronously claimed the slot.
    const concurrentCount = mockedCreateFnAgent.mock.calls.length;
    expect(concurrentCount).toBe(baselineCount);
  });

  it("a second sequential execute() after the first completes is allowed (slot is released)", async () => {
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
    const firstCount = mockedCreateFnAgent.mock.calls.length;
    /*
    FNXC:EngineTests 2026-07-23-21:40:
    The first graph run ends in the no-fn_task_done requeue: the ROW is now parked in
    `todo` awaiting the scheduler. A direct second execute() against a todo row is no
    longer a valid dispatch shape — the graph re-requeues it without opening a session
    (routeGraphFailureToExecutionResume). Emulate the scheduler's re-dispatch move
    (todo → in-progress) before the second execute so this test keeps measuring what it
    exists for: the in-memory executing slot was RELEASED and a sequential dispatch runs.
    */
    store._setRow("FN-4814", { column: "in-progress" });
    await executor.execute(makeTask());
    const secondCount = mockedCreateFnAgent.mock.calls.length;

    // The second call did SOMETHING (slot was released) — createFnAgent count grew.
    expect(secondCount).toBeGreaterThan(firstCount);
  });
});
