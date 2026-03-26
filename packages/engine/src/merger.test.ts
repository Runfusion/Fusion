import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("./pi.js", () => ({
  createHaiAgent: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { aiMergeTask, findWorktreeUser } from "./merger.js";
import { createHaiAgent } from "./pi.js";
import { execSync } from "node:child_process";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@hai/core";

const mockedCreateHaiAgent = vi.mocked(createHaiAgent);
const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);

function createMockStore(taskOverrides: Partial<Task> = {}, allTasks: Task[] = []) {
  const baseTask: Task = {
    id: "HAI-050",
    title: "Test task",
    description: "Test",
    column: "in-review",
    dependencies: [],
    worktree: "/tmp/root/.worktrees/HAI-050",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...taskOverrides,
  };

  return {
    getTask: vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" }),
    listTasks: vi.fn().mockResolvedValue(allTasks),
    updateTask: vi.fn().mockResolvedValue(baseTask),
    moveTask: vi.fn().mockResolvedValue(baseTask),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as TaskStore;
}

/**
 * Set up execSync to handle the standard merge flow:
 * rev-parse, log, diff, merge --squash, diff --cached, branch -d
 */
function setupHappyPathExecSync() {
  mockedExecSync.mockImplementation((cmd: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
    if (cmdStr.includes("git log")) return "- feat: something" as any;
    if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
    if (cmdStr.includes("merge --squash")) return Buffer.from("");
    if (cmdStr.includes("diff --cached")) return "0" as any;
    if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
    if (cmdStr.includes("worktree remove")) return Buffer.from("");
    return Buffer.from("");
  });
}

describe("findWorktreeUser", () => {
  it("returns null when no other task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "HAI-050", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "HAI-050");
    expect(result).toBeNull();
  });

  it("returns task ID when another non-done task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "HAI-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "HAI-051", worktree: "/tmp/wt", column: "in-progress" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "HAI-050");
    expect(result).toBe("HAI-051");
  });

  it("ignores done tasks", async () => {
    const store = createMockStore({}, [
      { id: "HAI-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "HAI-051", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "HAI-050");
    expect(result).toBeNull();
  });
});

describe("aiMergeTask — conditional worktree cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("does NOT remove worktree when another task references the same path", async () => {
    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [
        { id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "HAI-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "HAI-050");

    // Worktree should NOT be removed
    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeUndefined();
    expect(result.worktreeRemoved).toBe(false);
  });

  it("removes worktree when no other task references it", async () => {
    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [
        { id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "HAI-050");

    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeDefined();
    expect(result.worktreeRemoved).toBe(true);
  });

  it("always deletes the branch regardless of worktree sharing", async () => {
    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [
        { id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "HAI-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "HAI-050");

    // Branch should be deleted even though worktree is shared
    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d") || String(call[0]).includes("branch -D"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(result.branchDeleted).toBe(true);
  });

  it("result.worktreeRemoved is false when worktree is retained", async () => {
    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [
        { id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "HAI-051", worktree: worktreePath, column: "todo" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "HAI-050");
    expect(result.worktreeRemoved).toBe(false);
    expect(result.merged).toBe(true);
  });
});

describe("aiMergeTask — agent log persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("logs text deltas to store.appendAgentLog", async () => {
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("Hello ");
            capturedOnText?.("merge");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [{ id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "HAI-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-050", "Hello merge", "text");
  });

  it("logs tool invocations to store.appendAgentLog", async () => {
    let capturedOnToolStart: ((name: string, args: any) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnToolStart = opts.onToolStart;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnToolStart?.("Bash", { command: "git status" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [{ id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "HAI-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-050", "Bash", "tool", "git status");
  });

  it("still fires onAgentText callback alongside logging", async () => {
    const onAgentText = vi.fn();
    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            capturedOnText?.("hi");
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const worktreePath = "/tmp/root/.worktrees/HAI-050";
    const store = createMockStore(
      { id: "HAI-050", worktree: worktreePath },
      [{ id: "HAI-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "HAI-050", { onAgentText });

    expect(onAgentText).toHaveBeenCalledWith("hi");
    expect(store.appendAgentLog).toHaveBeenCalledWith("HAI-050", "hi", "text");
  });
});
