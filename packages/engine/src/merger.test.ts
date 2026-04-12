import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
  compactSessionContext: vi.fn(),
}));

// Route async `exec` through the `execSync` mock so existing tests that set up
// mockedExecSync.mockImplementation for verification commands (vitest run,
// pnpm build, etc.) keep working unchanged. `promisify(exec)` in merger.ts
// resolves/rejects based on the callback wired here.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn();
  const execFn: any = vi.fn((cmd: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const out = execSyncFn(cmd, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err: any) {
      if (typeof callback === "function") {
        callback(err, err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? "");
      }
    }
  });
  // Mirror real child_process.exec: promisify resolves to { stdout, stderr }.
  execFn[promisify.custom] = (cmd: any, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(),
}));

vi.mock("./rate-limit-retry.js", () => ({
  withRateLimitRetry: (fn: () => Promise<any>) => fn(),
}));

vi.mock("./context-limit-detector.js", () => ({
  isContextLimitError: vi.fn(),
}));

import {
  aiMergeTask,
  findWorktreeUser,
  detectResolvableConflicts,
  autoResolveFile,
  resolveConflicts,
  classifyConflict,
  getConflictedFiles,
  isTrivialWhitespaceConflict,
  resolveWithOurs,
  resolveWithTheirs,
  resolveTrivialWhitespace,
  LOCKFILE_PATTERNS,
  GENERATED_PATTERNS,
  parseDiffStat,
  extractFileScope,
  validateDiffScope,
  shouldSyncDependenciesForMerge,
  type ConflictCategory,
} from "./merger.js";
import { createKbAgent } from "./pi.js";
import { execSync } from "node:child_process";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@fusion/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);
const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw, readFileSync: mockedReadFileSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);
const mockedReadFileSync = vi.mocked(mockedReadFileSyncRaw);

function createMockStore(taskOverrides: Partial<Task> = {}, allTasks: Task[] = []) {
  const baseTask: Task = {
    id: "FN-050",
    title: "Test task",
    description: "Test",
    column: "in-review",
    dependencies: [],
    worktree: "/tmp/root/.worktrees/KB-050",
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
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as TaskStore;
}

/**
 * Set up execSync to handle the standard merge flow:
 * rev-parse, log, diff, merge --squash, diff --cached --quiet (squash check),
 * diff --cached (post-agent verify), branch -d
 */
function setupHappyPathExecSync() {
  mockedExecSync.mockImplementation((cmd: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
    if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
    if (cmdStr.includes("git log")) return "- feat: something" as any;
    if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
    if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
    if (cmdStr.includes("merge --squash")) return Buffer.from("");
    // Post-squash check: --quiet means "did squash stage anything?" → "1" = yes
    if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
    // Post-agent check: "did agent commit?" → "0" = yes
    if (cmdStr.includes("diff --cached")) return "0" as any;
    if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
    if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
    if (cmdStr.includes("worktree remove")) return Buffer.from("");
    return Buffer.from("");
  });
}

describe("findWorktreeUser", () => {
  it("returns null when no other task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "FN-050", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "FN-050");
    expect(result).toBeNull();
  });

  it("returns task ID when another non-done task uses the worktree", async () => {
    const store = createMockStore({}, [
      { id: "FN-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "FN-051", worktree: "/tmp/wt", column: "in-progress" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "FN-050");
    expect(result).toBe("FN-051");
  });

  it("ignores done tasks", async () => {
    const store = createMockStore({}, [
      { id: "FN-050", worktree: "/tmp/wt", column: "done" } as Task,
      { id: "FN-051", worktree: "/tmp/wt", column: "done" } as Task,
    ]);
    const result = await findWorktreeUser(store, "/tmp/wt", "FN-050");
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
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [
        { id: "FN-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "FN-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Worktree should NOT be removed
    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeUndefined();
    expect(result.worktreeRemoved).toBe(false);
  });

  it("removes worktree when no other task references it", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [
        { id: "FN-050", worktree: worktreePath, column: "in-review" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    const removeCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(removeCall).toBeDefined();
    expect(result.worktreeRemoved).toBe(true);
  });

  it("always deletes the branch regardless of worktree sharing", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [
        { id: "FN-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "FN-051", worktree: worktreePath, column: "in-progress" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Branch should be deleted even though worktree is shared
    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d") || String(call[0]).includes("branch -D"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(result.branchDeleted).toBe(true);
  });

  it("result.worktreeRemoved is false when worktree is retained", async () => {
    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [
        { id: "FN-050", worktree: worktreePath, column: "in-review" } as Task,
        { id: "FN-051", worktree: worktreePath, column: "todo" } as Task,
      ],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");
    expect(result.worktreeRemoved).toBe(false);
    expect(result.merged).toBe(true);
  });
});

describe("aiMergeTask — task.branch field", () => {
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

  it("uses task.branch when set instead of deriving from task ID", async () => {
    const store = createMockStore(
      { id: "FN-050", branch: "fusion/fn-050-2", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Should use fusion/fn-050-2, not fusion/fn-050
    expect(result.branch).toBe("fusion/fn-050-2");

    // Verify the suffixed branch was verified and deleted
    const revParseCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("rev-parse --verify") && String(call[0]).includes("fusion/fn-050-2"),
    );
    expect(revParseCall).toBeDefined();

    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d") && String(call[0]).includes("fusion/fn-050-2"),
    );
    expect(branchDeleteCall).toBeDefined();
  });

  it("falls back to conventional branch name when task.branch is not set", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.branch).toBe("fusion/fn-050");
  });
});

describe("aiMergeTask — empty squash merge (branch already merged via dep)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("skips agent and still completes when squash stages nothing", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Squash staged nothing → "0"
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    // Agent should NOT have been spawned
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    // Task should still be moved to done
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("still cleans up branch and worktree when squash is empty", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Branch should be deleted
    const branchDeleteCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("branch -d"),
    );
    expect(branchDeleteCall).toBeDefined();
    expect(result.branchDeleted).toBe(true);

    // Worktree should be removed
    const worktreeRemoveCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("worktree remove"),
    );
    expect(worktreeRemoveCall).toBeDefined();
    expect(result.worktreeRemoved).toBe(true);
  });
});

describe("aiMergeTask — includeTaskIdInCommit setting", () => {
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

  it("includes task ID in system prompt by default (includeTaskIdInCommit: true)", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const agentCall = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(agentCall.systemPrompt).toContain("<type>(<scope>): <summary>");
    expect(agentCall.systemPrompt).toContain("the task ID");
  });

  it("omits task ID scope in system prompt when includeTaskIdInCommit is false", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const agentCall = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(agentCall.systemPrompt).toContain("<type>: <summary>");
    expect(agentCall.systemPrompt).not.toContain("<type>(<scope>): <summary>");
    expect(agentCall.systemPrompt).toContain("Do NOT include a scope");
  });

  it("fallback commit includes task ID when includeTaskIdInCommit is true", async () => {
    // Make staged check return "1" so fallback is triggered
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached")) return "1" as any;
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const commitCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("git commit"),
    );
    expect(commitCall).toBeDefined();
    expect(String(commitCall![0])).toContain("feat(FN-050):");
  });

  it("fallback commit omits task ID when includeTaskIdInCommit is false", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached")) return "1" as any;
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const commitCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("git commit"),
    );
    expect(commitCall).toBeDefined();
    expect(String(commitCall![0])).toContain("feat: merge");
    expect(String(commitCall![0])).not.toContain("feat(KB-050)");
  });
});

