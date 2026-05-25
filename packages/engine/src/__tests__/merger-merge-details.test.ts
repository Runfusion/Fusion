import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external dependencies
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
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
  const { EventEmitter } = await import("node:events");
  const execSyncFn = vi.fn();
  const spawnFn = vi.fn((cmd: string, opts?: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    queueMicrotask(() => {
      try {
        const out = execSyncFn(cmd, opts);
        const stdout = out === undefined ? "" : out.toString();
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.exitCode = 0;
        child.emit("close", 0, null);
      } catch (err) {
        const error = err as { stdout?: string; stderr?: string; status?: number; code?: number };
        const stdout = error?.stdout?.toString?.() ?? "";
        const stderr = error?.stderr?.toString?.() ?? "";
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.exitCode = error.status ?? error.code ?? 1;
        child.emit("close", child.exitCode, null);
      }
    });
    return child;
  });
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

  // execFile(file, args, opts, cb) — reassemble a shell-equivalent command and
  // delegate to execSyncFn so the same mock infrastructure handles both exec and execFile.
  const execFileFn: any = vi.fn((file: any, args: any, opts: any, cb: any) => {
    // Normalize overloads: (file, args, cb) or (file, args, opts, cb)
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : opts;
    const cmd = [file, ...(Array.isArray(args) ? args : [])].join(" ");
    try {
      const out = execSyncFn(cmd, { stdio: ["pipe", "pipe", "pipe"], ...options });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err: any) {
      if (typeof callback === "function") {
        callback(err, err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? "");
      }
    }
  });
  execFileFn[promisify.custom] = (file: any, args?: any, opts?: any) =>
    new Promise((resolve, reject) => {
      execFileFn(file, args, opts, (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn, spawn: spawnFn };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(),
}));

vi.mock("../rate-limit-retry.js", () => ({
  withRateLimitRetry: (fn: () => Promise<any>) => fn(),
}));

vi.mock("../context-limit-detector.js", () => ({
  isContextLimitError: vi.fn(),
}));

import {
  aiMergeTask,
  pushToRemoteAfterMerge,
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
  summarizeVerificationOutput,
  inferDefaultTestCommand,
  resolveTaskDiffBaseRef,
  commitOrAmendMergeWithFixes,
  MergeAbortedError,
  type ConflictCategory,
} from "../merger.js";
import { mergerLog } from "../logger.js";
import { __resetIntegrationBranchCacheForTests } from "../integration-branch.js";
import { createFnAgent } from "../pi.js";
import { execSync, exec } from "node:child_process";
import * as core from "@fusion/core";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@fusion/core";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedExecSync = vi.mocked(execSync);
const mockedExec = vi.mocked(exec);
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
    moveTask: vi.fn().mockResolvedValue({ ...baseTask, column: "done" }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    }),
    getActiveMergingTask: vi.fn().mockReturnValue(null),
    emit: vi.fn(),
    on: vi.fn(),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    getVerificationCacheHit: vi.fn().mockReturnValue(null),
    recordVerificationCachePass: vi.fn(),
  } as unknown as TaskStore;
}

/**
 * Set up execSync to handle the standard merge flow:
 * rev-parse, log, diff, merge --squash, diff --cached --quiet (squash check),
 * diff --cached (post-agent verify), branch -d
 *
 * Both `-X ours` and `-X theirs` final-fallback merges return success — the
 * default settings strategy is "smart-prefer-main" (-X ours), but a few tests
 * still exercise -X theirs explicitly via `mergeConflictStrategy: "smart-prefer-branch"`.
 *
 * For tests that want the merge to fail after 3 attempts, call
 * setupFailingFallbackStrategy() instead.
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
    if (cmdStr.includes("merge -X theirs --squash") || cmdStr.includes("merge -X ours --squash")) {
      return Buffer.from("");
    }
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

/**
 * Same as setupHappyPathExecSync but makes the final fallback merge fail
 * (both `-X theirs` and `-X ours`). Use this for tests that expect the merge
 * to throw after 3 attempts fail.
 */
