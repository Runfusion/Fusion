/**
 * Integration tests for engine restart resilience.
 *
 * Verifies that after an engine crash/restart:
 * - In-progress tasks resume from their current step (not from scratch)
 * - Existing worktrees are reused rather than recreated
 * - Step progress survives and is communicated to the agent
 * - In-review tasks get re-queued for merge
 * - Triage re-picks unspecified tasks
 * - Crash scenarios are handled gracefully (semaphore release, status cleanup)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSemaphore } from "./concurrency.js";

// ── Module-level mocks (matching existing test patterns) ──────────────────

vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));
vi.mock("./reviewer.js", () => ({
  reviewStep: vi.fn(),
}));
vi.mock("node:child_process", () => {
  const { promisify } = require("node:util");
  const execSyncFn = vi.fn().mockReturnValue(Buffer.from(""));
  const execFn: any = vi.fn((cmd: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const forwardedOpts = typeof opts === "function" ? undefined : opts;
    try {
      const out = execSyncFn(cmd, forwardedOpts);
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
  readdirSync: vi.fn().mockReturnValue([]),
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("# Task prompt content"),
}));
vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: unknown) => ({ type: "string", ...((opts as object) ?? {}) }),
    Number: (opts?: unknown) => ({ type: "number", ...((opts as object) ?? {}) }),
    Boolean: (opts?: unknown) => ({ type: "boolean", ...((opts as object) ?? {}) }),
    Optional: (schema: unknown) => schema,
    Array: (schema: unknown, opts?: unknown) => ({ type: "array", items: schema, ...((opts as object) ?? {}) }),
    Union: (schemas: unknown[], opts?: unknown) => ({ anyOf: schemas, ...((opts as object) ?? {}) }),
    Literal: (value: unknown) => ({ const: value }),
  },
}));
vi.mock("@mariozechner/pi-coding-agent", () => {
  const mockSessionManager = {};
  return {
    SessionManager: {
      create: vi.fn().mockReturnValue(mockSessionManager),
      open: vi.fn().mockReturnValue(mockSessionManager),
      inMemory: vi.fn().mockReturnValue(mockSessionManager),
    },
  };
});

import { TaskExecutor } from "./executor.js";
import { TriageProcessor } from "./triage.js";
import { Scheduler } from "./scheduler.js";
import { aiMergeTask } from "./merger.js";
import { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees } from "./worktree-pool.js";
import { createKbAgent } from "./pi.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { Task, TaskDetail, TaskStep, Column, Settings, StepStatus } from "@fusion/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);
const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);

// ── Mock helpers ──────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: false,
  worktreeInitCommand: undefined,
};

function createMockStore(overrides: Record<string, any> = {}) {
  const listeners = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, fn: Function) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    emit: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-001", "in-progress")),
    updateTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockImplementation(async (id: string, col: Column) => {
      return makeTask(id, col);
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    getRootDir: vi.fn().mockReturnValue("/tmp/root"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/root/.fusion"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/root/.fusion/tasks"),
    updateStep: vi.fn().mockImplementation(async (id: string, step: number, status: StepStatus) => {
      return makeTaskDetail(id, "in-progress");
    }),
    createTask: vi.fn().mockImplementation(async (input: any) => {
      return makeTask("FN-NEW", "triage");
    }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    _trigger(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    _listeners: listeners,
    ...overrides,
  } as any;
}

function makeTask(id: string, column: Column, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskDetail(id: string, column: Column, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...makeTask(id, column, overrides),
    prompt: overrides.prompt ?? "# test\n## Steps\n### Step 0: Preflight\n- [ ] check\n## Review Level: 0",
    ...overrides,
  };
}

function makeSteps(...statuses: StepStatus[]): TaskStep[] {
  return statuses.map((status, i) => ({
    name: `Step ${i}`,
    status,
  }));
}

function mockAgentSuccess() {
  mockedCreateHaiAgent.mockResolvedValue({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
  } as any);
}

function mockAgentFailure(error = "agent crashed") {
  mockedCreateHaiAgent.mockRejectedValue(new Error(error));
}

/**
 * Create a mock agent that auto-triggers the task_done tool when prompt is called.
 * This simulates a successful task execution where the agent calls task_done(),
 * preventing the executor from entering the "finished without task_done — retrying
 * with new session" branch. Follows the same pattern as executor.test.ts.
 *
 * Uses per-session local customTools capture to avoid race conditions when
 * multiple tasks execute concurrently.
 */
