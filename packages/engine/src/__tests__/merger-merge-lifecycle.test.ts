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

vi.mock("../merger-squash-audit.js", () => ({
  MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS: 30,
  auditSquashMerge: vi.fn(async () => ({
    strategy: "squash",
    squashSha: "mergedcommit123",
    parentSha: "parent123",
    auditTargetLabel: "mergedcommit123",
    squashSubject: "feat: squash merge",
    lookback: 30,
    branchSubjects: [],
    recentMainSubjects: [],
    duplicateSubjects: [],
    touchedFiles: [],
    touchedFileOverlaps: [],
    findings: [],
    issueCount: 0,
    clean: true,
  })),
}));

vi.mock("../merger-overlap-guard.js", () => ({
  detectMergeOverlap: vi.fn(async () => ({
    overlappingFiles: [],
    recentMainCommitsByFile: new Map(),
  })),
  restoreBranchWinsFiles: vi.fn(async () => undefined),
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
import { auditSquashMerge } from "../merger-squash-audit.js";
import { detectMergeOverlap, restoreBranchWinsFiles } from "../merger-overlap-guard.js";
import { execSync, exec } from "node:child_process";
import * as core from "@fusion/core";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@fusion/core";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAuditSquashMerge = vi.mocked(auditSquashMerge);
const mockedDetectMergeOverlap = vi.mocked(detectMergeOverlap);
const mockedRestoreBranchWinsFiles = vi.mocked(restoreBranchWinsFiles);
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
    worktree: "/tmp/root",
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
    recordRunAuditEvent: vi.fn(),
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


describe("aiMergeTask pre-merge fetch + fast-forward (smart strategies)", () => {
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

  function setupSyncMock({
    behind,
    ahead,
    fetchFails = false,
  }: {
    behind: number;
    ahead: number;
    fetchFails?: boolean;
  }) {
    let fetchCalled = false;
    let ffCalled = false;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --abbrev-ref HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("rev-list --left-right --count")) {
        return `${behind}\t${ahead}` as any;
      }
      if (cmdStr.includes('git fetch "origin" "main"') || cmdStr.includes("git fetch origin main")) {
        fetchCalled = true;
        if (fetchFails) throw new Error("fatal: unable to access remote");
        return Buffer.from("");
      }
      if (cmdStr.includes("merge --ff-only")) {
        ffCalled = true;
        return Buffer.from("");
      }
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("merge -X theirs --squash") || cmdStr.includes("merge -X ours --squash")) {
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
    return {
      get fetchCalled() { return fetchCalled; },
      get ffCalled() { return ffCalled; },
    };
  }

  it("fast-forwards local main when origin is strictly ahead (default smart-prefer-main)", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    const probe = setupSyncMock({ behind: 2, ahead: 0 });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(probe.fetchCalled).toBe(true);
    expect(probe.ffCalled).toBe(true);
  });

  it("skips fast-forward when local main has unpushed commits (divergent)", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    const probe = setupSyncMock({ behind: 1, ahead: 1 });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(probe.fetchCalled).toBe(true);
    expect(probe.ffCalled).toBe(false);
  });

  it("continues merge when fetch fails (graceful degrade)", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    const probe = setupSyncMock({ behind: 0, ahead: 0, fetchFails: true });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(probe.fetchCalled).toBe(true);
    expect(probe.ffCalled).toBe(false);
    expect(result.merged).toBe(true);
  });

  it("does not fetch for ai-only strategy", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "ai-only",
    });
    const probe = setupSyncMock({ behind: 5, ahead: 0 });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(probe.fetchCalled).toBe(false);
  });

  it("normalizes legacy 'smart' setting and still fetches", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart" as any,
    });
    const probe = setupSyncMock({ behind: 1, ahead: 0 });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(probe.fetchCalled).toBe(true);
    expect(probe.ffCalled).toBe(true);
  });

  it("emits integration-worktree-state once per merge attempt", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    setupSyncMock({ behind: 0, ahead: 0 });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const events = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls
      .map(([event]) => event)
      .filter((event: any) => event?.mutationType === "merge:integration-worktree-state");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      domain: "git",
      mutationType: "merge:integration-worktree-state",
      metadata: expect.objectContaining({
        integrationBranch: "main",
        integrationMode: "cwd-integration",
      }),
    });
  });
});


describe("aiMergeTask abort handling", () => {
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

  it("throws immediately when signal is already aborted", async () => {
    const store = createMockStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(MergeAbortedError);

    expect(store.getTask).not.toHaveBeenCalled();
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
  });

  it("throws MergeAbortedError when aborted during deterministic verification", async () => {
    const controller = new AbortController();
    const store = createMockStore();
    store.getSettings = vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "pnpm test",
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "pnpm test") {
        controller.abort();
        return "" as any;
      }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("merge -X theirs --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    await expect(
      aiMergeTask(store, "/tmp/root", "FN-050", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(MergeAbortedError);
  });
});


describe("aiMergeTask autostash cleanup", () => {
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

  it("drops task autostash after successful merge restore", async () => {
    const store = createMockStore({ id: "FN-050", worktree: "/tmp/root" });
    const stashSha = "1111111111111111111111111111111111111111";
    let dropped = false;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git stash list --format="%H %gd %s"')) {
        return dropped ? "" : `${stashSha} stash@{0} fusion-merger-autostash:FN-050:1`;
      }
      if (cmdStr.includes("git status -z --porcelain")) return " M file.txt\0" as any;
      if (cmdStr.includes("git stash create")) return stashSha as any;
      if (cmdStr.includes("git stash store")) return "" as any;
      if (cmdStr.includes('git stash list --format="%H %gd"')) return dropped ? "" : `${stashSha} stash@{0}`;
      if (cmdStr.includes("git rev-parse stash@{0}")) return stashSha as any;
      if (cmdStr.includes("git stash drop stash@{0}")) {
        dropped = true;
        return "" as any;
      }
      if (cmdStr.includes("git stash apply")) return "" as any;
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

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(dropped).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).includes("git stash drop stash@{0}")),
    ).toBe(true);
  });
});


