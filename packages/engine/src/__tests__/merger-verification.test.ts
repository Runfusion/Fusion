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
  readdirSync: vi.fn().mockReturnValue([]),
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
  OutOfScopeVerificationError,
  parsePnpmWorkspaceGlobs,
  resolveWorkspacePackageRoots,
  mapChangedFilesToPackageNames,
  deriveScopedPnpmTestCommand,
  parseFailingFilesFromOutput,
  getBranchChangedFiles,
  type ConflictCategory,
} from "../merger.js";
import { mergerLog } from "../logger.js";
import { createFnAgent } from "../pi.js";
import { execSync, exec } from "node:child_process";
import * as core from "@fusion/core";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@fusion/core";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedExecSync = vi.mocked(execSync);
const mockedExec = vi.mocked(exec);
const { existsSync: mockedExistsSyncRaw, readFileSync: mockedReadFileSyncRaw, readdirSync: mockedReaddirSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);
const mockedReadFileSync = vi.mocked(mockedReadFileSyncRaw);
const mockedReaddirSync = vi.mocked(mockedReaddirSyncRaw);

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
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
    expect(capturedSystemPrompt).toContain("fn_report_build_failure");
  });

  it("includes build command in merge prompt when configured", async () => {
    let capturedArgs: any;
    let capturedPrompt: string | undefined;
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Verify custom tool was passed
    expect(capturedArgs.customTools).toBeDefined();
    expect(capturedArgs.customTools.some((t: any) => t.name === "fn_report_build_failure")).toBe(true);
    expect(capturedPrompt).toContain("Build command: `pnpm build`");
    expect(capturedPrompt).toContain("This command is mandatory before commit.");
    expect(capturedPrompt).toContain("Only commit if it exits 0.");
    expect(capturedPrompt).toContain("call `fn_report_build_failure`");
  });

  it("merge succeeds when build passes (agent reports success)", async () => {
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("merge aborts when build fails via fn_report_build_failure tool", async () => {
    // Mock agent that calls the fn_report_build_failure tool execute method
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const reportTool = opts.customTools?.find((t: any) => t.name === "fn_report_build_failure");
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
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
      verificationFixRetries: 0, // Disable in-merge fix for this test
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

  it("logs warning when git reset --merge fails during build-verification rollback", async () => {
    const store = createMockStore(
      { id: "FN-099", worktree: "/tmp/root/.worktrees/KB-099" },
      [{ id: "FN-099", worktree: "/tmp/root/.worktrees/KB-099", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
      verificationFixRetries: 0,
    });

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "reset failed: dirty working tree";

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const reportTool = opts.customTools?.find((t: any) => t.name === "fn_report_build_failure");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await reportTool?.execute("tool-call-1", {
              message: "Type error in src/utils.ts",
            });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git reset --merge")) throw new Error(resetFailureMessage);
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-099")).rejects.toThrow(
      "Build verification failed for FN-099: Type error in src/utils.ts",
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-099: git reset --merge cleanup failed during build-verification rollback"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(resetFailureMessage));

    warnSpy.mockRestore();
  });

  it("merge proceeds normally when no build command is configured", async () => {
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
    // buildCommand is undefined by default in DEFAULT_SETTINGS

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("merge proceeds when buildCommand is empty string (treated as undefined)", async () => {
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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "   ", // whitespace-only, should be treated as undefined
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("syncs dependencies before build verification when install state is missing", async () => {
    mockedCreateFnAgent.mockResolvedValue({
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
      mergeIntegrationWorktree: "cwd-main" as const,
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
      "Syncing dependencies before merge verification: pnpm install --frozen-lockfile",
    );
  });

  it("syncs dependencies before test verification when install state is missing", async () => {
    mockedCreateFnAgent.mockResolvedValue({
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
      { id: "FN-051", worktree: "/tmp/root/.worktrees/KB-051" },
      [{ id: "FN-051", worktree: "/tmp/root/.worktrees/KB-051", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "pnpm test",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-051");

    expect(result.merged).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).includes("pnpm install --frozen-lockfile")),
    ).toBe(true);
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(verificationOrder).toEqual(["test", "build"]);
  });

  it("writes verification start/success entries to agent log", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+)" as any;
      return Buffer.from("");
    });

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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      "Running deterministic merge verification (test: vitest run)",
      "text",
      undefined,
      "merger",
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      "Running test command",
      "tool",
      "vitest run",
      "merger",
    );

    const appendAgentLogCalls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
    const successCall = appendAgentLogCalls.find(
      ([task, message, type]) => task === "FN-050"
        && message === "test command succeeded (exit 0)"
        && type === "tool_result",
    );
    expect(successCall).toBeTruthy();
    expect(successCall?.[3]).toMatch(/^\d+ms$/);
    expect(successCall?.[4]).toBe("merger");

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      "Deterministic merge verification passed",
      "text",
      undefined,
      "merger",
    );
  });

  it("writes verification failure output summaries to agent log", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 0,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "Deterministic test verification failed",
    );

    const appendAgentLogCalls = (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls;
    const failureCall = appendAgentLogCalls.find(
      ([task, message, type]) => task === "FN-050"
        && message === "test command failed (exit 1)"
        && type === "tool_error",
    );
    expect(failureCall).toBeTruthy();
    expect(failureCall?.[3]).toContain("full output available in engine logs");
    expect(failureCall?.[4]).toBe("merger");
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
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

    // Verify log entry contains summary (not raw output) with engine logs reference
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
    const verificationFailCall = logCalls.find((call: any[]) =>
      typeof call[1] === "string" && call[1].includes("[verification] test command failed"),
    );
    expect(verificationFailCall).toBeTruthy();
    expect(verificationFailCall![1]).toContain("full output available in engine logs");
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

    mockedCreateFnAgent.mockImplementation(async () => ({
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringMatching(/^\[timing\] \[verification\] test command succeeded \(exit 0(?:, output exceeded buffer)?\) in \d+ms$/),
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    // Verify no verification commands were called
    const verificationCalls = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("vitest") || String(call[0]).includes("pnpm build"),
    );
    expect(verificationCalls).toHaveLength(0);
  });

  it("skips test and build commands when a cache hit is found for the current tree sha", async () => {
    const treeSha = "cachedtreeshaabc1234567890";
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      // Return the fake tree sha when rev-parse HEAD^{tree} is called
      if (cmdStr.includes("HEAD^{tree}")) return Buffer.from(treeSha + "\n");
      return Buffer.from("");
    });

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
    // Simulate a cache hit for this tree sha
    const cacheHit = { recordedAt: "2026-05-01T00:00:00.000Z", taskId: "FN-049" };
    (store.getVerificationCacheHit as ReturnType<typeof vi.fn>).mockReturnValue(cacheHit);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      buildCommand: "pnpm build",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // No actual test/build commands should have run
    const runCalls = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("vitest run") || String(call[0]).includes("pnpm build"),
    );
    expect(runCalls).toHaveLength(0);

    // The cache skip message should appear in the task log
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
    const cacheMsg = logCalls.find((call: any[]) =>
      typeof call[1] === "string" && call[1].includes("Skipping deterministic verification — cached pass"),
    );
    expect(cacheMsg).toBeTruthy();
    expect(cacheMsg![1]).toContain(treeSha.slice(0, 7));
    expect(cacheMsg![1]).toContain("FN-049");

    // getVerificationCacheHit should have been called with the tree sha and commands
    expect(store.getVerificationCacheHit).toHaveBeenCalledWith(treeSha, "vitest run", "pnpm build");
  });

  it("runs commands and records a cache pass when no cache hit exists", async () => {
    const treeSha = "freshtreedead0000beef";
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("HEAD^{tree}")) return Buffer.from(treeSha + "\n");
      return Buffer.from("");
    });

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
    // No cache hit — returns null (default mock)
    (store.getVerificationCacheHit as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // The test command should have been executed
    const testRuns = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("vitest run"),
    );
    expect(testRuns.length).toBeGreaterThan(0);

    // recordVerificationCachePass should have been called with the tree sha
    expect(store.recordVerificationCachePass).toHaveBeenCalledWith(
      treeSha, "vitest run", "", "FN-050",
    );
  });

  it("gracefully skips cache lookup when git rev-parse HEAD^{tree} fails", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      // Simulate git failure for tree sha resolution
      if (cmdStr.includes("HEAD^{tree}")) {
        const err = new Error("not a git repository") as any;
        err.status = 128;
        throw err;
      }
      return Buffer.from("");
    });

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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    // Should not throw — merge should complete normally
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");
    expect(result.merged).toBe(true);

    // Cache methods should never have been called
    expect(store.getVerificationCacheHit).not.toHaveBeenCalled();
    expect(store.recordVerificationCachePass).not.toHaveBeenCalled();

    // The test command should still have run
    const testRuns = mockedExecSync.mock.calls.filter(
      (call) => String(call[0]).includes("vitest run"),
    );
    expect(testRuns.length).toBeGreaterThan(0);
  });

  it("runs ensure-test-artifacts preamble before verification and logs it", async () => {
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 0,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const nodeCallIndex = mockedExecSync.mock.calls.findIndex((call) =>
      String(call[0]).includes("node scripts/ensure-test-artifacts.mjs"),
    );
    const testCallIndex = mockedExecSync.mock.calls.findIndex((call) => String(call[0]).includes("vitest run"));
    expect(nodeCallIndex).toBeGreaterThan(-1);
    expect(testCallIndex).toBeGreaterThan(nodeCallIndex);
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some((call) => String(call[1]).includes("[verification:bootstrap]"))).toBe(true);
  });

  it("rebuilds missing workspace package and retries verification once", async () => {
    let testAttempts = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        testAttempts += 1;
        if (testAttempts === 1) {
          const err = new Error("vite failure") as any;
          err.status = 1;
          err.stderr = 'Failed to resolve entry for package "@fusion/dashboard"';
          throw err;
        }
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", verificationFixRetries: 0 });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");
    expect(result.merged).toBe(true);
    expect(mockedExecSync.mock.calls.some((call) => String(call[0]).includes("pnpm --filter @fusion/dashboard build"))).toBe(true);
    expect(testAttempts).toBe(2);
  });

  it("throws VerificationError with environmentFault.recovered=false when retry still fails the same way", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("vite failure") as any;
        err.status = 1;
        err.stderr = 'Failed to resolve entry for package "@fusion/dashboard"';
        throw err;
      }
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", verificationFixRetries: 0 });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
      verificationResult: {
        environmentFault: {
          kind: "missing-workspace-entry",
          packageName: "@fusion/dashboard",
          recovered: false,
        },
      },
    });
  });

  it("throws normal VerificationError without environmentFault when retry fails differently", async () => {
    let testAttempts = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        testAttempts += 1;
        const err = new Error("verification failure") as any;
        err.status = 1;
        err.stderr = testAttempts === 1
          ? 'Failed to resolve entry for package "@fusion/dashboard"'
          : "AssertionError: genuine test failure";
        throw err;
      }
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", verificationFixRetries: 0 });

    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
      throw new Error("expected verification error");
    } catch (error) {
      expect(error).toMatchObject({ name: "VerificationError" });
      expect(error).not.toHaveProperty("verificationResult.environmentFault");
    }
  });

  it("throws VerificationError when bootstrap preamble fails without environmentFault", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("node scripts/ensure-test-artifacts.mjs")) {
        const err = new Error("bootstrap failed") as any;
        err.status = 1;
        err.stderr = "bootstrap failed";
        throw err;
      }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", verificationFixRetries: 0 });

    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
      throw new Error("expected verification error");
    } catch (error) {
      expect(error).toMatchObject({ name: "VerificationError" });
      expect(error).not.toHaveProperty("verificationResult.environmentFault");
    }
  });
});


