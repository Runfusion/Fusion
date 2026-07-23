import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree/worktree-pool.js";
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

describe("fn_task_done summary prose", () => {
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

  it("accepts completion when the summary documents future work as not implemented in this task", async () => {
    const { store, doneTool } = await setup();
    store.moveTask.mockClear();

    const result = await doneTool.execute("id", {
      summary: "KB-015 complete: Implemented semantic design tokens and migrated all components. All verification passes. Note: User steering comments requested migration to a shadcn-svelte pattern — this is documented as a future direction in project memory and task docs, not implemented in this task per the DO NOT redo completed steps instruction.",
    });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4851", "todo", { preserveProgress: true });
  });

  it("accepts a completion call even when its summary claims incompletion", async () => {
    const { store, doneTool } = await setup();
    store.moveTask.mockClear();

    const result = await doneTool.execute("id", { summary: "Task is not complete. I'm blocked from safely finishing this." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4851", "todo", { preserveProgress: true });
  });

  it("accepts a completion call whose summary contains 'To unblock'", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "To unblock, sync/land FN-4789 before I can finish." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
  });

  it("accepts a completion call whose summary says it needs another FN task", async () => {
    const { doneTool } = await setup();

    const result = await doneTool.execute("id", { summary: "This needs FN-1234 before completion." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
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
