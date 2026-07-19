import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { mockedCreateFnAgent, createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4601",
    title: "Test",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Preflight", status: "in-progress" }],
    currentStep: 0,
    taskDoneRetryCount: 0,
    worktree: "/tmp/test/.worktrees/fn-4601",
    branch: "fusion/fn-4601",
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

function makeSession() {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
    state: {},
  };
}

describe("reliability interactions: executor no-fn_task_done vs worktree reclaim", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("pre-retry liveness recheck aborts retry and silently requeues (FN-4806)", async () => {
    const store = createMockStore();
    const state = makeTask();
    let getTaskCalls = 0;
    store.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls >= 2) {
        state.worktree = null;
        state.branch = null;
      }
      return { ...state };
    });

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    // FN-4806: silent requeue — task goes to todo with preserveProgress, no failed status,
    // no taskDoneRetryCount burn, no onError surface.
    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4601",
      expect.stringContaining("engine self-heal, no failure"),
      undefined,
      expect.any(Object),
    );
    // Reclaim path must NOT mark task failed and must NOT burn taskDoneRetryCount budget.
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ taskDoneRetryCount: expect.any(Number) }),
    );
    // Stale binding must be cleared so the next pickup creates a fresh worktree.
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ worktree: null, branch: null }),
    );
  });

  it("missing-worktree session-start error during retry clears metadata and requeues", async () => {
    const store = createMockStore();
    const state = makeTask();
    store.getTask.mockImplementation(async () => ({ ...state }));

    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: makeSession() } as any)
      .mockRejectedValueOnce(new Error("Refusing to start coding agent in missing worktree: /tmp/test/.worktrees/fn-4601"));

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4601", expect.objectContaining({
      sessionFile: null,
      worktree: null,
      branch: null,
      worktreeSessionRetryCount: 1,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
    // FN-4806: session-start missing-worktree is engine self-heal, must not burn retry budget
    // and must not mark the task failed.
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ taskDoneRetryCount: expect.any(Number) }),
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "in-review");
  });

  it("non-recoverable retry error still follows failure path", async () => {
    const store = createMockStore();
    const state = makeTask();
    store.getTask.mockImplementation(async () => ({ ...state }));

    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: makeSession() } as any)
      .mockRejectedValueOnce(new Error("boom"));

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    // FNXC:WorkflowLifecycle 2026-07-01-21:05: A non-recoverable execute error follows the terminal
    // FAILURE path, which under the workflow-graph model parks the task `status: "failed"` IN PLACE (the
    // failure-in-place model that superseded FN-1284's in-review escalation). The invariant under test is
    // that this path is DISTINCT from the FN-4806 reclaim self-heal (silent todo requeue, no failed): a
    // non-recoverable error marks the task failed and does NOT silently requeue to todo.
    expect(store.updateTask).toHaveBeenCalledWith("FN-4601", expect.objectContaining({ status: "failed" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
  });

  it("reclaim path ignores requeue budget and always silently requeues (FN-4806)", async () => {
    // FN-4806: reclaim is engine self-heal, not an agent failure, so it must not be subject to
    // the no-fn_task_done requeue cap. Even at the previously-exhausted budget the task must
    // still go silently to todo, not in-review.
    const store = createMockStore();
    const state = makeTask({ taskDoneRetryCount: 3 });
    let getTaskCalls = 0;
    store.getTask.mockImplementation(async () => {
      getTaskCalls++;
      if (getTaskCalls >= 2) {
        state.worktree = null;
        state.branch = null;
      }
      return { ...state };
    });

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(store.moveTask).toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "in-review");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.objectContaining({ status: "failed" }),
    );
  });

  /*
  FNXC:ExecutorTaskDonePark 2026-07-15-16:10:
  FN-7965 symptom verification. The in-session `fn_task_done` refusal handler parks the row terminally
  (status=failed + cleared worktree/branch/sessionFile) once the refusal budget is exhausted. The retry
  loop never observed that park and spawned a fresh session, which completed and marked the task done
  against a worktree-less row — stranding the pre-merge graph on `no-worktree-for-write-node`.
  Surface enumeration: the park must be honored whichever way the cleared binding surfaces (the real
  store maps a cleared column to `undefined` via `row.worktree || undefined`, never `null`), and the
  park must NOT be laundered into the FN-4806 silent requeue, which would clear the failure and
  re-park on the next pickup in a todo→execute→park loop.
  */
  it.each([
    ["binding cleared to undefined (real store contract)", { worktree: undefined, branch: undefined }],
    ["binding cleared to null (mirror/legacy shape)", { worktree: null, branch: null }],
    ["binding still present", {}],
  ])("honors a terminal fn_task_done park instead of retrying — %s", async (_label, cleared) => {
    const store = createMockStore();
    const initial = makeTask({ taskDoneRetryCount: 3 });
    let getTaskCalls = 0;
    // Mutate only what the STORE returns, never the object passed to execute(): in production the
    // in-session tool handler writes the park while this loop still holds its original `task`.
    store.getTask.mockImplementation(async () => {
      getTaskCalls++;
      return getTaskCalls >= 2
        ? { ...initial, status: "failed", error: "fn_task_done refused (bulk-step-completion-without-review)", ...cleared }
        : { ...initial };
    });

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(makeTask({ taskDoneRetryCount: 3 }));

    // No resurrection: the park must abort before a second session spawns.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4601",
      expect.stringContaining("honoring park, not retrying"),
      undefined,
      expect.any(Object),
    );
    // The park must survive: never laundered into the FN-4806 silent requeue...
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "todo", { preserveProgress: true });
    // ...and never handed off to review, which is what dragged the worktree-less row into the graph.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4601", "in-review");
  });

  it("still retries when the task has not been parked", async () => {
    // Negative control: the park check must not abort a healthy retry, or every no-fn_task_done
    // session would degrade into a premature stop.
    const store = createMockStore();
    const state = makeTask();
    store.getTask.mockImplementation(async () => ({ ...state }));

    mockedCreateFnAgent.mockResolvedValue({ session: makeSession() } as any);

    const executor = new TaskExecutor(store as any, "/tmp/test");
    await executor.execute(state);

    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThan(1);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-4601",
      expect.stringContaining("honoring park, not retrying"),
      undefined,
      expect.any(Object),
    );
  });
});