describe("summarizeVerificationOutput", () => {
  it("extracts vitest-style test summary with failure names", () => {
    const output = [
      "some setup output...",
      "FAIL src/utils.test.ts",
      "  ✗ should validate input",
      "  ✗ should handle edge case",
      "Tests: 2 failed, 48 passed, 50 total",
    ].join("\n");
    const result = summarizeVerificationOutput(output, "test");
    expect(result).toContain("Tests: 2 failed, 48 passed, 50 total");
    expect(result).toContain("should validate input");
    expect(result).toContain("full output available in engine logs");
  });

  it("limits failure names to 5 with overflow indicator", () => {
    // Build output with 7 FAIL lines
    const output = [
      "FAIL test1",
      "FAIL test2",
      "FAIL test3",
      "FAIL test4",
      "FAIL test5",
      "FAIL test6",
      "FAIL test7",
      "Tests: 7 failed, 0 passed, 7 total",
    ].join("\n");
    const result = summarizeVerificationOutput(output, "test");
    expect(result).toContain("test5");
    expect(result).toContain("... and 2 more failures");
    expect(result).not.toContain("test6");
  });

  it("falls back to first 500 chars for unstructured output", () => {
    const output = "A".repeat(1000);
    const result = summarizeVerificationOutput(output, "build");
    expect(result.length).toBeLessThan(600);
    expect(result).toContain("full output available in engine logs");
  });

  it("returns generic message for empty output", () => {
    const result = summarizeVerificationOutput("", "test");
    expect(result).toContain("no output");
    expect(result).toContain("full output available in engine logs");
  });

  it("deduplicates identical failure names", () => {
    const output = [
      "FAIL src/a.test.ts",
      "FAIL src/a.test.ts",  // duplicate
      "FAIL src/b.test.ts",
      "Tests: 3 failed, 0 passed",
    ].join("\n");
    const result = summarizeVerificationOutput(output, "test");
    // Should contain only unique names (src/a.test.ts once, src/b.test.ts)
    const bulletMatches = result.match(/• /g);
    expect(bulletMatches?.length).toBe(2);
  });
});