function createAgentWithTaskDone() {
  mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
    // Capture tools per-session to avoid race conditions with concurrent tasks
    const localCustomTools = opts.customTools || [];
    const session = {
      prompt: vi.fn().mockImplementation(async () => {
        // Find and execute task_done tool to set taskDone = true
        const taskDoneTool = localCustomTools.find((t: any) => t.name === "task_done");
        if (taskDoneTool) {
          await taskDoneTool.execute("tool-1", {});
        }
      }),
      dispose: vi.fn(),
    };
    return { session };
  }) as any);
}

// ── Tests begin ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(true); // Default: worktrees exist (resume scenario)
  mockedExecSync.mockImplementation((cmd: any) => {
    if (String(cmd) === "git worktree list --porcelain") {
      return [
        "worktree /tmp/test",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /tmp/wt/KB-010",
        "HEAD def456",
        "branch refs/heads/fusion/fn-010",
        "",
        "worktree /tmp/wt/FN-963",
        "HEAD def456",
        "branch refs/heads/fusion/fn-963",
        "",
        "worktree /root/.worktrees/active-wt",
        "HEAD def456",
        "branch refs/heads/fusion/active-wt",
        "",
        "worktree /root/.worktrees/review-wt",
        "HEAD def456",
        "branch refs/heads/fusion/review-wt",
        "",
        "worktree /root/.worktrees/idle-wt",
        "HEAD def456",
        "branch refs/heads/fusion/idle-wt",
        "",
      ].join("\n") as any;
    }
    return Buffer.from("");
  });
});

// ── Step 2: In-progress task resume tests ─────────────────────────────────

