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

  it("FN-350 allows Review Level 1 coordination completion with zero commits when no source files are scoped", async () => {
    const fn350Prompt = `# Task: FN-350 - Route Ready Swift Tasks to Executor Owner

**Created:** 2026-06-12
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a coordination/routing task that should not change product source, but it can affect execution ordering and owner assignment for active Swift implementation work. Risk is low if the executor follows the existing coordinator handoff policy, routes at most one existing ready task, and records clear evidence instead of creating duplicate implementation work.

## Mission

Route exactly one existing ready Swift implementation task to the durable executor owner, or record the intentional block if no safe candidate exists. Do not change product source.

## File Scope

Atlas Notes task-board artifacts only:

- FN-350 task document \`docs\` via \`fn_task_document_write\`
- Board task metadata and logs via Fusion task tools

## Steps

### Step 0: Preflight
- [x] Required board records exist.

### Step 1: Re-check live candidate readiness
- [x] Candidate readiness inspected.

### Step 2: Select exactly one routing action
- [x] One routing action selected.

### Step 3: Perform safe routing or record intentional block
- [x] Routing evidence recorded.

### Step 4: Testing & Verification
- [x] Board-only verification recorded.

### Step 5: Documentation & Delivery
- [x] Final documentation saved.

## Do NOT

- Do not edit product source.
- Do not create duplicate implementation tasks.
`;
    const { store, tool } = await setup({
      id: "FN-350",
      title: "Route Ready Swift Tasks to Executor Owner",
      description: "Coordination/routing task with task-document evidence only.",
      prompt: fn350Prompt,
      branch: "fusion/fn-350",
      noCommitsExpected: undefined,
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Re-check live candidate readiness", status: "done" as const },
        { name: "Select exactly one routing action", status: "done" as const },
        { name: "Perform safe routing or record intentional block", status: "done" as const },
        { name: "Testing & Verification", status: "done" as const },
        { name: "Documentation & Delivery", status: "in-progress" as const },
      ],
      currentStep: 5,
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-350\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    store.moveTask.mockClear();
    const result = await tool.execute("id", { summary: "Recorded routing evidence in task documents and logs." });

    expect(result.content[0].text).toContain("Task marked complete");
    expect(result.content[0].text).not.toContain("fn_task_done refused: no_commits");
    expect(store.moveTask.mock.calls).toEqual([["FN-350", "in-progress"]]);
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("FN-350 refuses contradictory implementation plus coordination fallback prompts", async () => {
    const prompt = `# Task: FN-350 - Route Ready Swift Tasks to Executor Owner

## Review Level: 1 (Plan Only)

**Assessment:** This is a coordination/routing task that should not change product source.

## Mission
Implement the source fix if possible, or record the intentional block if no safe candidate exists. Do not change product source.

## File Scope

- FN-350 task document \`docs\` via \`fn_task_document_write\`

## Steps

### Step 1: Decide
- [x] Decision recorded.
`;
    const { store, tool } = await setup({
      id: "FN-350",
      title: "Route Ready Swift Tasks to Executor Owner",
      description: "Coordination/routing task with task-document evidence only.",
      prompt,
      branch: "fusion/fn-350",
      noCommitsExpected: undefined,
      steps: [{ name: "Decide", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-350\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});

    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-350", "todo", { preserveProgress: true });
  });

  it("FN-4114 still refuses source-changing implementation tasks with zero commits and no explicit no-commit contract", async () => {
    const implementationPrompt = `# Task: FN-4114 - Implement source change

**Size:** M

## Review Level: 2 (Plan and Code)

## Mission

Implement a bug fix in the engine.

## File Scope

- packages/engine/src/executor.ts
- packages/engine/src/__tests__/executor-task-done-invariant.test.ts

## Steps

### Step 1: Implement
- [ ] Change source code and tests.
`;
    const { store, tool } = await setup({ prompt: implementationPrompt, noCommitsExpected: undefined });
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
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
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