// ── Default Test Command Inference Tests ──────────────────────────────────


describe("inferDefaultTestCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no lock files present
    mockedExistsSync.mockReturnValue(false);
  });

  it("returns null when no package manager lock files exist", () => {
    mockedExistsSync.mockReturnValue(false);
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toBeNull();
  });

  it("returns pnpm test for pnpm-lock.yaml", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toEqual({
      command: "pnpm test",
      testSource: "inferred",
    });
  });

  it("returns npm test for package-lock.json", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("package-lock.json");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toEqual({
      command: "npm test",
      testSource: "inferred",
    });
  });

  it("returns yarn test for yarn.lock", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("yarn.lock");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toEqual({
      command: "yarn test",
      testSource: "inferred",
    });
  });

  it("returns bun test for bun.lock", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("bun.lock");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toEqual({
      command: "bun test",
      testSource: "inferred",
    });
  });

  it("returns bun test for bun.lockb", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("bun.lockb");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result).toEqual({
      command: "bun test",
      testSource: "inferred",
    });
  });

  it("prefers pnpm over npm when both exist", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      return pathStr.includes("pnpm-lock.yaml") || pathStr.includes("package-lock.json");
    });
    const result = inferDefaultTestCommand("/tmp/root");
    expect(result?.command).toBe("pnpm test");
  });

  it("uses explicit testCommand when provided", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });
    const result = inferDefaultTestCommand("/tmp/root", "vitest run", "pnpm build");
    expect(result).toEqual({
      command: "vitest run",
      testSource: "explicit",
      buildSource: "explicit",
    });
  });

  it("ignores empty string explicit testCommand", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });
    const result = inferDefaultTestCommand("/tmp/root", "", "pnpm build");
    expect(result?.command).toBe("pnpm test");
    expect(result?.testSource).toBe("inferred");
    expect(result?.buildSource).toBe("explicit");
  });

  it("ignores whitespace-only explicit testCommand", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });
    const result = inferDefaultTestCommand("/tmp/root", "   ", "pnpm build");
    expect(result?.command).toBe("pnpm test");
    expect(result?.testSource).toBe("inferred");
  });

  it("returns build source even when test is inferred", () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });
    const result = inferDefaultTestCommand("/tmp/root", undefined, "pnpm build");
    expect(result).toEqual({
      command: "pnpm test",
      testSource: "inferred",
      buildSource: "explicit",
    });
  });
});

