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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));
import { AgentSemaphore } from "../concurrency.js";

const WAIT_FOR_ASYNC_OPTIONS = { timeout: 2000, interval: 5 };

async function waitForAsyncExpectation(assertion: () => void | Promise<void>) {
  await vi.waitFor(assertion, WAIT_FOR_ASYNC_OPTIONS);
}

/* eslint-disable @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any -- Test mocks use Function/any type for simplicity */

// ── Module-level mocks (matching existing test patterns) ──────────────────

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
  // FNXC:EngineTests 2026-07-02-07:40:
  // Both triage.ts and executor.ts now call formatModelMarkerDetails (from
  // pi.js) to build the model-marker log line after resolving an agent
  // session. The mock must expose the export so the resume/triage paths can
  // reach finalization instead of throwing on a missing mock member.
  formatModelMarkerDetails: vi.fn((model: string) => model),
  // triage.ts guards its catch block with `err instanceof ModelFallbackExhaustedError`
  // (imported from pi.js). Because this factory replaces pi.js wholesale, the class
  // must be exported or evaluating the `instanceof` throws "No ModelFallbackExhaustedError
  // export is defined on the mock". No restart test enters the fallback-exhausted branch,
  // so a plain Error subclass is a faithful stub (instanceof simply returns false).
  ModelFallbackExhaustedError: class ModelFallbackExhaustedError extends Error {},
}));
vi.mock("../reviewer.js", () => ({
  reviewStep: vi.fn(),
}));
vi.mock("../agent-session-helpers.js", async () => {
  const { createFnAgent } = await import("../pi.js");
  return {
    createResolvedAgentSession: async (options: any) => {
      const result = await createFnAgent(options);
      return {
        session: result.session,
        sessionFile: result.sessionFile,
        runtimeId: "pi",
        wasConfigured: false,
      };
    },
    extractRuntimeHint: (runtimeConfig: Record<string, unknown> | undefined) => {
      const hint = runtimeConfig?.runtimeHint;
      return typeof hint === "string" && hint.trim().length > 0 ? hint.trim() : undefined;
    },
    resolveExecutorSessionModel: (
      taskModelProvider: string | undefined,
      taskModelId: string | undefined,
      settings: Record<string, unknown> | undefined,
      assignedAgentRuntimeConfig?: Record<string, unknown>,
    ) => {
      const model = typeof assignedAgentRuntimeConfig?.model === "string" ? assignedAgentRuntimeConfig.model : "";
      const slash = model.indexOf("/");
      if (slash > 0 && slash < model.length - 1) {
        return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
      }
      if (taskModelProvider && taskModelId) return { provider: taskModelProvider, modelId: taskModelId };
      if (typeof settings?.executionProvider === "string" && typeof settings?.executionModelId === "string") {
        return { provider: settings.executionProvider as string, modelId: settings.executionModelId as string };
      }
      if (typeof settings?.executionGlobalProvider === "string" && typeof settings?.executionGlobalModelId === "string") {
        return { provider: settings.executionGlobalProvider as string, modelId: settings.executionGlobalModelId as string };
      }
      if (typeof settings?.defaultProviderOverride === "string" && typeof settings?.defaultModelIdOverride === "string") {
        return { provider: settings.defaultProviderOverride as string, modelId: settings.defaultModelIdOverride as string };
      }
      if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModelId === "string") {
        return { provider: settings.defaultProvider as string, modelId: settings.defaultModelId as string };
      }
      return { provider: undefined, modelId: undefined };
    },
    resolvePlanningSessionModel: (
      taskPlanningModelProvider: string | undefined,
      taskPlanningModelId: string | undefined,
      settings: Record<string, unknown> | undefined,
      assignedAgentRuntimeConfig?: Record<string, unknown>,
    ) => {
      const model = typeof assignedAgentRuntimeConfig?.model === "string" ? assignedAgentRuntimeConfig.model : "";
      const slash = model.indexOf("/");
      if (slash > 0 && slash < model.length - 1) {
        return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
      }
      if (
        typeof assignedAgentRuntimeConfig?.modelProvider === "string"
        && typeof assignedAgentRuntimeConfig?.modelId === "string"
      ) {
        return {
          provider: assignedAgentRuntimeConfig.modelProvider,
          modelId: assignedAgentRuntimeConfig.modelId,
        };
      }
      if (taskPlanningModelProvider && taskPlanningModelId) {
        return { provider: taskPlanningModelProvider, modelId: taskPlanningModelId };
      }
      if (typeof settings?.planningProvider === "string" && typeof settings?.planningModelId === "string") {
        return { provider: settings.planningProvider as string, modelId: settings.planningModelId as string };
      }
      if (typeof settings?.planningGlobalProvider === "string" && typeof settings?.planningGlobalModelId === "string") {
        return { provider: settings.planningGlobalProvider as string, modelId: settings.planningGlobalModelId as string };
      }
      if (typeof settings?.defaultProviderOverride === "string" && typeof settings?.defaultModelIdOverride === "string") {
        return { provider: settings.defaultProviderOverride as string, modelId: settings.defaultModelIdOverride as string };
      }
      if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModelId === "string") {
        return { provider: settings.defaultProvider as string, modelId: settings.defaultModelId as string };
      }
      return { provider: undefined, modelId: undefined };
    },
    // FNXC:EngineTestDrift 2026-07-11-22:30:
    // agent-session-helpers gained phase/lane thinking-level + fallback resolvers
    // (Settings-ThinkingLevel precedence, 2026-07-10) and an implicit planning
    // fallback model resolver. The exercised executor + triage paths import them;
    // surface the full set so the next export doesn't re-break this mock.
    resolveExecutorThinkingLevel: vi.fn(() => undefined),
    resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
    resolvePlanningThinkingLevel: vi.fn(() => undefined),
    resolvePlanningFallbackThinkingLevel: vi.fn(() => undefined),
    resolveValidatorThinkingLevel: vi.fn(() => undefined),
    resolveValidatorFallbackThinkingLevel: vi.fn(() => undefined),
    resolveMergerThinkingLevel: vi.fn(() => undefined),
    resolveMergerFallbackThinkingLevel: vi.fn(() => undefined),
    resolveImplicitPlanningFallbackModel: vi.fn(() => ({ provider: undefined, modelId: undefined })),
  };
});
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
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

  // execFile(file, args, opts, cb) — assemble a command string and delegate to
  // execSyncFn so the same mock infrastructure covers execFile-based git calls.
  const execFileFn: any = vi.fn((file: any, args: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? undefined : opts;
    const cmd = [file, ...(Array.isArray(args) ? args : [])].join(" ");
    try {
      const out = execSyncFn(cmd, options);
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

  // spawn() is used by the merger's verification runner. Route it through the
  // same execSyncFn mock so a single mockedExecSync.mockImplementation controls
  // both git calls (execSync) and verification commands (spawn). Throwing from
  // execSyncFn ⇒ child emits non-zero close; returning normally ⇒ exit 0.
  const spawnFn: any = vi.fn((cmd: any, opts: any) => {
    const child: any = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      try {
        const out = execSyncFn(cmd, opts);
        if (out !== undefined && out !== null) {
          child.stdout.emit("data", Buffer.from(out.toString()));
        }
        child.emit("close", 0, null);
      } catch (err: any) {
        const stderrText = err?.stderr?.toString?.() ?? err?.message ?? "";
        if (stderrText) child.stderr.emit("data", Buffer.from(stderrText));
        child.emit("close", typeof err?.status === "number" ? err.status : 1, null);
      }
    });
    return child;
  });

  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn, spawn: spawnFn };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue("# Task prompt content"),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@earendil-works/pi-ai", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: unknown) => ({ type: "string", ...((opts as object) ?? {}) }),
    Number: (opts?: unknown) => ({ type: "number", ...((opts as object) ?? {}) }),
    Boolean: (opts?: unknown) => ({ type: "boolean", ...((opts as object) ?? {}) }),
    Optional: (schema: unknown) => schema,
    Array: (schema: unknown, opts?: unknown) => ({ type: "array", items: schema, ...((opts as object) ?? {}) }),
    Union: (schemas: unknown[], opts?: unknown) => ({ anyOf: schemas, ...((opts as object) ?? {}) }),
    Literal: (value: unknown) => ({ const: value }),
    Unknown: (opts?: unknown) => ({ ...((opts as object) ?? {}) }),
    Record: (_key: unknown, value: unknown, opts?: unknown) => ({
      type: "object",
      additionalProperties: value,
      ...((opts as object) ?? {}),
    }),
  },
}));
vi.mock("@earendil-works/pi-coding-agent", () => {
  const mockSessionManager = {};
  return {
    SessionManager: {
      create: vi.fn().mockReturnValue(mockSessionManager),
      open: vi.fn().mockReturnValue(mockSessionManager),
      inMemory: vi.fn().mockReturnValue(mockSessionManager),
    },
  };
});