describe("In-progress task resume after restart", () => {
  it("resumeOrphaned() calls execute() for each in-progress task not already executing", async () => {
    const store = createMockStore();
    const task1 = makeTask("FN-001", "in-progress");
    const task2 = makeTask("FN-002", "in-progress");
    const taskDone = makeTask("FN-003", "done");
    store.listTasks.mockResolvedValue([task1, task2, taskDone]);

    // Use deterministic mock that calls task_done to prevent retry-with-new-session
    createAgentWithTaskDone();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    // Wait for async execute calls to complete
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one agent session per in-progress task (no retry inflation)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Both tasks should have received resume log entries (behavioral guarantee)
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Resumed after engine restart");
    expect(store.logEntry).toHaveBeenCalledWith("FN-002", "Resumed after engine restart");
  });

  it("resumed task reuses existing worktree — no git worktree add called", async () => {
    const store = createMockStore();
    const task = makeTask("FN-010", "in-progress", {
      worktree: "/tmp/wt/KB-010",
    });
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-010", "in-progress", {
      worktree: "/tmp/wt/KB-010",
    }));

    // Worktree exists on disk
    mockedExistsSync.mockReturnValue(true);
    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    // No git worktree add commands should have been called
    const gitWorktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add"),
    );
    expect(gitWorktreeAddCalls).toHaveLength(0);
  });

  it("resumed task with step progress includes RESUMING section in agent prompt", async () => {
    const store = createMockStore();
    const steps = makeSteps("done", "done", "done", "in-progress", "pending");
    const task = makeTask("FN-020", "in-progress", { steps, currentStep: 3 });
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-020", "in-progress", {
      steps,
      currentStep: 3,
    }));

    let capturedPrompt = "";
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedPrompt).toContain("⚠️ RESUMING");
    expect(capturedPrompt).toContain("Step 0 (Step 0): **done**");
    expect(capturedPrompt).toContain("Step 3 (Step 3): **in-progress**");
    expect(capturedPrompt).toContain("Resume from: Step 3");
  });

  it("resumed task does NOT re-run worktreeInitCommand", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      worktreeInitCommand: "pnpm install",
    });
    const task = makeTask("FN-030", "in-progress");
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-030", "in-progress"));

    mockedExistsSync.mockReturnValue(true); // worktree exists
    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    // getSettings is called (for project commands in execution prompt) but init command should not run
    expect(store.getSettings).toHaveBeenCalled();

    // No init command calls
    const initCalls = mockedExecSync.mock.calls.filter(
      (call) => call[0] === "pnpm install",
    );
    expect(initCalls).toHaveLength(0);
  });

  it("resumeOrphaned() logs 'Resumed after engine restart' for each orphaned task", async () => {
    const store = createMockStore();
    const task1 = makeTask("FN-040", "in-progress");
    const task2 = makeTask("FN-041", "in-progress");
    store.listTasks.mockResolvedValue([task1, task2]);
    store.getTask.mockImplementation(async (id: string) =>
      makeTaskDetail(id, "in-progress"),
    );

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    expect(store.logEntry).toHaveBeenCalledWith("FN-040", "Resumed after engine restart");
    expect(store.logEntry).toHaveBeenCalledWith("FN-041", "Resumed after engine restart");
  });

  it("resumeOrphaned() fast-paths already-complete tasks to in-review", async () => {
    const store = createMockStore();
    const completedTask = makeTask("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      baseCommitSha: "base123",
      steps: makeSteps("done", "done", "skipped"),
    });
    store.listTasks.mockResolvedValue([completedTask]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      baseCommitSha: "base123",
      steps: makeSteps("done", "done", "skipped"),
    }));

    const executor = new TaskExecutor(store, "/tmp/test");
    const executeSpy = vi.spyOn(executor, "execute");

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === 'git diff --name-only base123..HEAD') {
        return "packages/dashboard/app/components/SettingsModal.tsx\n" as any;
      }
      return "" as any;
    });

    await executor.resumeOrphaned();

    expect(executeSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(store.updateTask).toHaveBeenCalledWith("FN-963", {
        modifiedFiles: ["packages/dashboard/app/components/SettingsModal.tsx"],
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-963", "in-review");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-963",
        "Auto-recovered: task work was complete but stuck in in-progress — moved to in-review",
      );
    });
  });

  it("resumeOrphaned() does not block startup on completed-task recovery", async () => {
    const store = createMockStore();
    const completedTask = makeTask("FN-964", "in-progress", {
      worktree: "/tmp/wt/FN-964",
      baseCommitSha: "base123",
      steps: makeSteps("done", "done", "skipped"),
    });
    store.listTasks.mockResolvedValue([completedTask]);

    const executor = new TaskExecutor(store, "/tmp/test");
    const recoverSpy = vi.spyOn(executor, "recoverCompletedTask").mockImplementation(
      () => new Promise(() => {}),
    );

    await expect(executor.resumeOrphaned()).resolves.toBeUndefined();
    expect(recoverSpy).toHaveBeenCalledWith(completedTask);
  });

  it("resumeOrphaned() leaves no-progress no-task_done failures for self-healing", async () => {
    const store = createMockStore();
    const failedTask = makeTask("FN-1473", "in-progress", {
      status: "failed",
      error: "Agent finished without calling task_done (after retry)",
      steps: [],
    });
    store.listTasks.mockResolvedValue([failedTask]);

    const executor = new TaskExecutor(store, "/tmp/test");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.resumeOrphaned();

    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1473", "Resumed after engine restart");
  });

  it("recoverCompletedTask() marks task failed then moves to in-review when workflow fails", async () => {
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-963", "in-progress", {
        worktree: "/tmp/wt/FN-963",
        steps: makeSteps("done"),
        enabledWorkflowSteps: ["wf-1"],
      })),
      getWorkflowStep: vi.fn().mockResolvedValue({
        id: "wf-1",
        name: "Build",
        mode: "script",
        scriptName: "pnpm test",
        phase: "pre-merge",
      }),
    });
    const task = makeTask("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      steps: makeSteps("done"),
    });

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "pnpm test") {
        throw new Error("tests failed");
      }
      return "" as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("FN-963", {
      status: "failed",
      error: "Workflow step failed during recovery",
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-963", "in-review");
  });
});

// ── Step 3: In-review merge re-queue tests ────────────────────────────────
//
// The merge queue/enqueueMerge logic lives in dashboard.ts (CLI layer).
// These tests focus on what @fusion/engine owns: aiMergeTask() behaviour
// relevant to restart resilience — state validation, status lifecycle,
// and error handling with git reset --merge cleanup.

