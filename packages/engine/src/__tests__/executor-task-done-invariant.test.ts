import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree-pool.js";
import { TaskStore } from "@fusion/core";
import { createMockStore, mockedCreateFnAgent, mockedExec, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const fn416Prompt = `# Task: FN-416 - Assign ready implementation task to active owner

**Created:** 2026-06-12
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is an operational routing task with no expected product-source changes.

## Mission
Assign or route exactly one ready implementation task to an eligible active owner, or record an intentional no-route state. No source files expected.

## File Scope

- FN-416 task document docs via fn_task_document_write
- .fusion/tasks/FN-416/ task log evidence only

## Steps

### Step 0: Preflight
- [x] Check board state

### Step 1: Route exactly one existing ready task or record no-route
- [x] Record evidence in task documents/logs
`;

const sourceChangingPlanOnlyPrompt = `# Task: FN-999 - Implement source fix

**Size:** S

## Review Level: 1 (Plan Only)

## Mission
Implement a source-changing bug-fix in the executor.

## File Scope

- packages/engine/src/executor.ts

## Steps

### Step 1: Implement
- [ ] Change source
`;

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4114",
    title: "Invariant test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4114",
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
  let task: any = baseTask(overrides);
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.moveTask.mockImplementation(async (id: string, column: string) => {
    task = { ...task, id, column, paused: false, pausedByAgentId: null, status: null, error: null };
  });
  store.handoffToReview.mockImplementation(async (id: string) => {
    task = { ...task, id, column: "in-review", paused: false, pausedByAgentId: null };
    return task;
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((t: any) => t.name === "fn_task_done");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(task as any);

  return { store, tool, setTask: (next: any) => (task = { ...task, ...next }) };
}

describe("FN-4114 fn_task_done invariants", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("FN-4114 refuses fn_task_done when toplevel resolves to repo root", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_toplevel");
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 refuses fn_task_done when branch is wrong", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 refuses fn_task_done when no commits exist beyond base", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 allows no-commit completion when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4114",
      expect.stringContaining("noCommitsExpected=true"),
      undefined,
      undefined,
    );
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
  });

  it("FN-4114 still refuses wrong_toplevel even when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_toplevel");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 still refuses wrong_branch even when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });


  it("FN-416 allows plan-only operational no-source completion with zero commits when the explicit flag is missing", async () => {
    const { store, tool } = await setup({
      id: "FN-416",
      branch: "fusion/fn-416",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: fn416Prompt,
      sourceMetadata: { fileScope: ["FN-416 task document docs via fn_task_document_write"] },
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Route or record no-route", status: "done" as const },
      ],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-416\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-416", "todo", { preserveProgress: true });
    expect(store.handoffToReview).not.toHaveBeenCalledWith("FN-416", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "invariant-check-failed" }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-416",
      expect.stringContaining("prompt/source metadata derived operational no-commit contract"),
      undefined,
      undefined,
    );
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
  });
  it("FN-416 refuses plan-only operational no-source completion when File Scope is missing", async () => {
    const promptWithoutFileScope = `# Task: FN-417 - Assign ready implementation task to active owner

## Review Level: 1 (Plan Only)

**Assessment:** This is an operational routing task with no expected product-source changes.

## Mission
Assign or route exactly one ready implementation task to an eligible active owner, or record an intentional no-route state. No source files expected.

## Steps

### Step 1: Route exactly one existing ready task or record no-route
- [x] Record evidence in task documents/logs
`;
    const { store, tool } = await setup({
      id: "FN-417",
      branch: "fusion/fn-417",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: promptWithoutFileScope,
      sourceMetadata: {},
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [{ name: "Route or record no-route", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-417\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-417", "todo", { preserveProgress: true });
  });

  it("FN-416 refuses prompt-only evidence text when steps are incomplete and logs are empty", async () => {
    const { store, tool } = await setup({
      id: "FN-418",
      branch: "fusion/fn-418",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: fn416Prompt.replace("# Task: FN-416", "# Task: FN-418"),
      sourceMetadata: { fileScope: ["FN-418 task document docs via fn_task_document_write"] },
      log: [],
      steps: [{ name: "Route or record no-route", status: "in-progress" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-418\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-418", "todo", { preserveProgress: true });
  });

  it("FN-416 refuses mixed no-source text with source-changing scope entries", async () => {
    const mixedScopePrompt = fn416Prompt
      .replace("# Task: FN-416", "# Task: FN-419")
      .replace(
        "- FN-416 task document docs via fn_task_document_write",
        "- No source changes expected, but inspect packages/engine/src/executor.ts",
      );
    const { store, tool } = await setup({
      id: "FN-419",
      branch: "fusion/fn-419",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: mixedScopePrompt,
      sourceMetadata: { fileScope: ["No source changes expected, but inspect packages/engine/src/executor.ts"] },
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [{ name: "Route or record no-route", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-419\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-419", "todo", { preserveProgress: true });
  });

  it("FN-416 keeps the missing-commit guard for source-changing plan-only tasks without an explicit contract", async () => {
    const { store, tool } = await setup({
      title: "Implement executor fix",
      description: "Plan Only but requires source-changing implementation work.",
      reviewLevel: 1,
      prompt: sourceChangingPlanOnlyPrompt,
      sourceMetadata: { fileScope: ["packages/engine/src/executor.ts"] },
      steps: [{ name: "Implement", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 allows fn_task_done on valid worktree/branch/commit state", async () => {
    const { store, tool } = await setup();
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
  });
});

describe("FN-5241 executor handoff auditing", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-5241-executor-"));
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createExecutorTask(taskDoneRetryCount = 0) {
    const created = await store.createTask({ description: "Invariant test", priority: "high" });
    await store.moveTask(created.id, "todo");
    await store.moveTask(created.id, "in-progress");
    const worktreePath = join(rootDir, ".worktrees", "swift-falcon");
    mkdirSync(worktreePath, { recursive: true });
    const branch = `fusion/${created.id.toLowerCase()}`;
    await store.updateTask(created.id, {
      worktree: worktreePath,
      branch,
      baseCommitSha: "abc123",
      taskDoneRetryCount,
      steps: [{ name: "Step 1", status: "in-progress" }],
      currentStep: 0,
    });
    const task = (await store.getTask(created.id))!;
    return {
      task: {
        ...task,
        prompt: "# Test\n## Steps\n### Step 1: Implement\n- [ ] check",
      },
      worktreePath,
    };
  }

  it("emits task:handoff and enqueues merge work on successful fn_task_done", async () => {
    const { task, worktreePath } = await createExecutorTask();
    mockedExec.mockImplementation(((cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (!cb) return undefined as any;
      if (cmd.includes("rev-parse --show-toplevel")) return cb(null, `${worktreePath}\n`, "");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return cb(null, `${task.branch}\n`, "");
      if (cmd.includes("rev-list --count")) return cb(null, "1\n", "");
      if (cmd.includes("rev-parse HEAD")) return cb(null, "def456\n", "");
      return cb(null, "", "");
    }) as any);
    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const taskDoneTool = customTools.find((tool: any) => tool.name === "fn_task_done");
          await taskDoneTool.execute("tool-1", {});
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    }) as any);

    const executor = new TaskExecutor(store as any, rootDir);
    await executor.execute(task as any);

    expect((await store.getTask(task.id))?.column).toBe("in-review");
    expect(store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: task.priority }),
    ]);
    const handoff = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:handoff", limit: 10 })[0];
    expect(handoff?.metadata).toMatchObject({
      taskId: task.id,
      reason: "workflow-graph-review",
      alreadyEnqueued: false,
    });
  });

  it("emits failed-status handoff auditing when no-fn_task_done retry budget is exhausted", async () => {
    const { task, worktreePath } = await createExecutorTask(3);
    mockedExec.mockImplementation(((cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (!cb) return undefined as any;
      if (cmd.includes("rev-parse --show-toplevel")) return cb(null, `${worktreePath}\n`, "");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return cb(null, `${task.branch}\n`, "");
      if (cmd.includes("rev-list --count")) return cb(null, "1\n", "");
      if (cmd.includes("rev-parse HEAD")) return cb(null, "def456\n", "");
      return cb(null, "", "");
    }) as any);
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

    const executor = new TaskExecutor(store as any, rootDir);
    await executor.execute(task as any);

    const latest = await store.getTask(task.id);
    expect(latest?.column).toBe("in-review");
    expect(latest?.status).toBe("failed");
    expect(String(latest?.error ?? "")).toContain("without calling fn_task_done");
    expect(store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: task.priority }),
    ]);
    const handoff = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:handoff", limit: 10 })[0];
    expect(handoff?.metadata).toMatchObject({
      taskId: task.id,
      reason: "max-task-done-retries-exhausted",
      alreadyEnqueued: false,
    });
  });
});