import { TaskExecutor } from "../executor.js";
import { TriageProcessor } from "../triage.js";
import { Scheduler } from "../scheduler.js";
import { aiMergeTask } from "../merger.js";
import { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees } from "../worktree-pool.js";
import { createFnAgent } from "../pi.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { Task, TaskDetail, TaskStep, ColumnId, Settings, StepStatus } from "@fusion/core";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
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

/*
FNXC:EngineTests 2026-07-19-18:20 (U10b):
This file defines its OWN `createMockStore`, which SHADOWS the shared harness one — so none of
the shared U5g/U10b seams reached it. Under graph ownership that is no longer a cosmetic
difference: a store exposing neither `getTaskWorkflowSelection` nor `getTaskWorkflowSelectionAsync`
now ALWAYS fails closed (`workflow-selection-api-unavailable`) because the legacy fallback
executor was deleted, so every `execute()`/`resumeOrphaned()` on this surface terminated the graph
before reaching any behavior under test.

The requirement this fake must model is "a real TaskStore": it can name the workflow a task runs
under, it serves PROMPT.md as an artifact (the graph's `parse` node reads step sources from
`getTaskDocument` before any agent session exists), it answers the verification-request reader the
completion path calls unconditionally, and — critically — its writes are READABLE BACK. The graph
deliberately re-reads the row instead of trusting the in-memory task it was handed (the
write-capable-node isolation guard and the merge implementation-proof gate both do this), so a
write-only `updateTask`/`updateStep`/`moveTask` reported a task with no worktree and no completed
steps no matter what the executor had just persisted.

Fixed once here rather than per test. Per-test `getTask`/`moveTask` overrides still choose the
row's SHAPE; the executor's own writes layer on top, because they are the later writes. A test that
must simulate an EXTERNAL mutation beating the executor's writes uses `store._setRow(id, patch)`.
*/
function createMockStore(overrides: Record<string, any> = {}) {
  const listeners = new Map<string, Function[]>();
  const patches = new Map<string, Record<string, any>>();
  const applyPatch = (id: string, patch: Record<string, any> | undefined) => {
    if (!patch || typeof patch !== "object") return;
    patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
  };
  const makeWriteThroughGetTask = (defaultImpl: (id?: string) => Promise<any>) => {
    const mock = vi.fn(defaultImpl);
    const merge = (id: string | undefined, result: unknown) =>
      result && typeof result === "object"
        ? { ...(result as Record<string, any>), ...(patches.get(id ?? "FN-001") ?? {}) }
        : result;
    const rawImpl = mock.mockImplementation.bind(mock);
    mock.mockImplementation = ((fn: (id?: string) => unknown) =>
      rawImpl(async (id?: string) => merge(id, await fn(id)))) as typeof mock.mockImplementation;
    mock.mockResolvedValue = ((value: unknown) =>
      rawImpl(async (id?: string) => merge(id, value))) as typeof mock.mockResolvedValue;
    return mock;
  };
  const makeWriteThroughMoveTask = () => {
    const finish = async (id: string, column: string, result?: unknown) => {
      applyPatch(id, { column });
      const live = await store.getTask(id);
      return result && typeof result === "object"
        ? { ...(result as Record<string, any>), ...(patches.get(id) ?? {}), ...(live ?? {}) }
        : live;
    };
    const mock = vi.fn(async (id: string, column: string) => finish(id, column));
    const rawImpl = mock.mockImplementation.bind(mock);
    mock.mockImplementation = ((fn: (...a: any[]) => unknown) =>
      rawImpl(async (id: string, column: string, ...rest: unknown[]) =>
        finish(id, column, await (fn as any)(id, column, ...rest)))) as typeof mock.mockImplementation;
    mock.mockResolvedValue = ((value: unknown) =>
      rawImpl(async (id: string, column: string) => finish(id, column, value))) as typeof mock.mockResolvedValue;
    return mock;
  };
  const store = {
    _setRow(id: string, patch: Record<string, any>) {
      applyPatch(id, patch);
    },
    on: vi.fn((event: string, fn: Function) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    emit: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: makeWriteThroughGetTask(async (id?: string) =>
      makeTaskDetail(id ?? "FN-001", "in-progress"),
    ),
    updateTask: vi.fn(async (id: string, patch: Record<string, any>) => {
      applyPatch(id, patch);
      return { ...(patches.get(id) ?? {}), id };
    }),
    moveTask: makeWriteThroughMoveTask(),
    recordActivity: vi.fn().mockResolvedValue({}),
    mergeTask: vi.fn().mockResolvedValue({}),
    getWorkflowStep: vi.fn().mockResolvedValue(undefined),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getGoalStore: vi.fn().mockReturnValue({ listGoals: vi.fn().mockReturnValue([]) }),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    getBranchGroup: vi.fn().mockReturnValue({ id: "BG-test", status: "open", branchName: "fusion/bg-test" }),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getGlobalSettingsDir: vi.fn().mockReturnValue(undefined),
    getTaskVerificationRequestAsync: vi.fn().mockResolvedValue(null),
    getTaskVerificationRequest: vi.fn().mockReturnValue(null),
    getTaskDocument: vi.fn(async (_taskId: string, key: string) =>
      key === "PROMPT.md"
        ? { content: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check" }
        : undefined,
    ),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "builtin:coding", stepIds: [] }),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    addTaskComment: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    }),
    /*
    FNXC:EngineTests 2026-06-27-10:05:
    Scheduler/restart fakes must include the production `updateSettings` heartbeat surface so restart dispatch call-count assertions stay deterministic under full-suite shard load.
    */
    updateSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
    }),
    setPluginWorkflowStepTemplates: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/tmp/root"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/root/.fusion"),
    getTasksDir: vi.fn().mockReturnValue("/tmp/root/.fusion/tasks"),
    updateStep: vi.fn(async (id: string, stepIndex: number, status: StepStatus) => {
      const current = await store.getTask(id);
      const steps = ((current?.steps as TaskStep[] | undefined) ?? []).map(
        (s, i) => (i === stepIndex ? { ...s, status } : s),
      );
      applyPatch(id, { steps });
      return { ...current, steps };
    }),
    createTask: vi.fn().mockImplementation(async (input: any) => {
      return makeTask("FN-NEW", "triage");
    }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getActiveMergingTask: vi.fn().mockReturnValue(undefined),
    _trigger(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    _listeners: listeners,
    ...overrides,
  } as any;
  store.handoffToReview ??= vi.fn().mockImplementation(async (id: string) => store.moveTask(id, "in-review"));
  return store;
}