describe("In-review merge handling after restart", () => {
  it("aiMergeTask validates task is in 'in-review' before merging", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-050", "in-progress"));

    await expect(aiMergeTask(store, "/tmp/root", "FN-050")).rejects.toThrow(
      "Cannot merge FN-050: task is in 'in-progress', must be in 'in-review'",
    );

    // No git commands should have been executed
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("aiMergeTask sets status to 'merging' during execution and clears on success", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-051", "in-review"));
    store.moveTask.mockResolvedValue(makeTask("FN-051", "done"));

    // Branch exists, merge succeeds, no conflicts
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      // Post-squash check: squash staged changes → "1"
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      // Post-agent check: agent committed → "0"
      if (cmdStr.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    });

    mockAgentSuccess();

    await aiMergeTask(store, "/tmp/root", "FN-051");

    // Should have set status to "merging"
    expect(store.updateTask).toHaveBeenCalledWith("FN-051", { status: "merging" });
    // Should have cleared status via completeTask (status: null before moveTask)
    expect(store.updateTask).toHaveBeenCalledWith("FN-051", { status: null });
  });

  it("sequential aiMergeTask calls for multiple in-review tasks all succeed", async () => {
    const taskIds = ["FN-052", "FN-053", "FN-054"];

    for (const taskId of taskIds) {
      const store = createMockStore();
      store.getTask.mockResolvedValue(makeTaskDetail(taskId, "in-review"));
      store.moveTask.mockResolvedValue(makeTask(taskId, "done"));

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
        if (cmdStr.includes("diff --cached")) return "0" as any;
        return Buffer.from("");
      });
      mockAgentSuccess();

      const result = await aiMergeTask(store, "/tmp/root", taskId);
      expect(result.merged).toBe(true);
      expect(store.moveTask).toHaveBeenCalledWith(taskId, "done");
    }
  });

  it("aiMergeTask throws on agent failure during session.prompt and calls git reset --merge", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-055", "in-review"));

    // Branch exists, merge starts, agent creates but prompt fails
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      // Make merge fail so all attempts exhaust
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) {
        const err = new Error("Merge conflict");
        err.name = "ExecSyncError";
        throw err;
      }
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --cached")) return "0" as any;
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "src/file.ts";
      // Make auto-resolution fail by making git add fail
      if (cmdStr.includes("git add")) {
        const err = new Error("git add failed");
        err.name = "ExecSyncError";
        throw err;
      }
      return Buffer.from("");
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("merge agent crashed")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(aiMergeTask(store, "/tmp/root", "FN-055")).rejects.toThrow(
      "AI merge failed for FN-055: all 3 attempts exhausted",
    );

    // Should have attempted git reset --merge cleanup
    const resetCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git reset --merge"),
    );
    expect(resetCalls.length).toBeGreaterThan(0);

    // Status was set to "merging" but NOT cleared by aiMergeTask (that's the dashboard's job)
    expect(store.updateTask).toHaveBeenCalledWith("FN-055", { status: "merging" });
  });

  it("aiMergeTask moves task to done when branch does not exist", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-056", "in-review"));
    store.moveTask.mockResolvedValue(makeTask("FN-056", "done"));

    // git rev-parse --verify throws (branch not found)
    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("git rev-parse --verify")) {
        throw new Error("branch not found");
      }
      return Buffer.from("");
    });

    const result = await aiMergeTask(store, "/tmp/root", "FN-056");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("Branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-056", "done");
  });
});

// ── Step 4: Triage re-pick and scheduler tests ────────────────────────────

describe("Triage re-pick after restart", () => {
  it("TriageProcessor.start() after restart picks up triage tasks (processing set is fresh)", async () => {
    const store = createMockStore();
    const triageTask1 = makeTask("FN-060", "triage");
    const triageTask2 = makeTask("FN-061", "triage");
    store.listTasks.mockResolvedValue([triageTask1, triageTask2]);
    store.getTask.mockImplementation(async (id: string) =>
      makeTaskDetail(id, "triage"),
    );

    mockAgentSuccess();

    const triage = new TriageProcessor(store, "/tmp/root", {
      pollIntervalMs: 100000, // large interval to avoid re-poll
    });
    triage.start();

    // Wait for the immediate poll() to fire
    await new Promise((r) => setTimeout(r, 100));
    triage.stop();

    // Both triage tasks should have been picked up for specification
    expect(store.updateTask).toHaveBeenCalledWith("FN-060", { status: "specifying" });
    expect(store.updateTask).toHaveBeenCalledWith("FN-061", { status: "specifying" });
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);
  });

  it("specifyTask() skips task already in processing set (no double-specification)", async () => {
    const store = createMockStore();
    const task = makeTask("FN-062", "triage");
    store.getTask.mockResolvedValue(makeTaskDetail("FN-062", "triage"));

    // Slow agent to keep task in processing
    let resolvePrompt: Function;
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => new Promise((r) => { resolvePrompt = r; })),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/root");

    // Start first specification (will block on prompt)
    const first = triage.specifyTask(task);

    // Give it time to enter processing set
    await new Promise((r) => setTimeout(r, 20));

    // Second call should be a no-op (already processing)
    await triage.specifyTask(task);

    // Only one agent created
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Resolve the blocked prompt to clean up
    resolvePrompt!();
    await first;
  });
});

