import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import * as branchAutocorrect from "../execution/branch-autocorrect.js";
import { createMockStore, createWorkflowRoutingAgentStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

function baseTask() {
  return {
    id: "FN-5083",
    title: "Branch case check",
    description: "",
    column: "in-progress",
    /*
    FNXC:ExecutorToolCapture 2026-09-24-16:50:
    Fresh graph acquisition assigns the task-pinned checkout before this suite captures its
    implementation completion tool; pre-seeding a legacy synthetic path prevents that session.
    */
    taskDoneRetryCount: 0,
    branch: "fusion/fn-5083",
    enabledWorkflowSteps: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function setup() {
  const store = createMockStore();
  let task: any = baseTask();
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.moveTask.mockImplementation(async (id: string, column: string) => {
    task = { ...task, id, column, paused: false, pausedByAgentId: null, status: null, error: null };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((t: any) => t.name === "fn_task_done") ?? tool;
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: createWorkflowRoutingAgentStore(store).agentStore,
  });
  await executor.execute(baseTask() as any);
  expect(tool, "TaskExecutor should open an implementation session with fn_task_done").toBeDefined();
  return { tool, store };
}

describe("executor fn_task_done case-insensitive branch handling", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    vi.spyOn(branchAutocorrect, "attemptBranchAutocorrect").mockResolvedValue({ status: "renamed" });
    mockedExecSync.mockImplementation((cmd: string) => {
      // FNXC:ExecutorToolCapture 2026-09-24-16:50: Preserve the Git-root precondition that reaches the implementation session.
      if (cmd.includes("rev-parse --is-inside-work-tree")) return Buffer.from("true\n");
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/tmp/test/.fusion/worktrees/fn-5083\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-5083\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("allows exact branch matches", async () => {
    const { tool } = await setup();
    // FNXC:ExecutorToolCapture 2026-09-24-16:50: Only completion validation needs the acquired path present; setup must retain fresh acquisition.
    mockedExistsSync.mockReturnValue(true);
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
  });

  it("auto-canonicalizes case-only mismatches", async () => {
    const { tool } = await setup();
    // FNXC:ExecutorToolCapture 2026-09-24-16:50: Validate the captured tool against its acquired checkout after fresh session creation.
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/tmp/test/.fusion/worktrees/fn-5083\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/FN-5083\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(branchAutocorrect.attemptBranchAutocorrect).toHaveBeenCalled();
  });

  it("still refuses genuine wrong branches", async () => {
    const { tool } = await setup();
    // FNXC:ExecutorToolCapture 2026-09-24-16:50: Validation must see a present worktree to exercise wrong-branch refusal.
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/tmp/test/.fusion/worktrees/fn-5083\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
  });
});