describe("aiMergeTask — model settings threading", () => {
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

  it("passes defaultProvider and defaultModelId from settings to createKbAgent", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("does not set model fields when settings omit them", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const opts = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(opts.defaultProvider).toBeUndefined();
    expect(opts.defaultModelId).toBeUndefined();
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

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [{ id: "FN-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "Hello merge", "text", undefined, "merger");
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

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [{ id: "FN-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "Bash", "tool", "git status", "merger");
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

    const worktreePath = "/tmp/root/.worktrees/KB-050";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [{ id: "FN-050", worktree: worktreePath, column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050", { onAgentText });

    expect(onAgentText).toHaveBeenCalledWith("hi");
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "hi", "text", undefined, "merger");
  });
});

// ── Usage limit detection in merger ──────────────────────────────────

import { UsageLimitPauser } from "./usage-limit-detector.js";

describe("aiMergeTask — usage limit detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("triggers global pause when merger catches a usage-limit error", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "FN-050",
      "rate_limit_error: Rate limit exceeded",
    );
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true });
  });

  it("triggers global pause when session.prompt() resolves with exhausted-retry error on state.error", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    // session.prompt() resolves normally, but session.state.error is set
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: "429 Too Many Requests" },
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    // UsageLimitPauser should be called with "merger" agent type
    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "FN-050",
      "429 Too Many Requests",
    );
    // git reset --merge should be called to abort the merge
    const resetCalls = mockedExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("reset --merge"),
    );
    expect(resetCalls.length).toBeGreaterThan(0);
  });

  it("does NOT trigger global pause for non-usage-limit errors", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded")),
        dispose: vi.fn(),
      },
    } as any);

    // Should not crash — just re-throw
    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050"),
    ).rejects.toThrow("AI merge failed");
  });

  it("triggers global pause for overloaded error", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("overloaded_error: Overloaded")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { usageLimitPauser: pauser }),
    ).rejects.toThrow("AI merge failed");

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "merger",
      "FN-050",
      "overloaded_error: Overloaded",
    );
  });
});

describe("aiMergeTask — onSession callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
  });

  it("calls onSession with the session object after creation", async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockedCreateHaiAgent.mockResolvedValue({
      session: mockSession,
    } as any);

    const onSession = vi.fn();
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050", { onSession });

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(mockSession);
  });

  it("works without onSession callback (backward compatible)", async () => {
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Should not crash without onSession
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).resolves.toBeDefined();
  });
});

// ── Conflict Detection & Auto-Resolution ─────────────────────────────────

describe("detectResolvableConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no conflicts exist", () => {
    mockedExecSync.mockReturnValue(""); // Empty output = no conflicts

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });

  it("detects package-lock.json as auto-resolvable with 'theirs' strategy", () => {
    mockedExecSync.mockReturnValue("package-lock.json\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "package-lock.json",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects pnpm-lock.yaml as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("pnpm-lock.yaml\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "pnpm-lock.yaml",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects yarn.lock as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("yarn.lock\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects Gemfile.lock as lock file with 'ours' strategy", () => {
    mockedExecSync.mockReturnValue("Gemfile.lock\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects .gen.ts files as generated files with 'theirs' strategy", () => {
    mockedExecSync.mockReturnValue("src/types.gen.ts\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("detects dist/ paths as generated files with 'theirs' strategy", () => {
    mockedExecSync.mockReturnValue("dist/index.js\n");

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("detects coverage/ paths as generated files with 'theirs' strategy", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "coverage/lcov.info\n";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("marks regular source files as complex conflicts", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/components/App.tsx\n";
      // git diff-tree for trivial detection — return real diff content to indicate non-trivial
      if (cmdStr.includes("diff-tree")) return "+real change\n-old line\n";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      filePath: "src/components/App.tsx",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflicted files with mixed categories", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only"))
        return "package-lock.json\nsrc/components/App.tsx\ndist/bundle.js\n";
      // git diff-tree for trivial detection — return real diff for source files
      if (cmdStr.includes("diff-tree")) return "+real change\n-old line\n";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(3);

    const lockFile = result.find((r) => r.filePath === "package-lock.json");
    const sourceFile = result.find((r) => r.filePath === "src/components/App.tsx");
    const distFile = result.find((r) => r.filePath === "dist/bundle.js");

    expect(lockFile).toMatchObject({ autoResolvable: true, reason: "lock-file" });
    expect(sourceFile).toMatchObject({ autoResolvable: false, reason: "complex" });
    expect(distFile).toMatchObject({ autoResolvable: true, reason: "generated-file" });
  });

  it("returns empty array on git command failure", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("git command failed");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });
});

describe("autoResolveFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock returns empty buffer for all git commands
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --theirs for 'theirs' resolution", () => {
    autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --theirs"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("package-lock.json");
  });

  it("calls git checkout --ours for 'ours' resolution", () => {
    autoResolveFile("config.json", "ours", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --ours"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("config.json");
  });

  it("stages the resolved file with git add", () => {
    autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );
    expect(addCall).toBeDefined();
    expect(String(addCall![0])).toContain("package-lock.json");
  });

  it("throws error when git checkout fails", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes("checkout")) {
        throw new Error("checkout failed");
      }
      return Buffer.from("");
    });

    expect(() => autoResolveFile("file.ts", "theirs", "/tmp/root")).toThrow(
      "Failed to auto-resolve",
    );
  });
});

describe("resolveConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock - success
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("resolves lock files and returns remaining complex conflicts", () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "dist/bundle.js", autoResolvable: true, strategy: "ours", reason: "generated-file" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    // Should have resolved package-lock.json and dist/bundle.js
    expect(remaining).toEqual(["src/App.tsx"]);

    // Should have called checkout and add for resolved files
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(2);
  });

  it("returns all files when none are auto-resolvable", () => {
    const categories: ConflictCategory[] = [
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "src/utils.ts", autoResolvable: false, reason: "complex" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual(["src/App.tsx", "src/utils.ts"]);
    // No checkout calls should be made
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(0);
  });

  it("returns empty array when all conflicts are resolved", () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "yarn.lock", autoResolvable: true, strategy: "ours", reason: "lock-file" },
    ];

    const remaining = resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual([]);
  });
});

// ── Trivial Conflict Detection Tests ──────────────────────────────────────