describe("Scheduler after restart", () => {
  it("schedule() moves todo tasks to in-progress when deps are satisfied", async () => {
    const store = createMockStore();
    const todoTask = makeTask("FN-070", "todo");
    store.listTasks.mockResolvedValue([todoTask]);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });

    // Needs parseFileScopeFromPrompt for overlap checks
    store.parseFileScopeFromPrompt.mockResolvedValue([]);

    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, {
      maxConcurrent: 2,
      maxWorktrees: 4,
      onSchedule,
    });

    // Use start/stop to trigger schedule() then clean up
    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();

    expect(store.moveTask).toHaveBeenCalledWith("FN-070", "in-progress");
    expect(store.updateTask).toHaveBeenCalledWith("FN-070", expect.objectContaining({ status: null, blockedBy: null }));
    expect(onSchedule).toHaveBeenCalledWith(todoTask);
  });

  it("schedule() respects dependency ordering — blocked tasks stay in todo", async () => {
    const store = createMockStore();
    const depTask = makeTask("FN-071", "in-progress");
    const blockedTask = makeTask("FN-072", "todo", {
      dependencies: ["FN-071"],
    });
    store.listTasks.mockResolvedValue([depTask, blockedTask]);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });

    const onBlocked = vi.fn();
    const scheduler = new Scheduler(store, {
      maxConcurrent: 2,
      maxWorktrees: 4,
      onBlocked,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();

    // Task should NOT have been moved
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-072", "in-progress");
    expect(onBlocked).toHaveBeenCalledWith(blockedTask, ["FN-071"]);
  });

  it("full column coverage: restart with tasks in every column", async () => {
    const store = createMockStore();

    // Tasks across all columns
    const triageTask = makeTask("FN-080", "triage");
    const todoTask = makeTask("FN-081", "todo");
    const inProgressTask = makeTask("FN-082", "in-progress");
    const inReviewTask = makeTask("FN-083", "in-review");
    const doneTask = makeTask("FN-084", "done");

    const allTasks = [triageTask, todoTask, inProgressTask, inReviewTask, doneTask];
    store.listTasks.mockResolvedValue(allTasks);
    store.getTask.mockImplementation(async (id: string) => {
      const t = allTasks.find((t) => t.id === id)!;
      return makeTaskDetail(id, t.column);
    });
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, autoMerge: true });

    mockAgentSuccess();

    // 1. Triage picks up triage tasks
    const triage = new TriageProcessor(store, "/tmp/root", {
      pollIntervalMs: 100000,
    });
    triage.start();
    await new Promise((r) => setTimeout(r, 100));
    triage.stop();

    expect(store.updateTask).toHaveBeenCalledWith("FN-080", { status: "specifying" });

    // 2. Scheduler moves todo → in-progress
    vi.clearAllMocks();
    store.listTasks.mockResolvedValue(allTasks);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });

    const scheduler = new Scheduler(store, { maxConcurrent: 2, maxWorktrees: 4 });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();

    expect(store.moveTask).toHaveBeenCalledWith("FN-081", "in-progress");

    // 3. Executor resumes in-progress tasks
    vi.clearAllMocks();
    store.listTasks.mockResolvedValue(allTasks);
    store.getTask.mockImplementation(async (id: string) => {
      const t = allTasks.find((t) => t.id === id)!;
      return makeTaskDetail(id, t.column);
    });
    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/root");
    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    expect(store.logEntry).toHaveBeenCalledWith("FN-082", "Resumed after engine restart");

    // 4. Done tasks are untouched (no operations on KB-084)
    const doneCalls = [
      ...store.updateTask.mock.calls,
      ...store.moveTask.mock.calls,
    ].filter((call) => call[0] === "FN-084");
    expect(doneCalls).toHaveLength(0);
  });
});

// ── Step 5: Crash scenario edge case tests ────────────────────────────────

