/*
FN-4115 invariant: fn_task_done is the only path from in-progress to done, and it must refuse completion unless (1) git toplevel is a valid task worktree under <repo>/.worktrees, (2) branch matches fusion/<task-id>, and (3) there is at least one commit beyond baseCommitSha. Violations must requeue via taskDoneRetryCount + moveTask("todo", { preserveProgress: true }) and must not log successful completion.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { captureNamedTool, createMockStore, mockedCreateFnAgent, mockedExecSync, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:ExecutorCompletionInvariant 2026-09-22-13:18:
The graph creates session state beneath the repository's Fusion worktree root. Use a real,
test-owned `.fusion/worktrees/<task-id>` directory so completion reaches the production tool;
the fake must expose it only after session startup to preserve the acquisition test boundary.
*/
let rootDir = "";
let worktreePath = "";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4115",
    title: "Invariant test",
    description: "",
    column: "in-progress",
    worktree: worktreePath,
    branch: "fusion/fn-4115",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  let task: any = makeTask(overrides);
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.updateTask.mockImplementation(async (_id: string, updates: any) => {
    task = { ...task, ...updates };
    return task;
  });
  store.moveTask.mockImplementation(async (id: string, column: string) => {
    task = { ...task, id, column, paused: false, pausedByAgentId: null, status: null, error: null };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = captureNamedTool(customTools, "fn_task_done", tool);
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, rootDir);
  await executor.execute(makeTask(overrides) as any);

  return { store, tool, getTask: () => task };
}

function makeCompletionCheckoutVisible() {
  mockedExistsSync.mockReturnValue(true);
}

describe("FN-4115 wrong-checkout completion rejection", () => {
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-fn-4115-"));
    worktreePath = join(rootDir, ".fusion", "worktrees", "fn-4115");
    mkdirSync(worktreePath, { recursive: true });
    resetExecutorMocks();
    vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValue({ ok: true });
    mockedExistsSync.mockImplementation((path) => !/[\\/]worktrees[\\/]/.test(String(path)));
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(`${worktreePath}\n`);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4115\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("FN-4115: fn_task_done refuses completion when git toplevel resolves to repo root", async () => {
    const { store, tool } = await setup();
    makeCompletionCheckoutVisible();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(`${rootDir}\n`);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4115\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_toplevel");
    /*
    FNXC:EngineTests 2026-07-19-15:05 (U10b):
    The graph's step-execute node legitimately marks step 0 `in-progress` (`{ source: "graph" }`) during
    setup, so "updateStep was never called" no longer isolates the refusal. The requirement it stood for is
    that a REFUSED fn_task_done must never advance a step to `done`; assert that directly.
    */
    expect(
      store.updateStep.mock.calls.some(([id, , status]) => id === "FN-4115" && status === "done"),
    ).toBe(false);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4115", "todo", { preserveProgress: true });
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-4115", expect.stringContaining("Task marked done by agent"));
  });

  it("FN-4115: fn_task_done refuses completion when current branch is not fusion/<task-id>", async () => {
    const { store, tool } = await setup();
    makeCompletionCheckoutVisible();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(`${worktreePath}\n`);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4115", "todo", { preserveProgress: true });
  });

  it("FN-4115: fn_task_done refuses completion when there are zero commits beyond base", async () => {
    const { store, tool } = await setup();
    makeCompletionCheckoutVisible();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(`${worktreePath}\n`);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4115\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4115", "todo", { preserveProgress: true });
  });

  it("FN-4115: fn_task_done completes on valid worktree branch and commit state", async () => {
    const { store, tool } = await setup();
    makeCompletionCheckoutVisible();
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
    // FNXC:ExecutorMoveTask 2026-07-07-08:38: A valid fn_task_done completion is distinguished from a wrong-checkout REFUSAL by its success log, not by the absence of a todo moveTask. setup() runs execute() with a mocked agent that never calls fn_task_done, so the FN-4806 silent worktree-reclaim path (executor.ts:11149, 3f8a5e6839) legitimately requeues to todo with { preserveProgress: true } — the same signature the refusal path (handleImplicitTaskDoneRefusal, executor.ts:13030) emits — so a moveTask-shape assertion cannot tell a valid completion from a refusal. Pin the positive success marker instead: a valid completion logs "Task marked done by agent" (executor.ts:13306), which the refusal test at line 82 proves a wrong-checkout rejection never emits. (Filter on id+message so the runContext arg / arity don't make this brittle.)
    expect(
      store.logEntry.mock.calls.some(
        ([id, msg]) => id === "FN-4115" && typeof msg === "string" && msg === "Task marked done by agent",
      ),
    ).toBe(true);
  });

  /*
  FNXC:ExecutorCompletionInvariant 2026-09-22-13:18:
  This suite owns fn_task_done's observable checkout refusal after an implementation session
  is open. Executor worktree liveness and acquisition-before-session behavior is separately
  covered by executor-worktree-liveness.test.ts, which drives the real acquisition seam.
  */
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
});