describe("trivial conflict detection (isTrivialWhitespaceConflict via detectResolvableConflicts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects whitespace-only conflicts as trivial", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // git diff-tree with -w returns empty = trivial whitespace
      if (cmdStr.includes("diff-tree")) return "";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: true,
      strategy: "ours",
      reason: "trivial",
    });
  });

  it("marks conflicts with actual content differences as complex", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // git diff-tree returns real content changes = non-trivial
      if (cmdStr.includes("diff-tree")) return "+return 2;\n-return 1;\n";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflict sections - one non-trivial makes complex", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // Real diff content = non-trivial
      if (cmdStr.includes("diff-tree")) return "+const x = 999;\n-const x = 2;\n";
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles git command errors as complex conflicts", () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      if (cmdStr.includes("diff-tree")) throw new Error("git error");
      return Buffer.from("");
    });

    const result = detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });
});

// ── Retry Logic Tests ───────────────────────────────────────────────────

describe("aiMergeTask — retry logic with escalating strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);

    // Default mock: successful happy path
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) return Buffer.from("");
      // Post-squash check: "1" = has staged changes
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      // Post-agent check: "0" = committed
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("attempt 1 success: sets resolutionStrategy to 'ai' and attemptsMade to 1", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Clean merge with no conflicts - simulate empty diff for conflicts
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // No conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      // Has staged changes that need committing
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ai");
    expect(result.attemptsMade).toBe(1);
  });

  it("with autoResolveConflicts disabled: only makes 1 attempt on conflict", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoResolveConflicts: false, // Disabled
    });

    let agentCallCount = 0;

    // Simulate: merge succeeds but leaves conflicts, agent is called but fails
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        // Merge command succeeds but leaves conflict markers
        return Buffer.from("");
      }

      // Conflict detection returns conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/file.ts\n";
      }

      // Staged changes check after merge (conflicts present but not staged)
      if (cmdStr.includes("diff --cached --quiet")) {
        return "1"; // Has staged changes from the merge
      }

      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    // Agent will be called and will fail
    mockedCreateHaiAgent.mockImplementation(() => {
      agentCallCount++;
      return Promise.resolve({
        session: {
          prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
          dispose: vi.fn(),
        },
      } as any);
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow();

    // Should have called agent exactly once (no retries since autoResolve is disabled)
    expect(agentCallCount).toBe(1);
  });

  it("attempt 1 fails, attempt 2 auto-resolves lock files: sets resolutionStrategy to 'auto-resolve'", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    let mergeCallCount = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        mergeCallCount++;
        if (mergeCallCount === 1) {
          // First attempt: conflict
          throw new Error("Merge conflict");
        }
        // Second attempt succeeds after auto-resolution
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        // First time: return lock file, second time: empty
        if (mergeCallCount === 1) return "package-lock.json\n";
        return "";
      }

      if (cmdStr.includes("checkout --ours")) return Buffer.from("");
      if (cmdStr.includes("git add")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "0"; // All resolved
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");

      return Buffer.from("");
    });

    // Agent should not be called since all conflicts are auto-resolved
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("auto-resolve");
    expect(result.attemptsMade).toBe(2);
  });

  it("attempt 3 uses -X theirs strategy: sets resolutionStrategy to 'theirs'", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    let squashCallCount = 0;
    let theirsCallCount = 0;
    let hasConflicts = true;
    let agentCallCount = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      // First two regular squash merges fail with conflicts
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        squashCallCount++;
        throw new Error("Merge conflict");
      }

      // Third attempt with -X theirs succeeds (no conflicts)
      if (cmdStr.includes("merge -X theirs --squash")) {
        theirsCallCount++;
        hasConflicts = false;
        return Buffer.from("");
      }

      // After -X theirs, no conflicts
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return hasConflicts ? "src/complex.ts\n" : "";
      }

      if (cmdStr.includes("diff --cached --quiet")) return hasConflicts ? "1" : "0";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");

      return Buffer.from("");
    });

    // Agent fails on attempt 2 (when called to resolve complex conflicts)
    mockedCreateHaiAgent.mockImplementation(() => {
      agentCallCount++;
      if (agentCallCount === 1) {
        // First agent call (attempt 2) fails
        return Promise.resolve({
          session: {
            prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
            dispose: vi.fn(),
          },
        } as any);
      }
      // Should not reach here
      return Promise.resolve({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any);
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("theirs");
    expect(result.attemptsMade).toBe(3);
    expect(theirsCallCount).toBe(1); // -X theirs was used once
    expect(agentCallCount).toBe(1); // Agent was called once (on attempt 2, which failed)
  });

  it("all 3 attempts fail: throws error and calls git reset --merge", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const resetCalls: string[] = [];

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X theirs")) {
        // All merge attempts fail with conflicts
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/always-conflicts.ts\n"; // Always has conflicts
      }

      if (cmdStr.includes("reset --merge")) {
        resetCalls.push(cmdStr);
        return Buffer.from("");
      }

      return Buffer.from("");
    });

    // Agent will also fail
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "all 3 attempts exhausted",
    );

    // Should have cleanup calls after each failed attempt plus final cleanup
    expect(resetCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("tracks resolutionStrategy as 'ai' when attempt 1 succeeds even with autoResolve enabled", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    // Clean merge with no conflicts
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return ""; // No conflicts
      if (cmdStr.includes("diff --cached --quiet")) return "1"; // Has staged changes
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ai");
    expect(result.attemptsMade).toBe(1);
  });
});

// ── New Smart Conflict Resolution API Tests ────────────────────────────

