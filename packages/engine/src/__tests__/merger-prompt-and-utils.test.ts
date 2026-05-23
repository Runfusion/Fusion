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


describe("push-after-merge", () => {
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

  function setupAiMergeExecSyncWithPush(pushBehavior?: (attempt: number) => void) {
    let pushAttempts = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);

      if (cmdStr.includes("rev-parse --verify REBASE_HEAD")) {
        const err = new Error("fatal: Needed a single revision") as Error & { status?: number };
        err.status = 128;
        throw err;
      }
      if (cmdStr.includes("rev-parse --verify")) return Buffer.from("abc123");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("git rev-parse --abbrev-ref origin/HEAD")) return "origin/main" as any;
      if (cmdStr === "git rev-parse HEAD" || cmdStr.startsWith("git rev-parse HEAD ")) return "mergedcommit123" as any;
      if (cmdStr.includes("git log HEAD..")) return "- feat: something" as any;
      if (cmdStr.includes("merge-base")) return Buffer.from("abc123");
      if (cmdStr.includes("git diff") && cmdStr.includes("--stat")) return "1 file changed" as any;
      if (cmdStr.includes("git merge --squash")) return Buffer.from("");
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "" as any;
      if (cmdStr.includes("git diff --cached --quiet")) {
        // First call: squash-empty check, second call: post-agent commit verification.
        return "1" as any;
      }
      if (cmdStr.startsWith("git commit ")) return Buffer.from("");
      if (cmdStr.includes("git show --shortstat")) return "3 files changed, 10 insertions(+), 2 deletions(-)" as any;
      if (cmdStr.includes("branch -d") || cmdStr.includes("branch -D")) return Buffer.from("");
      if (cmdStr.includes("worktree remove")) return Buffer.from("");
      if (cmdStr.startsWith("git pull --rebase")) return Buffer.from("");
      if (cmdStr.startsWith("git push ")) {
        pushAttempts += 1;
        pushBehavior?.(pushAttempts);
        return Buffer.from("");
      }

      return Buffer.from("");
    });

  }

  it("pushes merged result when pushAfterMerge is enabled", async () => {
    setupAiMergeExecSyncWithPush();

    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
      mergeStrategy: "direct",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.pushedToRemote).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).includes('git pull --rebase "origin" "main"')),
    ).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).includes('git push "origin" "main"')),
    ).toBe(true);
  });

  it("does not push when pushAfterMerge is disabled (default)", async () => {
    setupAiMergeExecSyncWithPush();

    const store = createMockStore();
    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.pushedToRemote).toBeUndefined();
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("git pull --rebase")),
    ).toBe(false);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("git push ")),
    ).toBe(false);
  });

  it("does not push for pull-request merge strategy", async () => {
    setupAiMergeExecSyncWithPush();

    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      mergeStrategy: "pull-request",
      pushAfterMerge: true,
      pushRemote: "origin",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.pushedToRemote).toBeUndefined();
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("git pull --rebase")),
    ).toBe(false);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("git push ")),
    ).toBe(false);
  });

  it("records push error but still completes merge when push fails", async () => {
    setupAiMergeExecSyncWithPush((attempt) => {
      if (attempt === 1) {
        const err = new Error("failed to push some refs");
        (err as Error & { stderr?: string }).stderr = "remote: permission denied";
        throw err;
      }
    });

    const store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
      mergeStrategy: "direct",
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(result.merged).toBe(true);
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("permission denied");
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("uses custom remote and branch when configured", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.startsWith("git pull --rebase \"upstream\" \"main\"")) return Buffer.from("");
      if (cmdStr.startsWith("git push \"upstream\" \"main\"")) return Buffer.from("");
      if (cmdStr.includes("rev-parse --verify REBASE_HEAD")) {
        const err = new Error("fatal: Needed a single revision");
        throw err;
      }
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await pushToRemoteAfterMerge(store, "/tmp/root", "FN-050", {
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "upstream main",
    });

    expect(result.pushed).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith('git pull --rebase "upstream" "main"')),
    ).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith('git push "upstream" "main"')),
    ).toBe(true);
  });

  it("auto-resolves lock-file rebase conflicts and continues", async () => {
    let rebaseInProgress = false;
    let hasConflicts = false;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);

      if (cmdStr.startsWith('git pull --rebase "origin" "main"')) {
        hasConflicts = true;
        rebaseInProgress = true;
        const err = new Error("rebase conflict") as Error & { stderr?: string };
        err.stderr = "CONFLICT (content): Merge conflict in pnpm-lock.yaml";
        throw err;
      }
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) {
        return hasConflicts ? "pnpm-lock.yaml" as any : "" as any;
      }
      if (cmdStr.includes("checkout --ours") && cmdStr.includes("pnpm-lock.yaml")) return Buffer.from("");
      if (cmdStr.includes("git add") && cmdStr.includes("pnpm-lock.yaml")) {
        hasConflicts = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("git rev-parse --verify REBASE_HEAD")) {
        if (rebaseInProgress) return "rebasehead" as any;
        const err = new Error("fatal: Needed a single revision") as Error & { status?: number };
        err.status = 128;
        throw err;
      }
      if (cmdStr.startsWith("GIT_EDITOR=true git rebase --continue")) {
        rebaseInProgress = false;
        return Buffer.from("");
      }
      if (cmdStr.startsWith('git push "origin" "main"')) return Buffer.from("");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;

      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await pushToRemoteAfterMerge(store, "/tmp/root", "FN-050", {
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
    });

    expect(result.pushed).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).includes("checkout --ours") && String(call[0]).includes("pnpm-lock.yaml")),
    ).toBe(true);
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("GIT_EDITOR=true git rebase --continue")),
    ).toBe(true);
  });

  it("uses AI to resolve complex rebase conflicts", async () => {
    let rebaseInProgress = false;
    let hasConflicts = false;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          hasConflicts = false;
        }),
        dispose: vi.fn(),
      },
    } as any);

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);

      if (cmdStr.startsWith('git pull --rebase "origin" "main"')) {
        hasConflicts = true;
        rebaseInProgress = true;
        const err = new Error("rebase conflict") as Error & { stderr?: string };
        err.stderr = "CONFLICT (content): Merge conflict in src/app.ts";
        throw err;
      }
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) {
        return hasConflicts ? "src/app.ts" as any : "" as any;
      }
      if (cmdStr.startsWith("git diff-tree -p -w")) return "@@\n-foo\n+bar" as any;
      if (cmdStr.includes("git rev-parse --verify REBASE_HEAD")) {
        if (rebaseInProgress) return "rebasehead" as any;
        const err = new Error("fatal: Needed a single revision") as Error & { status?: number };
        err.status = 128;
        throw err;
      }
      if (cmdStr.startsWith("GIT_EDITOR=true git rebase --continue")) {
        rebaseInProgress = false;
        return Buffer.from("");
      }
      if (cmdStr.startsWith('git push "origin" "main"')) return Buffer.from("");
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;

      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await pushToRemoteAfterMerge(store, "/tmp/root", "FN-050", {
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
    });

    expect(result.pushed).toBe(true);
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  it("retries push once after non-fast-forward rejection", async () => {
    let pushAttempts = 0;
    let pullAttempts = 0;

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.startsWith('git pull --rebase "origin" "main"')) {
        pullAttempts += 1;
        return Buffer.from("");
      }
      if (cmdStr.startsWith('git push "origin" "main"')) {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          const err = new Error("non-fast-forward") as Error & { stderr?: string };
          err.stderr = "[rejected] main -> main (non-fast-forward)";
          throw err;
        }
        return Buffer.from("");
      }
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;
      if (cmdStr.includes("git rev-parse --verify REBASE_HEAD")) {
        const err = new Error("fatal: Needed a single revision") as Error & { status?: number };
        err.status = 128;
        throw err;
      }
      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await pushToRemoteAfterMerge(store, "/tmp/root", "FN-050", {
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
    });

    expect(result.pushed).toBe(true);
    expect(pullAttempts).toBe(2);
    expect(pushAttempts).toBe(2);
  });

  it("aborts rebase when conflicts remain unresolved", async () => {
    let rebaseInProgress = false;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);

      if (cmdStr.startsWith('git pull --rebase "origin" "main"')) {
        rebaseInProgress = true;
        const err = new Error("rebase conflict") as Error & { stderr?: string };
        err.stderr = "CONFLICT (content): Merge conflict in src/app.ts";
        throw err;
      }
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "src/app.ts" as any;
      if (cmdStr.startsWith("git diff-tree -p -w")) return "@@\n-foo\n+bar" as any;
      if (cmdStr.includes("git rev-parse --verify REBASE_HEAD")) {
        if (rebaseInProgress) return "rebasehead" as any;
        const err = new Error("fatal: Needed a single revision") as Error & { status?: number };
        err.status = 128;
        throw err;
      }
      if (cmdStr.startsWith("git rebase --abort")) {
        rebaseInProgress = false;
        return Buffer.from("");
      }
      if (cmdStr.includes("git symbolic-ref --short HEAD")) return "main" as any;

      return Buffer.from("");
    });

    const store = createMockStore();
    const result = await pushToRemoteAfterMerge(store, "/tmp/root", "FN-050", {
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      pushAfterMerge: true,
      pushRemote: "origin",
    });

    expect(result.pushed).toBe(false);
    expect(result.error).toContain("unable to resolve rebase conflicts");
    expect(
      mockedExecSync.mock.calls.some((call) => String(call[0]).startsWith("git rebase --abort")),
    ).toBe(true);
  });
});


