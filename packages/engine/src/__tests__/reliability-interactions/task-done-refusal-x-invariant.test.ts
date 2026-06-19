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
  let reviewTool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.updateTask.mockImplementation(async (_id: string, patch: any) => {
    task = { ...task, ...patch };
    return { ...task, steps: task.steps.map((s: any) => ({ ...s })) };
  });
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    task = { ...task, column };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    doneTool = customTools.find((tool: any) => tool.name === "fn_task_done");
    reviewTool = customTools.find((tool: any) => tool.name === "fn_review_step");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(createTask() as any);

  return { store, doneTool, reviewTool, getTask: () => task };
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

  it("runs dissent refusal before scope-leak guard when invariants pass", async () => {
    const invariantSpy = vi.spyOn(TaskExecutor.prototype as any, "verifyWorktreeInvariants").mockResolvedValue({ ok: true });
    const scopeSpy = vi.spyOn(TaskExecutor.prototype as any, "evaluateTaskDoneScopeLeak");
    const { doneTool } = await setup();

    const result = await doneTool.execute("done", { summary: "To unblock, land FN-4789 first." });

    expect(result.details.refusalClass).toBe("summary-claims-incomplete");
    expect(scopeSpy).not.toHaveBeenCalled();
    scopeSpy.mockRestore();
    invariantSpy.mockRestore();
  });

  it("shares one retry budget across mixed refusal classes", async () => {
    const { doneTool, reviewTool, store, getTask } = await setup({ steps: [{ name: "S1", status: "in-progress" }, { name: "S2", status: "pending" }] });

    await doneTool.execute("1", { summary: "Task is not complete." });
    expect(getTask().taskDoneRetryCount).toBe(1);

    await doneTool.execute("2", { summary: "Completed implementation and tests." });
    expect(getTask().taskDoneRetryCount).toBe(2);

    getTask().steps = [{ name: "S1", status: "in-progress" }];
    await reviewTool.execute("rev", { step: 0, type: "code", step_name: "S1", baseline: "abc" });
    const third = await doneTool.execute("3", { summary: "Completed implementation and tests." });
    expect(third.details.refusalClass).toBe("pending-code-review-revise");
    expect(getTask().taskDoneRetryCount).toBe(3);

    const fourth = await doneTool.execute("4", { summary: "Task is not complete." });
    expect(fourth.details.refusalClass).toBe("pending-code-review-revise");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4851", "in-review");
  });
});
