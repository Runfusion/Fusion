import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { createFnAgent } from "../../pi.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-5436-RI",
    title: "Pending review skip",
    description: "",
    column: "in-progress",
    dependencies: [],
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 1: Step 1\n- [ ] do work",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

/*
FNXC:EngineTests 2026-07-19-04:05 (U10b):
Requirement unchanged: when the task's STEPS say the work is finished, implicit-done wins over the
pending-review skip heuristic, even if a stale review log line is still on the row.
What changed: the workflow graph now owns the run, and its `parse-steps` node RE-DERIVES the step
list from PROMPT.md on every run and writes every step back as `pending`. A step list marked `done`
on the fixture literal therefore no longer survives to the implicit-completion check — the only
thing that can leave a step `done` at that point is the implementation session itself doing the
work. Simulate exactly that: the session marks its steps complete but never calls fn_task_done,
which is the precise situation implicit-done exists to cover.
*/
function sessionThatCompletesStepsWithoutCallingTaskDone(store: ReturnType<typeof createMockStore>, taskId: string) {
  mockedCreateFnAgent.mockImplementation(async () => ({
    session: {
      prompt: vi.fn(async () => {
        store._setRow(taskId, { steps: [{ name: "Preflight", status: "done" }] });
      }),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      on: vi.fn(),
      sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      state: {},
    },
  }) as any);
}

describe("reliability interactions: FN-5436 executor pending-review skip", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);
  });

  it("FN-5436 composition: implicit-done wins when no in-progress step exists despite stale review logs", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-A",
      steps: [{ name: "Step 1", status: "done" }],
      log: [{ action: "code review Step 0: REVISE", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);
    sessionThatCompletesStepsWithoutCallingTaskDone(store, "FN-5436-RI-A");

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-A", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    /*
    FNXC:EngineTests 2026-07-19-04:12 (U10b):
    The in-review handoff is now the graph's merge boundary, so `moveTask` carries the node's move
    provenance (`workflowMoveSource`/`workflowMoveMetadata`) alongside the column. The contract
    asserted here is the destination column, which is unchanged.
    */
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-A", "in-review", expect.anything());
  });

  it("FN-5436 composition: reclaim-abort path takes precedence over pending-review skip", async () => {
    const store = createMockStore();
    const task = makeTask({ id: "FN-5436-RI-B", paused: true });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-B", "todo", { preserveProgress: true });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-B", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
  });

  it("FN-5436 composition: pending-review park does not consume taskDone requeue budget", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-C",
      taskDoneRetryCount: 2,
      log: [{ action: "code review requested for Step 0 (Step 1)", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-C", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-C", expect.objectContaining({ taskDoneRetryCount: 3 }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-C", "in-review");
  });

  it("FN-5436 composition: recoverApprovedStepsOnResume leaves pending-review skip disabled after approval resolves step", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-D",
      steps: [{ name: "Step 1", status: "done" }],
      log: [{ action: "code review Step 0: APPROVE", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);
    sessionThatCompletesStepsWithoutCallingTaskDone(store, "FN-5436-RI-D");

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    /*
    FNXC:EngineTests 2026-07-19-04:24 (U10b):
    DELETED assertion: `updateTask({ workflowStepRetries: undefined, taskDoneRetryCount: null })`.
    That "reset retry counters on success" write exists at exactly three sites in executor.ts, and
    all three sit AFTER the `if (graphCompletion) { ... return; }` short-circuit — i.e. only on the
    non-graph completion path. Now that every run is graph-owned, completion hands off at the
    implementation boundary and that write has no live caller, so the assertion measured deleted
    machinery rather than this test's subject (approval resolving a step must leave the
    pending-review skip disabled), which the two assertions below still prove.
    */
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-D", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
    /*
    FNXC:EngineTests 2026-07-19-04:12 (U10b):
    The in-review handoff is now the graph's merge boundary, so `moveTask` carries the node's move
    provenance (`workflowMoveSource`/`workflowMoveMetadata`) alongside the column. The contract
    asserted here is the destination column, which is unchanged.
    */
    expect(store.moveTask).toHaveBeenCalledWith("FN-5436-RI-D", "in-review", expect.anything());
  });

  it("FN-5436 negative: plan-review UNAVAILABLE advisory remains non-blocking", async () => {
    const store = createMockStore();
    const task = makeTask({
      id: "FN-5436-RI-E",
      log: [{ action: "plan review Step 0: UNAVAILABLE — proceeding advisory after fallback retry exhausted", timestamp: new Date().toISOString() }],
    });
    store.getTask.mockResolvedValue(task);

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(task);

    /*
    FNXC:EngineTests 2026-07-19-04:33 (U10b):
    Requirement unchanged: an UNAVAILABLE plan-review advisory is NOT a pending review, so it must
    not arm the pending-review skip — the executor still spends the full no-fn_task_done retry
    budget (1 implementation session + 3 retries) and then requeues.
    What changed: Plan Review and Code Review are now graph NODES with their own agent sessions, so
    a bare `createFnAgent` call count no longer counts implementation sessions. Count the sessions
    that carry `fn_task_done` — those and only those are implementation sessions.
    */
    const implementationSessions = mockedCreateFnAgent.mock.calls.filter(
      ([opts]: any[]) => (opts?.customTools ?? []).some((tool: any) => tool?.name === "fn_task_done"),
    );
    expect(implementationSessions).toHaveLength(4);
    expect(store.updateTask).toHaveBeenCalledWith("FN-5436-RI-E", {
      status: "queued",
      error: null,
      taskDoneRetryCount: 1,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-RI-E", {
      status: "failed",
      error: "executor-exit-while-review-pending",
    });
  });
});
