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
  __testOnlyResolveComplexRebaseConflictsWithAi,
  type ConflictCategory,
} from "../merger.js";
import { AgentLogger } from "../agent-logger.js";
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

describe("merger agent logger flushing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flushes buffered rebase conflict agent logs before disposing session", async () => {
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      getSessionStats: vi.fn().mockReturnValue(undefined),
    };
    mockedCreateFnAgent.mockResolvedValue({ session } as any);

    const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);

    await __testOnlyResolveComplexRebaseConflictsWithAi(
      createMockStore(),
      "/tmp/root",
      "FN-5752",
      { ...DEFAULT_SETTINGS },
      ["src/conflicted.ts"],
    );

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(flushSpy.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });
});

describe("detectResolvableConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no conflicts exist", async () => {
    mockedExecSync.mockReturnValue(""); // Empty output = no conflicts

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });

  it("detects package-lock.json as auto-resolvable with 'theirs' strategy", async () => {
    mockedExecSync.mockReturnValue("package-lock.json\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "package-lock.json",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects pnpm-lock.yaml as lock file with 'ours' strategy", async () => {
    mockedExecSync.mockReturnValue("pnpm-lock.yaml\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "pnpm-lock.yaml",
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects yarn.lock as lock file with 'ours' strategy", async () => {
    mockedExecSync.mockReturnValue("yarn.lock\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects Gemfile.lock as lock file with 'ours' strategy", async () => {
    mockedExecSync.mockReturnValue("Gemfile.lock\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "ours",
      reason: "lock-file",
    });
  });

  it("detects .gen.ts files as generated files with 'theirs' strategy", async () => {
    mockedExecSync.mockReturnValue("src/types.gen.ts\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("detects dist/ paths as generated files with 'theirs' strategy", async () => {
    mockedExecSync.mockReturnValue("dist/index.js\n");

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("detects coverage/ paths as generated files with 'theirs' strategy", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "coverage/lcov.info\n";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      autoResolvable: true,
      strategy: "theirs",
      reason: "generated-file",
    });
  });

  it("marks regular source files as complex conflicts", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/components/App.tsx\n";
      // git diff for trivial detection — return real diff content to indicate non-trivial
      if (cmdStr.includes("git diff -p -w")) return "+real change\n-old line\n";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result[0]).toMatchObject({
      filePath: "src/components/App.tsx",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflicted files with mixed categories", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only"))
        return "package-lock.json\nsrc/components/App.tsx\ndist/bundle.js\n";
      // git diff for trivial detection — return real diff for source files
      if (cmdStr.includes("git diff -p -w")) return "+real change\n-old line\n";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(3);

    const lockFile = result.find((r) => r.filePath === "package-lock.json");
    const sourceFile = result.find((r) => r.filePath === "src/components/App.tsx");
    const distFile = result.find((r) => r.filePath === "dist/bundle.js");

    expect(lockFile).toMatchObject({ autoResolvable: true, reason: "lock-file" });
    expect(sourceFile).toMatchObject({ autoResolvable: false, reason: "complex" });
    expect(distFile).toMatchObject({ autoResolvable: true, reason: "generated-file" });
  });

  it("returns empty array on git command failure", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("git command failed");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toEqual([]);
  });
});