// ── Inferred Test Command Merge Behavior ─────────────────────────────────


describe("aiMergeTask — inferred test command execution", () => {
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

  it("runs inferred test command when settings.testCommand is not configured", async () => {
    // pnpm-lock.yaml exists, testCommand is not set
    mockedExistsSync.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes("pnpm-lock.yaml")) return true;
      return true; // other files exist for worktree check
    });

    const verificationCalls: string[] = [];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("pnpm test")) {
        verificationCalls.push("pnpm test");
        return Buffer.from("");
      }
      // Handle all other git commands - matching setupHappyPathExecSync
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached") && !cmdStr.includes("--quiet")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    // testCommand is not set (undefined in DEFAULT_SETTINGS)
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(verificationCalls).toContain("pnpm test");
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("logs that test command was inferred from project files", async () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });

    // Setup happy path
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("pnpm test")) return Buffer.from("");
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

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Verify log entries include verification with test command mentioned
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
    const verificationLogCall = logCalls.find((call: any[]) =>
      typeof call[1] === "string" && call[1].includes("pnpm test")
    );
    expect(verificationLogCall).toBeTruthy();
  });

  it("failing inferred test command blocks merge and keeps task out of done", async () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("pnpm test")) {
        // Simulate test failure
        const error = new Error("Test failed") as any;
        error.status = 1;
        error.stdout = "FAIL: test failed";
        error.stderr = "";
        throw error;
      }
      // Handle other commands normally
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

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "Deterministic test verification failed",
    );

    // Task should NOT be moved to done
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-050", "done");
    // Log entry should indicate failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("test verification failed"),
      "VerificationError",
    );
  });

  it("explicit settings.testCommand takes precedence over inferred command", async () => {
    mockedExistsSync.mockImplementation((path: any) => {
      return String(path).includes("pnpm-lock.yaml");
    });

    const verificationCalls: string[] = [];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("vitest run")) {
        verificationCalls.push("vitest run");
        return Buffer.from("");
      }
      if (cmdStr.includes("pnpm test")) {
        verificationCalls.push("pnpm test - SHOULD NOT BE CALLED");
        return Buffer.from("");
      }
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

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    // Explicit testCommand is set
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // Explicit command should be used, not inferred
    expect(verificationCalls).toContain("vitest run");
    expect(verificationCalls).not.toContain("pnpm test - SHOULD NOT BE CALLED");
  });

  it("skips verification when no lock files exist and no explicit testCommand is set", async () => {
    // No lock files exist
    mockedExistsSync.mockReturnValue(false);

    const verificationCalls: string[] = [];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("pnpm test") || cmdStr.includes("npm test") || cmdStr.includes("yarn test") || cmdStr.includes("bun test")) {
        verificationCalls.push(cmdStr);
      }
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

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    // No test verification should have run
    expect(verificationCalls).toHaveLength(0);
    // Merge should still succeed
    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });
});