describe("Crash scenario edge cases", () => {
  it("agent dies mid-step — onError is called, semaphore slot released, task eligible for resume", async () => {
    const sem = new AgentSemaphore(2);
    const store = createMockStore();
    const task = makeTask("FN-090", "in-progress");
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-090", "in-progress"));

    // Agent session.prompt rejects (simulating crash mid-step)
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("agent died mid-step")),
        dispose: vi.fn(),
      },
    } as any);

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      onError,
    });

    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    // onError should have been called
    expect(onError).toHaveBeenCalledWith(task, expect.any(Error));

    // Semaphore slot should be released
    expect(sem.activeCount).toBe(0);

    // Task should be eligible for resume (not in executing set)
    // Verify by calling resumeOrphaned again — it should try to execute again
    vi.clearAllMocks();
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-090", "in-progress"));
    // Use deterministic mock that calls task_done to prevent retry-with-new-session
    createAgentWithTaskDone();

    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one agent created for the re-resume, proving the task was eligible
    // and completed without retry inflation.
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Re-resume should have logged again (behavioral guarantee)
    expect(store.logEntry).toHaveBeenCalledWith("FN-090", "Resumed after engine restart");
  });

  it("engine killed during merge — git reset --merge cleanup, task stays in-review", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-091", "in-review"));

    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      // Make merge fail so all attempts exhaust
      if (cmdStr.includes("merge --squash") || cmdStr.includes("merge -X")) {
        const err = new Error("Merge conflict");
        err.name = "ExecSyncError";
        throw err;
      }
      // Post-squash check: squash staged changes → "1"
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      if (cmdStr.includes("diff --name-only --diff-filter=U")) return "src/file.ts";
      // Make auto-resolution fail by making git add fail
      if (cmdStr.includes("git add")) {
        const err = new Error("git add failed");
        err.name = "ExecSyncError";
        throw err;
      }
      return Buffer.from("");
    });

    // Agent prompt rejects (simulating kill during merge)
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("killed")),
        dispose: vi.fn(),
      },
    } as any);

    await expect(aiMergeTask(store, "/tmp/root", "FN-091")).rejects.toThrow();

    // git reset --merge should have been called
    const resetCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git reset --merge"),
    );
    expect(resetCalls.length).toBeGreaterThan(0);

    // Task should NOT have been moved to done
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-091", "done");

    // Status was set to "merging" during execution
    expect(store.updateTask).toHaveBeenCalledWith("FN-091", { status: "merging" });
  });

  it("concurrent resumeOrphaned() calls don't double-execute the same task", async () => {
    const store = createMockStore();
    const task = makeTask("FN-092", "in-progress");
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-092", "in-progress"));

    let resolvePrompt: Function;
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => new Promise((r) => { resolvePrompt = r; })),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // First call starts execution
    const first = executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 20));

    // Second call while first is still executing
    const second = executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 20));

    // Only one agent should have been created (the executing set guards against double-exec)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Clean up
    resolvePrompt!();
    await first;
    await second;
  });

  it("semaphore integrity after crash — activeCount returns to pre-execution value", async () => {
    const sem = new AgentSemaphore(3);
    const store = createMockStore();

    // Pre-acquire one slot to simulate other work
    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const task = makeTask("FN-093", "in-progress");
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-093", "in-progress"));

    // Agent creation itself fails
    mockedCreateHaiAgent.mockRejectedValue(new Error("cannot create agent"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      onError,
    });

    await executor.resumeOrphaned();
    await new Promise((r) => setTimeout(r, 50));

    // Semaphore should return to pre-execution count (1 from our manual acquire)
    expect(sem.activeCount).toBe(1);
    expect(onError).toHaveBeenCalled();

    // Release our manual slot
    sem.release();
    expect(sem.activeCount).toBe(0);
  });
});

// ── Worktree pool restart resilience tests ────────────────────────────────

function makeDirEntry(name: string) {
  return { name, isDirectory: () => true } as any;
}

function mockRegisteredWorktrees(rootDir: string, names: string[]) {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (String(cmd) === "git worktree list --porcelain") {
      return [
        `worktree ${rootDir}`,
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        ...names.flatMap((name) => [
          `worktree ${rootDir}/.worktrees/${name}`,
          "HEAD def456",
          `branch refs/heads/fusion/${name}`,
          "",
        ]),
      ].join("\n") as any;
    }
    return Buffer.from("");
  });
}