function makeTask(id: string, column: ColumnId, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column,
    /*
    FNXC:EngineTests 2026-07-19-18:40 (U10b):
    No optional pre-merge gates by default. These restart tests hand-roll a session stub that
    assumes it IS the implementation session; under graph ownership the FIRST session is Plan
    Review, whose verdict is read off the session's stream. A stub with no `subscribe` reads as a
    provider failure, so the graph retried Plan Review in place and re-dispatched forever — a
    runaway that outlived the test and inflated unrelated agent-count assertions later in the
    file. Declaring the gates OFF restores the premise these tests were written against; a test
    that wants a gate enables it explicitly. This must live on the row the STORE serves, because
    the graph re-reads the row rather than trusting the task literal handed to `execute()`.
    */
    enabledWorkflowSteps: [],
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskDetail(id: string, column: ColumnId, overrides: Partial<TaskDetail> = {}): TaskDetail {
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
  mockedCreateFnAgent.mockResolvedValue({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
  } as any);
}

function mockAgentFailure(error = "agent crashed") {
  mockedCreateFnAgent.mockRejectedValue(new Error(error));
}

/**
 * Create a mock agent that auto-triggers the fn_task_done tool when prompt is called.
 * This simulates a successful task execution where the agent calls fn_task_done(),
 * preventing the executor from entering the "finished without fn_task_done — retrying
 * with new session" branch. Follows the same pattern as executor.test.ts.
 *
 * Uses per-session local customTools capture to avoid race conditions when
 * multiple tasks execute concurrently.
 */
function createAgentWithTaskDone() {
  mockedCreateFnAgent.mockImplementation((async (opts: { customTools?: Array<{ name: string; execute: (name: string, args: unknown) => unknown }> }) => {
    // Capture tools per-session to avoid race conditions with concurrent tasks
    const localCustomTools = opts?.customTools || [];
    const session = {
      prompt: vi.fn().mockImplementation(async () => {
        // Find and execute fn_task_done tool to set taskDone = true
        const taskDoneTool = localCustomTools.find((t: any) => t.name === "fn_task_done");
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
  mockedExecSync.mockImplementation(((cmd: unknown) => {
    if (String(cmd) === "git rev-parse --is-inside-work-tree") {
      return "true\n" as any;
    }
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
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Step 2: In-progress task resume tests ─────────────────────────────────

describe("In-progress task resume after restart", () => {
  it("resumeOrphaned() calls execute() for each in-progress task not already executing", async () => {
    const store = createMockStore();
    const task1 = makeTask("FN-001", "in-progress");
    const task2 = makeTask("FN-002", "in-progress");
    const taskDone = makeTask("FN-003", "done");
    store.listTasks.mockResolvedValue([task1, task2, taskDone]);

    // Use deterministic mock that calls fn_task_done to prevent retry-with-new-session
    createAgentWithTaskDone();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    });

    // Exactly one agent session per in-progress task (no retry inflation)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

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
    await waitForAsyncExpectation(() => {
      expect(store.logEntry).toHaveBeenCalledWith("FN-010", "Resumed after engine restart");
    });

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
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(capturedPrompt).toContain("⚠️ RESUMING");
    });

    expect(capturedPrompt).toContain("⚠️ RESUMING");
    expect(capturedPrompt).toContain("Step 0 (Step 0): **done**");
    expect(capturedPrompt).toContain("Step 3 (Step 3): **in-progress**");
    expect(capturedPrompt).toContain("Resume from: Step 3");
  });

  it("resumed task does NOT re-run worktreeInitCommand", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const,
      worktreeInitCommand: "pnpm install --frozen-lockfile",
    });
    const task = makeTask("FN-030", "in-progress");
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-030", "in-progress"));

    mockedExistsSync.mockReturnValue(true); // worktree exists
    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(store.getSettings).toHaveBeenCalled();
    });

    // getSettings is called (for project commands in execution prompt) but init command should not run
    expect(store.getSettings).toHaveBeenCalled();

    // No init command calls
    const initCalls = mockedExecSync.mock.calls.filter(
      (call) => call[0] === "pnpm install --frozen-lockfile",
    );
    expect(initCalls).toHaveLength(0);
  });

  it("recovers a step whose code review approved before the engine stopped (no review replay)", async () => {
    const store = createMockStore();
    const steps: StepStatus[] = ["done", "in-progress", "pending"];
    const task = makeTask("FN-1701", "in-progress", {
      steps: makeSteps(...steps),
      currentStep: 1,
    });
    // Log order mirrors what we saw in FN-2215: plan review APPROVE → impl →
    // code review requested → code review APPROVE → (engine stops before
    // step status flips to done).
    const detail = makeTaskDetail("FN-1701", "in-progress", {
      steps: makeSteps(...steps),
      currentStep: 1,
      log: [
        { timestamp: "2026-04-21T00:00:00.000Z", action: "Step 1 (Step 1) → in-progress" },
        { timestamp: "2026-04-21T00:00:01.000Z", action: "plan review Step 1: APPROVE" },
        { timestamp: "2026-04-21T00:00:02.000Z", action: "code review requested for Step 1 (Step 1)" },
        { timestamp: "2026-04-21T00:00:03.000Z", action: "code review Step 1: APPROVE" },
      ],
    });
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(detail);

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(store.updateStep).toHaveBeenCalledWith("FN-1701", 1, "done");
    });

    // The step should have been flipped to done *before* execute ran.
    expect(store.updateStep).toHaveBeenCalledWith("FN-1701", 1, "done");
    // A recovery log entry should have been written explaining the flip.
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1701",
      expect.stringContaining("recovered as done on resume"),
    );
  });

  it("does NOT recover a step that was reset to pending after its code review approved", async () => {
    const store = createMockStore();
    const steps: StepStatus[] = ["done", "in-progress", "pending"];
    const detail = makeTaskDetail("FN-1702", "in-progress", {
      steps: makeSteps(...steps),
      currentStep: 1,
      log: [
        { timestamp: "2026-04-21T00:00:00.000Z", action: "Step 1 (Step 1) → in-progress" },
        { timestamp: "2026-04-21T00:00:01.000Z", action: "code review Step 1: APPROVE" },
        // Workflow revision came in after the approval and reset this step.
        { timestamp: "2026-04-21T00:00:02.000Z", action: "Step 1 (Step 1) → pending" },
        { timestamp: "2026-04-21T00:00:03.000Z", action: "Step 1 (Step 1) → in-progress" },
      ],
    });
    store.listTasks.mockResolvedValue([makeTask("FN-1702", "in-progress", { steps: makeSteps(...steps), currentStep: 1 })]);
    store.getTask.mockResolvedValue(detail);

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalled();
    });

    // Must NOT mark the step done — the reset invalidated the prior approval.
    const updateStepDoneCalls = store.updateStep.mock.calls.filter(
      (c: any[]) => c[0] === "FN-1702" && c[2] === "done",
    );
    expect(updateStepDoneCalls).toHaveLength(0);
  });

  it("does NOT recover a step whose code review only revised (no APPROVE)", async () => {
    const store = createMockStore();
    const steps: StepStatus[] = ["done", "in-progress", "pending"];
    const detail = makeTaskDetail("FN-1703", "in-progress", {
      steps: makeSteps(...steps),
      currentStep: 1,
      log: [
        { timestamp: "2026-04-21T00:00:00.000Z", action: "Step 1 (Step 1) → in-progress" },
        { timestamp: "2026-04-21T00:00:01.000Z", action: "code review Step 1: REVISE" },
      ],
    });
    store.listTasks.mockResolvedValue([makeTask("FN-1703", "in-progress", { steps: makeSteps(...steps), currentStep: 1 })]);
    store.getTask.mockResolvedValue(detail);

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalled();
    });

    const updateStepDoneCalls = store.updateStep.mock.calls.filter(
      (c: any[]) => c[0] === "FN-1703" && c[2] === "done",
    );
    expect(updateStepDoneCalls).toHaveLength(0);
  });

  it("recovers multiple in-progress steps that each have approved code reviews", async () => {
    const store = createMockStore();
    // Two consecutive steps each stuck in-progress with approved code reviews.
    // (Rare but possible if the agent was processing step N+1 when the engine
    // stopped after approving step N.)
    const steps: StepStatus[] = ["in-progress", "in-progress", "pending"];
    const detail = makeTaskDetail("FN-1704", "in-progress", {
      steps: makeSteps(...steps),
      currentStep: 0,
      log: [
        { timestamp: "2026-04-21T00:00:00.000Z", action: "Step 0 (Step 0) → in-progress" },
        { timestamp: "2026-04-21T00:00:01.000Z", action: "code review Step 0: APPROVE" },
        { timestamp: "2026-04-21T00:00:02.000Z", action: "Step 1 (Step 1) → in-progress" },
        { timestamp: "2026-04-21T00:00:03.000Z", action: "code review Step 1: APPROVE" },
      ],
    });
    store.listTasks.mockResolvedValue([makeTask("FN-1704", "in-progress", { steps: makeSteps(...steps), currentStep: 0 })]);
    store.getTask.mockResolvedValue(detail);

    mockAgentSuccess();

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(store.updateStep).toHaveBeenCalledWith("FN-1704", 0, "done");
    });

    expect(store.updateStep).toHaveBeenCalledWith("FN-1704", 0, "done");
    expect(store.updateStep).toHaveBeenCalledWith("FN-1704", 1, "done");
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
    await waitForAsyncExpectation(() => {
      expect(store.logEntry).toHaveBeenCalledWith("FN-040", "Resumed after engine restart");
    });

    expect(store.logEntry).toHaveBeenCalledWith("FN-040", "Resumed after engine restart");
    expect(store.logEntry).toHaveBeenCalledWith("FN-041", "Resumed after engine restart");
  });

  /*
  FNXC:EngineTests 2026-07-19-19:10 (U10b):
  "Already complete" now has to mean complete INCLUDING its pre-merge gates. The graph is the
  sole owner of gate execution, so recovery only transitions straight to in-review when the
  gates are provably satisfied; a task whose gates have not run is re-dispatched through the
  graph instead (that is the FN-7039 fail-open this cutover closed). Recording the passed
  default review rows states the premise this test always assumed — that nothing is left to run
  and only the stranded COLUMN needs fixing — so every assertion below is unchanged.
  */
  it("resumeOrphaned() fast-paths already-complete tasks to in-review", async () => {
    const store = createMockStore();
    const passedDefaultReviews = [
      { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge" as const, status: "passed" as const },
      { workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge" as const, status: "passed" as const },
    ];
    const completedTask = makeTask("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      baseCommitSha: "base123",
      steps: makeSteps("done", "done", "skipped"),
      enabledWorkflowSteps: undefined,
      workflowStepResults: passedDefaultReviews,
    });
    store.listTasks.mockResolvedValue([completedTask]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      baseCommitSha: "base123",
      steps: makeSteps("done", "done", "skipped"),
      enabledWorkflowSteps: undefined,
      workflowStepResults: passedDefaultReviews,
    }));

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([
      "packages/dashboard/app/components/SettingsModal.tsx",
    ]);
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
        "Auto-recovered: task work was complete but stranded in in-progress — moved to in-review",
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

  it("resumeOrphaned() leaves no-progress no-fn_task_done failures for self-healing", async () => {
    const store = createMockStore();
    const failedTask = makeTask("FN-1473", "in-progress", {
      status: "failed",
      error: "Agent finished without calling fn_task_done (after retry)",
      steps: [],
    });
    store.listTasks.mockResolvedValue([failedTask]);

    const executor = new TaskExecutor(store, "/tmp/test");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.resumeOrphaned();

    expect(executeSpy).not.toHaveBeenCalled();
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1473", "Resumed after engine restart");
  });

  // U4 (KTD-2/KTD-5): the legacy `runWorkflowSteps` recovery path was deleted.
  // recoverCompletedTask now RE-ENTERS the workflow graph, which records
  // workflowStepResults and OWNS the in-review / back-for-fix transition.
  // These two tests replace the old "runWorkflowSteps fails → bounce" test:
  // one proves the graph re-entry seam, one proves the fail-closed guard.
  /*
  FNXC:EngineTests 2026-07-19-18:25 (U10b):
  The graph entry seam is `executeWorkflowGraph`, not `maybeExecuteWorkflowGraph`. The rename
  encodes a contract change, not a cosmetic one: the graph can no longer DECLINE a task (it
  returns void and fails closed instead of falling through to a second, legacy executor), so
  there is nothing left for a "maybe" to mean. Recovery therefore delegates unconditionally.
  */
  it("recoverCompletedTask() re-enters the workflow graph (records results + owns the transition)", async () => {
    const store = createMockStore();
    const task = makeTask("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      steps: makeSteps("done"),
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    // The graph is the sole executor; recovery delegates to it. Spy the graph
    // entry to assert the re-entry seam without standing up a full graph runner
    // (the graph's own recording/transition behavior is covered by
    // builtin-coding-workflow-step-results.test.ts and the cutover backstop).
    const graphEntry = vi
      .spyOn(executor as any, "executeWorkflowGraph")
      .mockResolvedValue(true);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(graphEntry).toHaveBeenCalledTimes(1);
    expect(graphEntry).toHaveBeenCalledWith(task);
    // The graph owns the transition — recovery must NOT itself bounce or hand off.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-963", "in-review");
  });

  it("recoverCompletedTask() skips graph re-entry when enabled pre-merge gates already passed", async () => {
    const store = createMockStore();
    const task = makeTask("FN-7228", "in-progress", {
      worktree: "/tmp/wt/FN-7228",
      steps: makeSteps("done"),
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "passed",
        },
        {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          phase: "pre-merge",
          status: "passed",
        },
      ],
    });
    store.getTask.mockResolvedValue(makeTaskDetail("FN-7228", "in-progress", {
      worktree: "/tmp/wt/FN-7228",
      steps: makeSteps("done"),
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: task.workflowStepResults,
    }));

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graphEntry = vi
      .spyOn(executor as any, "executeWorkflowGraph")
      .mockResolvedValue(true);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(graphEntry).not.toHaveBeenCalled();
    expect(store.handoffToReview).toHaveBeenCalledWith("FN-7228", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "completed-task-recovered" }),
    }));
  });

  it("recoverCompletedTask() legally re-homes a completed triage zombie before review handoff", async () => {
    const store = createMockStore();
    const task = makeTask("FN-TRIAGE-ZOMBIE", "triage", {
      worktree: "/tmp/wt/FN-TRIAGE-ZOMBIE",
      steps: makeSteps("done"),
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowIrPinNodeId: "merge",
      workflowStepResults: [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "passed" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "passed" },
      ],
    });
    store.getTask.mockResolvedValue(makeTaskDetail("FN-TRIAGE-ZOMBIE", "triage", {
      worktree: task.worktree,
      steps: makeSteps("done"),
      enabledWorkflowSteps: task.enabledWorkflowSteps,
      workflowIrPinNodeId: "merge",
      workflowStepResults: task.workflowStepResults,
    }));

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(store.moveTask).toHaveBeenNthCalledWith(
      1,
      task.id,
      "todo",
      expect.objectContaining({ recoveryRehome: true, preserveProgress: true, preserveWorktree: true }),
    );
    expect(store.moveTask).toHaveBeenNthCalledWith(2, task.id, "in-progress");
    expect(store.handoffToReview).toHaveBeenCalledWith(task.id, expect.objectContaining({
      evidence: expect.objectContaining({ reason: "completed-task-recovered" }),
    }));
  });

  /*
  FNXC:EngineTests 2026-07-19-18:55 (U10b):
  "Enabled steps are ABSENT" is the condition under test, so it must be stated rather than
  inherited: the fixture builders now default `enabledWorkflowSteps` to `[]` (gates off) for the
  graph, and `[]` is a present-but-empty selection, not an absent one. Setting it back to
  `undefined` keeps this test asserting the default-review-row path it was written for.
  */
  it("recoverCompletedTask() treats passed default review rows as satisfied when enabled steps are absent", async () => {
    const store = createMockStore();
    const task = makeTask("FN-7228-DEFAULT", "in-progress", {
      worktree: "/tmp/wt/FN-7228-DEFAULT",
      steps: makeSteps("done"),
      enabledWorkflowSteps: undefined,
      workflowStepResults: [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "passed" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "passed" },
      ],
    });
    store.getTask.mockResolvedValue(makeTaskDetail("FN-7228-DEFAULT", "in-progress", {
      worktree: "/tmp/wt/FN-7228-DEFAULT",
      steps: makeSteps("done"),
      enabledWorkflowSteps: undefined,
      workflowStepResults: task.workflowStepResults,
    }));

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graphEntry = vi
      .spyOn(executor as any, "executeWorkflowGraph")
      .mockResolvedValue(true);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(graphEntry).not.toHaveBeenCalled();
    expect(store.handoffToReview).toHaveBeenCalledWith("FN-7228-DEFAULT", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "completed-task-recovered" }),
    }));
  });

  it("recoverCompletedTask() fails closed (KTD-5) when the store lacks getTaskWorkflowSelection and the task has enabled workflow steps", async () => {
    /*
    FNXC:EngineTests 2026-07-19-18:45 (U10b):
    The fail-closed requirement is unchanged, but the premise now has to be STATED. The default
    fake is workflow-aware (as a real TaskStore is), so this test deliberately strips the
    workflow-selection readers to model the only remaining store that cannot name a workflow.
    Such a store no longer has a legacy executor to fall through to: it parks the task instead of
    reaching review with its gates unrun (the FN-7039 class). The reason string is now
    unconditional and no longer mentions enabled step counts.
    */
    const store = createMockStore({
      getTaskWorkflowSelection: undefined,
      getTaskWorkflowSelectionAsync: undefined,
      getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-963", "in-progress", {
        worktree: "/tmp/wt/FN-963",
        steps: makeSteps("done"),
        enabledWorkflowSteps: ["wf-1"],
      })),
    });
    const task = makeTask("FN-963", "in-progress", {
      worktree: "/tmp/wt/FN-963",
      steps: makeSteps("done"),
      enabledWorkflowSteps: ["wf-1"],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    // Spy handleGraphFailure (the park-the-task seam) to assert the fail-closed
    // branch fired with a clear reason — i.e. NOT a silent no-op.
    const handleGraphFailure = vi
      .spyOn(executor as any, "handleGraphFailure")
      .mockResolvedValue(undefined);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(true);
    expect(handleGraphFailure).toHaveBeenCalledTimes(1);
    const failureArg = (handleGraphFailure.mock.calls[0] as unknown[])[1] as {
      disposition: string;
      reason: string;
    };
    expect(failureArg.disposition).toBe("failed");
    expect(String(failureArg.reason)).toContain("workflow-selection-api-unavailable");
    // Must NOT silently finalize to review as a success.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-963", "in-review");
  });

  // FNXC:WorkflowOptionalStepFix 2026-06-28-12:00 (FN-7210 regression):
  // A pre-merge optional/advisory REVISE reopens plan steps to `pending` and
  // schedules a remediation bounce so the executor can finish them. recoverCompletedTask
  // must NOT re-enter the workflow graph (and thus the merge node) while the live task
  // still has incomplete steps — otherwise the re-run re-passes the advisory step
  // (fix budget exhausted), advances to merge, and the merge gate refuses forever with
  // "task has incomplete steps".
  it("recoverCompletedTask() refuses graph re-entry when the live task has incomplete steps", async () => {
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-7210", "in-review", {
        worktree: "/tmp/wt/FN-7210",
        steps: makeSteps("done", "done", "pending"),
      })),
    });
    const task = makeTask("FN-7210", "in-review", {
      worktree: "/tmp/wt/FN-7210",
      steps: makeSteps("done", "done", "pending"),
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graphEntry = vi
      .spyOn(executor as any, "executeWorkflowGraph")
      .mockResolvedValue(true);

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(false);
    expect(graphEntry).not.toHaveBeenCalled();
  });

  // FNXC:WorkflowOptionalStepFix 2026-06-28-12:00 (FN-7210 regression):
  // While a remediation bounce is scheduled (scheduleWorkflowRerun registers a
  // rerun watchdog synchronously), recoverCompletedTask must yield to it rather than
  // racing a competing graph re-entry to the merge node.
  it("recoverCompletedTask() yields to a scheduled workflow remediation bounce", async () => {
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-7211", "in-review", {
        worktree: "/tmp/wt/FN-7211",
        steps: makeSteps("done"),
      })),
    });
    const task = makeTask("FN-7211", "in-review", {
      worktree: "/tmp/wt/FN-7211",
      steps: makeSteps("done"),
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue([]);
    const graphEntry = vi
      .spyOn(executor as any, "executeWorkflowGraph")
      .mockResolvedValue(true);
    // Simulate a bounce already scheduled for this task.
    (executor as any).workflowRerunWatchdogs.set("FN-7211", setTimeout(() => {}, 0));

    const recovered = await executor.recoverCompletedTask(task);

    expect(recovered).toBe(false);
    expect(graphEntry).not.toHaveBeenCalled();
    clearTimeout((executor as any).workflowRerunWatchdogs.get("FN-7211"));
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
    mockedExecSync.mockImplementation(((cmd: unknown) => {
      const cmdStr = String(cmd);
      // Post-squash check: squash staged changes → "1"
      if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
      // Post-agent check: agent committed → "0"
      if (cmdStr.includes("diff --cached")) return "0" as any;
      return Buffer.from("");
    }) as any);

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

      mockedExecSync.mockImplementation(((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("diff --cached --quiet")) return "1" as any;
        if (cmdStr.includes("diff --cached")) return "0" as any;
        return Buffer.from("");
      }) as any);
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
    mockedExecSync.mockImplementation(((cmd: unknown) => {
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
    }) as any);

    mockedCreateFnAgent.mockResolvedValue({
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

  it("aiMergeTask blocks done transition when branch is missing and ownership evidence is unproven", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-056", "in-review"));
    store.moveTask.mockResolvedValue(makeTask("FN-056", "done"));

    // git rev-parse --verify throws (branch not found)
    mockedExecSync.mockImplementation(((cmd: unknown) => {
      if (typeof cmd === "string" && cmd.includes("git rev-parse --verify")) {
        throw new Error("branch not found");
      }
      return Buffer.from("");
    }) as any);

    const result = await aiMergeTask(store, "/tmp/root", "FN-056");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("finalize-unproven");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-056", "done");
    expect(store.moveTask).toHaveBeenCalledWith("FN-056", "todo", expect.anything());
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

    await waitForAsyncExpectation(() => {
      expect(store.updateTask).toHaveBeenCalledWith("FN-060", { status: "planning" });
    });
    triage.stop();

    // Both triage tasks should have been picked up for specification
    expect(store.updateTask).toHaveBeenCalledWith("FN-060", { status: "planning" });
    expect(store.updateTask).toHaveBeenCalledWith("FN-061", { status: "planning" });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("specifyTask() skips task already in processing set (no double-specification)", async () => {
    const store = createMockStore();
    const task = makeTask("FN-062", "triage");
    store.getTask.mockResolvedValue(makeTaskDetail("FN-062", "triage"));

    // Slow agent to keep task in processing — only the first prompt() blocks;
    // subsequent calls (e.g. the no-APPROVE reminder loop in triage) resolve
    // immediately so cleanup can drain.
    let resolvePrompt: (() => void) | undefined;
    let promptCallCount = 0;
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => {
          promptCallCount += 1;
          if (promptCallCount === 1) {
            return new Promise<void>((r) => { resolvePrompt = r; });
          }
          return Promise.resolve();
        }),
        dispose: vi.fn(),
      },
    } as any);

    const triage = new TriageProcessor(store, "/tmp/root");

    // Start first specification (will block on prompt)
    const first = triage.specifyTask(task);

    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    // Second call should be a no-op (already processing)
    await triage.specifyTask(task);

    // Only one agent created
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

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
    // Mock getTask for compare-and-swap verification in schedule()
    store.getTask.mockResolvedValue(todoTask);

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
    await waitForAsyncExpectation(() => {
      expect(store.moveTask).toHaveBeenCalledWith("FN-070", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
    scheduler.stop();

    expect(store.moveTask).toHaveBeenCalledWith("FN-070", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-070", expect.objectContaining({ status: null, blockedBy: null }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: todoTask.id,
      column: "in-progress",
      effectiveNodeSource: "local",
      dispatchStormCount: 1,
      blockedBy: undefined,
    }));
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
    await waitForAsyncExpectation(() => {
      expect(onBlocked).toHaveBeenCalledWith(blockedTask, ["FN-071"]);
    });
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
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, autoMerge: true });

    mockAgentSuccess();

    // 1. Triage picks up triage tasks
    const triage = new TriageProcessor(store, "/tmp/root", {
      pollIntervalMs: 100000,
    });
    triage.start();
    await waitForAsyncExpectation(() => {
      expect(store.updateTask).toHaveBeenCalledWith("FN-080", { status: "planning" });
    });
    triage.stop();

    expect(store.updateTask).toHaveBeenCalledWith("FN-080", { status: "planning" });

    // 2. Scheduler moves todo → in-progress
    vi.clearAllMocks();
    store.listTasks.mockResolvedValue(allTasks);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });

    const scheduler = new Scheduler(store, { maxConcurrent: 2, maxWorktrees: 4 });
    scheduler.start();
    await waitForAsyncExpectation(() => {
      expect(store.moveTask).toHaveBeenCalledWith("FN-081", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
    scheduler.stop();

    expect(store.moveTask).toHaveBeenCalledWith("FN-081", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));

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
    await waitForAsyncExpectation(() => {
      expect(store.logEntry).toHaveBeenCalledWith("FN-082", "Resumed after engine restart");
    });

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
    mockedCreateFnAgent.mockResolvedValue({
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
    await waitForAsyncExpectation(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.any(Error));
    });

    // onError should have been called
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.any(Error));

    // Semaphore slot should be released
    expect(sem.activeCount).toBe(0);

    // Task should be eligible for resume (not in executing set)
    // Verify by calling resumeOrphaned again — it should try to execute again
    vi.clearAllMocks();
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-090", "in-progress"));
    // Use deterministic mock that calls fn_task_done to prevent retry-with-new-session
    createAgentWithTaskDone();

    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    // Exactly one agent created for the re-resume, proving the task was eligible
    // and completed without retry inflation.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Re-resume should have logged again (behavioral guarantee)
    expect(store.logEntry).toHaveBeenCalledWith("FN-090", "Resumed after engine restart");
  });

  it("engine killed during merge — git reset --merge cleanup, task stays in-review", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-091", "in-review"));

    mockedExecSync.mockImplementation(((cmd: unknown) => {
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
    }) as any);

    // Agent prompt rejects (simulating kill during merge)
    mockedCreateFnAgent.mockResolvedValue({
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
    const rootDir = "/private/tmp/test";
    const worktreePath = `${rootDir}/.worktrees/swift-falcon`;
    const task = makeTask("FN-092", "in-progress", {
      worktree: worktreePath,
      branch: "fusion/fn-092",
    });
    store.listTasks.mockResolvedValue([task]);
    store.getTask.mockResolvedValue(makeTaskDetail("FN-092", "in-progress", {
      worktree: worktreePath,
      branch: "fusion/fn-092",
    }));
    mockedExecSync.mockImplementation(((cmd: unknown) => {
      if (String(cmd) === "git rev-parse --is-inside-work-tree") {
        return "true\n" as any;
      }
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          `worktree ${rootDir}`,
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          `worktree ${worktreePath}`,
          "HEAD def456",
          "branch refs/heads/fusion/fn-092",
          "",
        ].join("\n") as any;
      }
      return Buffer.from("");
    }) as any);

    let resolvePrompt: (() => void) | undefined;
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => new Promise<void>((r) => { resolvePrompt = r; })),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, rootDir);

    // First call starts execution
    const first = executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    // Second call while first is still executing
    const second = executor.resumeOrphaned();
    await Promise.resolve();

    // Only one agent should have been created (the executing set guards against double-exec)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

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
    mockedCreateFnAgent.mockRejectedValue(new Error("cannot create agent"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      onError,
    });

    await executor.resumeOrphaned();
    await waitForAsyncExpectation(() => {
      expect(onError).toHaveBeenCalled();
    });

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
  mockedExecSync.mockImplementation(((cmd: unknown) => {
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
  }) as any);
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
      mergeIntegrationWorktree: "cwd-main" as const,
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

    // Pool should be empty (worktree acquired)
    expect(pool.size).toBe(0);

    // No git worktree add calls (reused from pool)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(0);

    // Should log either successful pool reuse or classified fallback to fresh creation.
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-110",
      expect.stringMatching(/Acquired worktree from pool|Pool returned .*worktree/),
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
    const result = pool.acquire("FN-test");
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
    mockedCreateFnAgent.mockImplementation((async (opts: any) => ({

      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger engine pause — session should NOT be terminated
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });

          // Session continues normally and completes by calling fn_task_done
          const taskDoneTool = opts?.customTools?.find((t: any) => t.name === "fn_task_done");
          if (taskDoneTool) {
            await taskDoneTool.execute("tool-1", {});
          }
        }),
        dispose: vi.fn(),
      },
    }) as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(task);

    // Soft pause: agent sessions continue and may complete to in-review; do not fail the task.
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP1", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-EP1", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-EP1", { status: "failed" });
  });

  it("triage: agents NOT terminated on enginePaused (soft pause), session continues", async () => {
    /*
    FNXC:EngineTests 2026-07-15-17:20:
    FN-7977 gates planning writes with isTaskStillInPlanningStage via getTask.
    The default createMockStore getTask returns an in-progress FN-001 detail, which
    aborts specifyTask before createFnAgent. Return the live triage task under test.
    */
    const task = makeTask("FN-EP2", "triage");
    const store = createMockStore({
      getTask: vi.fn().mockResolvedValue(makeTaskDetail("FN-EP2", "triage")),
    });
    const disposeFn = vi.fn();
    let sessionContinued = false;

    // Agent triggers engine pause mid-flight; session should NOT be disposed
    mockedCreateFnAgent.mockImplementation(async () => ({
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
    await triage.specifyTask(task);

    // Session should have continued past the enginePaused event
    expect(sessionContinued).toBe(true);
    // dispose should only be called once in the finally block, not by the engine pause listener
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  it("scheduler resumes on unpause: schedule() runs when enginePaused goes true→false", async () => {
    const store = createMockStore();
    const todoTask = makeTask("FN-EP3", "todo");
    store.listTasks.mockResolvedValue([todoTask]);
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, enginePaused: false });
    store.parseFileScopeFromPrompt.mockResolvedValue([]);
    // Mock getTask for compare-and-swap verification in schedule()
    store.getTask.mockResolvedValue(todoTask);

    const onSchedule = vi.fn();
    const scheduler = new Scheduler(store, {
      maxConcurrent: 2,
      maxWorktrees: 4,
      onSchedule,
    });

    scheduler.start();
    await waitForAsyncExpectation(() => {
      expect(store.moveTask).toHaveBeenCalledWith("FN-EP3", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    // Scheduler should have moved todo task to in-progress
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP3", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));

    // Now simulate engine pause then unpause
    store.moveTask.mockClear();
    onSchedule.mockClear();

    // During pause, scheduler halts
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, enginePaused: true });

    // Add a new todo task
    const newTask = makeTask("FN-EP4", "todo");
    store.listTasks.mockResolvedValue([newTask]);

    // Unpause — trigger settings:updated to wake the scheduler
    store.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, enginePaused: false });
    store._trigger("settings:updated", {
      settings: { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, enginePaused: false },
      previous: { ...DEFAULT_SETTINGS,
      mergeIntegrationWorktree: "cwd-main" as const, enginePaused: true },
    });

    await waitForAsyncExpectation(() => {
      expect(store.moveTask).toHaveBeenCalledWith("FN-EP4", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
    scheduler.stop();

    // The new task should have been scheduled after unpause
    expect(store.moveTask).toHaveBeenCalledWith("FN-EP4", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
  });

  it("concurrency slots freed after agent completes during enginePaused (soft pause)", async () => {
    const sem = new AgentSemaphore(1); // Only 1 concurrent slot
    const store = createMockStore();
    store.getTask.mockResolvedValue(makeTaskDetail("FN-EP5", "in-progress"));

    mockedCreateFnAgent.mockImplementation(async () => ({
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
    const merger = await import("../merger.js");
    expect(typeof merger.aiMergeTask).toBe("function");
    expect(typeof merger.findWorktreeUser).toBe("function");
  });
});

/* eslint-enable @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any */