describe("buildSourceIssueRef", () => {
  it("returns owner/repo#number for GitHub source issues", async () => {
    const { buildSourceIssueRef } = await import("../merger.js");
    expect(buildSourceIssueRef({
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "123",
      issueNumber: 123,
    })).toBe("runfusion/fusion#123");
  });

  it("falls back to externalIssueId when issueNumber is missing", async () => {
    const { buildSourceIssueRef } = await import("../merger.js");
    expect(buildSourceIssueRef({
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "321",
    } as any)).toBe("runfusion/fusion#321");
  });

  it("returns empty string for non-GitHub providers", async () => {
    const { buildSourceIssueRef } = await import("../merger.js");
    expect(buildSourceIssueRef({
      provider: "gitlab",
      repository: "group/project",
      externalIssueId: "123",
      issueNumber: 123,
    })).toBe("");
  });

  it("returns empty string for nullish source issue", async () => {
    const { buildSourceIssueRef } = await import("../merger.js");
    expect(buildSourceIssueRef(undefined)).toBe("");
    expect(buildSourceIssueRef(null)).toBe("");
    expect(buildSourceIssueRef({
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "not-a-number",
    } as any)).toBe("");
  });
});


describe("buildMergePrompt — truncation behavior", () => {
  it("truncates commit log when exceeding MERGE_COMMIT_LOG_MAX_CHARS", async () => {
    const { buildMergePrompt } = await import("../merger.js");

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
    const { buildMergePrompt } = await import("../merger.js");

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
    const { buildMergePrompt } = await import("../merger.js");

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
    const { buildMergePrompt } = await import("../merger.js");

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

  it("includes co-author trailer arg in no-conflicts commit instruction", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: false,
      authorArg: ' -m "Co-authored-by: Fusion <noreply@runfusion.ai>"',
    });

    expect(prompt).toContain('Be sure to append `-m "Co-authored-by: Fusion <noreply@runfusion.ai>"` to the commit command');
  });

  it("includes co-author trailer arg in conflicts commit instruction", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: true,
      authorArg: ' -m "Co-authored-by: CustomBot <bot@example.com>"',
    });

    expect(prompt).toContain('Be sure to append `-m "Co-authored-by: CustomBot <bot@example.com>"` to the commit command');
  });

  it("omits author instruction when authorArg is not provided", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: false,
    });

    expect(prompt).not.toContain("Be sure to include");
    expect(prompt).toContain("Write and run the `git commit` command with a good message summarizing the work");
  });

  it("handles empty authorArg gracefully", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: false,
      authorArg: "",
    });

    expect(prompt).not.toContain("Be sure to include");
  });

  it("includes source issue reference guidance when provided", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: false,
      sourceIssueRef: "runfusion/fusion#2915",
    });

    expect(prompt).toContain("Include this in the commit message body:");
    expect(prompt).toContain("Ref: runfusion/fusion#2915");
  });

  it("omits source issue reference guidance when not provided", async () => {
    const { buildMergePrompt } = await import("../merger.js");

    const prompt = buildMergePrompt({
      taskId: "FN-001",
      branch: "fusion/fn-001",
      commitLog: "- feat: something",
      diffStat: "1 file changed",
      hasConflicts: false,
    });

    expect(prompt).not.toContain("Include this in the commit message body:");
    expect(prompt).not.toContain("Ref: runfusion/fusion#2915");
  });
});