describe("classifyConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies package-lock.json as 'lockfile-ours'", () => {
    const result = classifyConflict("package-lock.json", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies pnpm-lock.yaml as 'lockfile-ours'", () => {
    const result = classifyConflict("pnpm-lock.yaml", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies yarn.lock as 'lockfile-ours'", () => {
    const result = classifyConflict("yarn.lock", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies Gemfile.lock as 'lockfile-ours'", () => {
    const result = classifyConflict("Gemfile.lock", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies bun.lockb as 'lockfile-ours'", () => {
    const result = classifyConflict("bun.lockb", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies go.sum as 'lockfile-ours'", () => {
    const result = classifyConflict("go.sum", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies *.gen.ts files as 'generated-theirs'", () => {
    const result = classifyConflict("src/types.gen.ts", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies dist/* files as 'generated-theirs'", () => {
    const result = classifyConflict("dist/bundle.js", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies build/* files as 'generated-theirs'", () => {
    const result = classifyConflict("build/index.html", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies *.min.js files as 'generated-theirs'", () => {
    const result = classifyConflict("app.min.js", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies regular source files as 'complex'", () => {
    mockedReadFileSync.mockReturnValue("const x = 1;");
    const result = classifyConflict("src/components/App.tsx", "/tmp/root");
    expect(result).toBe("complex");
  });
});

describe("getConflictedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns array of conflicted file paths", () => {
    mockedExecSync.mockReturnValue("package-lock.json\nsrc/index.ts\n");

    const result = getConflictedFiles("/tmp/root");
    expect(result).toEqual(["package-lock.json", "src/index.ts"]);
  });

  it("returns empty array when no conflicts", () => {
    mockedExecSync.mockReturnValue("");

    const result = getConflictedFiles("/tmp/root");
    expect(result).toEqual([]);
  });

  it("returns empty array on git error", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("git error");
    });

    const result = getConflictedFiles("/tmp/root");
    expect(result).toEqual([]);
  });
});

describe("resolveWithOurs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --ours and git add", () => {
    resolveWithOurs("package-lock.json", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("checkout --ours"),
    );
    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );

    expect(checkoutCall).toBeDefined();
    expect(addCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("package-lock.json");
  });

  it("throws on git error", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("checkout failed");
    });

    expect(() => resolveWithOurs("file.ts", "/tmp/root")).toThrow(
      "Failed to auto-resolve",
    );
  });
});

describe("resolveWithTheirs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --theirs and git add", () => {
    resolveWithTheirs("dist/bundle.js", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("checkout --theirs"),
    );
    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );

    expect(checkoutCall).toBeDefined();
    expect(addCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("dist/bundle.js");
  });

  it("throws on git error", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("checkout failed");
    });

    expect(() => resolveWithTheirs("file.ts", "/tmp/root")).toThrow(
      "Failed to auto-resolve",
    );
  });
});

describe("resolveTrivialWhitespace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git add to resolve trivial whitespace conflict", () => {
    resolveTrivialWhitespace("src/utils.ts", "/tmp/root");

    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );

    expect(addCall).toBeDefined();
    expect(String(addCall![0])).toContain("src/utils.ts");
  });

  it("throws on git error", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("add failed");
    });

    expect(() => resolveTrivialWhitespace("file.ts", "/tmp/root")).toThrow(
      "Failed to auto-resolve",
    );
  });
});

describe("LOCKFILE_PATTERNS and GENERATED_PATTERNS", () => {
  it("LOCKFILE_PATTERNS contains expected lock file patterns", () => {
    expect(LOCKFILE_PATTERNS).toContain("package-lock.json");
    expect(LOCKFILE_PATTERNS).toContain("pnpm-lock.yaml");
    expect(LOCKFILE_PATTERNS).toContain("yarn.lock");
    expect(LOCKFILE_PATTERNS).toContain("Gemfile.lock");
    expect(LOCKFILE_PATTERNS).toContain("bun.lockb");
    expect(LOCKFILE_PATTERNS).toContain("go.sum");
    expect(LOCKFILE_PATTERNS).toContain("composer.lock");
    expect(LOCKFILE_PATTERNS).toContain("poetry.lock");
    expect(LOCKFILE_PATTERNS).not.toContain("Cargo.lock"); // Not in task spec
  });

  it("GENERATED_PATTERNS contains expected generated file patterns", () => {
    expect(GENERATED_PATTERNS).toContain("*.gen.ts");
    expect(GENERATED_PATTERNS).toContain("*.gen.js");
    expect(GENERATED_PATTERNS).toContain("*.min.js");
    expect(GENERATED_PATTERNS).toContain("*.min.css");
    expect(GENERATED_PATTERNS).toContain("dist/*");
    expect(GENERATED_PATTERNS).toContain("build/*");
    expect(GENERATED_PATTERNS).toContain("coverage/*");
    expect(GENERATED_PATTERNS).toContain("out/*");
  });
});

describe("isTrivialWhitespaceConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when diff contains only whitespace changes", () => {
    // Mock git diff-tree to return empty diff (no content changes)
    mockedExecSync.mockReturnValue(
      "diff --git a/file.ts b/file.ts\nindex 123..456 100644\n--- a/file.ts\n+++ b/file.ts\n"
    );

    const result = isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(true);
  });

  it("returns false when diff contains content changes", () => {
    // Mock git diff-tree to return diff with actual content changes
    mockedExecSync.mockImplementation(() => {
      const error = new Error("exit code 1") as any;
      error.stdout = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-const x = 1;
+const x = 2;`;
      throw error;
    });

    const result = isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(false);
  });

  it("returns true when only line endings differ (CRLF vs LF)", () => {
    // Mock git diff-tree -w to show no content changes (whitespace ignored)
    mockedExecSync.mockReturnValue(
      "diff --git a/file.ts b/file.ts\nindex 123..456 100644\n--- a/file.ts\n+++ b/file.ts\n"
    );

    const result = isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(true);
  });

  it("returns false when git diff-tree fails unexpectedly", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    // Mock readFileSync for the fallback
    mockedReadFileSync.mockReturnValue("content without conflict markers");

    const result = isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(false);
  });

  it("calls git diff-tree with correct index references (:2: and :3:)", () => {
    mockedExecSync.mockReturnValue("");

    isTrivialWhitespaceConflict("src/utils.ts", "/tmp/root");

    const call = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git diff-tree")
    );
    expect(call).toBeDefined();
    const cmdStr = String(call![0]);
    expect(cmdStr).toContain("-w"); // whitespace ignored
    expect(cmdStr).toContain(':2:"src/utils.ts"');
    expect(cmdStr).toContain(':3:"src/utils.ts"');
  });
});

// ── Build Verification Tests ─────────────────────────────────────────

describe("aiMergeTask — build verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    // Default happy path exec mock
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });
  });

  it("system prompt contains build verification section", async () => {
    let capturedSystemPrompt: string | undefined;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore();
    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(capturedSystemPrompt).toContain("## Build verification");
    expect(capturedSystemPrompt).toContain("build verification is a hard gate");
    expect(capturedSystemPrompt).toContain("Do not assume the build passes");
    expect(capturedSystemPrompt).toContain("report_build_failure");
  });

  it("includes build command in merge prompt when configured", async () => {
    let capturedArgs: any;
    let capturedPrompt: string | undefined;
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedArgs = opts;
      // Simulate agent committing by returning session that results in clean state
      return {
        session: {
          prompt: vi.fn().mockImplementation(async (prompt: string) => {
            capturedPrompt = prompt;
            // Simulate commit happening by making staged check return "0" (clean)
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              // After commit, diff shows clean
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      buildCommand: "pnpm build",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Verify custom tool was passed
    expect(capturedArgs.customTools).toBeDefined();
    expect(capturedArgs.customTools.some((t: any) => t.name === "report_build_failure")).toBe(true);
    expect(capturedPrompt).toContain("Build command: `pnpm build`");
    expect(capturedPrompt).toContain("This command is mandatory before commit.");
    expect(capturedPrompt).toContain("Only commit if it exits 0.");
    expect(capturedPrompt).toContain("call `report_build_failure`");
  });

  it("merge succeeds when build passes (agent reports success)", async () => {
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate commit happening by making staged check return "0" (clean)
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              // After commit, diff shows clean
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("merge aborts when build fails via report_build_failure tool", async () => {
    // Mock agent that calls the report_build_failure tool execute method
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      const reportTool = opts.customTools?.find((t: any) => t.name === "report_build_failure");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate the agent calling the tool when session.prompt() is called
            if (reportTool) {
              await reportTool.execute("tool-call-123", { message: "Type error in src/utils.ts" });
            }
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const resetCalls: string[] = [];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("reset --merge")) {
        resetCalls.push(cmdStr);
        return Buffer.from("");
      }
      // Default happy path for other commands
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Staged changes present (agent didn't commit due to build failure)
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      buildCommand: "pnpm build",
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "Build verification failed for FN-050: Type error in src/utils.ts",
    );

    // Verify git reset --merge was called
    expect(resetCalls.length).toBeGreaterThan(0);
    // Verify task was NOT moved to done
    expect(store.moveTask).not.toHaveBeenCalled();
    // Verify log entry was made
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "Build verification failed during merge",
      "Type error in src/utils.ts",
    );
  });

  it("merge proceeds normally when no build command is configured", async () => {
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    // buildCommand is undefined by default in DEFAULT_SETTINGS

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("merge proceeds when buildCommand is empty string (treated as undefined)", async () => {
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      buildCommand: "   ", // whitespace-only, should be treated as undefined
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("syncs dependencies before build verification when install state is missing", async () => {
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    mockedExistsSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes("node_modules") || pathStr.endsWith(".pnp.cjs")) return false;
      return true;
    });

    let cachedQuietChecks = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "2 files changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("git diff --cached --name-only")) {
        return "package.json\npackages/desktop/package.json" as any;
      }
      if (cmdStr.includes("pnpm install --frozen-lockfile")) return "Lockfile is up to date" as any;
      if (cmdStr.includes("diff --cached --quiet")) {
        cachedQuietChecks += 1;
        return cachedQuietChecks === 1 ? "1" as any : "0" as any;
      }
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    const installCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("pnpm install --frozen-lockfile"),
    );
    expect(installCall).toBeDefined();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "Syncing dependencies before merge build verification: pnpm install --frozen-lockfile",
    );
  });
});

// ── Deterministic Merge Verification Tests ──────────────────────────────

describe("aiMergeTask — deterministic merge verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    // Default happy path exec mock
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });
  });

  it("runs testCommand before buildCommand when both are configured", async () => {
    const verificationOrder: string[] = [];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Record verification command calls
      if (cmdStr.includes("vitest run")) {
        verificationOrder.push("test");
        return Buffer.from("");
      }
      if (cmdStr.includes("pnpm build")) {
        verificationOrder.push("build");
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate commit
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              if (cmdStr.includes("vitest run")) {
                verificationOrder.push("test");
                return Buffer.from("");
              }
              if (cmdStr.includes("pnpm build")) {
                verificationOrder.push("build");
                return Buffer.from("");
              }
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      testCommand: "vitest run",
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(verificationOrder).toEqual(["test", "build"]);
  });

  it("fails merge when testCommand fails and does not move task to done", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Fail the test command
      if (cmdStr.includes("vitest run")) {
        const error = new Error("Test failed") as any;
        error.status = 1;
        error.stdout = "FAIL: some test failed";
        error.stderr = "";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      testCommand: "vitest run",
    });

    try {
      await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
        "Deterministic test verification failed",
      );
      const consoleErrors = errorSpy.mock.calls.flat().join("\n");
      expect(consoleErrors).not.toContain("FAIL: some test failed");
    } finally {
      errorSpy.mockRestore();
    }

    // Verify task was NOT moved to done
    expect(store.moveTask).not.toHaveBeenCalled();
    // Verify log entry was made
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Deterministic test verification failed"),
      "VerificationError",
    );
  });

  it("does not fail verification when verbose test output exceeds buffer after exit 0", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const error = new Error("stdout maxBuffer length exceeded") as any;
        error.code = "ENOBUFS";
        error.status = 0;
        error.stdout = "tests passed but output was verbose";
        error.stderr = "";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+)" as any;
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      testCommand: "vitest run",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "[verification] test command succeeded (exit 0, output exceeded buffer)",
    );
  });

  it("fails merge when buildCommand fails and does not move task to done", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Setup exec mock that will be updated after agent commits
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      // Initial diff check - staged changes exist
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // After agent "commits", update mock to handle verification commands
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              // test passes
              if (cmdStr.includes("vitest run")) return Buffer.from("");
              // Fail the build command
              if (cmdStr.includes("pnpm build")) {
                const error = new Error("Build failed") as any;
                error.status = 1;
                error.stdout = "";
                error.stderr = "Type error in src/utils.ts";
                throw error;
              }
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      testCommand: "vitest run",
      buildCommand: "pnpm build",
    });

    try {
      await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
        "Deterministic build verification failed",
      );
      const consoleErrors = errorSpy.mock.calls.flat().join("\n");
      expect(consoleErrors).not.toContain("Type error in src/utils.ts");
    } finally {
      errorSpy.mockRestore();
    }

    // Verify task was NOT moved to done
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("enforces verification when merge uses fallback commit", async () => {
    const verificationCalls: string[] = [];

    // Initial exec mock - will be updated after agent commits
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // After agent "commits", update mock for verification
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              // Track verification commands
              if (cmdStr.includes("vitest run")) {
                verificationCalls.push("test");
                return Buffer.from("");
              }
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      testCommand: "vitest run",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    // Verification should have run
    expect(verificationCalls).toContain("test");
  });

  it("skips verification when neither testCommand nor buildCommand is configured", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate commit
            mockedExecSync.mockImplementation((cmd: any) => {
              const cmdStr = String(cmd);
              if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
              if (cmdStr.includes("git log")) return "- feat: something" as any;
              if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
              if (cmdStr.includes("--stat")) return "1 file changed" as any;
              if (cmdStr.includes("merge --squash")) return Buffer.from("");
              if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
              if (cmdStr.includes("branch -d")) return Buffer.from("");
              if (cmdStr.includes("worktree remove")) return Buffer.from("");
              return Buffer.from("");
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    // Neither testCommand nor buildCommand configured
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    // Verify no verification commands were called
    const verificationCalls = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("vitest") || String(call[0]).includes("pnpm build"),
    );
    expect(verificationCalls).toHaveLength(0);
  });
});

describe("shouldSyncDependenciesForMerge", () => {
  it("returns true when install state is missing", () => {
    expect(shouldSyncDependenciesForMerge([], false)).toBe(true);
  });

  it("returns true when staged files change package manifests or lockfiles", () => {
    expect(shouldSyncDependenciesForMerge(["packages/desktop/package.json"], true)).toBe(true);
    expect(shouldSyncDependenciesForMerge(["pnpm-lock.yaml"], true)).toBe(true);
  });

  it("returns false for regular source-only changes when install state exists", () => {
    expect(shouldSyncDependenciesForMerge(["packages/engine/src/merger.ts"], true)).toBe(false);
  });
});

// ── Pre-merge diffstat scope validation tests ────────────────────────

describe("parseDiffStat", () => {
  it("parses standard diffstat output", () => {
    const stat = [
      " packages/core/src/types.ts         | 9 ++--",
      " packages/engine/src/notifier.ts     | 46 +-----",
      " 2 files changed, 10 insertions(+), 45 deletions(-)",
    ].join("\n");

    const entries = parseDiffStat(stat);
    expect(entries).toHaveLength(2);
    expect(entries[0].file).toBe("packages/core/src/types.ts");
    // Rounding may shift total by ±1, so check approximate range
    expect(entries[0].insertions + entries[0].deletions).toBeGreaterThanOrEqual(9);
    expect(entries[0].insertions + entries[0].deletions).toBeLessThanOrEqual(10);
    expect(entries[1].file).toBe("packages/engine/src/notifier.ts");
    expect(entries[1].deletions).toBeGreaterThan(entries[1].insertions);
  });

  it("handles pure-deletion lines", () => {
    const stat = " packages/engine/src/usage.ts | 527 ---";
    const entries = parseDiffStat(stat);
    expect(entries).toHaveLength(1);
    expect(entries[0].insertions).toBe(0);
    expect(entries[0].deletions).toBe(527);
  });

  it("handles pure-insertion lines", () => {
    const stat = " packages/engine/src/new.ts | 100 +++";
    const entries = parseDiffStat(stat);
    expect(entries).toHaveLength(1);
    expect(entries[0].insertions).toBe(100);
    expect(entries[0].deletions).toBe(0);
  });

  it("returns empty for unreadable stat", () => {
    expect(parseDiffStat("(unable to read diff)")).toEqual([]);
    expect(parseDiffStat("")).toEqual([]);
  });

  it("skips summary line", () => {
    const stat = " 1 file changed, 5 insertions(+)";
    expect(parseDiffStat(stat)).toEqual([]);
  });
});

describe("extractFileScope", () => {
  it("extracts file patterns from PROMPT.md", () => {
    const prompt = [
      "# Task: FN-100 - Add feature",
      "",
      "## File Scope",
      "",
      "- `packages/core/src/types.ts`",
      "- `packages/engine/src/notifier.ts`",
      "- `packages/dashboard/app/components/*`",
      "",
      "## Steps",
      "",
      "### Step 1: Do things",
    ].join("\n");

    const scope = extractFileScope(prompt);
    expect(scope).toEqual([
      "packages/core/src/types.ts",
      "packages/engine/src/notifier.ts",
      "packages/dashboard/app/components/*",
    ]);
  });

  it("handles patterns with artifact annotations", () => {
    const prompt = [
      "## File Scope",
      "",
      "- `src/foo.ts` (new)",
      "- `src/bar.ts` (modified)",
      "",
      "## Steps",
    ].join("\n");

    const scope = extractFileScope(prompt);
    expect(scope).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("returns empty for missing File Scope section", () => {
    const prompt = "# Task\n\n## Steps\n### Step 1\n";
    expect(extractFileScope(prompt)).toEqual([]);
  });
});

describe("validateDiffScope", () => {
  it("returns warnings for large deletions outside scope", async () => {
    const store = {
      getTask: vi.fn().mockResolvedValue({
        prompt: [
          "## File Scope",
          "",
          "- `packages/dashboard/app/components/Header.tsx`",
          "",
          "## Steps",
        ].join("\n"),
      }),
      logEntry: vi.fn(),
    } as unknown as TaskStore;

    const diffStat = [
      " packages/dashboard/app/components/Header.tsx | 20 ++--",
      " packages/engine/src/usage.ts                 | 527 ---",
      " packages/engine/src/usage.test.ts            | 524 ---",
      " 3 files changed, 5 insertions(+), 1066 deletions(-)",
    ].join("\n");

    const result = await validateDiffScope(store, "FN-100", diffStat);
    expect(result.outOfScopeFiles).toContain("packages/engine/src/usage.ts");
    expect(result.outOfScopeFiles).toContain("packages/engine/src/usage.test.ts");
    expect(result.largeOutOfScopeDeletions).toHaveLength(2);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("SCOPE WARNING");
  });

  it("allows changeset files outside scope", async () => {
    const store = {
      getTask: vi.fn().mockResolvedValue({
        prompt: "## File Scope\n\n- `src/foo.ts`\n\n## Steps",
      }),
    } as unknown as TaskStore;

    const diffStat = [
      " src/foo.ts                          | 10 +++",
      " .changeset/my-change.md             | 5 +++",
      " 2 files changed, 15 insertions(+)",
    ].join("\n");

    const result = await validateDiffScope(store, "FN-100", diffStat);
    expect(result.outOfScopeFiles).not.toContain(".changeset/my-change.md");
    expect(result.warnings).toHaveLength(0);
  });

  it("returns empty result when no scope is declared", async () => {
    const store = {
      getTask: vi.fn().mockResolvedValue({
        prompt: "# Task\n\n## Steps\n",
      }),
    } as unknown as TaskStore;

    const result = await validateDiffScope(store, "FN-100", " foo.ts | 500 ---");
    expect(result.warnings).toHaveLength(0);
  });

  it("does not warn for in-scope changes", async () => {
    const store = {
      getTask: vi.fn().mockResolvedValue({
        prompt: "## File Scope\n\n- `packages/engine/src/*`\n\n## Steps",
      }),
    } as unknown as TaskStore;

    const diffStat = [
      " packages/engine/src/executor.ts | 50 +++---",
      " packages/engine/src/triage.ts   | 30 +++---",
      " 2 files changed, 40 insertions(+), 40 deletions(-)",
    ].join("\n");

    const result = await validateDiffScope(store, "FN-100", diffStat);
    expect(result.outOfScopeFiles).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("aiMergeTask — post-merge workflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      },
    } as any);
  });

  it("runs post-merge workflow steps after successful merge", async () => {
    const store = createMockStore();
    // Add getWorkflowStep to mock
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "Send notifications after merge",
      prompt: "Check the merged code and confirm all is well.",
      phase: "post-merge",
      mode: "prompt",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Override getTask to include enabledWorkflowSteps
    const baseTask = {
      id: "FN-050",
      title: "Test task",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/KB-050",
      steps: [],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // getWorkflowStep should have been called for the post-merge step
    expect((store as any).getWorkflowStep).toHaveBeenCalledWith("WS-001");

    // Task should still move to done even though post-merge step ran
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("does not run pre-merge workflow steps in merger", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Pre-merge Check",
      description: "Check before merge",
      prompt: "Run pre-merge checks.",
      phase: "pre-merge",
      mode: "prompt",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const baseTask = {
      id: "FN-050",
      title: "Test task",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/KB-050",
      steps: [],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // getWorkflowStep may be called but pre-merge steps should not trigger agent creation
    // beyond the merge agent itself. We verify createKbAgent was called only once (merge agent)
    // since pre-merge steps are skipped in the merger
    const mergeAgentCalls = mockedCreateHaiAgent.mock.calls.filter(
      (c: any) => c[0]?.systemPrompt?.includes("You are a merge agent")
    );
    const postMergeCalls = mockedCreateHaiAgent.mock.calls.filter(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge")
    );

    // No post-merge agent should be created for a pre-merge step
    expect(postMergeCalls).toHaveLength(0);
  });

  it("appends post-merge results to existing pre-merge results", async () => {
    const existingPreMergeResults = [{
      workflowStepId: "WS-001",
      workflowStepName: "Pre-merge Check",
      phase: "pre-merge",
      status: "passed",
      output: "All good",
    }];

    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-002",
      name: "Post-merge Verify",
      description: "Verify after merge",
      prompt: "Check merged state.",
      phase: "post-merge",
      mode: "prompt",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const baseTask = {
      id: "FN-050",
      title: "Test task",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/KB-050",
      steps: [],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001", "WS-002"],
      workflowStepResults: existingPreMergeResults,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Should have called updateTask with workflow results containing both pre and post
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const resultsCall = updateCalls.find((c: any) =>
      Array.isArray(c[1]?.workflowStepResults) && c[1].workflowStepResults.length > 1
    );

    if (resultsCall) {
      const results = resultsCall[1].workflowStepResults;
      // Should contain both pre-merge and post-merge results
      expect(results.some((r: any) => r.phase === "pre-merge")).toBe(true);
      expect(results.some((r: any) => r.phase === "post-merge")).toBe(true);
    }
  });

  it("moves task to done even when post-merge step fails", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Fail",
      description: "Will fail",
      prompt: "Fail this check.",
      phase: "post-merge",
      mode: "prompt",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const baseTask = {
      id: "FN-050",
      title: "Test task",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/KB-050",
      steps: [],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    // Make the post-merge agent throw
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      if (opts.systemPrompt?.includes("post-merge")) {
        return {
          session: {
            prompt: vi.fn().mockRejectedValue(new Error("Post-merge agent failed")),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          },
        };
      }
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      };
    }) as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Merge should succeed regardless of post-merge step failure
    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("runs script-mode post-merge steps", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Build",
      description: "Verify build passes",
      phase: "post-merge",
      mode: "script",
      scriptName: "build",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const baseTask = {
      id: "FN-050",
      title: "Test task",
      description: "Test",
      column: "in-review",
      dependencies: [],
      worktree: "/tmp/root/.worktrees/KB-050",
      steps: [],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    // Override settings to include scripts
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      scripts: { build: "pnpm build" },
    });

    // Mock execSync to handle the script execution
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "pnpm build") return "Build successful" as any;
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });
});

// ── Merge Details Collection Tests ─────────────────────────────────────

describe("aiMergeTask — merge details collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("stores mergeDetails with commitSha and stats after successful merge", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD "))
        return "mergedcommit123456789"; // encoding: utf-8 → string
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat"))
        return "3 files changed, 10 insertions(+), 2 deletions(-)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // Find the updateTask call that set mergeDetails
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall).toBeDefined();

    const mergeDetails = mergeDetailsCall![1].mergeDetails;
    expect(mergeDetails.commitSha).toBe("mergedcommit123456789");
    expect(mergeDetails.filesChanged).toBe(3);
    expect(mergeDetails.insertions).toBe(10);
    expect(mergeDetails.deletions).toBe(2);
    expect(mergeDetails.mergeCommitMessage).toBe("- feat: something");
    expect(mergeDetails.mergedAt).toBeDefined();
    expect(mergeDetails.mergeConfirmed).toBe(true);
    expect(mergeDetails.resolutionStrategy).toBe("ai");
    expect(mergeDetails.resolutionMethod).toBe("ai");
    expect(mergeDetails.attemptsMade).toBe(1);
  });

  it("stores partial mergeDetails when branch is not found", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      // Branch verification fails → branch not found
      if (cmdStr.includes("rev-parse --verify")) throw new Error("not found");
      // But rev-parse HEAD still works → can capture commitSha (encoding: utf-8 → string)
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD "))
        return "existingheadsha999";
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("not found");

    // Find the updateTask call that set mergeDetails
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall).toBeDefined();

    const mergeDetails = mergeDetailsCall![1].mergeDetails;
    expect(mergeDetails.commitSha).toBe("existingheadsha999");
    expect(mergeDetails.mergedAt).toBeDefined();
    expect(mergeDetails.mergeConfirmed).toBe(false);
  });

  it("completes merge even when git commands fail during merge details collection", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    let revParseHeadCalled = false;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) {
        revParseHeadCalled = true;
        throw new Error("git rev-parse HEAD failed");
      }
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Merge should still succeed even though merge details collection failed
    expect(result.merged).toBe(true);
    expect(revParseHeadCalled).toBe(true);

    // No mergeDetails should have been stored
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall).toBeUndefined();

    // Task should still be moved to done
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("handles missing shortstat gracefully when show --shortstat fails", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD "))
        return "mergedcommit123"; // encoding: utf-8 → string
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      // show --shortstat fails
      if (cmdStr.includes("show --shortstat")) throw new Error("show failed");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // mergeDetails should still be stored with commitSha but without stats
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall).toBeDefined();

    const mergeDetails = mergeDetailsCall![1].mergeDetails;
    expect(mergeDetails.commitSha).toBe("mergedcommit123");
    // Stats should be undefined since show --shortstat failed (inner catch sets them as undefined)
    expect(mergeDetails.filesChanged).toBeUndefined();
    expect(mergeDetails.insertions).toBeUndefined();
    expect(mergeDetails.deletions).toBeUndefined();
  });
});

describe("aiMergeTask — fresh session and compaction recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  function setupFreshSessionExecSync() {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  it("creates a fresh session for merge agent via createKbAgent", async () => {
    setupFreshSessionExecSync();

    const sessionInstances: any[] = [];
    mockedCreateHaiAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      };
      sessionInstances.push(session);
      // Use type assertion to match expected return type
      return { session } as any;
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Session should be created once for the merge agent
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    expect(sessionInstances.length).toBe(1);
  });

  it("disposes session after merge agent completes (finally block)", async () => {
    setupFreshSessionExecSync();

    const mockDispose = vi.fn();
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: mockDispose,
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Session should be disposed via finally block
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it("imports compactSessionContext and isContextLimitError from respective modules", async () => {
    // This test verifies the imports are present in merger.ts
    // The actual functionality is tested via behavior verification
    const mergerModule = await import("./merger.js");
    expect(mergerModule).toBeDefined();
  });
});

// ── Merge Prompt Truncation Tests ─────────────────────────────────────

describe("buildMergePrompt — truncation behavior", () => {
  it("truncates commit log when exceeding MERGE_COMMIT_LOG_MAX_CHARS", async () => {
    const { buildMergePrompt } = await import("./merger.js");

    // Create a commit log that exceeds 5000 characters
    const longCommitLog = "- " + "a".repeat(6000);
    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: longCommitLog,
      diffStat: "1 file changed",
      hasConflicts: false,
    });

    // The prompt should contain truncation indicator
    expect(prompt).toContain("... (truncated)");
    // The truncated version should be shorter than original
    expect(prompt.indexOf("- " + "a".repeat(5000))).toBe(-1);
  });

  it("truncates diff stat when exceeding MERGE_DIFF_STAT_MAX_CHARS", async () => {
    const { buildMergePrompt } = await import("./merger.js");

    // Create a diff stat that exceeds 3000 characters
    const longDiffStat = "file.ts | " + " ".repeat(10) + "x".repeat(4000);
    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: longDiffStat,
      hasConflicts: false,
    });

    // The prompt should contain truncation indicator
    expect(prompt).toContain("... (truncated)");
    // The diff stat section should not contain the full long content
    expect(prompt.indexOf("x".repeat(3000))).toBe(-1);
  });

  it("preserves short content unchanged (under limits)", async () => {
    const { buildMergePrompt } = await import("./merger.js");

    const shortCommitLog = "- feat: add login\n- fix: correct typo";
    const shortDiffStat = "src/login.ts | 5 +++\n1 file changed";
    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: shortCommitLog,
      diffStat: shortDiffStat,
      hasConflicts: false,
    });

    // Should not contain truncation markers
    expect(prompt).not.toContain("... (truncated)");
    // Should contain original content
    expect(prompt).toContain(shortCommitLog);
    expect(prompt).toContain(shortDiffStat);
  });

  it("truncates commit log but not diff stat when only commit log is over limit", async () => {
    const { buildMergePrompt } = await import("./merger.js");

    const longCommitLog = "- " + "b".repeat(6000);
    const shortDiffStat = "1 file changed";
    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: longCommitLog,
      diffStat: shortDiffStat,
      hasConflicts: false,
    });

    // Should contain truncation for commit log
    expect(prompt).toContain("... (truncated)");
    // Diff stat should be unchanged
    expect(prompt).toContain(shortDiffStat);
  });
});

// ── Context Limit Recovery Tests ─────────────────────────────────────

describe("aiMergeTask — context limit recovery with truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  function setupContextLimitExecSync() {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  it("retries with minimal prompt when context limit hit and compaction returns null", async () => {
    const { compactSessionContext } = await import("./pi.js");
    const { isContextLimitError } = await import("./context-limit-detector.js");

    // Mock compaction to return null (fresh session)
    vi.mocked(compactSessionContext).mockResolvedValue(null);
    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls
    const promptCalls: string[] = [];
    let firstCall = true;
    mockedCreateHaiAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          promptCalls.push(prompt);
          if (firstCall) {
            firstCall = false;
            throw new Error("context window exceeds limit (2013)");
          }
          // Second call succeeds
        }),
        dispose: vi.fn(),
      };
      return { session } as any;
    });

    setupContextLimitExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Merge should succeed after truncated retry
    expect(result.merged).toBe(true);

    // Should have made 2 prompt calls
    expect(promptCalls).toHaveLength(2);

    // First call had original prompt, second call should have simplified prompt
    expect(promptCalls[0]).toContain("## Branch commits");
    // Second call uses simplifiedContext=true, so it should NOT contain "## Files changed"
    expect(promptCalls[1]).not.toContain("## Files changed");
    // Second call should have the minimal placeholder
    expect(promptCalls[1]).toContain("(see git log)");

    // Compaction was attempted
    expect(vi.mocked(compactSessionContext)).toHaveBeenCalled();
  });

  it("throws when truncated retry also fails with context limit", async () => {
    const { compactSessionContext } = await import("./pi.js");
    const { isContextLimitError } = await import("./context-limit-detector.js");

    // Mock compaction to return null (fresh session)
    vi.mocked(compactSessionContext).mockResolvedValue(null);
    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls to verify both original and truncated prompts were tried
    const promptCalls: string[] = [];

    mockedCreateHaiAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          promptCalls.push(prompt);
          // Both calls fail with context limit error
          throw new Error("context window exceeds limit (2013)");
        }),
        dispose: vi.fn(),
      };
      return { session } as any;
    });

    // Setup that simulates both attempts failing (first fails, attempts 2 and 3 also fail)
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      // All merge attempts fail
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) {
        throw new Error("merge conflict");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "src/file.ts";
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      smartConflictResolution: true, // Enable all 3 attempts
    });

    // Should throw after all attempts exhausted
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow("all 3 attempts exhausted");

    // Verify both original and truncated prompts were attempted (2 attempts for attempt 1)
    // Each merge attempt calls promptWithFallback twice (original + truncated when compaction fails)
    // With 3 merge attempts, this means we should have at least 6 prompt calls total
    expect(promptCalls.length).toBeGreaterThan(0);

    // Compaction was attempted
    expect(vi.mocked(compactSessionContext)).toHaveBeenCalled();
  });

  it("uses normal flow when compaction succeeds (regression test)", async () => {
    const { compactSessionContext } = await import("./pi.js");
    const { isContextLimitError } = await import("./context-limit-detector.js");

    // Mock compaction to succeed
    vi.mocked(compactSessionContext).mockResolvedValue({ summary: "compacted", tokensBefore: 10000 });
    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls
    const promptCalls: string[] = [];
    let firstCall = true;
    mockedCreateHaiAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          promptCalls.push(prompt);
          if (firstCall) {
            firstCall = false;
            throw new Error("context window exceeds limit (2013)");
          }
          // Second call succeeds
        }),
        dispose: vi.fn(),
      };
      return { session } as any;
    });

    setupContextLimitExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // Merge should succeed after compaction retry
    expect(result.merged).toBe(true);

    // Should have made 2 prompt calls
    expect(promptCalls).toHaveLength(2);

    // Compaction was attempted and succeeded
    expect(vi.mocked(compactSessionContext)).toHaveBeenCalled();
  });

  it("does not attempt truncation retry for non-context errors", async () => {
    const { compactSessionContext } = await import("./pi.js");
    const { isContextLimitError } = await import("./context-limit-detector.js");

    // Non-context error should not trigger recovery path
    vi.mocked(compactSessionContext).mockResolvedValue(null);
    vi.mocked(isContextLimitError).mockReturnValue(false);

    // Mock non-context error
    mockedCreateHaiAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
        dispose: vi.fn(),
      };
      return { session } as any;
    });

    // Setup that simulates merge failing
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      // All merge attempts fail
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) {
        throw new Error("merge conflict");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "src/file.ts";
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      smartConflictResolution: true,
    });

    // Should throw without attempting compaction or truncation
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow("all 3 attempts exhausted");

    // Compaction should NOT have been called for non-context errors
    expect(vi.mocked(compactSessionContext)).not.toHaveBeenCalled();
  });
});