describe("aiMergeTask — in-merge verification fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(true);
  });

  it("verification fix is attempted when verification fails", async () => {
    // Simple mock: always fail verification
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const isFixAgent = opts.systemPrompt?.includes("verification fix agent");
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 1,
    });

    // With verificationFixRetries: 1, the merge should fail with VerificationError
    // because the fix agent can't fix the verification (it's mocked to not actually fix anything)
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    // 2 calls: merge AI agent (attempt 1) + verification-fix agent.
    // VerificationError no longer triggers a redundant attempt 2 — the
    // in-merge fix runs immediately on attempt 1's catch with the correct
    // preAttemptHeadSha baseline.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Verify the fix agent was called with correct options
    const fixAgentCall = mockedCreateFnAgent.mock.calls[1];
    expect(fixAgentCall[0].tools).toBe("coding");
    expect(fixAgentCall[0].cwd).toBe("/tmp/root");
    expect(fixAgentCall[0].systemPrompt).toContain("verification fix agent");
  });

  it("runs full test+build verification after a test-failure fix", async () => {
    let vitestRuns = 0;
    let buildRuns = 0;
    let statusReads = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("status --porcelain")) {
        statusReads += 1;
        return statusReads === 1 ? "" : " M src/fix.ts";
      }
      if (cmdStr.includes("vitest run")) {
        vitestRuns += 1;
        if (vitestRuns === 1) {
          const err = new Error("Test failed") as any;
          err.status = 1;
          err.stdout = "";
          err.stderr = "";
          throw err;
        }
        return Buffer.from("");
      }
      if (cmdStr.includes("pnpm build")) {
        buildRuns += 1;
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", buildCommand: "pnpm build", verificationFixRetries: 1 });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).resolves.toMatchObject({
      branchDeleted: true,
    });
    expect(vitestRuns).toBe(2);
    expect(buildRuns).toBe(1);
  });

  it("retries when test-failure fix passes tests but full rerun fails on build", async () => {
    let vitestRuns = 0;
    let statusReads = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("status --porcelain")) return ++statusReads === 1 ? "" : " M src/fix.ts";
      if (cmdStr.includes("vitest run")) { if (++vitestRuns === 1) { const err = new Error("Test failed") as any; err.status = 1; throw err; } return Buffer.from(""); }
      if (cmdStr.includes("pnpm build")) { const err = new Error("Build failed") as any; err.status = 1; throw err; }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      return Buffer.from("");
    });
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
    const store = createMockStore({ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" }, [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", buildCommand: "pnpm build", verificationFixRetries: 2 });
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow();
  });

  it("runs full test+build verification after a build-failure fix", async () => {
    let buildRuns = 0;
    let statusReads = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("status --porcelain")) return ++statusReads === 1 ? "" : " M src/fix.ts";
      if (cmdStr.includes("vitest run")) return Buffer.from("");
      if (cmdStr.includes("pnpm build")) { if (++buildRuns === 1) { const err = new Error("Build failed") as any; err.status = 1; throw err; } return Buffer.from(""); }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    });
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
    const store = createMockStore({ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" }, [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", buildCommand: "pnpm build", verificationFixRetries: 1, buildRetryCount: 0 });
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).resolves.toMatchObject({
      branchDeleted: true,
    });
    expect(buildRuns).toBe(2);
  });

  it("retries when build-failure fix keeps build green but breaks tests in full rerun", async () => {
    let buildRuns = 0;
    let statusReads = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("status --porcelain")) return ++statusReads === 1 ? "" : " M src/fix.ts";
      if (cmdStr.includes("vitest run")) { const err = new Error("Test failed") as any; err.status = 1; throw err; }
      if (cmdStr.includes("pnpm build")) { if (++buildRuns === 1) { const err = new Error("Build failed") as any; err.status = 1; throw err; } return Buffer.from(""); }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      return Buffer.from("");
    });
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any);
    const store = createMockStore({ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" }, [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, testCommand: "vitest run", buildCommand: "pnpm build", verificationFixRetries: 2, buildRetryCount: 0 });
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow();
  });

  it("logs fix-agent startup metadata, streams callbacks, and logs rerun lifecycle", async () => {
    let capturedFixOptions: any;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const isFixAgent = opts.systemPrompt?.includes("verification fix agent");
      if (!isFixAgent) {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
          },
        } as any;
      }

      capturedFixOptions = opts;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            opts.onText?.("working on fix");
            opts.onThinking?.("diagnosing");
            opts.onToolStart?.("Bash", { command: "vitest run" });
            opts.onToolEnd?.("Bash", false, "still failing");
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 1,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    expect(capturedFixOptions).toBeDefined();
    expect(capturedFixOptions.onText).toBeTypeOf("function");
    expect(capturedFixOptions.onThinking).toBeTypeOf("function");
    expect(capturedFixOptions.onToolStart).toBeTypeOf("function");
    expect(capturedFixOptions.onToolEnd).toBeTypeOf("function");

    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "Bash", "tool", "vitest run", "merger");

    const logMessages = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls
      .map((call: any[]) => call[1])
      .filter((message: unknown): message is string => typeof message === "string");

    const startupLog = logMessages.find((message) =>
      message.includes("In-merge verification fix agent started"),
    );
    expect(startupLog).toBeDefined();
    expect(startupLog).toContain("model: mock-provider/mock-model");
    expect(startupLog).toContain("agentId: merger");
    expect(startupLog).toMatch(/runId: merge-FN-050-/);

    const rerunIdx = logMessages.findIndex((message) =>
      message.includes("Re-running deterministic merge verification (attempt 1)"),
    );
    expect(rerunIdx).toBeGreaterThan(-1);

    const verificationAfterRerunIdx = logMessages.findIndex(
      (message, index) =>
        index > rerunIdx && message.includes("[verification] Running test command: vitest run"),
    );
    expect(verificationAfterRerunIdx).toBeGreaterThan(rerunIdx);
  });

  it("logs rerun lifecycle before verification in build-failure fix path", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("pnpm build")) {
        const err = new Error("Build failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const isFixAgent = opts.systemPrompt?.includes("verification fix agent");
      if (isFixAgent) {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
          },
        } as any;
      }

      const reportTool = opts.customTools?.find((t: any) => t.name === "fn_report_build_failure");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await reportTool?.execute("tool-call-build", { message: "Type error in src/build.ts" });
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
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
      verificationFixRetries: 1,
      buildRetryCount: 0,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "Build verification failed for FN-050: Type error in src/build.ts",
    );

    const logMessages = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls
      .map((call: any[]) => call[1])
      .filter((message: unknown): message is string => typeof message === "string");

    const rerunIdx = logMessages.findIndex((message) =>
      message.includes("Re-running deterministic merge verification (attempt 1)"),
    );
    expect(rerunIdx).toBeGreaterThan(-1);

    const verificationAfterRerunIdx = logMessages.findIndex(
      (message, index) =>
        index > rerunIdx && message.includes("[verification] Running build command: pnpm build"),
    );
    expect(verificationAfterRerunIdx).toBeGreaterThan(rerunIdx);
  });

  it("verification fix is skipped when verificationFixRetries is 0", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 0,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    // Verify fix agent was NOT spawned — only the merge AI agent (attempt 1).
    // VerificationError propagates without triggering attempt 2.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Verify no fix attempt was logged
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
    const fixAttempts = logCalls.filter((call: any[]) =>
      typeof call[1] === "string" && call[1].includes("in-merge verification fix"),
    );
    expect(fixAttempts).toHaveLength(0);
  });

  it("fix agent uses same model settings as merger", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (_opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 1,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    // Verify fix agent uses same model settings
    const fixAgentCall = mockedCreateFnAgent.mock.calls[1];
    expect(fixAgentCall[0].defaultProvider).toBe("anthropic");
    expect(fixAgentCall[0].defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("uses project default override for merge agent model", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (_opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 0,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    const mergeAgentCall = mockedCreateFnAgent.mock.calls[0];
    expect(mergeAgentCall[0].defaultProvider).toBe("openai");
    expect(mergeAgentCall[0].defaultModelId).toBe("gpt-4o");
  });

  it("fix agent session is disposed", async () => {
    const disposeMock = vi.fn();

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const isFixAgent = opts.systemPrompt?.includes("verification fix agent");
      if (isFixAgent) {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: disposeMock,
          },
        } as any;
      }
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 1,
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    expect(disposeMock).toHaveBeenCalled();
  });

  it("max fix retries capped at 3", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
      verificationFixRetries: 10, // Exceeds max
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    // 1 merger AI agent (attempt 1) + 3 fix agent attempts (capped) = 4 calls
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
  });

  it("default verificationFixRetries (omitted) results in 3 fix attempts", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("vitest run")) {
        const err = new Error("Test failed") as any;
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
    // Use core defaults (verificationFixRetries defaults to 3)
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "vitest run",
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toMatchObject({
      name: "VerificationError",
    });

    // 1 merger AI agent (attempt 1) + 3 fix agent attempts (default) = 4 calls
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);

    // Verify the log shows 3 fix attempts (2 log entries per attempt: start + failure)
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
    const fixAttempts = logCalls.filter((call: any[]) =>
      typeof call[1] === "string" && call[1].includes("In-merge verification fix attempt"),
    );
    // Each attempt produces 2 log entries: "attempt X/3" and "attempt X — verification still fails"
    expect(fixAttempts).toHaveLength(6);
    expect(fixAttempts[0][1]).toContain("attempt 1/3");
    expect(fixAttempts[2][1]).toContain("attempt 2/3");
    expect(fixAttempts[4][1]).toContain("attempt 3/3");
  });
});