function setupFailingFallbackStrategy() {
  mockedExecSync.mockImplementation((cmd: any) => {
    const cmdStr = String(cmd);
    if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
    if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
    if (cmdStr.includes("git log")) return "- feat: something" as any;
    if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
    if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
    if (cmdStr.includes("merge --squash")) return Buffer.from("");
    // -X theirs / -X ours should fail for these tests (they expect merge to throw)
    if (cmdStr.includes("merge -X theirs --squash") || cmdStr.includes("merge -X ours --squash")) {
      const err = new Error("fatal: git merge -X fallback failed with unresolved conflicts");
      err.name = "ExecSyncError";
      throw err;
    }
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

/** @deprecated Renamed to setupFailingFallbackStrategy. */
const setupFailingTheirsStrategy = setupFailingFallbackStrategy;


describe("aiMergeTask — includeTaskIdInCommit setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
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

    const agentCall = mockedCreateFnAgent.mock.calls[0][0] as any;
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
      mergeIntegrationWorktree: "cwd-main" as const,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const agentCall = mockedCreateFnAgent.mock.calls[0][0] as any;
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
      mergeIntegrationWorktree: "cwd-main" as const,
      includeTaskIdInCommit: false,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const commitCall = mockedExecSync.mock.calls.find(
      (call) => String(call[0]).includes("git commit"),
    );
    expect(commitCall).toBeDefined();
    // Subject must use bare `feat:` prefix (no task-id scope) when
    // includeTaskIdInCommit=false. The summary portion is derived from the
    // step commit log or AI subject, so we don't pin its exact text — just
    // assert the prefix shape.
    expect(String(commitCall![0])).toMatch(/git commit -m "feat: \S/);
    expect(String(commitCall![0])).not.toContain("feat(KB-050)");
    expect(String(commitCall![0])).not.toContain("feat(FN-050)");
  });
});


describe("aiMergeTask — integration branch resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetIntegrationBranchCacheForTests();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("threads settings.baseBranch into merge target branch", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      baseBranch: "trunk",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const commands = mockedExecSync.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((cmd) => cmd.includes("checkout \"trunk\""))).toBe(true);
  });
});