describe("aiMergeTask — conditional worktree cleanup", () => {
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

  it("does NOT remove worktree when another task references the same path", async () => {
    const worktreePath = "/tmp/root";
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
    const worktreePath = "/tmp/root";
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

  it("clears task.worktree/branch after the worktree is removed", async () => {
    const worktreePath = "/tmp/root";
    const store = createMockStore(
      { id: "FN-050", worktree: worktreePath },
      [
        { id: "FN-050", worktree: worktreePath, column: "in-review" } as Task,
      ],
    );

    await aiMergeTask(store, "/tmp/root", "FN-050");

    // The dashboard's diff endpoint reads task.worktree to decide whether to
    // run a live git diff; leaving it set after removal would point at a
    // foreign branch (when the path is recycled) and surface other tasks'
    // commits as if they belonged to FN-050.
    const updateCalls = (store.updateTask as any).mock.calls;
    const cleared = updateCalls.find(
      ([id, patch]: [string, any]) =>
        id === "FN-050" && patch && patch.worktree === null && patch.branch === null,
    );
    expect(cleared).toBeDefined();
  });

  it("always deletes the branch regardless of worktree sharing", async () => {
    const worktreePath = "/tmp/root";
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
    const worktreePath = "/tmp/root";
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


describe("aiMergeTask — pre-merge rebase abort observability", () => {
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

  it("attempts rebase abort in the task worktree and continues merge when abort succeeds", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    // Fall-through is only allowed for prefer-branch; prefer-main hard-fails (see test below).
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-branch",
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("git rev-parse --abbrev-ref origin/HEAD")) return "origin/main" as any;
      if (cmdStr === "git rev-parse --abbrev-ref HEAD") return "main" as any;
      if (cmdStr.includes("git config --get branch.main.remote")) return "origin" as any;
      if (cmdStr === 'git fetch "origin"') return Buffer.from("");
      if (cmdStr === 'git rebase "origin/main"') {
        throw new Error("pre-merge rebase conflict");
      }
      if (cmdStr === "git rebase --abort") return Buffer.from("");
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+), 0 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(
      mockedExec.mock.calls.some(
        ([command, options]) => command === "git rebase --abort"
          && typeof options === "object"
          && options !== null
          && "cwd" in options
          && (options as { cwd?: string }).cwd === "/tmp/root",
      ),
    ).toBe(true);
    expect(mockedExecSync.mock.calls.some(([command]) => String(command).includes("merge --squash"))).toBe(true);
  });

  it("logs abort cleanup failure details but still falls through to merge", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-branch",
    });

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const abortFailureMessage = "fatal: no rebase in progress";

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("git rev-parse --abbrev-ref origin/HEAD")) return "origin/main" as any;
      if (cmdStr === "git rev-parse --abbrev-ref HEAD") return "main" as any;
      if (cmdStr.includes("git config --get branch.main.remote")) return "origin" as any;
      if (cmdStr === 'git fetch "origin"') return Buffer.from("");
      if (cmdStr === 'git rebase "origin/main"') {
        throw new Error("pre-merge rebase conflict");
      }
      if (cmdStr === "git rebase --abort") {
        const error = new Error("rebase abort failed") as Error & { stderr?: string };
        error.stderr = abortFailureMessage;
        throw error;
      }
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+), 0 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes(`FN-050: failed to abort pre-merge rebase: ${abortFailureMessage}`)),
    ).toBe(true);
    expect(mockedExecSync.mock.calls.some(([command]) => String(command).includes("merge --squash"))).toBe(true);

    warnSpy.mockRestore();
  });

  it("hard-fails when prefer-main is paired with both rebase stages disabled", async () => {
    // After the rebase block was split into two independent stages
    // (remote + local-base), prefer-main is satisfied by either stage running
    // successfully. Only when BOTH are explicitly disabled is the
    // configuration incoherent.
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
      worktreeRebaseBeforeMerge: false,
      worktreeRebaseLocalBase: false,
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git rev-parse --abbrev-ref")) return "main" as any;
      return Buffer.from("");
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      /Incompatible settings.*smart-prefer-main.*worktreeRebase/i,
    );
  });

  it("local-base rebase still runs when remote is unresolvable (independent stages)", async () => {
    // Regression: previously the local-base rebase was nested inside the
    // remote-rebase success path, so a missing remote would skip BOTH. Now
    // the stages are independent — local-base runs even when remote can't
    // resolve, providing prefer-main with a usable safety net.
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
    });

    let localBaseRebaseRan = false;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr === "git rev-parse --abbrev-ref HEAD") return "main" as any;
      // No remote configured: empty config + empty remote list
      if (cmdStr.includes("git config --get branch.")) return "" as any;
      if (cmdStr === "git remote") return "" as any;
      // Local HEAD lookup for Stage 2
      if (cmdStr === "git rev-parse HEAD") return "localhead123";
      // Stage 2 ancestor check fails (not contained), so rebase runs
      if (cmdStr.includes("merge-base --is-ancestor")) {
        const err: any = new Error("not an ancestor");
        err.status = 1;
        throw err;
      }
      // Stage 2 rebase command
      if (cmdStr.includes('git rebase "localhead123"')) {
        localBaseRebaseRan = true;
        return Buffer.from("");
      }
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+), 0 deletions(-)";
      return Buffer.from("");
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(localBaseRebaseRan).toBe(true);
  });

  it("does not silently fall through to -X ours when smart-prefer-main rebase aborts and recovery layers 1+2 fail", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("git rev-parse --abbrev-ref origin/HEAD")) return "origin/main" as any;
      if (cmdStr === "git rev-parse --abbrev-ref HEAD") return "main" as any;
      if (cmdStr.includes("git config --get branch.main.remote")) return "origin" as any;
      if (cmdStr === 'git fetch "origin"') return Buffer.from("");
      if (cmdStr === 'git rebase "origin/main"') {
        throw new Error("pre-merge rebase conflict");
      }
      if (cmdStr === "git rebase --abort") return Buffer.from("");
      return Buffer.from("");
    });

    // Layers 1+2 require successful exec calls we don't stub here, so they
    // fail-soft. After fall-through, AI attempts 1+2 fail (no AI mock) and
    // the merge cascade exhausts. The contract under test: -X ours must
    // NEVER run, even after fall-through, because that would silently
    // re-introduce content main has deleted.
    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow();
    expect(
      mockedExec.mock.calls.some(([command]) => String(command).includes("merge -X ours")),
    ).toBe(false);
    // The fall-through must be visible in the task log so the user can see
    // the recovery attempt and why we declined to silently merge.
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => String(args[1] ?? ""),
    );
    expect(
      logCalls.some((msg: string) => msg.includes("Pre-merge recovery (Layer 3)")),
    ).toBe(true);
    expect(
      logCalls.some((msg: string) => msg.includes("Attempt 3 (-X ours fallback) suppressed")),
    ).toBe(true);
  });

  it("Layer 1 recovery: surgically drops dep commits via rebase --onto when executionStartBranch is set and primary rebase aborted", async () => {
    // Scenario: FN-2849 declared baseBranch=fusion/fn-2729 (a dep). The
    // worktree was forked off FN-2729's tip and inherited its raw commits.
    // FN-2729 was later squash-merged to main. Now the primary rebase onto
    // main aborts because FN-2729's raw commits conflict with their own
    // squashed equivalent + later main commits. Layer 1 detects baseBranch
    // and runs `git rebase --onto <main> <dep-tip> <branch>` to peel off
    // the dep's commits cleanly so the merge can proceed.
    const store = createMockStore(
      {
        id: "FN-2849",
        executionStartBranch: "fusion/fn-2729",
        branch: "fusion/fn-2849",
        worktree: "/tmp/root/.worktrees/coral-stone",
      },
      [{ id: "FN-2849", worktree: "/tmp/root/.worktrees/coral-stone", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
    });

    // Layer happy-path mocks first, then override only what this test needs.
    setupHappyPathExecSync();
    const happyPath = mockedExecSync.getMockImplementation()!;
    const DEP_TIP = "8f54a0e66b419a43703f996df5206d82bb4832e1";
    let primaryRebaseAttempted = false;
    let layer1OntoRebaseRan = false;

    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      const cmdStr = String(cmd);
      // Set up a resolvable origin remote so Stage 1 actually runs.
      if (cmdStr === "git remote") return "origin\n" as any;
      if (cmdStr.includes("git config --get branch.main.remote")) return "origin" as any;
      if (cmdStr.includes("git rev-parse --abbrev-ref origin/HEAD")) return "origin/main" as any;
      if (cmdStr === "git rev-parse --abbrev-ref HEAD") return "main" as any;
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr === 'git fetch "origin"') return Buffer.from("");
      // Resolve dep tip when Layer 1 looks it up via baseBranch.
      if (cmdStr.includes('rev-parse --verify "fusion/fn-2729^{commit}"')) {
        return Buffer.from(DEP_TIP);
      }
      // Stage 1 rebase aborts — this is what triggers Layer 1 recovery.
      if (cmdStr === 'git rebase "origin/main"') {
        primaryRebaseAttempted = true;
        const err: any = new Error(
          'could not apply ca5674d43... feat(FN-2729): Step 2 — adopt NodeHealthDot in InlineCreateCard\nadvice.mergeConflict false\nrebase conflict manually',
        );
        throw err;
      }
      if (cmdStr === "git rebase --abort") return Buffer.from("");
      // Layer 1's surgical rebase succeeds.
      if (
        cmdStr.startsWith("git rebase --onto") &&
        cmdStr.includes(DEP_TIP) &&
        cmdStr.includes("fusion/fn-2849")
      ) {
        layer1OntoRebaseRan = true;
        return Buffer.from("");
      }
      return happyPath(cmd, opts);
    });

    await aiMergeTask(store, "/tmp/root", "FN-2849");

    expect(primaryRebaseAttempted).toBe(true);
    expect(layer1OntoRebaseRan).toBe(true);
    const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => String(args[1] ?? ""),
    );
    expect(
      logCalls.some((msg: string) => msg.includes("Pre-merge recovery (Layer 1)")),
    ).toBe(true);
    // Layer 3 fall-through must NOT have triggered — Layer 1 unblocked.
    expect(
      logCalls.some((msg: string) => msg.includes("Pre-merge recovery (Layer 3)")),
    ).toBe(false);
  });
});