// ── parsePnpmWorkspaceGlobs ───────────────────────────────────────────────

describe("parsePnpmWorkspaceGlobs", () => {
  it("parses a simple packages list", () => {
    const content = `packages:\n  - "packages/*"\n  - "plugins/*"\n`;
    expect(parsePnpmWorkspaceGlobs(content)).toEqual(["packages/*", "plugins/*"]);
  });

  it("handles single-quoted entries", () => {
    const content = `packages:\n  - 'packages/*'\n`;
    expect(parsePnpmWorkspaceGlobs(content)).toEqual(["packages/*"]);
  });

  it("handles unquoted entries", () => {
    const content = `packages:\n  - packages/*\n`;
    expect(parsePnpmWorkspaceGlobs(content)).toEqual(["packages/*"]);
  });

  it("stops at next top-level key", () => {
    const content = `packages:\n  - packages/*\ncatalog:\n  react: ^18\n`;
    expect(parsePnpmWorkspaceGlobs(content)).toEqual(["packages/*"]);
  });

  it("returns empty array for empty content", () => {
    expect(parsePnpmWorkspaceGlobs("")).toEqual([]);
  });

  it("returns empty array when no packages key", () => {
    expect(parsePnpmWorkspaceGlobs("name: root\n")).toEqual([]);
  });

  it("parses literal (non-glob) package paths", () => {
    const content = `packages:\n  - "plugins/fusion-plugin-foo"\n`;
    expect(parsePnpmWorkspaceGlobs(content)).toEqual(["plugins/fusion-plugin-foo"]);
  });
});

// ── resolveWorkspacePackageRoots ──────────────────────────────────────────

