import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { reviewStep } from "../reviewer.js";
import * as worktreePool from "../worktree-pool.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4851",
    title: "REVISE guard",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4851",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
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
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    task = { ...task, column };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    doneTool = customTools.find((tool: any) => tool.name === "fn_task_done") ?? doneTool;
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(createTask() as any);

  return { store, doneTool };
}

describe("FN-4851 REVISE verdict task-done guard", () => {
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
    vi.mocked(reviewStep).mockResolvedValue({
      verdict: "REVISE",
      summary: "Needs fixes",
      review: "Please fix issues",
    } as any);
  });

  it("ignores REVISE verdict on already done or skipped steps", async () => {
    const { doneTool } = await setup({
      steps: [{ name: "Step 1", status: "done" }, { name: "Step 2", status: "skipped" }],
    });

    const result = await doneTool.execute("done", { summary: "Implemented all requested changes." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
  });
});