describe("aiMergeTask — task.branch field", () => {
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

  it("uses task.branch when set instead of deriving from task ID", async () => {
    const store = createMockStore(
      { id: "FN-050", branch: "fusion/fn-050-2", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
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
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.branch).toBe("fusion/fn-050");
  });
});


describe("aiMergeTask — merge-target branch resolution", () => {
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

  it("uses task.baseBranch as merge-target context when provided", async () => {
    const store = createMockStore({
      id: "FN-050",
      branch: "feature/fn-050-work",
      baseBranch: "release/2026-05",
      worktree: "/tmp/root",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('git merge-base "feature/fn-050-work" "release/2026-05"'),
      ),
    ).toBe(true);

    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('git merge-base "feature/fn-050-work" "main"'),
      ),
    ).toBe(false);

    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('rev-parse --verify "feature/fn-050-work"'),
      ),
    ).toBe(true);
  });

  it("defaults merge-target context to integrationBranch when task.baseBranch is missing", async () => {
    const store = createMockStore({
      id: "FN-050",
      branch: "feature/fn-050-work",
      baseBranch: undefined,
      worktree: "/tmp/root",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      integrationBranch: "master",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('git merge-base "feature/fn-050-work" "master"'),
      ),
    ).toBe(true);

    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('rev-parse --verify "feature/fn-050-work"'),
      ),
    ).toBe(true);
  });
});


