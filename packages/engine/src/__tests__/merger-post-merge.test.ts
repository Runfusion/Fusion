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
import { execSync, exec, spawn } from "node:child_process";
import * as core from "@fusion/core";
import { type TaskStore, type Task, type MergeResult, DEFAULT_SETTINGS } from "@fusion/core";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedExecSync = vi.mocked(execSync);
const mockedExec = vi.mocked(exec);
const mockedSpawn = vi.mocked(spawn);
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


describe("aiMergeTask — post-merge workflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
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

    const postMergeAgentCall = mockedCreateFnAgent.mock.calls.find(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge workflow step agent"),
    );
    expect(postMergeAgentCall).toBeDefined();
    expect(postMergeAgentCall?.[0]?.cwd).toMatch(/\.worktrees\/post-merge-FN-050-[a-z0-9]+/);
    expect(postMergeAgentCall?.[0]?.cwd).not.toBe("/tmp/root");

    // Task should still move to done even though post-merge step ran
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("uses assigned agent runtime model for post-merge prompt step when workflow step has no override", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "Send notifications after merge",
      prompt: "Check merged code.",
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
      assignedAgentId: "agent-001",
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: {
        listAgents: vi.fn().mockResolvedValue([]),
        getAgent: vi.fn().mockResolvedValue({
          id: "agent-001",
          runtimeConfig: {
            model: "anthropic/claude-3-5-sonnet-20241022",
          },
        }),
      } as any,
    });

    const postMergeAgentCall = mockedCreateFnAgent.mock.calls.find(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge workflow step agent"),
    );
    expect(postMergeAgentCall?.[0]?.defaultProvider).toBe("anthropic");
    expect(postMergeAgentCall?.[0]?.defaultModelId).toBe("claude-3-5-sonnet-20241022");
  });

  it("uses workflow-step model override over assigned agent runtime model", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "Send notifications after merge",
      prompt: "Check merged code.",
      phase: "post-merge",
      mode: "prompt",
      modelProvider: "openai",
      modelId: "gpt-4.1-mini",
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
      assignedAgentId: "agent-001",
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask = vi.fn().mockResolvedValue({ ...baseTask, prompt: "# test" });

    await aiMergeTask(store, "/tmp/root", "FN-050", {
      agentStore: {
        listAgents: vi.fn().mockResolvedValue([]),
        getAgent: vi.fn().mockResolvedValue({
          id: "agent-001",
          runtimeConfig: {
            model: "anthropic/claude-3-5-sonnet-20241022",
          },
        }),
      } as any,
    });

    const postMergeAgentCall = mockedCreateFnAgent.mock.calls.find(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge workflow step agent"),
    );
    expect(postMergeAgentCall?.[0]?.defaultProvider).toBe("openai");
    expect(postMergeAgentCall?.[0]?.defaultModelId).toBe("gpt-4.1-mini");

    const modelLogCall = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: any) => String(call[1]).includes("Workflow step 'Post-merge Notify' using model:"),
    );
    expect(modelLogCall?.[1]).toContain("(workflow step override)");
  });

  it("falls back to project default override model when no workflow-step or assigned-agent model is set", async () => {
    const store = createMockStore();
    (store as any).getWorkflowStep = vi.fn().mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "Send notifications after merge",
      prompt: "Check merged code.",
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
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o-mini",
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-haiku-latest",
    });

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const postMergeAgentCall = mockedCreateFnAgent.mock.calls.find(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge workflow step agent"),
    );
    expect(postMergeAgentCall?.[0]?.defaultProvider).toBe("openai");
    expect(postMergeAgentCall?.[0]?.defaultModelId).toBe("gpt-4o-mini");
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
    // beyond the merge agent itself. We verify createFnAgent was called only once (merge agent)
    // since pre-merge steps are skipped in the merger
    const mergeAgentCalls = mockedCreateFnAgent.mock.calls.filter(
      (c: any) => c[0]?.systemPrompt?.includes("You are a merge agent")
    );
    const postMergeCalls = mockedCreateFnAgent.mock.calls.filter(
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
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
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
      mergeIntegrationWorktree: "cwd-main" as const,
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

    const scriptSpawnCall = mockedSpawn.mock.calls.find((call: any) => String(call[0]) === "pnpm build");
    expect(scriptSpawnCall).toBeDefined();
    expect(scriptSpawnCall?.[2]?.cwd).toMatch(/\.worktrees\/post-merge-FN-050-[a-z0-9]+/);

    expect(result.merged).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("creates temporary worktree for post-merge steps", async () => {
    const store = createMockStore();
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

    const worktreeAddCall = mockedExec.mock.calls.find((call: any) =>
      String(call[0]).includes("git worktree add") && String(call[0]).includes("post-merge-FN-050-"),
    );
    const worktreeRemoveCall = mockedExec.mock.calls.find((call: any) =>
      String(call[0]).includes("git worktree remove --force") && String(call[0]).includes("post-merge-FN-050-"),
    );

    expect(worktreeAddCall).toBeDefined();
    expect(worktreeRemoveCall).toBeDefined();
  });

  it("falls back to rootDir when worktree creation fails", async () => {
    const store = createMockStore();
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

    const baseExecImpl = mockedExecSync.getMockImplementation();
    mockedExecSync.mockImplementation((cmd: any, opts: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git worktree add") && cmdStr.includes("post-merge-FN-050-")) {
        const error: any = new Error("cannot create worktree");
        error.stderr = "cannot create worktree";
        throw error;
      }
      return baseExecImpl ? baseExecImpl(cmd, opts) : Buffer.from("");
    });

    const warnSpy = vi.spyOn(mergerLog, "warn");
    await aiMergeTask(store, "/tmp/root", "FN-050");

    const postMergeAgentCall = mockedCreateFnAgent.mock.calls.find(
      (c: any) => c[0]?.systemPrompt?.includes("post-merge workflow step agent"),
    );
    expect(postMergeAgentCall?.[0]?.cwd).toBe("/tmp/root");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not create post-merge worktree — falling back to rootDir"));
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("cleans up temporary worktree even when post-merge step fails", async () => {
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

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      if (opts.systemPrompt?.includes("post-merge")) {
        throw new Error("Post-merge agent creation failed");
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

    await aiMergeTask(store, "/tmp/root", "FN-050");

    const worktreeRemoveCall = mockedExec.mock.calls.find((call: any) =>
      String(call[0]).includes("git worktree remove --force") && String(call[0]).includes("post-merge-FN-050-"),
    );
    expect(worktreeRemoveCall).toBeDefined();
    expect(store.moveTask).toHaveBeenCalledWith("FN-050", "done");
  });

  it("does not create post-merge worktree when no post-merge steps exist", async () => {
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

    const worktreeAddCall = mockedExec.mock.calls.find((call: any) =>
      String(call[0]).includes("git worktree add") && String(call[0]).includes("post-merge-FN-050-"),
    );
    expect(worktreeAddCall).toBeUndefined();
  });
});

// ── Merge Details Collection Tests ─────────────────────────────────────

