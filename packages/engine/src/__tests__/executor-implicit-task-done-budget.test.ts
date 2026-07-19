import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { executorLog } from "../logger.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

function refusal() {
  return {
    ok: false as const,
    refusalClass: "pending-code-review-revise" as const,
    reason: "Step 1 has pending REVISE",
    message: "fn_task_done refused (pending-code-review-revise): Step 1 has pending REVISE",
  };
}

function task(retryCount: number) {
  return {
    id: "FN-4946-B",
    title: "Budget",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4946-b",
    baseCommitSha: "abc123",
    taskDoneRetryCount: retryCount,
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

describe("FN-4946 implicit refusal budget handling", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("requeues to todo under budget", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");

    await (executor as any).handleImplicitTaskDoneRefusal(task(2), refusal());

    expect(store.updateTask).toHaveBeenCalledWith("FN-4946-B", expect.objectContaining({
      status: "queued",
      error: null,
      taskDoneRetryCount: 3,
      worktree: null,
      branch: null,
      paused: false,
      pausedByAgentId: null,
      sessionFile: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-4946-B", "todo", { preserveProgress: true });
    expect(executorLog.error).toHaveBeenCalledWith(expect.stringContaining("(implicit completion)"));
  });

  it("escalates to in-review at budget limit", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    const persistSpy = vi.spyOn(executor as any, "persistTokenUsage").mockResolvedValue(undefined);

    await (executor as any).handleImplicitTaskDoneRefusal(task(3), refusal());

    // FNXC:WorkflowLifecycle 2026-07-01-20:25: At refusal-budget exhaustion the implicit path now parks
    // the task `status: "failed"` IN PLACE (worktree/branch cleared), mirroring the explicit fn_task_done
    // exhaustion path and the workflow-graph failure-in-place model. status="failed" is the surfaced
    // terminal + self-healing-exemption marker; the legacy FN-1284 move-to-in-review escalation was
    // superseded. The protected invariant — budget exhaustion is terminal, not another requeue — holds
    // via the failed parking + persisted token usage.
    expect(store.updateTask).toHaveBeenCalledWith("FN-4946-B", expect.objectContaining({ status: "failed", worktree: null, branch: null }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4946-B", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4946-B", "todo", { preserveProgress: true });
    expect(persistSpy).toHaveBeenCalledWith("FN-4946-B");
  });

  it("shares retry budget with explicit fn_task_done refusals", async () => {
    const store = createMockStore();
    let currentTask: any = { ...task(2), id: "FN-4946-B2", steps: [{ name: "Step 1", status: "in-progress" }] };
    let doneTool: any;

    store.getTask.mockImplementation(async () => ({ ...currentTask, steps: currentTask.steps.map((s: any) => ({ ...s })) }));
    store.updateTask.mockImplementation(async (_id: string, patch: any) => {
      currentTask = { ...currentTask, ...patch };
    });

    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
      doneTool = customTools.find((t: any) => t.name === "fn_task_done") ?? doneTool;
      return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn(), on: vi.fn(), state: {} } } as any;
    });

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(currentTask);

    // Burn explicit-path refusal budget from 2 -> 3 (still todo), then implicit refusal should escalate immediately.
    await doneTool.execute("d1", { summary: "I am not done yet." });
    expect(currentTask.taskDoneRetryCount).toBe(3);

    await (executor as any).handleImplicitTaskDoneRefusal(
      { ...currentTask, id: "FN-4946-B2", column: "todo" },
      refusal(),
    );

    // FNXC:WorkflowLifecycle 2026-07-01-20:25: The shared-budget invariant is that once the explicit path
    // has burned the retry budget (2->3), the follow-up implicit refusal escalates IMMEDIATELY instead of
    // requeuing again. That terminal escalation now parks the task `status: "failed"` in place (no
    // move-to-in-review — the legacy FN-1284 escalation was superseded by the failure-in-place model). The
    // budget-sharing invariant is proven by the terminal failed update carrying no further taskDoneRetryCount
    // bump, and by the absence of a second todo requeue for the implicit refusal.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4946-B2", "in-review");
    const implicitEscalationUpdate = store.updateTask.mock.calls.find(
      ([id, patch]: [string, Record<string, unknown>]) =>
        id === "FN-4946-B2" && patch.status === "failed" && !("taskDoneRetryCount" in patch),
    );
    expect(implicitEscalationUpdate).toBeTruthy();
  });

  it("resets taskDoneRetryCount after later clean completion", async () => {
    const store = createMockStore();
    /*
    FNXC:EngineTests 2026-07-19-16:15 (U10b):
    The invariant under test is the IMPLEMENTATION session's clean completion: a clean
    fn_task_done must reach the in-review merge boundary without bumping taskDoneRetryCount.
    Under graph ownership the optional pre-merge review nodes would run first and this test's
    session stub (which calls fn_task_done from `prompt`) assumes it IS the implementation
    session, so the task declares no pre-merge gates.
    */
    let currentTask: any = { ...task(1), id: "FN-4946-B3", enabledWorkflowSteps: [], steps: [{ name: "Step 1", status: "in-progress" }], executionMode: "fast" };
    store.getTask.mockImplementation(async () => ({ ...currentTask, steps: currentTask.steps.map((s: any) => ({ ...s })) }));
    store.updateTask.mockImplementation(async (_id: string, patch: any) => {
      currentTask = { ...currentTask, ...patch };
    });

    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
      const doneTool = customTools.find((t: any) => t.name === "fn_task_done");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await doneTool.execute("done", { summary: "complete" });
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
        },
      } as any;
    });

    const executor = new TaskExecutor(store as any, "/repo");
    await executor.execute(currentTask);

    /*
    FNXC:EngineTests 2026-07-19-16:20 (U10b):
    The in-review handoff is now the graph's merge boundary, so the move carries the
    workflow-graph provenance of the node that made it instead of being a bare 2-arg
    completion-path move.
    */
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-4946-B3",
      "in-review",
      expect.objectContaining({
        preserveProgress: true,
        workflowMoveSource: "workflow-graph",
        workflowMoveMetadata: expect.objectContaining({ nodeId: "completion-summary" }),
      }),
    );
    const retryBumpCalls = store.updateTask.mock.calls.filter(([, patch]: [string, Record<string, unknown>]) => typeof patch.taskDoneRetryCount === "number" && patch.taskDoneRetryCount > 1);
    expect(retryBumpCalls).toHaveLength(0);
  });
});