describe("resolveWorkspacePackageRoots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves glob pattern to subdirectories with package.json", () => {
    mockedReaddirSync.mockReturnValue([
      { name: "dashboard", isDirectory: () => true },
      { name: "engine", isDirectory: () => true },
    ] as any);
    mockedExistsSync.mockImplementation((p: any) => String(p).endsWith("package.json"));

    const roots = resolveWorkspacePackageRoots("/repo", ["packages/*"]);
    expect(roots).toEqual(["packages/dashboard", "packages/engine"]);
  });

  it("skips directories without package.json", () => {
    mockedReaddirSync.mockReturnValue([
      { name: "dashboard", isDirectory: () => true },
      { name: ".cache", isDirectory: () => true },
    ] as any);
    mockedExistsSync.mockImplementation((p: any) => String(p).includes("dashboard/package.json"));

    const roots = resolveWorkspacePackageRoots("/repo", ["packages/*"]);
    expect(roots).toEqual(["packages/dashboard"]);
  });

  it("handles literal (non-glob) paths", () => {
    mockedExistsSync.mockImplementation((p: any) => String(p).endsWith("package.json"));
    const roots = resolveWorkspacePackageRoots("/repo", ["plugins/fusion-plugin-foo"]);
    expect(roots).toEqual(["plugins/fusion-plugin-foo"]);
  });

  it("returns empty when readdirSync throws", () => {
    mockedReaddirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const roots = resolveWorkspacePackageRoots("/repo", ["packages/*"]);
    expect(roots).toEqual([]);
  });
});

// ── mapChangedFilesToPackageNames ─────────────────────────────────────────

describe("mapChangedFilesToPackageNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a changed file to the correct package name", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: "@fusion/dashboard" }));
    mockedExistsSync.mockReturnValue(true);

    const names = mapChangedFilesToPackageNames(
      ["packages/dashboard/src/index.ts"],
      ["packages/dashboard", "packages/engine"],
      "/repo",
    );
    expect(names).toEqual(["@fusion/dashboard"]);
  });

  it("assigns to the longest matching prefix", () => {
    mockedReadFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("plugins/examples/foo")) return JSON.stringify({ name: "@fusion/example-foo" });
      if (path.includes("plugins")) return JSON.stringify({ name: "@fusion/plugins" });
      return JSON.stringify({ name: "unknown" });
    });
    mockedExistsSync.mockReturnValue(true);

    const names = mapChangedFilesToPackageNames(
      ["plugins/examples/foo/index.ts"],
      ["plugins", "plugins/examples/foo"],
      "/repo",
    );
    expect(names).toEqual(["@fusion/example-foo"]);
  });

  it("returns empty array for files not in any package root", () => {
    const names = mapChangedFilesToPackageNames(
      ["root-file.ts"],
      ["packages/dashboard"],
      "/repo",
    );
    expect(names).toEqual([]);
  });

  it("deduplicates package names when multiple files touch same package", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ name: "@fusion/dashboard" }));
    mockedExistsSync.mockReturnValue(true);

    const names = mapChangedFilesToPackageNames(
      ["packages/dashboard/a.ts", "packages/dashboard/b.ts"],
      ["packages/dashboard"],
      "/repo",
    );
    expect(names).toEqual(["@fusion/dashboard"]);
  });
});

// ── inferDefaultTestCommand — scoped pnpm workspace ──────────────────────

describe("inferDefaultTestCommand — pnpm workspace scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("returns pnpm test (unscoped/inferred) when no git context provided", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.includes("pnpm-lock.yaml") || path.includes("pnpm-workspace.yaml");
    });

    const result = inferDefaultTestCommand("/tmp/root");
    expect(result?.command).toBe("pnpm test");
    expect(result?.testSource).toBe("inferred");
  });

  it("returns scoped command (inferred-scoped) when monorepo + git context + 1 changed package", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      // workspace files exist; package.json for dashboard exists
      if (path.includes("pnpm-lock.yaml")) return true;
      if (path.includes("pnpm-workspace.yaml")) return true;
      if (path.includes("package.json")) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("pnpm-workspace.yaml")) {
        return `packages:\n  - "packages/*"\n`;
      }
      if (path.includes("dashboard/package.json")) {
        return JSON.stringify({ name: "@fusion/dashboard" });
      }
      return JSON.stringify({ name: "unknown" });
    });
    mockedReaddirSync.mockReturnValue([
      { name: "dashboard", isDirectory: () => true },
    ] as any);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) {
        return "packages/dashboard/src/index.ts\n";
      }
      return "";
    });

    const result = inferDefaultTestCommand("/tmp/root", undefined, undefined, "main", "fusion/fn-123");
    expect(result?.command).toBe(`pnpm --filter "@fusion/dashboard...^" test`);
    expect(result?.testSource).toBe("inferred-scoped");
    expect(mockedExecSync).toHaveBeenCalledWith(
      'git diff --name-only "main"..."fusion/fn-123"',
      expect.objectContaining({ cwd: "/tmp/root", encoding: "utf-8" }),
    );
  });

  it("returns command with 2 filters when 2 packages are changed", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("pnpm-lock.yaml")) return true;
      if (path.includes("pnpm-workspace.yaml")) return true;
      if (path.includes("package.json")) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("pnpm-workspace.yaml")) return `packages:\n  - "packages/*"\n`;
      if (path.includes("dashboard/package.json")) return JSON.stringify({ name: "@fusion/dashboard" });
      if (path.includes("engine/package.json")) return JSON.stringify({ name: "@fusion/engine" });
      return JSON.stringify({ name: "unknown" });
    });
    mockedReaddirSync.mockReturnValue([
      { name: "dashboard", isDirectory: () => true },
      { name: "engine", isDirectory: () => true },
    ] as any);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) {
        return "packages/dashboard/src/index.ts\npackages/engine/src/merger.ts\n";
      }
      return "";
    });

    const result = inferDefaultTestCommand("/tmp/root", undefined, undefined, "main", "fusion/fn-123");
    expect(result?.command).toContain("--filter");
    expect(result?.command).toContain("@fusion/dashboard");
    expect(result?.command).toContain("@fusion/engine");
    expect(result?.testSource).toBe("inferred-scoped");
  });

  it("falls back to pnpm test (inferred) when all changes are root-only files", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("pnpm-lock.yaml")) return true;
      if (path.includes("pnpm-workspace.yaml")) return true;
      if (path.includes("package.json")) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("pnpm-workspace.yaml")) return `packages:\n  - "packages/*"\n`;
      return JSON.stringify({ name: "unknown" });
    });
    mockedReaddirSync.mockReturnValue([
      { name: "dashboard", isDirectory: () => true },
    ] as any);
    // Changed file is at root (pnpm-workspace.yaml) — no package prefix match
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) {
        return "pnpm-workspace.yaml\n";
      }
      return "";
    });

    const result = inferDefaultTestCommand("/tmp/root", undefined, undefined, "main", "fusion/fn-123");
    expect(result?.command).toBe("pnpm test");
    expect(result?.testSource).toBe("inferred");
  });

  it("falls back to pnpm test (inferred) when no git context", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.includes("pnpm-lock.yaml") || path.includes("pnpm-workspace.yaml");
    });

    // No baseBranch or branch passed
    const result = inferDefaultTestCommand("/tmp/root", undefined, undefined, undefined, undefined);
    expect(result?.command).toBe("pnpm test");
    expect(result?.testSource).toBe("inferred");
  });

  it("explicit testCommand always wins over scoping", () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.includes("pnpm-lock.yaml") || path.includes("pnpm-workspace.yaml");
    });

    const result = inferDefaultTestCommand("/tmp/root", "vitest run --reporter=verbose", undefined, "main", "fusion/fn-123");
    expect(result?.command).toBe("vitest run --reporter=verbose");
    expect(result?.testSource).toBe("explicit");
  });
});