// ── Context Limit Recovery Tests ─────────────────────────────────────


describe("commitOrAmendMergeWithFixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns already-merged success when branch tip is ancestor of integration target and finalize has no staged content", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --cached --name-only")) return "" as any;
      if (cmdStr === "git diff --name-only") return "" as any;
      if (cmdStr.includes("git status -z --porcelain")) return "" as any;
      if (cmdStr === "git rev-parse HEAD") return "abc123" as any;
      if (cmdStr === "git rev-parse fusion/fn-9999") return "def456" as any;
      if (cmdStr === "git merge-base def456 abc123") return "abc123" as any;
      if (cmdStr === "git diff --stat abc123..fusion/fn-9999") return "" as any;
      if (cmdStr === "git ls-files --others --exclude-standard") return "" as any;
      if (cmdStr.includes("git log -1 --pretty=%B HEAD")) return "commit message without trailer" as any;
      if (cmdStr === "git merge-base --is-ancestor def456 abc123") return "" as any;
      return "" as any;
    });

    const result = await commitOrAmendMergeWithFixes(
      "/tmp/root",
      "FN-9999",
      "fusion/fn-9999",
      "",
      true,
      "abc123",
      "",
      undefined,
      DEFAULT_SETTINGS,
      undefined,
      null,
      null,
      new Set(),
    );

    expect(result).toEqual({ ok: true, reason: "branch-already-merged" });
    expect(mockedExecSync.mock.calls.some((call) => String(call[0]).includes("git merge-base --is-ancestor"))).toBe(true);
  });

  it("persists dirty leftovers before finalize reset in no-content fallback path", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff -z --cached --name-only")) return "" as any;
      if (cmdStr.includes("git diff -z --name-only")) return "orphan.txt\0" as any;
      if (cmdStr.includes("git diff --cached --name-only")) return "" as any;
      if (cmdStr === "git diff --name-only") return "orphan.txt" as any;
      if (cmdStr.includes("git status -z --porcelain")) return "" as any;
      if (cmdStr === "git rev-parse HEAD") return "abc123" as any;
      if (cmdStr === "git rev-parse fusion/fn-9999") return "def456" as any;
      if (cmdStr === "git merge-base def456 abc123") return "zzz999" as any;
      if (cmdStr === "git diff --stat abc123..fusion/fn-9999") return "" as any;
      if (cmdStr === "git ls-files --others --exclude-standard") return "" as any;
      if (cmdStr.includes("git log -1 --pretty=%B HEAD")) return "commit message without trailer" as any;
      if (cmdStr.includes("git merge-base --is-ancestor")) throw new Error("not ancestor");
      if (cmdStr === "git add -A") return "" as any;
      if (cmdStr === "git stash create") return "ff00aa" as any;
      if (cmdStr.startsWith("git stash store -m")) return "" as any;
      if (cmdStr === "git reset") return "" as any;
      if (cmdStr === "git reset --hard abc123") return "" as any;
      if (cmdStr === "git clean -fd") return "" as any;
      if (cmdStr === "git merge --squash fusion/fn-9999") return "Already up to date." as any;
      return "" as any;
    });

    const store = createMockStore();
    const result = await commitOrAmendMergeWithFixes(
      "/tmp/root",
      "FN-9999",
      "fusion/fn-9999",
      "",
      true,
      "abc123",
      "",
      undefined,
      DEFAULT_SETTINGS,
      undefined,
      null,
      null,
      new Set(),
      store,
    );

    expect(result).toEqual({ ok: true, reason: "branch-already-merged" });
    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("treats squash-restore 'Already up to date' with no staged changes as already-merged success", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --cached --name-only")) return "" as any;
      if (cmdStr === "git diff --name-only") return "" as any;
      if (cmdStr.includes("git status -z --porcelain")) return "" as any;
      if (cmdStr === "git rev-parse HEAD") return "abc123" as any;
      if (cmdStr === "git rev-parse fusion/fn-9999") return "def456" as any;
      if (cmdStr === "git merge-base def456 abc123") return "zzz999" as any;
      if (cmdStr === "git diff --stat abc123..fusion/fn-9999") return "" as any;
      if (cmdStr === "git ls-files --others --exclude-standard") return "" as any;
      if (cmdStr.includes("git log -1 --pretty=%B HEAD")) return "commit message without trailer" as any;
      if (cmdStr.includes("git merge-base --is-ancestor")) throw new Error("not ancestor");
      if (cmdStr === "git reset --hard abc123") return "" as any;
      if (cmdStr === "git clean -fd") return "" as any;
      if (cmdStr === "git merge --squash fusion/fn-9999") return "Already up to date." as any;
      return "" as any;
    });

    const result = await commitOrAmendMergeWithFixes(
      "/tmp/root",
      "FN-9999",
      "fusion/fn-9999",
      "",
      true,
      "abc123",
      "",
      undefined,
      DEFAULT_SETTINGS,
      undefined,
      null,
      null,
      new Set(),
    );

    expect(result).toEqual({ ok: true, reason: "branch-already-merged" });
  });
});