describe("Worktree pool restart with recycleWorktrees=true", () => {
  it("pool is rehydrated with idle worktrees from disk", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("swift-falcon"),
      makeDirEntry("calm-river"),
      makeDirEntry("bold-eagle"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["swift-falcon", "calm-river", "bold-eagle"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      makeTask("FN-100", "in-progress", { worktree: "/root/.worktrees/swift-falcon" }),
      makeTask("FN-101", "done", { worktree: "/root/.worktrees/calm-river" }),
    ]);

    // Simulate startup rehydration
    const pool = new WorktreePool();
    const idlePaths = await scanIdleWorktrees("/root", store);
    pool.rehydrate(idlePaths);

    // swift-falcon → in-progress, not idle
    // calm-river → done, idle
    // bold-eagle → unassigned, idle
    expect(pool.size).toBe(2);
    expect(pool.has("/root/.worktrees/calm-river")).toBe(true);
    expect(pool.has("/root/.worktrees/bold-eagle")).toBe(true);
    expect(pool.has("/root/.worktrees/swift-falcon")).toBe(false);
  });

  it("executor acquires from rehydrated pool instead of creating new worktrees", async () => {
    // Setup: rehydrate pool with one idle worktree
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("idle-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", ["idle-wt"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    store.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recycleWorktrees: true,
    });
    store.getTask.mockResolvedValue(makeTaskDetail("FN-110", "in-progress"));

    const pool = new WorktreePool();
    const idlePaths = await scanIdleWorktrees("/root", store);
    pool.rehydrate(idlePaths);
    expect(pool.size).toBe(1);

    // Now simulate executor acquiring from pool
    // The pool path exists on disk, but the task's default path does not
    mockedExistsSync.mockImplementation(
      (p) => p === "/root/.worktrees/idle-wt",
    );

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/root", { pool });
    await executor.execute(makeTask("FN-110", "in-progress"));
    await new Promise((r) => setTimeout(r, 50));

    // Pool should be empty (worktree acquired)
    expect(pool.size).toBe(0);

    // No git worktree add calls (reused from pool)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls).toHaveLength(0);

    // Should log pool acquisition
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-110",
      expect.stringContaining("Acquired worktree from pool"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("worktrees assigned to in-progress tasks are preserved (not in pool)", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("active-wt"),
      makeDirEntry("idle-wt"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["active-wt", "idle-wt"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      makeTask("KB-120", "in-progress", { worktree: "/root/.worktrees/active-wt" }),
    ]);

    const pool = new WorktreePool();
    const idlePaths = await scanIdleWorktrees("/root", store);
    pool.rehydrate(idlePaths);

    // Only idle-wt should be in pool (active-wt is assigned to in-progress task)
    expect(pool.size).toBe(1);
    expect(pool.has("/root/.worktrees/idle-wt")).toBe(true);
    expect(pool.has("/root/.worktrees/active-wt")).toBe(false);
  });

  it("worktrees assigned to in-review tasks are preserved (not in pool)", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("review-wt"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["review-wt"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      makeTask("KB-121", "in-review", { worktree: "/root/.worktrees/review-wt" }),
    ]);

    const pool = new WorktreePool();
    const idlePaths = await scanIdleWorktrees("/root", store);
    pool.rehydrate(idlePaths);

    // review-wt is assigned to in-review task — NOT idle
    expect(pool.size).toBe(0);
  });
});

describe("Worktree cleanup on restart with recycleWorktrees=false", () => {
  it("orphaned worktrees are cleaned up via git worktree remove", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("orphan-1"),
      makeDirEntry("orphan-2"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["orphan-1", "orphan-2"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(2);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(2);
  });

  it("worktrees assigned to in-progress tasks are preserved during cleanup", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("active-wt"),
      makeDirEntry("orphan-wt"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["active-wt", "orphan-wt"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      makeTask("KB-130", "in-progress", { worktree: "/root/.worktrees/active-wt" }),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(1);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][0]).toContain("orphan-wt");
    expect(removeCalls[0][0]).not.toContain("active-wt");
  });

  it("worktrees assigned to in-review tasks are preserved during cleanup", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("review-wt"),
    ] as any);
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", ["review-wt"]);

    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      makeTask("KB-131", "in-review", { worktree: "/root/.worktrees/review-wt" }),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    // review-wt is assigned to in-review task — should NOT be removed
    expect(cleaned).toBe(0);
  });
});

describe("Edge case: worktree deleted between scan and acquire", () => {
  it("acquire returns null when rehydrated worktree was deleted from disk", async () => {
    const pool = new WorktreePool();

    // Rehydrate succeeds (path exists at scan time)
    mockedExistsSync.mockReturnValue(true);
    pool.rehydrate(["/root/.worktrees/vanished-wt"]);
    expect(pool.size).toBe(1);

    // Between rehydrate and acquire, the directory is deleted
    mockedExistsSync.mockReturnValue(false);

    // acquire() checks existsSync and prunes the stale entry
    const result = pool.acquire();
    expect(result).toBeNull();
    expect(pool.size).toBe(0);
  });
});

// ── Engine pause/unpause cycle integration tests ──────────────────────────

