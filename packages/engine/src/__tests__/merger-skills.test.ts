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


describe("aiMergeTask — skill selection resolver contract (FN-1510/FN-1511)", () => {
  // FNXC:SessionSkillContext 2026-07-13: buildSessionSkillContext mockResolvedValue objects MUST include additionalSkillPaths: [] — production code (merger.ts:1991/3187/3607/12094) reads skillContext.additionalSkillPaths.length unconditionally when skillContext is truthy; omitting the field crashes with TypeError before createFnAgent is reached.
  vi.mock("../cli-runtime/session-skill-context.js", () => ({
    buildSessionSkillContext: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes skillSelection to createFnAgent when agentStore is provided", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: ["fusion"],
      sessionPurpose: "merger",
    }, resolvedSkillNames: ["fusion"], skillSource: "role-fallback", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    // Find the first createFnAgent call (main merger agent)
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.skillSelection).toBeDefined();
    expect(opts.skillSelection!.projectRootDir).toBe("/tmp/root");
    expect(opts.skillSelection!.requestedSkillNames).toEqual(["fusion"]);
    expect(opts.skillSelection!.sessionPurpose).toBe("merger");
  });

  it("uses assigned agent skills when available", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: ["custom-skill", "another-skill"],
      sessionPurpose: "merger",
    }, resolvedSkillNames: ["custom-skill", "another-skill"], skillSource: "assigned-agent", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", assignedAgentId: "agent-001" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.skillSelection).toBeDefined();
    expect(opts.skillSelection!.requestedSkillNames).toEqual(["custom-skill", "another-skill"]);
  });

  it("does not pass skillSelection when buildSessionSkillContext returns undefined context", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: undefined, resolvedSkillNames: [], skillSource: "none", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    // skillSelection should not be present when context is undefined
    expect("skillSelection" in opts).toBe(false);
  });

  it("does not pass skillSelection when agentStore is not provided", async () => {
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    // No agentStore provided
    await aiMergeTask(store, "/tmp/root", "FN-050");

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect("skillSelection" in opts).toBe(false);
  });

  it("gracefully handles buildSessionSkillContext throwing", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockRejectedValue(new Error("Agent not found"));

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    // Should not throw - graceful fallback
    const result = await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(result.merged).toBe(true);
    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect("skillSelection" in opts).toBe(false);
  });

  it("records resolved skill names in skill context result", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    const resolvedNames = ["skill-a", "skill-b"];
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: resolvedNames,
      sessionPurpose: "merger",
    }, resolvedSkillNames: resolvedNames, skillSource: "assigned-agent", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", assignedAgentId: "agent-001" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.skillSelection?.requestedSkillNames).toEqual(resolvedNames);
  });

  it("uses sessionPurpose='merger' in skill selection context", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: ["fusion"],
      sessionPurpose: "merger",
    }, resolvedSkillNames: ["fusion"], skillSource: "role-fallback", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.skillSelection?.sessionPurpose).toBe("merger");
  });
});


describe("aiMergeTask — skill selection non-fatal diagnostics (FN-1510/FN-1511)", () => {
  // FNXC:SessionSkillContext 2026-07-13: buildSessionSkillContext mockResolvedValue objects MUST include additionalSkillPaths: [] — same contract as the resolver-contract block above; production code reads skillContext.additionalSkillPaths.length unconditionally.
  vi.mock("../cli-runtime/session-skill-context.js", () => ({
    buildSessionSkillContext: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merge continues when skill selection produces diagnostics", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    // Simulate diagnostics being logged - the resolver would produce these
    // when requested skills are not found or filtered
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: ["nonexistent-skill"],
      sessionPurpose: "merger",
    }, resolvedSkillNames: [], skillSource: "none", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    // Merge should succeed even when skill diagnostics are present
    const result = await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("records skill source in context result for debugging", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/root",
      requestedSkillNames: ["custom-skill"],
      sessionPurpose: "merger",
    }, resolvedSkillNames: ["custom-skill"], skillSource: "assigned-agent", additionalSkillPaths: [] });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    } as any);

    setupHappyPathExecSync();

    const store = createMockStore(
      { id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", assignedAgentId: "agent-001" },
      [{ id: "FN-050", worktree: "/tmp/root/.worktrees/KB-050", column: "in-review" } as Task],
    );
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    });

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    const result = await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: mockAgentStore as any,
    });

    // Result should be successful regardless of skill source
    expect(result.merged).toBe(true);

    // Verify skillSelection was passed with the custom skill
    expect(mockedCreateFnAgent).toHaveBeenCalled();
    const firstCall = mockedCreateFnAgent.mock.calls[0];
    const opts = firstCall[0];
    expect(opts.skillSelection?.requestedSkillNames).toEqual(["custom-skill"]);
  });
});


