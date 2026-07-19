import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree-pool.js";
import { captureNamedTool, createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4851",
    title: "Task done refusal test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4851",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    dependencies: [],
    steps: [{ name: "Implementation", status: "in-progress" as const }],
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
    doneTool = captureNamedTool(customTools, "fn_task_done", doneTool);
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(createTask() as any);

  return { store, doneTool };
}

describe("FN-4851 dissent guard", () => {
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
  });

  it("refuses summary that directly claims incompletion", async () => {
    const { store, doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "Task is not complete. I'm blocked from safely finishing this." });

    expect(result.details.refusalClass).toBe("summary-claims-incomplete");
    expect(result.content[0].text).toContain("fn_task_done refused (summary-claims-incomplete)");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4851", "todo", { preserveProgress: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-4851", expect.objectContaining({ taskDoneRetryCount: 1 }));
  });

  it("refuses 'To unblock' summary", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "To unblock, sync/land FN-4789 before I can finish." });

    expect(result.details.refusalClass).toBe("summary-claims-incomplete");
  });

  it("refuses summary that says it needs another FN task", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "This needs FN-1234 before completion." });

    expect(result.details.refusalClass).toBe("summary-claims-incomplete");
  });

  it("allows bare 'incomplete' without first-person/task context", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "Fixed incomplete dependency declaration in package.json" });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
  });

  it("does not trigger dissent guard for empty summary", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", {});

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
  });
});