describe("autoResolveFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock returns empty buffer for all git commands
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --theirs for 'theirs' resolution", async () => {
    await autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --theirs"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("package-lock.json");
  });

  it("calls git checkout --ours for 'ours' resolution", async () => {
    await autoResolveFile("config.json", "ours", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --ours"),
    );
    expect(checkoutCall).toBeDefined();
    expect(String(checkoutCall![0])).toContain("config.json");
  });

  it("stages the resolved file with git add", async () => {
    await autoResolveFile("package-lock.json", "theirs", "/tmp/root");

    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );
    expect(addCall).toBeDefined();
    expect(String(addCall![0])).toContain("package-lock.json");
  });

  it("throws error when git checkout fails", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes("checkout")) {
        throw new Error("checkout failed");
      }
      return Buffer.from("");
    });

    await expect(autoResolveFile("file.ts", "theirs", "/tmp/root")).rejects.toThrow(
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

  it("resolves lock files and returns remaining complex conflicts", async () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "dist/bundle.js", autoResolvable: true, strategy: "ours", reason: "generated-file" },
    ];

    const remaining = await resolveConflicts(categories, "/tmp/root");

    // Should have resolved package-lock.json and dist/bundle.js
    expect(remaining).toEqual(["src/App.tsx"]);

    // Should have called checkout and add for resolved files
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(2);
  });

  it("returns all files when none are auto-resolvable", async () => {
    const categories: ConflictCategory[] = [
      { filePath: "src/App.tsx", autoResolvable: false, reason: "complex" },
      { filePath: "src/utils.ts", autoResolvable: false, reason: "complex" },
    ];

    const remaining = await resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual(["src/App.tsx", "src/utils.ts"]);
    // No checkout calls should be made
    const checkoutCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("checkout"),
    );
    expect(checkoutCalls).toHaveLength(0);
  });

  it("returns empty array when all conflicts are resolved", async () => {
    const categories: ConflictCategory[] = [
      { filePath: "package-lock.json", autoResolvable: true, strategy: "ours", reason: "lock-file" },
      { filePath: "yarn.lock", autoResolvable: true, strategy: "ours", reason: "lock-file" },
    ];

    const remaining = await resolveConflicts(categories, "/tmp/root");

    expect(remaining).toEqual([]);
  });
});

// ── Trivial Conflict Detection Tests ──────────────────────────────────────


describe("trivial conflict detection (isTrivialWhitespaceConflict via detectResolvableConflicts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects whitespace-only conflicts as trivial", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // git diff with -w returns empty = trivial whitespace
      if (cmdStr.includes("git diff -p -w")) return "";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: true,
      strategy: "ours",
      reason: "trivial",
    });
  });

  it("marks conflicts with actual content differences as complex", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // git diff returns real content changes = non-trivial
      if (cmdStr.includes("git diff -p -w")) return "+return 2;\n-return 1;\n";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filePath: "src/utils.ts",
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles multiple conflict sections - one non-trivial makes complex", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      // Real diff content = non-trivial
      if (cmdStr.includes("git diff -p -w")) return "+const x = 999;\n-const x = 2;\n";
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });

  it("handles git command errors as complex conflicts", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --name-only")) return "src/utils.ts\n";
      if (cmdStr.includes("git diff -p -w")) throw new Error("git error");
      return Buffer.from("");
    });

    const result = await detectResolvableConflicts("/tmp/root");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      autoResolvable: false,
      reason: "complex",
    });
  });
});

// ── Retry Logic Tests ───────────────────────────────────────────────────


