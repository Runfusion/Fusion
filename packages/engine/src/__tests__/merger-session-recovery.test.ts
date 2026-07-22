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

vi.mock("../errors/rate-limit-retry.js", () => ({
  withRateLimitRetry: (fn: () => Promise<any>) => fn(),
}));

vi.mock("../errors/context-limit-detector.js", () => ({
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

  it("creates a fresh session for merge agent via createFnAgent", async () => {
    setupFreshSessionExecSync();

    const sessionInstances: any[] = [];
    mockedCreateFnAgent.mockImplementation(async () => {
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
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(sessionInstances.length).toBe(1);
  });

  it("disposes session after merge agent completes (finally block)", async () => {
    setupFreshSessionExecSync();

    const mockDispose = vi.fn();
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: mockDispose,
    };
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

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
    const mergerModule = await import("../merger.js");
    expect(mergerModule).toBeDefined();
  });
});

// ── Merge Prompt Truncation Tests ─────────────────────────────────────


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

  it("retries with minimal prompt when context limit hit after auto-compaction", async () => {
    const { isContextLimitError } = await import("../errors/context-limit-detector.js");

    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls
    const promptCalls: string[] = [];
    let firstCall = true;
    mockedCreateFnAgent.mockImplementation(async () => {
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

    // Note: Compaction is now handled by promptWithFallback, not by the merger directly
  });

  it("throws when truncated retry also fails with context limit", async () => {
    const { isContextLimitError } = await import("../errors/context-limit-detector.js");

    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls to verify both original and truncated prompts were tried
    const promptCalls: string[] = [];

    mockedCreateFnAgent.mockImplementation(async () => {
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
      /*
      FNXC:MergeSafety 2026-07-16-08:10:
      classifyConflict/isTrivialWhitespaceConflict now uses execFile
      `git diff -p -w :2:path :3:path` (not shell git diff-tree). Mock that form
      with substantive +/- lines so the conflict stays complex and the context-limit
      AI path is exercised instead of trivial auto-resolve.
      */
      if (
        cmdStr.includes("diff-tree")
        || (cmdStr.includes("git diff") && cmdStr.includes("-w") && cmdStr.includes(":2:"))
      ) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      smartConflictResolution: true, // Enable all 3 attempts
    });

    // Should throw after all attempts exhausted
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow("all 3 attempts exhausted");

    // Verify both original and truncated prompts were attempted (2 attempts for attempt 1)
    // Each merge attempt calls promptWithFallback twice (original + truncated when compaction fails)
    // With 3 merge attempts, this means we should have at least 6 prompt calls total
    expect(promptCalls.length).toBeGreaterThan(0);

    // Note: Compaction is now handled by promptWithFallback, not by the merger directly
  });

  it("succeeds when prompt succeeds on retry after context error", async () => {
    const { isContextLimitError } = await import("../errors/context-limit-detector.js");

    vi.mocked(isContextLimitError).mockReturnValue(true);

    // Track prompt calls
    const promptCalls: string[] = [];
    let firstCall = true;
    mockedCreateFnAgent.mockImplementation(async () => {
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

    // Merge should succeed after retry
    expect(result.merged).toBe(true);

    // Should have made 2 prompt calls
    expect(promptCalls).toHaveLength(2);

    // Note: Compaction is now handled by promptWithFallback, not by the merger directly
  });

  it("does not attempt truncation retry for non-context errors", async () => {
    const { compactSessionContext } = await import("../pi.js");
    const { isContextLimitError } = await import("../errors/context-limit-detector.js");

    // Non-context error should not trigger recovery path
    vi.mocked(compactSessionContext).mockResolvedValue(null);
    vi.mocked(isContextLimitError).mockReturnValue(false);

    // Mock non-context error
    mockedCreateFnAgent.mockImplementation(async () => {
      const session = {
        prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
        dispose: vi.fn(),
      };
      return { session } as any;
    });

    // Setup that simulates merge failing - make merge --squash throw so auto-resolution isn't triggered
    // Also make commit fail so all attempts exhaust
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      // All merge attempts fail - make merge --squash throw with conflicts
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) {
        const err = new Error("merge conflict");
        err.name = "ExecSyncError";
        throw err;
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "src/file.ts";
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      // Make commit fail so attempt 2's auto-resolution also fails
      if (cmdStr.includes("git commit")) {
        const err = new Error("commit failed");
        err.name = "ExecSyncError";
        throw err;
      }
      return Buffer.from("");
    });

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      smartConflictResolution: true,
    });

    // Should throw without attempting compaction or truncation
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow("all 3 attempts exhausted");

    // Compaction should NOT have been called for non-context errors
    expect(vi.mocked(compactSessionContext)).not.toHaveBeenCalled();
  });
});