// ── parseFailingFilesFromOutput ──────────────────────────────────────────

describe("parseFailingFilesFromOutput", () => {
  it("parses FAIL lines from jest/vitest output", () => {
    const output = [
      "FAIL packages/engine/src/__tests__/reliability-interactions/foo.test.ts",
      "FAIL packages/engine/src/__tests__/bar.test.ts",
      "● some test name",
    ].join("\n");
    const files = parseFailingFilesFromOutput(output);
    expect(files).toContain("packages/engine/src/__tests__/reliability-interactions/foo.test.ts");
    expect(files).toContain("packages/engine/src/__tests__/bar.test.ts");
    expect(files.length).toBe(2);
  });

  it("parses vitest summary ❯ lines", () => {
    const output = [
      " ❯ packages/engine/src/__tests__/merger.test.ts (5 tests | 2 failed)",
    ].join("\n");
    const files = parseFailingFilesFromOutput(output);
    expect(files).toContain("packages/engine/src/__tests__/merger.test.ts");
  });

  it("returns empty array when output has no file paths", () => {
    const output = "● some test title\n● another test\n";
    expect(parseFailingFilesFromOutput(output)).toEqual([]);
  });

  it("deduplicates repeated file paths", () => {
    const output = [
      "FAIL packages/engine/src/__tests__/foo.test.ts",
      "FAIL packages/engine/src/__tests__/foo.test.ts",
    ].join("\n");
    expect(parseFailingFilesFromOutput(output)).toHaveLength(1);
  });
});

// ── getBranchChangedFiles ────────────────────────────────────────────────

describe("getBranchChangedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns changed files from git diff output", () => {
    mockedExecSync.mockReturnValue("packages/dashboard/src/a.ts\npackages/dashboard/src/b.ts\n" as any);
    const files = getBranchChangedFiles("/repo", "main", "fusion/fn-123");
    expect(files).toEqual(["packages/dashboard/src/a.ts", "packages/dashboard/src/b.ts"]);
  });

  it("returns empty array when git diff fails", () => {
    mockedExecSync.mockImplementation(() => { throw new Error("not a git repo"); });
    const files = getBranchChangedFiles("/repo", "main", "fusion/fn-123");
    expect(files).toEqual([]);
  });

  it("filters out empty lines", () => {
    mockedExecSync.mockReturnValue("\npackages/engine/src/merger.ts\n\n" as any);
    const files = getBranchChangedFiles("/repo", "main", "fusion/fn-123");
    expect(files).toEqual(["packages/engine/src/merger.ts"]);
  });
});

// ── OutOfScopeVerificationError ─────────────────────────────────────────

describe("OutOfScopeVerificationError", () => {
  it("is constructable with message, failingFiles, and branchFiles", () => {
    const err = new OutOfScopeVerificationError(
      "test failure outside branch scope",
      ["packages/engine/src/__tests__/reliability-interactions/foo.test.ts"],
      ["packages/dashboard/src/index.ts"],
    );
    expect(err.name).toBe("OutOfScopeVerificationError");
    expect(err.message).toContain("outside branch scope");
    expect(err.failingFiles).toHaveLength(1);
    expect(err.branchFiles).toHaveLength(1);
  });
});