describe("aiMergeTask — model settings threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("passes defaultProvider and defaultModelId from settings to createFnAgent", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0] as any;
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("does not set model fields when settings omit them", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const opts = mockedCreateFnAgent.mock.calls[0][0] as any;
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

import { UsageLimitPauser } from "../usage-limit-detector.js";


describe("aiMergeTask — usage limit detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    // Use setupFailingTheirsStrategy so -X theirs merge fails,
    // allowing tests that expect throws to pass
    setupFailingTheirsStrategy();
  });

  it("triggers global pause when merger catches a usage-limit error", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateFnAgent.mockResolvedValue({
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
    expect(store.updateSettings).toHaveBeenCalledWith({
      globalPause: true,
      globalPauseReason: "rate-limit",
    });
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
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

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

    mockedCreateFnAgent.mockResolvedValue({
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

    mockedCreateFnAgent.mockResolvedValue({
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

    mockedCreateFnAgent.mockResolvedValue({
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

    mockedCreateFnAgent.mockResolvedValue({
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
    mockedCreateFnAgent.mockResolvedValue({
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


describe("aiMergeTask — merge details collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);

    mockedCreateFnAgent.mockResolvedValue({
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
    expect(mergeDetails.rebaseBaseSha).toBeUndefined();
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

  it("stores rebaseBaseSha when direct merge routes through rebase strategy", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    mockedExistsSync.mockReturnValue(false);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      directMergeCommitStrategy: "always-rebase",
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "rebasemergedsha";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-parse \"abc123\"")) return "rebasebase123";
      if (cmdStr.includes("rev-list --reverse \"rebasebase123..fusion/FN-050\"")) return "";
      if (cmdStr.includes("status --porcelain")) return "";
      if (cmdStr.includes("rev-parse --git-path CHERRY_PICK_HEAD")) return ".git/CHERRY_PICK_HEAD";
      if (cmdStr.includes("rev-parse --git-path sequencer")) return ".git/sequencer";
      if (cmdStr.includes("diff --shortstat \"rebasebase123..HEAD\"")) return "2 files changed, 5 insertions(+), 1 deletions(-)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find((call: any[]) => call[1]?.mergeDetails !== undefined);
    expect(mergeDetailsCall?.[1].mergeDetails.rebaseBaseSha).toBe("rebasebase123");
  });

  it("stores AI summary in mergeDetails when useAiMergeCommitSummary is enabled", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      useAiMergeCommitSummary: true,
    });

    vi.spyOn(core, "summarizeMergeCommit").mockResolvedValue("AI summary of merged work.");

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123456789";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");
    expect(result.merged).toBe(true);

    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find((call: any[]) => call[1]?.mergeDetails !== undefined);
    expect(mergeDetailsCall?.[1].mergeDetails.mergeCommitMessage).toBe("AI summary of merged work.");
  });

  it("emits task:merged once when completeTask finalizes a successful merge", async () => {
    const store = createMockStore(
      { id: "FN-777", worktree: "/tmp/root/.worktrees/FN-777" },
      [{ id: "FN-777", worktree: "/tmp/root/.worktrees/FN-777", column: "in-review" } as Task],
    );
    setupHappyPathExecSync();

    const result = await aiMergeTask(store, "/tmp/root", "FN-777");

    expect(result.merged).toBe(true);
    const mergedEvents = (store.emit as ReturnType<typeof vi.fn>).mock.calls.filter((call: any[]) => call[0] === "task:merged");
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0][1]).toEqual(
      expect.objectContaining({
        merged: true,
        task: expect.objectContaining({ column: "done" }),
      }),
    );
  });

  it("falls back to raw commit log when AI merge summary returns null", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      useAiMergeCommitSummary: true,
    });

    vi.spyOn(core, "summarizeMergeCommit").mockResolvedValue(null);

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123456789";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+)";
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");
    expect(result.merged).toBe(true);

    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find((call: any[]) => call[1]?.mergeDetails !== undefined);
    expect(mergeDetailsCall?.[1].mergeDetails.mergeCommitMessage).toBe("- feat: something");
  });

  it("recovers owned landed commit when branch is not found", async () => {
    const store = createMockStore(
      {
        id: "FN-3469",
        worktree: "/tmp/root/.worktrees/FN-3469",
        baseCommitSha: "base3469",
        mergeDetails: { commitSha: "a47b1e5d78d626f8b480f1e90d3d64be2625ff6a" } as any,
      },
      [{ id: "FN-3469", worktree: "/tmp/root/.worktrees/FN-3469", column: "in-review" } as Task],
    );

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) throw new Error("not found");
      if (cmdStr.includes("merge-base --is-ancestor a47b1e5d78d626f8b480f1e90d3d64be2625ff6a HEAD")) return Buffer.from("");
      if (cmdStr.includes("log -1 --format=%H%x1f%s%x1f%b a47b1e5d78d626f8b480f1e90d3d64be2625ff6a")) {
        return "a47b1e5d78d626f8b480f1e90d3d64be2625ff6a\u001ffix(FN-3469): title\u001fFusion-Task-Id: FN-3469" as any;
      }
      if (cmdStr.includes("show --shortstat --format= a47b1e5d78d626f8b480f1e90d3d64be2625ff6a")) {
        return "2 files changed, 84 insertions(+), 2 deletions(-)" as any;
      }
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-3469");
    expect(result.merged).toBe(true);
    expect((store.emit as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      "task:merged",
      expect.objectContaining({
        merged: true,
        mergeConfirmed: true,
        commitSha: "a47b1e5d78d626f8b480f1e90d3d64be2625ff6a",
      }),
    ]);

    const mergeDetailsCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall?.[1].mergeDetails).toEqual(expect.objectContaining({
      commitSha: "a47b1e5d78d626f8b480f1e90d3d64be2625ff6a",
      mergeCommitMessage: "fix(FN-3469): title",
      mergeConfirmed: true,
    }));
  });

  it("does not persist misleading mergeDetails when branch is not found and no owned commit exists", async () => {
    const store = createMockStore(
      { id: "FN-3373", worktree: "/tmp/root/.worktrees/FN-3373" },
      [{ id: "FN-3373", worktree: "/tmp/root/.worktrees/FN-3373", column: "in-review" } as Task],
    );

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) throw new Error("not found");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-3373");
    expect(result.merged).toBe(false);

    const mergeDetailsCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: any[]) => call[1]?.mergeDetails !== undefined,
    );
    expect(mergeDetailsCall).toBeUndefined();
  });

  it("completes merge even when git commands fail during merge details collection", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    // Use prefer-branch: this test simulates `git rev-parse HEAD` failing to
    // exercise merge-details fallback. The local-base rebase stage hits the
    // same command first; under prefer-main its failure would hard-fail. This
    // test isn't about prefer-main semantics, so opt out.
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-branch",
    });

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