describe("aiMergeTask — no-op short-circuit", () => {
  it("finalizes to done when branch has zero commits ahead of base (including review-level-0 coordination tasks)", async () => {
    const store = createMockStore({
      id: "FN-3834-NOOP",
      branch: "fusion/fn-3834-noop",
      reviewLevel: 0,
      mergeDetails: { mergeTargetBranch: "main" },
      worktree: "/tmp/root/.worktrees/FN-3834-NOOP",
    });

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify") && cmdStr.includes("fusion/fn-3834-noop")) return Buffer.from("ok");
      if (cmdStr.includes("rev-parse --verify") && cmdStr.includes("main")) return Buffer.from("ok");
      if (cmdStr.includes("rev-list --count") && cmdStr.includes("main") && cmdStr.includes("fusion/fn-3834-noop")) return "0\n" as any;
      if (cmdStr.includes("git merge --squash")) {
        throw new Error("merge path should not run");
      }
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-3834-NOOP");

    expect(result.merged).toBe(true);
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-3834-NOOP", "done");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-3834-NOOP",
      expect.objectContaining({
        mergeDetails: expect.objectContaining({
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason: expect.stringContaining("main"),
        }),
      }),
    );
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
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    // Task should still be moved to done
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("does not record commitSha when squash is empty (would be pre-merge HEAD)", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "premergehead999";
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return " 5 files changed, 12 insertions(+), 3 deletions(-)\n" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);

    // mergeDetails should be stored without commitSha (which would be the
    // pre-merge HEAD, unrelated to this task).
    const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const mergeDetailsCall = updateCalls.find((call: any[]) => call[1]?.mergeDetails !== undefined);
    expect(mergeDetailsCall).toBeDefined();
    expect(mergeDetailsCall![1].mergeDetails.commitSha).toBeUndefined();
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


describe("aiMergeTask — retry logic with escalating strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedDetectMergeOverlap.mockResolvedValue({
      overlappingFiles: [],
      recentMainCommitsByFile: new Map(),
    });
    mockedRestoreBranchWinsFiles.mockResolvedValue(undefined);

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

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("attempt 1 success: sets resolutionStrategy to 'ai' and attemptsMade to 1", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
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
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
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

      // git diff-tree for trivial whitespace detection - return real changes (non-trivial)
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }

      // Staged changes check after merge (conflicts present but not staged)
      if (cmdStr.includes("diff --cached --quiet")) {
        return "1"; // Has staged changes from the merge
      }

      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    // Agent will be called and will fail
    mockedCreateFnAgent.mockImplementation(() => {
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

  it("attempt 2 throws when squash fails for a non-conflict reason (no U files)", async () => {
    // Regression: previously any squash error was treated as conflicts. If
    // the failure was non-conflict (hook, IO, lock) and no U files existed,
    // the cascade fell into "all conflicts auto-resolved" and returned true,
    // recording merge metadata for a merge that never happened.
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
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
        // Simulate a non-conflict failure on every squash attempt
        // (e.g. pre-commit hook rejected, repo locked).
        throw new Error("fatal: pre-commit hook returned non-zero status");
      }
      // Critical: no conflicted files surface
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      /failed without producing conflicts/i,
    );
    expect(mergeCallCount).toBeGreaterThanOrEqual(1);
  });

  it("attempt 1 fails, attempt 2 auto-resolves lock files: sets resolutionStrategy to 'auto-resolve'", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
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
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    // Pin the strategy: default is now "smart-prefer-main" (-X ours), but
    // this test specifically exercises the -X theirs fallback path.
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-branch",
    });

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

      // git diff-tree for trivial whitespace detection - return real changes (non-trivial)
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }

      if (cmdStr.includes("diff --cached --quiet")) return hasConflicts ? "1" : "0";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.includes("reset --merge")) return Buffer.from("");

      return Buffer.from("");
    });

    // Agent fails on attempt 2 (when called to resolve complex conflicts)
    mockedCreateFnAgent.mockImplementation(() => {
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

  it("attempt 3 under smart-prefer-main restores overlapping files from the branch by default", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
      mergeStrategyOverlapBehavior: "flip-to-prefer-branch",
    });
    mockedDetectMergeOverlap.mockResolvedValue({
      overlappingFiles: ["packages/core/src/store.ts"],
      recentMainCommitsByFile: new Map([["packages/core/src/store.ts", ["12345678abcdef00"]]]),
    });

    let squashCallCount = 0;
    let oursCallCount = 0;
    let hasConflicts = true;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        squashCallCount++;
        throw new Error("Merge conflict");
      }
      if (cmdStr.includes("merge -X ours --squash")) {
        oursCallCount++;
        hasConflicts = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return hasConflicts ? "packages/core/src/store.ts\n" : "";
      }
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return hasConflicts ? "1" : "1";
      if (cmdStr.includes("git commit")) return Buffer.from("");
      if (cmdStr.includes("branch -d") || cmdStr.includes("worktree remove") || cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ours");
    expect(result.resolutionMethod).toBe("mixed");
    expect(result.attemptsMade).toBe(3);
    expect(oursCallCount).toBe(1);
    expect(mockedRestoreBranchWinsFiles).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      branch: "fusion/fn-050",
      files: expect.any(Set),
    });
    expect([...mockedRestoreBranchWinsFiles.mock.calls[0][0].files]).toEqual(["packages/core/src/store.ts"]);
    expect(squashCallCount).toBe(2);
  });

  it("warn-only logs overlap but keeps legacy -X ours fallback", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
      mergeStrategyOverlapBehavior: "warn-only",
    });
    mockedDetectMergeOverlap.mockResolvedValue({
      overlappingFiles: ["packages/core/src/store.ts"],
      recentMainCommitsByFile: new Map([["packages/core/src/store.ts", ["12345678abcdef00"]]]),
    });

    let hasConflicts = true;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) throw new Error("Merge conflict");
      if (cmdStr.includes("merge -X ours --squash")) {
        hasConflicts = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return hasConflicts ? "packages/core/src/store.ts\n" : "";
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit") || cmdStr.includes("branch -d") || cmdStr.includes("worktree remove") || cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ours");
    expect(result.resolutionMethod).toBe("ours");
    expect(mockedRestoreBranchWinsFiles).not.toHaveBeenCalled();
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Overlap guard detected 1 recent-main overlap file(s) for smart-prefer-main (warn-only)"),
      "text",
      undefined,
      "merger",
    );
  });

  it("ignore preserves legacy behavior and skips overlap detection", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeConflictStrategy: "smart-prefer-main",
      mergeStrategyOverlapBehavior: "ignore",
    });

    let hasConflicts = true;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) throw new Error("Merge conflict");
      if (cmdStr.includes("merge -X ours --squash")) {
        hasConflicts = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return hasConflicts ? "packages/core/src/store.ts\n" : "";
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit") || cmdStr.includes("branch -d") || cmdStr.includes("worktree remove") || cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.resolutionStrategy).toBe("ours");
    expect(mockedDetectMergeOverlap).not.toHaveBeenCalled();
    expect(mockedRestoreBranchWinsFiles).not.toHaveBeenCalled();
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([taskId, message]) => taskId === "FN-050" && String(message).includes("Overlap guard detected")),
    ).toBe(false);
  });

  it("final cleanup reset succeeds after all 3 attempts fail", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const resetCalls: string[] = [];
    const warnSpy = vi.spyOn(mergerLog, "warn");

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        // AI merge attempts fail with conflicts
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("merge -X theirs")) {
        // -X theirs also fails (some conflicts can't be auto-resolved)
        const err = new Error("Merge conflict");
        err.name = "ExecSyncError";
        throw err;
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/always-conflicts.ts\n"; // Always has conflicts
      }

      // Make auto-resolution fail by making git add fail
      if (cmdStr.includes("git add")) {
        const err = new Error("git add failed");
        err.name = "ExecSyncError";
        throw err;
      }

      if (cmdStr.includes("reset --merge")) {
        resetCalls.push(cmdStr);
        return Buffer.from("");
      }

      return Buffer.from("");
    });

    // Agent will also fail
    mockedCreateFnAgent.mockResolvedValue({
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
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes("git reset --merge cleanup failed")),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it("final cleanup reset failure is logged but does not change thrown error", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const resetFailureMessage = "reset failed: dirty worktree";
    const warnSpy = vi.spyOn(mergerLog, "warn");

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash")) {
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("merge -X theirs")) {
        const err = new Error("Merge conflict");
        err.name = "ExecSyncError";
        throw err;
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/always-conflicts.ts\n";
      }

      if (cmdStr.includes("git add")) {
        const err = new Error("git add failed");
        err.name = "ExecSyncError";
        throw err;
      }

      if (cmdStr.includes("reset --merge")) {
        throw new Error(resetFailureMessage);
      }

      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    let thrown: unknown;
    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("all 3 attempts exhausted");
    expect((thrown as Error).message).not.toContain(resetFailureMessage);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.length).toBeGreaterThan(0);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("retry-cleanup reset failure after attempt 1 is logged and merge continues to attempt 2", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "attempt-1 cleanup reset failed";
    let mergeSquashCalls = 0;
    let resetCalls = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+), 0 deletions(-)";

      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        mergeSquashCalls++;
        if (mergeSquashCalls === 1) {
          throw new Error("Merge conflict");
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "0";

      if (cmdStr.includes("reset --merge")) {
        resetCalls++;
        if (resetCalls === 1) {
          throw new Error(resetFailureMessage);
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.attemptsMade).toBe(2);
    expect(mergeSquashCalls).toBe(2);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.some((message) => message.includes("merge-cleanup, attempt 1"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("build-retry reset failure is logged when build verification fails", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      buildRetryCount: 1,
      verificationFixRetries: 0,
    });

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const buildFailureMessage = "Build verification failed: tsc error";
    const resetFailureMessage = "build-retry reset failed";
    let resetCalls = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";

      if (cmdStr.includes("reset --merge")) {
        resetCalls++;
        if (resetCalls === 1) {
          throw new Error(resetFailureMessage);
        }
        return Buffer.from("");
      }

      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error(buildFailureMessage)),
        dispose: vi.fn(),
      },
    } as any);

    let thrown: unknown;
    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(buildFailureMessage);
    expect((thrown as Error).message).not.toContain(resetFailureMessage);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.some((message) => message.includes("build-retry"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("error-path retry cleanup reset failure is logged and merge still retries", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "retry cleanup reset failed";
    let mergeSquashCalls = 0;
    let resetCalls = 0;
    let usedFallbackStrategy = false;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123";
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)";

      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        mergeSquashCalls++;
        if (mergeSquashCalls === 1) {
          throw new Error("Merge conflict");
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("merge -X theirs --squash") || cmdStr.includes("merge -X ours --squash")) {
        usedFallbackStrategy = true;
        return Buffer.from("");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        if (!usedFallbackStrategy && mergeSquashCalls === 2) {
          return "src/complex.ts\n";
        }
        return "";
      }

      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const value = 2;\n-const value = 1;";
        throw error;
      }

      if (cmdStr.includes("diff --cached --quiet")) return "1";

      if (cmdStr.includes("git commit")) return Buffer.from("");

      if (cmdStr.includes("reset --merge")) {
        resetCalls++;
        if (resetCalls === 2) {
          throw new Error(resetFailureMessage);
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed on attempt 2")),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.attemptsMade).toBe(3);
    expect(mergeSquashCalls).toBe(2);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.some((message) => message.includes("merge-retry, attempt 2"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("tracks resolutionStrategy as 'ai' when attempt 1 succeeds even with autoResolve enabled", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
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


describe("aiMergeTask — reset cleanup failure diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("retry-cleanup reset failure after failed attempt is logged", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "dirty worktree";
    let resetCalls = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";
      if (cmdStr.includes("show --shortstat")) return "1 file changed, 1 insertion(+), 0 deletions(-)";

      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("merge -X theirs --squash")) {
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return "src/always-conflicts.ts\n";
      }

      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }

      if (cmdStr.includes("git add")) {
        const err = new Error("git add failed");
        err.name = "ExecSyncError";
        throw err;
      }

      if (cmdStr.includes("reset --merge")) {
        resetCalls++;
        if (resetCalls === 1) {
          throw new Error(resetFailureMessage);
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);

    let thrown: unknown;
    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("all 3 attempts exhausted");
    expect((thrown as Error).message).not.toContain(resetFailureMessage);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.some((message) => message.includes("merge-cleanup"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("error-path retry cleanup reset failure is logged", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "retry cleanup reset failed";
    let mergeSquashCalls = 0;
    let resetCalls = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git log")) return "- feat: something";
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed";

      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        mergeSquashCalls++;
        if (mergeSquashCalls === 1) {
          throw new Error("git merge failed: exit code 128");
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("merge -X theirs --squash") || cmdStr.includes("merge -X ours --squash")) {
        throw new Error("Merge conflict");
      }

      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";

      if (cmdStr.includes("reset --merge")) {
        resetCalls++;
        if (resetCalls === 2) {
          throw new Error(resetFailureMessage);
        }
        return Buffer.from("");
      }

      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("git merge failed: exit code 128")),
        dispose: vi.fn(),
      },
    } as any);

    let thrown: unknown;
    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("all 3 attempts exhausted");
    expect((thrown as Error).message).not.toContain(resetFailureMessage);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    expect(cleanupWarnMessages.some((message) => message.includes("merge-retry"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });

  it("build-verification reset failure is logged in executeMergeAttempt", async () => {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root" },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      buildCommand: "pnpm build",
      buildRetryCount: 0,
      verificationFixRetries: 0,
    });

    const warnSpy = vi.spyOn(mergerLog, "warn");
    const resetFailureMessage = "lock file busy";

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const reportTool = opts.customTools?.find((t: any) => t.name === "fn_report_build_failure");
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            if (reportTool) {
              await reportTool.execute("tool-call-1", { message: "build failed" });
            }
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
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("diff --cached --quiet")) return "1";

      if (cmdStr.includes("reset --merge")) {
        throw new Error(resetFailureMessage);
      }

      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });

    let thrown: unknown;
    try {
      await aiMergeTask(store, "/tmp/root", "FN-050");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Build verification failed");
    expect((thrown as Error).message).not.toContain(resetFailureMessage);

    const cleanupWarnMessages = warnSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("git reset --merge cleanup failed"));

    // Reset cleanup now runs from mergeAttempt's catch handler (after the
    // squash state is preserved across the build-failure throw site for the
    // in-merge fix path). With both verificationFixRetries=0 and
    // buildRetryCount=0 the rollback fires from the "no retries left" branch.
    expect(cleanupWarnMessages.some((message) => message.includes("build-verification rollback"))).toBe(true);
    expect(cleanupWarnMessages.some((message) => message.includes(resetFailureMessage))).toBe(true);

    warnSpy.mockRestore();
  });
});

