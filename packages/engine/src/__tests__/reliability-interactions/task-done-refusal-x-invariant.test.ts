import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { reviewStep } from "../../reviewer.js";
import * as worktreePool from "../../worktree-pool.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "../executor-test-helpers.js";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4851",
    title: "Reliability ordering",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4851",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }, { name: "Step 2", status: "pending" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  let task: any = createTask(overrides);
  let doneTool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.updateTask.mockImplementation(async (_id: string, patch: any) => {
    task = { ...task, ...patch };
    return { ...task, steps: task.steps.map((s: any) => ({ ...s })) };
  });
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    task = { ...task, column };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    doneTool = customTools.find((tool: any) => tool.name === "fn_task_done") ?? doneTool;
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(createTask() as any);

  return { store, doneTool, getTask: () => task };
}

describe("FN-4851 reliability interactions: task-done refusals x invariant", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4851\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    vi.mocked(reviewStep).mockResolvedValue({ verdict: "REVISE", summary: "needs work", review: "fix" } as any);
  });

  it("lets invariant refusal win over summary dissent", async () => {
    const invariantSpy = vi.spyOn(TaskExecutor.prototype as any, "verifyWorktreeInvariants").mockResolvedValue({
      ok: false,
      reason: "wrong_branch",
      observed: "main",
      expected: "fusion/fn-4851",
    });
    const { doneTool } = await setup();

    const result = await doneTool.execute("done", { summary: "Task is not complete and I am blocked." });

    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(result.details.refusalClass).toBeUndefined();
    invariantSpy.mockRestore();
  });

  it("does not let summary prose prevent the scope-leak guard from running", async () => {
    const invariantSpy = vi.spyOn(TaskExecutor.prototype as any, "verifyWorktreeInvariants").mockResolvedValue({ ok: true });
    const scopeSpy = vi.spyOn(TaskExecutor.prototype as any, "evaluateTaskDoneScopeLeak");
    const { doneTool } = await setup();

    const result = await doneTool.execute("done", { summary: "To unblock, land FN-4789 first." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(scopeSpy).toHaveBeenCalled();
    scopeSpy.mockRestore();
    invariantSpy.mockRestore();
  });

  it("shares one retry budget across repeated structural refusals", async () => {
    const { doneTool, store, getTask } = await setup({ steps: [{ name: "S1", status: "in-progress" }, { name: "S2", status: "pending" }] });

    // FNXC:WorkflowLifecycle 2026-07-01-21:20: setup()'s execute() drives a bare mock agent through the
    // default-on workflow graph; the agent never calls fn_task_done, so the graph's no-fn_task_done requeue
    // pre-bumps taskDoneRetryCount by one before the refusal sequence under test begins. Reset the shared
    // budget to zero so this test measures ONLY the mixed-refusal-class budget sharing it is asserting.
    getTask().taskDoneRetryCount = 0;

    /*
    FNXC:EngineTests 2026-07-19-03:36 (U10b):
    Requirement unchanged: every fn_task_done refusal class draws from ONE shared retry budget.
    What changed: the graph now owns the run and PERSISTS its own step list, so the step shape a
    refusal class reads is whatever the executor last wrote — not the literal this file handed to
    `setup()`. Staging the incomplete-step precondition through `store._setRow` (a simulated
    external mutation that outranks the executor's own writes) is the only way to hold the
    bulk-step-completion precondition true at the moment each refusal is evaluated.
    */
    const stageIncompleteSteps = () =>
      store._setRow("FN-4851", {
        steps: [{ name: "S1", status: "in-progress" }, { name: "S2", status: "pending" }],
      });

    stageIncompleteSteps();
    await doneTool.execute("1", { summary: "Completed implementation and tests." });
    expect(getTask().taskDoneRetryCount).toBe(1);

    stageIncompleteSteps();
    await doneTool.execute("2", { summary: "Completed implementation and tests." });
    expect(getTask().taskDoneRetryCount).toBe(2);

    stageIncompleteSteps();
    const third = await doneTool.execute("3", { summary: "Completed implementation and tests." });
    expect(third.details.refusalClass).toBe("bulk-step-completion-without-review");
    expect(getTask().taskDoneRetryCount).toBe(3);

    stageIncompleteSteps();
    const fourth = await doneTool.execute("4", { summary: "Completed implementation and tests." });
    expect(fourth.details.refusalClass).toBe("bulk-step-completion-without-review");
    // FNXC:WorkflowLifecycle 2026-07-01-21:20: The shared retry budget is exhausted on the 4th refusal
    // (count already 3). Exhaustion is terminal and now parks the task `status: "failed"` in place under
    // the workflow-graph failure model (superseding FN-1284's move-to-in-review escalation); the invariant
    // proven here is that a SINGLE budget is shared across mixed refusal classes and its exhaustion is
    // terminal, not that the terminal state is in-review.
    expect(store.updateTask).toHaveBeenCalledWith("FN-4851", expect.objectContaining({ status: "failed" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4851", "in-review");
  });
});