describe("Engine pause/unpause cycle", () => {
  it("executor: agents continue running on enginePaused (soft pause), complete normally", async () => {
    const store = createMockStore();
    const task = makeTask("FN-EP1", "in-progress");
    store.getTask.mockResolvedValue(makeTaskDetail("FN-EP1", "in-progress"));

    // Agent triggers engine pause mid-flight but continues normally (soft pause)
    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger engine pause — session should NOT be terminated
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          // Session continues normally
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(task);

    // Task should complete normally (in-review), NOT moved to todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP1", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-EP1", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-EP1", { status: "failed" });
  });

  it("triage: agents NOT terminated on enginePaused (soft pause), session continues", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();
    let sessionContinued = false;

    // Agent triggers engine pause mid-flight; session should NOT be disposed
    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          // If the session was disposed by the listener, we'd get an error.
          // Instead, the session continues normally (soft pause).
          sessionContinued = true;
          // Throw to exit without needing file system (PROMPT.md read).
          // The key assertion is that dispose was NOT called by the listener.
          throw new Error("simulated completion");
        }),
        dispose: disposeFn,
      },
    } as any));

    const triage = new TriageProcessor(store, "/tmp/test");
    await triage.specifyTask(makeTask("FN-EP2", "triage"));

    // Session should have continued past the enginePaused event
    expect(sessionContinued).toBe(true);
    // dispose should only be called once in the finally block, not by the engine pause listener
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  it("scheduler resumes on unpause: schedule() runs when enginePaused goes true→false", async () => {
    const store = createMockStore();
    const todoTask = makeTask("FN-EP3", "todo");
    store.listTasks.mockResolvedValue([todoTask]);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, enginePaused: false });
    store.parseFileScopeFromPrompt.mockResolvedValue([]);

    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, {
      maxConcurrent: 2,
      maxWorktrees: 4,
      onSchedule,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 50));

    // Scheduler should have moved todo task to in-progress
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP3", "in-progress");

    // Now simulate engine pause then unpause
    store.moveTask.mockClear();
    onSchedule.mockClear();

    // During pause, scheduler halts
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, enginePaused: true });

    // Add a new todo task
    const newTask = makeTask("FN-EP4", "todo");
    store.listTasks.mockResolvedValue([newTask]);

    // Unpause — trigger settings:updated to wake the scheduler
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, enginePaused: false });
    store._trigger("settings:updated", {
      settings: { ...DEFAULT_SETTINGS, enginePaused: false },
      previous: { ...DEFAULT_SETTINGS, enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 100));
    scheduler.stop();

    // The new task should have been scheduled after unpause
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP4", "in-progress");
  });

  it("concurrency slots freed after agent completes during enginePaused (soft pause)", async () => {
    const sem = new AgentSemaphore(1); // Only 1 concurrent slot
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-EP5", "in-progress"));

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger engine pause while the agent holds the semaphore slot
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          // Agent continues and finishes normally (soft pause)
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test", { semaphore: sem });

    // Execute — agent runs to completion despite engine pause
    await executor.execute(makeTask("FN-EP5", "in-progress"));

    // After completion, the semaphore slot should be freed.
    // Verify by running a new task through the semaphore — it should not block.
    let secondSlotAcquired = false;
    const runPromise = sem.run(async () => {
      secondSlotAcquired = true;
    }, 10);

    // If the slot was properly released, this resolves immediately
    await runPromise;
    expect(secondSlotAcquired).toBe(true);
  });
});

// ── Regression: getTaskMergeBlocker import contract ──────────────────────

describe("getTaskMergeBlocker import regression", () => {
  it("getTaskMergeBlocker is importable from @fusion/core at runtime", async () => {
    // Dynamic import to verify the runtime export contract — if this fails,
    // packages/core/dist/index.js is stale or the export was removed.
    const core = await import("@fusion/core");
    expect(typeof core.getTaskMergeBlocker).toBe("function");
    expect(typeof core.isTaskReadyForMerge).toBe("function");
  });

  it("getTaskMergeBlocker rejects non-in-review tasks", async () => {
    const { getTaskMergeBlocker } = await import("@fusion/core");
    const blocker = getTaskMergeBlocker({
      column: "in-progress",
      paused: false,
      status: undefined,
      error: undefined,
      steps: [],
      workflowStepResults: [],
    });
    expect(blocker).toContain("must be in 'in-review'");
  });

  it("aiMergeTask can be loaded from merger module (getTaskMergeBlocker reachable)", async () => {
    // Verify the merger module itself loads without import errors.
    // aiMergeTask internally uses getTaskMergeBlocker from @fusion/core —
    // if the core export is broken, this dynamic import will fail.
    const merger = await import("./merger.js");
    expect(typeof merger.aiMergeTask).toBe("function");
    expect(typeof merger.findWorktreeUser).toBe("function");
  });
});