// ── New Smart Conflict Resolution API Tests ────────────────────────────

describe("aiMergeTask post-squash audit gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: [],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    });
  });

  function setupAutoResolvedMergeExecSync() {
    let squashCalls = 0;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123" as any;
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-list --count")) return "1\n" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        squashCalls += 1;
        if (squashCalls === 2) {
          const error = new Error("merge conflict");
          (error as Error & { stdout?: string; stderr?: string }).stdout = "";
          (error as Error & { stdout?: string; stderr?: string }).stderr = "CONFLICT";
          throw error;
        }
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "pnpm-lock.yaml\n" as any;
      if (cmdStr.includes("checkout --ours --") || cmdStr.includes("git add -- pnpm-lock.yaml")) return Buffer.from("");
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("git commit ")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  function createAuditStore(
    overrides: Partial<typeof DEFAULT_SETTINGS> = {},
    taskOverrides: Partial<Task> & { prompt?: string } = {},
  ) {
    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root", ...taskOverrides } as Task & { prompt?: string },
      [{ id: "FN-050", worktree: "/tmp/root", column: "in-review", ...taskOverrides } as Task & { prompt?: string }],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      testCommand: "pnpm test",
      mergeConflictStrategy: "ai-only",
      directMergeCommitStrategy: "auto",
      worktreeRebaseBeforeMerge: false,
      worktreeRebaseLocalBase: false,
      ...overrides,
    });
    return store;
  }

  function setupNoConflictMergeExecSync() {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123" as any;
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-list --count")) return "1\n" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("git commit ")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "2 files changed, 4 insertions(+), 1 deletion(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  function setupAttempt3FallbackMergeExecSync() {
    let hasConflicts = true;
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123" as any;
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-list --count")) return "1\n" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) {
        throw new Error("Merge conflict");
      }
      if (cmdStr.includes("merge -X ours --squash")) {
        hasConflicts = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("diff --name-only --diff-filter=U")) {
        return hasConflicts ? "src/complex.ts\n" : "";
      }
      if (cmdStr.includes("diff-tree")) {
        const error = new Error("exit code 1") as any;
        error.stdout = "+const x = 2;\n-const x = 1;";
        throw error;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("git commit ")) return Buffer.from("");
      if (cmdStr.includes("show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D") || cmdStr.includes("worktree remove") || cmdStr.includes("reset --merge")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  function setupEmptySquashMergeExecSync() {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123" as any;
      if (cmdStr.includes("git log")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("rev-list --count")) return "1\n" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "0 files changed" as any;
      if (cmdStr.includes("merge --squash") && !cmdStr.includes("-X")) return Buffer.from("");
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("diff --cached --quiet")) return "0" as any;
      if (cmdStr.includes("show --shortstat")) return "0 files changed" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D") || cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  function setupRebaseRouteExecSync(treeOverrides?: Record<string, string | Error>) {
    let headIndex = 0;
    const landedHeads = ["landedcommit001", "landedcommit002"];
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) {
        return (headIndex > 0 ? landedHeads[Math.min(headIndex - 1, landedHeads.length - 1)] : "basehead123") as any;
      }
      if (cmdStr.includes("^{tree}") && treeOverrides) {
        for (const [ref, value] of Object.entries(treeOverrides)) {
          if (cmdStr.includes(`git rev-parse ${ref}^{tree}`) || cmdStr.includes(`git rev-parse "${ref}"^{tree}`)) {
            if (value instanceof Error) throw value;
            return `${value}\n` as any;
          }
        }
      }
      if (cmdStr.includes('git rev-parse "main"') || cmdStr.includes("git rev-parse main")) return "basehead123" as any;
      if (cmdStr.includes('git rev-list --count "main..fusion/fn-050"')) return "2\n" as any;
      if (cmdStr.includes('git rev-list --reverse "main..fusion/fn-050"') || cmdStr.includes('git rev-list --reverse "basehead123..fusion/fn-050"')) {
        return "commit-a\ncommit-b\ncommit-c\n" as any;
      }
      if (cmdStr.includes('git log -1 --format=%s "commit-a"')) return "fix: substantive one" as any;
      if (cmdStr.includes('git log -1 --format=%s "commit-b"')) return "chore: changeset only" as any;
      if (cmdStr.includes('git log -1 --format=%s "commit-c"')) return "feat: substantive two" as any;
      if (cmdStr.includes('git log "main..fusion/fn-050" --format="- %s"')) return "- fix: substantive one\n- chore: changeset only\n- feat: substantive two" as any;
      if (cmdStr.includes("git log -1 --pretty=%B")) return "commit body" as any;
      if (cmdStr.includes('git diff-tree --root --no-commit-id --name-status -r "commit-a"')) return "M\tsrc/feature-a.ts\n" as any;
      if (cmdStr.includes('git diff-tree --root --no-commit-id --name-status -r "commit-b"')) return "A\t.changeset/fn-050.md\n" as any;
      if (cmdStr.includes('git diff-tree --root --no-commit-id --name-status -r "commit-c"')) return "M\tsrc/feature-b.ts\n" as any;
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "2 files changed" as any;
      if (cmdStr.includes('git cherry-pick "commit-a"') || cmdStr.includes('git cherry-pick "commit-b"') || cmdStr.includes('git cherry-pick "commit-c"')) {
        headIndex += 1;
        return Buffer.from("");
      }
      if (cmdStr.includes("git -c trailer.ifExists=addIfDifferent commit --amend --no-edit")) return Buffer.from("");
      if (cmdStr.includes('git diff --shortstat "basehead123..HEAD"')) return "2 files changed, 6 insertions(+), 1 deletion(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D") || cmdStr.includes("worktree remove")) return Buffer.from("");
      return Buffer.from("");
    });
  }

  it("moves the task to done when the post-squash audit is clean", async () => {
    setupAutoResolvedMergeExecSync();
    const store = createAuditStore();

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "squash",
      squashSha: "mergedcommit123",
    });
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "post-squash audit clean", "text", undefined, "merger");
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("routes multi-substantive auto branches through rebase range audit", async () => {
    setupRebaseRouteExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/feature-a.ts", "src/feature-b.ts"],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    });
    const store = createAuditStore();

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
    });
    expect(store.appendAgentLog).toHaveBeenCalledWith("FN-050", "post-rebase range audit clean", "text", undefined, "merger");
  });

  it("degrades to squash fallback when no usable base can be resolved on the rebase route", async () => {
    setupRebaseRouteExecSync();
    const baseImpl = mockedExecSync.getMockImplementation();
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git rev-parse "main"')) return "" as any;
      if (cmdStr.includes('git rev-parse --verify "abc123^{commit}"')) return "abc123\n" as any;
      if (cmdStr.includes('git merge-base --is-ancestor "abc123" "landedcommit002"')) return "" as any;
      if (cmdStr.includes('git rev-list --reverse "..fusion/fn-050"')) return "commit-a\ncommit-b\ncommit-c\n" as any;
      if (cmdStr.includes('git diff --shortstat "..HEAD"')) return "2 files changed, 6 insertions(+), 1 deletion(-)" as any;
      if (cmdStr.includes("git show --shortstat --format= HEAD")) return "2 files changed, 6 insertions(+), 1 deletion(-)" as any;
      return baseImpl ? baseImpl(cmd) : Buffer.from("");
    });
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    });
    const store = createAuditStore({}, { prompt: "**Direct Merge Commit Strategy:** always-rebase" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith(expect.objectContaining({
      strategy: "squash",
      squashSha: "landedcommit002",
    }));
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-merge audit degraded to single-commit squash fallback"),
      "text",
      undefined,
      "merger",
    );
  });

  it("logs degraded squash fallback when no rebase range base can be resolved", async () => {
    setupRebaseRouteExecSync();
    const baseImpl = mockedExecSync.getMockImplementation();
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('git rev-parse "main"')) return "" as any;
      if (cmdStr.includes("git rev-parse --verify") && cmdStr.includes("^{commit}")) return "landedcommit002\n" as any;
      if (cmdStr.includes("git merge-base") && cmdStr.includes("landedcommit002") && cmdStr.includes("main")) return "landedcommit002\n" as any;
      if (cmdStr.includes('git rev-list --reverse "..fusion/fn-050"')) return "commit-a\ncommit-b\ncommit-c\n" as any;
      if (cmdStr.includes('git diff --shortstat "..HEAD"')) return "2 files changed, 6 insertions(+), 1 deletion(-)" as any;
      if (cmdStr.includes("git show --shortstat --format= HEAD")) return "2 files changed, 6 insertions(+), 1 deletion(-)" as any;
      return baseImpl ? baseImpl(cmd) : Buffer.from("");
    });
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "landedcommit002",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/feature-b.ts"],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    });
    const store = createAuditStore({}, { prompt: "**Direct Merge Commit Strategy:** always-rebase" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith(expect.objectContaining({
      strategy: "squash",
      squashSha: "landedcommit002",
    }));
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-merge audit degraded to single-commit squash fallback"),
      "text",
      undefined,
      "merger",
    );
  });

  it("honors the per-task always-rebase override", async () => {
    setupRebaseRouteExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [],
      issueCount: 0,
      clean: true,
    });
    const store = createAuditStore({}, { prompt: "**Direct Merge Commit Strategy:** always-rebase" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
    });
  });

  it("keeps the squash path for single-substantive branches in auto mode", async () => {
    setupAutoResolvedMergeExecSync();
    const store = createAuditStore();

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "squash",
      squashSha: "mergedcommit123",
    });
  });

  it("clears overlap-only post-rebase findings when branch-tip tree is verified despite audit ref drift (FN-4344)", async () => {
    setupRebaseRouteExecSync({
      landedcommit002: "tree-unverified",
      "fusion/fn-050": "tree-verified",
    });
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/feature-a.ts"],
      touchedFileOverlaps: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      findings: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      issueCount: 1,
      clean: false,
    });
    mockedExistsSync.mockReturnValue(false);
    const store = createAuditStore({ postMergeAuditMode: "block", testCommand: undefined, buildCommand: undefined }, { branch: "fusion/fn-050" });
    vi.mocked(store.getVerificationCacheHit).mockImplementation((treeSha: string) => (
      treeSha === "tree-verified" ? { recordedAt: "2026-05-13T00:00:00.000Z", taskId: "FN-049" } : null
    ));

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-rebase audit overlap cleared by deterministic verification"),
      "text",
      expect.any(String),
      "merger",
    );
  });

  it("keeps blocking overlap-only post-rebase findings when neither ref tree is verified (FN-4344)", async () => {
    setupRebaseRouteExecSync({
      landedcommit002: "tree-unverified-a",
      "fusion/fn-050": "tree-unverified-b",
    });
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/feature-a.ts"],
      touchedFileOverlaps: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      findings: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      issueCount: 1,
      clean: false,
    });
    mockedExistsSync.mockReturnValue(false);
    const store = createAuditStore({ postMergeAuditMode: "block", testCommand: undefined, buildCommand: undefined }, { branch: "fusion/fn-050" });
    vi.mocked(store.getVerificationCacheHit).mockReturnValue(null);

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(/post-rebase range audit blocked auto-completion/);

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-050", "done");
    expect(store.updateTask).toHaveBeenCalledWith("FN-050", { status: null });
  });

  it("continues to branch-tip lookup when audit ref tree is unresolvable and still short-circuits on cache hit (FN-4344)", async () => {
    const auditTreeError = new Error("fatal: bad revision 'landedcommit002^{tree}'");
    setupRebaseRouteExecSync({
      landedcommit002: auditTreeError,
      "fusion/fn-050": "tree-verified",
    });
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "rebase",
      rangeBaseSha: "basehead123",
      rangeHeadSha: "landedcommit002",
      parentSha: "basehead123",
      auditTargetLabel: "basehead123..landedcommit002",
      lookback: 30,
      branchSubjects: ["fix: substantive one", "feat: substantive two"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/feature-a.ts"],
      touchedFileOverlaps: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      findings: [{
        type: "touched-file-overlap",
        file: "src/feature-a.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: overlap" }],
      }],
      issueCount: 1,
      clean: false,
    });
    mockedExistsSync.mockReturnValue(false);
    const store = createAuditStore({ postMergeAuditMode: "block", testCommand: undefined, buildCommand: undefined }, { branch: "fusion/fn-050" });
    vi.mocked(store.getVerificationCacheHit).mockImplementation((treeSha: string) => (
      treeSha === "tree-verified" ? { recordedAt: "2026-05-13T00:00:00.000Z", taskId: "FN-049" } : null
    ));
    const warnSpy = vi.spyOn(mergerLog, "warn");

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not resolve post-merge audit verification tree for ref landedcommit002"));
    warnSpy.mockRestore();
  });

  it("honors the per-task always-squash override", async () => {
    setupAutoResolvedMergeExecSync();
    const store = createAuditStore({}, { prompt: "**Direct Merge Commit Strategy:** always-squash" });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "squash",
      squashSha: "mergedcommit123",
    });
  });

  it("blocks completion and logs duplicate-subject findings", async () => {
    setupAutoResolvedMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: duplicate subject"],
      recentMainSubjects: ["feat: duplicate subject"],
      duplicateSubjects: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      touchedFiles: ["src/example.ts"],
      touchedFileOverlaps: [],
      findings: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      issueCount: 1,
      clean: false,
    });
    const store = createAuditStore({ postMergeAuditMode: "block" });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "FN-050: post-squash audit blocked auto-completion for mergedco",
    );

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-squash audit blocked auto-completion"),
      "tool_error",
      expect.stringContaining("Duplicate-subject risks:\n- feat: duplicate subject"),
      "merger",
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-050", { status: null });
  });

  it("blocks completion and logs touched-file-overlap findings", async () => {
    setupAutoResolvedMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: branch change"],
      recentMainSubjects: [],
      duplicateSubjects: [],
      touchedFiles: ["src/shared.ts"],
      touchedFileOverlaps: [{
        type: "touched-file-overlap",
        file: "src/shared.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: recent main change" }],
      }],
      findings: [{
        type: "touched-file-overlap",
        file: "src/shared.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: recent main change" }],
      }],
      issueCount: 1,
      clean: false,
    });
    const store = createAuditStore({ postMergeAuditMode: "block" });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "FN-050: post-squash audit blocked auto-completion for mergedco",
    );

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-squash audit blocked auto-completion"),
      "tool_error",
      expect.stringContaining("Touched-file overlap risks:\n- src/shared.ts\n  - abc1234 fix: recent main change"),
      "merger",
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-050", { status: null });
  });

  it("blocks completion and logs combined duplicate-subject and touched-file findings", async () => {
    setupAutoResolvedMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: duplicate subject", "feat: branch change"],
      recentMainSubjects: ["feat: duplicate subject"],
      duplicateSubjects: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      touchedFiles: ["src/shared.ts"],
      touchedFileOverlaps: [{
        type: "touched-file-overlap",
        file: "src/shared.ts",
        recentMainCommits: [{ sha: "abc1234", subject: "fix: recent main change" }],
      }],
      findings: [
        { type: "duplicate-subject", subject: "feat: duplicate subject" },
        {
          type: "touched-file-overlap",
          file: "src/shared.ts",
          recentMainCommits: [{ sha: "abc1234", subject: "fix: recent main change" }],
        },
      ],
      issueCount: 2,
      clean: false,
    });
    const store = createAuditStore({ postMergeAuditMode: "block" });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(/post-squash audit blocked auto-completion/);

    expect(vi.mocked(store.moveTask).mock.calls.some(([, column]) => column === "done")).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith("FN-050", { status: null });
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("post-squash audit blocked auto-completion"),
      "tool_error",
      expect.stringContaining("Duplicate-subject risks:\n- feat: duplicate subject\n\nTouched-file overlap risks:\n- src/shared.ts\n  - abc1234 fix: recent main change"),
      "merger",
    );
  });

  it("skips the post-squash audit when the squash succeeds without auto-resolution", async () => {
    setupNoConflictMergeExecSync();
    const store = createAuditStore();

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(mockedAuditSquashMerge).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message]) => String(message).includes("post-squash audit clean") || String(message).includes("post-squash audit blocked auto-completion")),
    ).toBe(false);
  });

  it("runs the post-squash audit after the attempt 3 -X ours fallback path", async () => {
    setupAttempt3FallbackMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: duplicate subject"],
      recentMainSubjects: ["feat: duplicate subject"],
      duplicateSubjects: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      issueCount: 1,
      clean: false,
    });
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("Agent failed")),
        dispose: vi.fn(),
      },
    } as any);
    const store = createAuditStore({
      mergeConflictStrategy: "smart-prefer-main",
      worktreeRebaseBeforeMerge: true,
      postMergeAuditMode: "block",
    });

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(/post-squash audit blocked auto-completion/);

    expect(mockedAuditSquashMerge).toHaveBeenCalledWith({
      rootDir: "/tmp/root",
      strategy: "squash",
      squashSha: "mergedcommit123",
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-050", { status: null });
  });

  it("skips the post-merge audit entirely when postMergeAuditMode=off (FN-4333)", async () => {
    setupAutoResolvedMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: duplicate subject"],
      recentMainSubjects: ["feat: duplicate subject"],
      duplicateSubjects: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      issueCount: 1,
      clean: false,
    });
    const store = createAuditStore({ postMergeAuditMode: "off" });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(mockedAuditSquashMerge).not.toHaveBeenCalled();
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message]) => String(message).includes("audit blocked auto-completion")),
    ).toBe(false);
  });

  it("continues when postMergeAuditMode=warn even with dirty audit findings (FN-4333)", async () => {
    setupAutoResolvedMergeExecSync();
    mockedAuditSquashMerge.mockResolvedValue({
      strategy: "squash",
      squashSha: "mergedcommit123",
      parentSha: "parent123",
      auditTargetLabel: "mergedcommit123",
      squashSubject: "feat: squash merge",
      lookback: 30,
      branchSubjects: ["feat: duplicate subject"],
      recentMainSubjects: ["feat: duplicate subject"],
      duplicateSubjects: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      touchedFiles: [],
      touchedFileOverlaps: [],
      findings: [{ type: "duplicate-subject", subject: "feat: duplicate subject" }],
      issueCount: 1,
      clean: false,
    });
    const store = createAuditStore({ postMergeAuditMode: "warn" });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message, type]) => type === "tool_error" && String(message).includes("audit blocked auto-completion")),
    ).toBe(false);
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(
        ([, message]) => String(message).includes("post-squash audit found 1 risk(s) — continuing"),
      ),
    ).toBe(true);
  });

  it("skips the post-squash audit when the squash merge is empty", async () => {
    setupEmptySquashMergeExecSync();
    const store = createAuditStore();

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(mockedAuditSquashMerge).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
    expect(
      vi.mocked(store.appendAgentLog).mock.calls.some(([, message]) => String(message).includes("post-squash audit blocked auto-completion")),
    ).toBe(false);
  });
});