describe("classifyConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies package-lock.json as 'lockfile-ours'", async () => {
    const result = await classifyConflict("package-lock.json", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies pnpm-lock.yaml as 'lockfile-ours'", async () => {
    const result = await classifyConflict("pnpm-lock.yaml", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies yarn.lock as 'lockfile-ours'", async () => {
    const result = await classifyConflict("yarn.lock", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies Gemfile.lock as 'lockfile-ours'", async () => {
    const result = await classifyConflict("Gemfile.lock", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies bun.lockb as 'lockfile-ours'", async () => {
    const result = await classifyConflict("bun.lockb", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies go.sum as 'lockfile-ours'", async () => {
    const result = await classifyConflict("go.sum", "/tmp/root");
    expect(result).toBe("lockfile-ours");
  });

  it("classifies *.gen.ts files as 'generated-theirs'", async () => {
    const result = await classifyConflict("src/types.gen.ts", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies dist/* files as 'generated-theirs'", async () => {
    const result = await classifyConflict("dist/bundle.js", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies build/* files as 'generated-theirs'", async () => {
    const result = await classifyConflict("build/index.html", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies *.min.js files as 'generated-theirs'", async () => {
    const result = await classifyConflict("app.min.js", "/tmp/root");
    expect(result).toBe("generated-theirs");
  });

  it("classifies regular source files as 'complex'", async () => {
    // Mock git diff-tree to return actual content changes (non-trivial)
    mockedExecSync.mockImplementation(() => {
      const error = new Error("exit code 1") as any;
      error.stdout = `diff --git a/src/components/App.tsx b/src/components/App.tsx
--- a/src/components/App.tsx
+++ b/src/components/App.tsx
@@ -1 +1 @@
-const x = 1;
+const x = 2;`;
      throw error;
    });
    mockedReadFileSync.mockReturnValue("const x = 1;");
    const result = await classifyConflict("src/components/App.tsx", "/tmp/root");
    expect(result).toBe("complex");
  });
});


describe("getConflictedFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns array of conflicted file paths", async () => {
    mockedExecSync.mockReturnValue("package-lock.json\nsrc/index.ts\n");

    const result = await getConflictedFiles("/tmp/root");
    expect(result).toEqual(["package-lock.json", "src/index.ts"]);
  });

  it("returns empty array when no conflicts", async () => {
    mockedExecSync.mockReturnValue("");

    const result = await getConflictedFiles("/tmp/root");
    expect(result).toEqual([]);
  });

  it("returns empty array on git error", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("git error");
    });

    const result = await getConflictedFiles("/tmp/root");
    expect(result).toEqual([]);
  });
});


describe("resolveWithOurs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --ours and git add", async () => {
    await resolveWithOurs("package-lock.json", "/tmp/root");

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

  it("throws on git error", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("checkout failed");
    });

    await expect(resolveWithOurs("file.ts", "/tmp/root")).rejects.toThrow(
      "Failed to auto-resolve",
    );
  });
});


describe("resolveWithTheirs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("calls git checkout --theirs and git add", async () => {
    await resolveWithTheirs("dist/bundle.js", "/tmp/root");

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

  it("throws on git error", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("checkout failed");
    });

    await expect(resolveWithTheirs("file.ts", "/tmp/root")).rejects.toThrow(
      "Failed to auto-resolve",
    );
  });
});


describe("resolveTrivialWhitespace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("checks out ours before staging a trivial whitespace conflict", async () => {
    await resolveTrivialWhitespace("src/utils.ts", "/tmp/root");

    const checkoutCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git checkout --ours"),
    );
    const addCall = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git add"),
    );

    expect(checkoutCall).toBeDefined();
    expect(addCall).toBeDefined();
    expect(mockedExecSync.mock.calls.indexOf(checkoutCall!)).toBeLessThan(
      mockedExecSync.mock.calls.indexOf(addCall!),
    );
    expect(String(addCall![0])).toContain("src/utils.ts");
  });

  it("throws on git error", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("add failed");
    });

    await expect(resolveTrivialWhitespace("file.ts", "/tmp/root")).rejects.toThrow(
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

  it("returns true when diff contains only whitespace changes", async () => {
    // Mock git diff to return empty diff (no content changes)
    mockedExecSync.mockReturnValue(
      "diff --git a/file.ts b/file.ts\nindex 123..456 100644\n--- a/file.ts\n+++ b/file.ts\n"
    );

    const result = await isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(true);
  });

  it("returns false when diff contains content changes", async () => {
    // Mock git diff to return diff with actual content changes
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

    const result = await isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(false);
  });

  it("returns true when only line endings differ (CRLF vs LF)", async () => {
    // Mock git diff -w to show no content changes (whitespace ignored)
    mockedExecSync.mockReturnValue(
      "diff --git a/file.ts b/file.ts\nindex 123..456 100644\n--- a/file.ts\n+++ b/file.ts\n"
    );

    const result = await isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(true);
  });

  it("returns false when git diff fails unexpectedly", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    // Mock readFileSync for the fallback
    mockedReadFileSync.mockReturnValue("content without conflict markers");

    const result = await isTrivialWhitespaceConflict("src/file.ts", "/tmp/root");
    expect(result).toBe(false);
  });

  it("calls git diff with separate index references (:2: and :3:)", async () => {
    mockedExecSync.mockReturnValue("");

    await isTrivialWhitespaceConflict("src/utils.ts", "/tmp/root");

    const call = mockedExecSync.mock.calls.find((call) =>
      String(call[0]).includes("git diff -p -w")
    );
    expect(call).toBeDefined();
    const cmdStr = String(call![0]);
    expect(cmdStr).toContain("-w"); // whitespace ignored
    expect(cmdStr).toContain(":2:src/utils.ts");
    expect(cmdStr).toContain(":3:src/utils.ts");
  });
});

// ── Build Verification Tests ─────────────────────────────────────────

