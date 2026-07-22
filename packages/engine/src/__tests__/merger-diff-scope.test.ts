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


describe("resolveTaskDiffBaseRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers merge-base when it differs from head", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'git merge-base "HEAD" "main"') return "merge-base-123" as any;
      if (cmdStr === 'git rev-parse "HEAD"') return "head-456" as any;
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: "main",
      baseCommitSha: "task-base-789",
    });

    expect(diffBase).toBe("merge-base-123");
    expect(
      mockedExecSync.mock.calls.some(([cmd]) =>
        String(cmd).includes("merge-base --is-ancestor"),
      ),
    ).toBe(false);
  });

  it("uses baseCommitSha when merge-base equals head", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'git merge-base "HEAD" "main"') return "head-456" as any;
      if (cmdStr === 'git rev-parse "HEAD"') return "head-456" as any;
      if (cmdStr === 'git merge-base --is-ancestor "task-base-789" "HEAD"') return "" as any;
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: "main",
      baseCommitSha: "task-base-789",
    });

    expect(diffBase).toBe("task-base-789");
  });

  it("falls back to HEAD~1 when merge-base is unavailable and baseCommitSha is stale", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'git merge-base "HEAD" "main"') {
        throw new Error("missing local main");
      }
      if (cmdStr === 'git merge-base "HEAD" "origin/main"') {
        throw new Error("missing remote main");
      }
      if (cmdStr === 'git merge-base --is-ancestor "stale-base" "HEAD"') {
        throw new Error("stale base sha");
      }
      if (cmdStr === 'git rev-parse "HEAD~1"') return "parent-123" as any;
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: "main",
      baseCommitSha: "stale-base",
    });

    expect(diffBase).toBe("parent-123");
  });

  it("returns undefined when no merge base, no valid baseCommitSha, and no parent commit are available", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'git merge-base "HEAD" "main"') {
        throw new Error("missing local main");
      }
      if (cmdStr === 'git merge-base "HEAD" "origin/main"') {
        throw new Error("missing remote main");
      }
      if (cmdStr === 'git merge-base --is-ancestor "stale-base" "HEAD"') {
        throw new Error("stale base sha");
      }
      if (cmdStr === 'git rev-parse "HEAD~1"') {
        throw new Error("single commit repo");
      }
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: "main",
      baseCommitSha: "stale-base",
    });

    expect(diffBase).toBeUndefined();
  });

  // FN-3898 regression: legacy/imported tasks may have a stale baseCommitSha
  // and no baseBranch. After pre-merge rebase the recorded SHA is older than
  // the new merge-base, so `baseCommitSha..branch` includes every unrelated
  // commit landed on main since the fork — inflating scope warnings.
  it("tightens to merge-base(HEAD, main) when baseBranch is missing and baseCommitSha is an outdated ancestor", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      // No baseBranch → outer merge-base block is skipped.
      // Display recovery: merge-base(HEAD, main).
      if (cmdStr === 'git merge-base "HEAD" "main"') return "current-main-sha" as any;
      // baseCommitSha is still an ancestor of HEAD…
      if (cmdStr === 'git merge-base --is-ancestor "old-base-sha" "HEAD"') return "" as any;
      // …and recoveredBase descends baseCommitSha (rebase fast-forwarded).
      if (cmdStr === 'git merge-base --is-ancestor "old-base-sha" "current-main-sha"') return "" as any;
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: undefined,
      baseCommitSha: "old-base-sha",
      integrationBranchFallback: "main",
    });

    expect(diffBase).toBe("current-main-sha");
  });

  // Preserves the FN-2855 path: when the recovered merge-base is NOT a
  // descendant of baseCommitSha (e.g., baseCommitSha lives on a deleted
  // upstream feature branch), keep the task-scoped SHA rather than widening
  // the diff range.
  it("keeps baseCommitSha when recoveredBase does not descend it", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'git merge-base "HEAD" "main"') return "unrelated-main-sha" as any;
      if (cmdStr === 'git merge-base --is-ancestor "feature-base-sha" "HEAD"') return "" as any;
      if (cmdStr === 'git merge-base --is-ancestor "feature-base-sha" "unrelated-main-sha"') {
        throw new Error("not an ancestor");
      }
      throw new Error(`Unexpected command: ${cmdStr}`);
    });

    const diffBase = await resolveTaskDiffBaseRef({
      cwd: "/tmp/root",
      headRef: "HEAD",
      baseBranch: undefined,
      baseCommitSha: "feature-base-sha",
      integrationBranchFallback: "main",
    });

    expect(diffBase).toBe("feature-base-sha");
  });
});


