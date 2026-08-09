import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { validateCustomFieldPatch, type Settings, type Task } from "@fusion/core";

const testState = vi.hoisted(() => {
  class MockVerificationError extends Error {
    verificationResult: unknown;

    constructor(message: string, verificationResult: unknown) {
      super(message);
      this.name = "VerificationError";
      this.verificationResult = verificationResult;
    }
  }

  return {
    currentStore: null as MockTaskStore | null,
    runAiMerge: vi.fn(),
    VerificationError: MockVerificationError,
  };
});

// FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 unified the merge
// dispatch onto runAiMerge (merger-ai.js). These error-recovery tests use the
// merge fn as a mockable seam; they now mock/assert runAiMerge. VerificationError
// still comes from merger.js (shared, not deprecated).
vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => undefined),
  VerificationError: testState.VerificationError,
}));

// FNXC:Workspace 2026-06-22-09:30 (Phase C review fix): the dispatch's error handler does
// `err instanceof WorkspaceRepoLandBusyError` / `WorkspacePartialLandError` on EVERY merge error
// (these classes are imported from ./merger-ai.js). A bare replacement mock left them undefined,
// so `instanceof undefined` threw on every recovery path (24 pre-existing red tests). Re-export the
// REAL error classes via importOriginal so the instanceof guards evaluate; only runAiMerge is faked.
vi.mock("../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai.js")>();
  return {
    ...actual,
    runAiMerge: testState.runAiMerge,
  };
});

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => testState.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      resumeAfterUnpause: vi.fn(async () => undefined),
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";
import { VerificationError } from "../merger.js";
import { runAiMerge } from "../merge/merger-ai.js";

type MockTask = {
  id: string;
  title?: string;
  column: "triage" | "todo" | "in-progress" | "in-review" | "done" | "archived";
  mergeRetries: number;
  status: string | null;
  error: string | null;
  paused?: boolean;
  blockedBy?: string | null;
  overlapBlockedBy?: string | null;
  steps?: Array<{ status: string }>;
  mergeDetails?: { mergeConfirmed?: boolean; commitSha?: string; mergedAt?: string } | null;
  verificationFailureCount?: number;
  mergeConflictBounceCount?: number;
  mergeTransientRetryCount?: number;
  awaitingApprovalReason?: "merge-blocked-by-policy" | null;
  branch?: string;
  worktree?: string;
  sourceType?: string;
  sourceParentTaskId?: string;
  customFields?: Record<string, unknown>;
  updatedAt: string;
  log: Array<{ action?: string }>;
};

type MockTaskStore = {
  getSettings: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  addTaskComment: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  getActiveMergingTask: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  recordRunAuditEvent: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
};

const TASK_ID = "FN-2084";

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: TASK_ID,
    column: "in-review",
    mergeRetries: 0,
    status: null,
    error: null,
    updatedAt: new Date().toISOString(),
    log: [],
    ...overrides,
  };
}

function makeStore({
  tasks,
  listedTasks,
  settings,
  updateTask,
}: {
  tasks?: Array<MockTask | null>;
  listedTasks?: MockTask[];
  settings?: Partial<Settings>;
  updateTask?: ReturnType<typeof vi.fn>;
} = {}): MockTaskStore {
  const taskSequence = tasks ?? [makeTask(), makeTask()];
  let taskIdx = 0;

  return {
    getSettings: vi.fn(async () => ({
      autoMerge: true,
      autoResolveConflicts: true,
      globalPause: false,
      enginePaused: false,
      pollIntervalMs: 15_000,
      // FNXC:MergerUnification 2026-06-21-19:05: U0 unified merges onto runAiMerge;
      // these tests mock/assert runAiMerge directly. No `merger.mode` pin needed —
      // the dispatch ignores the value.
      ...settings,
    })),
    listTasks: vi.fn(async () => listedTasks ?? taskSequence.filter((task): task is MockTask => Boolean(task))),
    getTask: vi.fn(async () => {
      const value = taskSequence[Math.min(taskIdx, taskSequence.length - 1)] ?? null;
      taskIdx += 1;
      return value;
    }),
    updateTask: updateTask ?? vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
    createTask: vi.fn(async (input: { description: string }) => ({
      id: "FN-9999",
      description: input.description,
    })),
    recordRunAuditEvent: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createEngine(
  store: MockTaskStore,
  options: {
    getMergeStrategy?: (settings: Settings) => "direct" | "pull-request";
    processPullRequestMerge?: (...args: unknown[]) => Promise<"merged" | "waiting" | "skipped">;
    getTaskMergeBlocker?: (task: Task) => string | null | undefined;
  } = {},
): ProjectEngine {
  testState.currentStore = store;

  return new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    },
    {} as never,
    {
      skipNotifier: true,
      ...options,
    },
  );
}

async function runMergeCycle(engine: ProjectEngine, taskId = TASK_ID): Promise<void> {
  const privateEngine = engine as unknown as {
    mergeQueue: string[];
    mergeActive: Set<string>;
    drainMergeQueue: () => Promise<void>;
  };

  privateEngine.mergeActive.add(taskId);
  privateEngine.mergeQueue.push(taskId);
  await privateEngine.drainMergeQueue();
}

function hasErrorLog(errorSpy: MockInstance, text: string): boolean {
  return errorSpy.mock.calls.some(([message]) => String(message).includes(text));
}

describe("ProjectEngine merge error recovery", () => {
  let errorSpy: MockInstance;
  let warnSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAiMerge).mockReset();
    testState.currentStore = null;

    errorSpy = vi.spyOn(runtimeLog, "error").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    logSpy = vi.spyOn(runtimeLog, "log").mockImplementation(() => undefined);
  });

  it("keeps merge retry timer chain alive after sweep settings read failure", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStore();
    const settingsError = new Error("settings unavailable");
    store.getSettings
      .mockRejectedValueOnce(settingsError)
      .mockResolvedValueOnce({ pollIntervalMs: 7000 });

    const engine = createEngine(store);
    const privateEngine = engine as unknown as {
      scheduleMergeRetry: (taskStore: MockTaskStore) => void;
      mergeRetryTimer: ReturnType<typeof setTimeout> | null;
    };

    privateEngine.scheduleMergeRetry(store);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.runAllTicks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge periodic sweep failed: settings unavailable"),
    );
    expect(privateEngine.mergeRetryTimer).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    expect(setTimeoutSpy.mock.calls.some(([, interval]) => interval === 7000)).toBe(true);
    vi.useRealTimers();
  });


  it("uses default retry interval when interval settings retrieval fails", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStore();
    store.getSettings
      .mockResolvedValueOnce({ autoMerge: true, globalPause: false, enginePaused: false })
      .mockRejectedValueOnce(new Error("interval unavailable"));

    const engine = createEngine(store);
    const privateEngine = engine as unknown as {
      scheduleMergeRetry: (taskStore: MockTaskStore) => void;
      mergeRetryTimer: ReturnType<typeof setTimeout> | null;
    };

    privateEngine.scheduleMergeRetry(store);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.runAllTicks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge retry: failed to read pollIntervalMs, using default 15s: interval unavailable"),
    );
    expect(privateEngine.mergeRetryTimer).toBeTruthy();
    expect(setTimeoutSpy.mock.calls.some(([, interval]) => interval === 15_000)).toBe(true);
    vi.useRealTimers();
  });

  it("does not schedule merge retry timer when engine is shutting down", () => {
    vi.useFakeTimers();
    const store = makeStore();
    const engine = createEngine(store);
    const privateEngine = engine as unknown as {
      scheduleMergeRetry: (taskStore: MockTaskStore) => void;
      shuttingDown: boolean;
      mergeRetryTimer: ReturnType<typeof setTimeout> | null;
    };

    privateEngine.shuttingDown = true;
    privateEngine.scheduleMergeRetry(store);

    expect(privateEngine.mergeRetryTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("catches and logs unexpected drainMergeQueue failures from enqueue path", async () => {
    const engine = createEngine(makeStore());
    testState.currentStore = null;

    const privateEngine = engine as unknown as {
      internalEnqueueMerge: (taskId: string) => void;
      mergeRunning: boolean;
      started: boolean;
    };

    /*
    FNXC:EngineTests 2026-07-18-04:40:
    internalEnqueueMerge no-ops when started=false (post-start gate). Mark the
    engine started so the null-store drain path runs and the unexpected-failure
    catch can log.
    */
    privateEngine.started = true;
    privateEngine.internalEnqueueMerge(TASK_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Merge queue drain failed unexpectedly"),
    );
    expect(privateEngine.mergeRunning).toBe(false);
  });

  it("bounces task to in-progress when conflict retries are exhausted (under bounce cap)", async () => {
    const store = makeStore({
      tasks: [makeTask({ mergeRetries: 2 }), makeTask({ mergeRetries: 3, branch: "fusion/fn-2084" })],
    });
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: null,
      mergeRetries: 0,
      error: null,
      mergeConflictBounceCount: 1,
    });
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Bouncing back to in-progress"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("bounced to in-progress"),
      "MergeConflictBounce",
    );
    expect(hasErrorLog(errorSpy, "failed to bounce")).toBe(false);
  });

  it("logs when bouncing fails after conflict retries are exhausted", async () => {
    const store = makeStore({
      tasks: [makeTask({ mergeRetries: 2 }), makeTask({ mergeRetries: 3 })],
      updateTask: vi.fn(async () => {
        throw new Error("db write failed");
      }),
    });
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("Conflict while merging"));

    const engine = createEngine(store);
    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(hasErrorLog(errorSpy, `failed to bounce ${TASK_ID}`)).toBe(true);
    expect(hasErrorLog(errorSpy, "db write failed")).toBe(true);
  });








  it("re-enqueues direct merge on transient non-conflict errors", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStore();
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("This operation was aborted"));

    const engine = createEngine(store);
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeTransientRetryCount: 1,
      status: null,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ status: "failed" }),
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(enqueueSpy).toHaveBeenCalledWith(TASK_ID);
    vi.useRealTimers();
  });

  it("parks direct merge when transient retry cap is exhausted", async () => {
    // FNXC:MergeReliability 2026-07-15-19:25 (FN-8004): seed AT the cap, read from the constant.
    // This previously hardcoded 3; raising the budget to 5 silently turned this into a
    // "retries once more" case. Deriving the seed keeps the invariant (park once the budget is
    // spent) under test regardless of how the budget is tuned.
    const atCap = ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES;
    const store = makeStore({
      tasks: [makeTask({ mergeTransientRetryCount: atCap }), makeTask({ mergeTransientRetryCount: atCap })],
    });
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("socket hang up"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: "socket hang up",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("transient retries exhausted"),
      "MergeTransientRetryExhausted",
    );
  });

  it("stores terminal merge metadata for non-conflict direct merge errors", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = makeStore();
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("remote branch missing"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: "remote branch missing",
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ mergeTransientRetryCount: expect.any(Number) }),
    );
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(hasErrorLog(errorSpy, "after non-conflict error")).toBe(false);
    vi.useRealTimers();
  });

  it("parks merge-confirmed tasks in stable failed state when finalization is blocked by incomplete steps", async () => {
    const store = makeStore({
      tasks: [
        makeTask({
          mergeDetails: { mergeConfirmed: true },
          steps: [{ status: "in-progress" }],
        }),
      ],
    });

    const engine = createEngine(store, {
      getTaskMergeBlocker: (task) =>
        task.steps?.some((step) => step.status === "in-progress")
          ? "task has incomplete steps"
          : undefined,
    });
    await runMergeCycle(engine);

    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "done");
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      error: "Merge confirmed but finalization blocked: task has incomplete steps",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("finalization blocked"),
    );
  });

  it("auto-finalizes paused+failed merge-confirmed tasks by clearing soft blockers", async () => {
    const store = makeStore({
      tasks: [
        makeTask({
          mergeDetails: { mergeConfirmed: true },
          paused: true,
          status: "failed",
          error: "stale merge failure",
        }),
      ],
    });

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ paused: false, status: null, error: null }),
    );
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "done", expect.objectContaining({ moveSource: "engine" }));
  });

  it("auto-finalizes merge-confirmed tasks with stale transient merging status", async () => {
    const store = makeStore({
      tasks: [
        makeTask({
          mergeDetails: { mergeConfirmed: true },
          status: "merging",
          error: "stale transient merge state",
        }),
      ],
    });

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ paused: false, status: null, error: null }),
    );
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "done", expect.objectContaining({ moveSource: "engine" }));
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("finalization blocked"),
      }),
    );
  });

  it("reconciles merge-confirmed tasks when finalize refresh finds todo ownership", async () => {
    const store = makeStore({
      tasks: [
        makeTask({
          mergeDetails: { mergeConfirmed: true },
        }),
        makeTask({
          column: "todo",
          status: "queued",
          overlapBlockedBy: "FN-9999",
          mergeDetails: { mergeConfirmed: true },
        }),
      ],
    });

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: expect.stringContaining("Invalid transition"),
    });
    expect(store.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ status: null, error: null, blockedBy: null, overlapBlockedBy: null }),
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      TASK_ID,
      "done",
      expect.objectContaining({ moveSource: "engine", recoveryRehome: true }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Auto-merge finalization repaired column mismatch"),
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:auto-merge-finalize-column-mismatch-reconciled",
      target: TASK_ID,
      metadata: expect.objectContaining({
        previousColumn: "todo",
        targetColumn: "done",
        status: "queued",
        overlapBlockedBy: "FN-9999",
      }),
    }));
  });

  it("logs when non-conflict direct merge error recovery update fails", async () => {
    const store = makeStore({
      updateTask: vi.fn(async () => {
        throw new Error("sqlite locked");
      }),
    });
    vi.mocked(runAiMerge).mockRejectedValueOnce(new Error("remote push rejected"));

    const engine = createEngine(store);
    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(hasErrorLog(errorSpy, `failed to update ${TASK_ID} after non-conflict error`)).toBe(
      true,
    );
    expect(hasErrorLog(errorSpy, "sqlite locked")).toBe(true);
  });

  it("re-enqueues pull-request merge on transient strategy errors", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const processPullRequestMerge = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const store = makeStore();

    const engine = createEngine(store, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge,
    });
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeTransientRetryCount: 1,
      status: null,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ status: "failed" }),
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(enqueueSpy).toHaveBeenCalledWith(TASK_ID);
    vi.useRealTimers();
  });

  it("uses the transient budget for structured GitHub transport outcomes", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const structuredRateLimit = Object.assign(new Error("GitHub rate limiting response"), { code: "rate-limited" });
    const store = makeStore();
    const processPullRequestMerge = vi.fn(async () => { throw structuredRateLimit; });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeTransientRetryCount: 1,
      status: null,
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: expect.any(Number) }));
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    vi.useRealTimers();
  });

  it("logs when non-direct merge strategy recovery update fails", async () => {
    const store = makeStore({
      updateTask: vi.fn(async () => {
        throw new Error("persist failed");
      }),
    });
    const processPullRequestMerge = vi.fn(async () => {
      throw new Error("PR API timeout");
    });

    const engine = createEngine(store, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge,
    });

    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({
      status: null,
      mergeRetries: 1,
      error: null,
    }));
    expect(hasErrorLog(errorSpy, `failed to update ${TASK_ID} after merge strategy error`)).toBe(
      true,
    );
    expect(hasErrorLog(errorSpy, "persist failed")).toBe(true);
  });

  it("accounts pull-request retryable failures one at a time with durable backoff", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const processPullRequestMerge = vi.fn(async () => { throw new Error("unexpected GitHub response"); });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({
      mergeRetries: 1,
      status: null,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: 3, status: "failed" }));
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("does not let its retry log move the durable PR backoff past the scheduled timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T03:11:00.000Z"));
    const task = makeTask({ updatedAt: "2026-08-09T03:10:00.000Z" });
    const store = makeStore({ tasks: [task] });
    store.getTask.mockImplementation(async () => task);
    store.updateTask.mockImplementation(async (_taskId: string, patch: Partial<MockTask>) => {
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    });
    // Task logs also update `updatedAt` in the production store. Model a later
    // timestamp to prove the retry patch, rather than its log, owns the anchor.
    store.logEntry.mockImplementation(async () => {
      task.updatedAt = new Date(Date.now() + 1).toISOString();
    });
    const processPullRequestMerge = vi
      .fn<(...args: unknown[]) => Promise<"merged" | "waiting" | "skipped">>()
      .mockRejectedValueOnce(new Error("unexpected GitHub response"))
      .mockResolvedValueOnce("merged");
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    (engine as unknown as { started: boolean }).started = true;

    await runMergeCycle(engine);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(processPullRequestMerge).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses the persisted retry count for the 10s ladder and truthful final boundary", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const retrying = makeTask({ mergeRetries: 1, updatedAt: new Date(Date.now() - 20_000).toISOString() });
    const retryingStore = makeStore({ tasks: [retrying, retrying] });
    const retryingEngine = createEngine(retryingStore, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge: vi.fn(async () => { throw new Error("unexpected GitHub response"); }),
    });

    await runMergeCycle(retryingEngine);
    expect(retryingStore.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeRetries: 2,
      status: null,
      error: null,
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    await retryingEngine.stop();

    const twentySecondAttempt = makeTask({ mergeRetries: 2, updatedAt: new Date(Date.now() - 30_000).toISOString() });
    const twentySecondStore = makeStore({ tasks: [twentySecondAttempt, twentySecondAttempt], settings: { maxAutoMergeRetries: 4 } });
    const twentySecondEngine = createEngine(twentySecondStore, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge: vi.fn(async () => { throw new Error("unexpected GitHub response"); }),
    });
    await runMergeCycle(twentySecondEngine);
    expect(twentySecondStore.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeRetries: 3,
      status: null,
      error: null,
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20_000);
    await twentySecondEngine.stop();

    const finalAttempt = makeTask({ mergeRetries: 2, updatedAt: new Date(Date.now() - 30_000).toISOString() });
    const finalStore = makeStore({ tasks: [finalAttempt, finalAttempt], settings: { maxAutoMergeRetries: 3 } });
    const finalEngine = createEngine(finalStore, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge: vi.fn(async () => { throw new Error("unexpected GitHub response"); }),
    });

    await runMergeCycle(finalEngine);
    expect(finalStore.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: "unexpected GitHub response",
    });
    expect(finalStore.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("3/3 actual failures"),
      "MergeRetriesExhausted",
    );
    await finalEngine.stop();
    vi.useRealTimers();
  });

  it("reschedules an early PR retry rejected by drain admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T04:05:00.000Z"));
    const task = makeTask({ mergeRetries: 1, updatedAt: new Date().toISOString() });
    const store = makeStore({ tasks: [task] });
    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    (engine as unknown as { started: boolean }).started = true;

    // Model a duplicate/restart enqueue which arrives before the persisted not-before.
    await runMergeCycle(engine);
    expect(processPullRequestMerge).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    await engine.stop();
    vi.useRealTimers();
  });

  it("parks exhausted pull-request transient retries without consuming the normal retry budget", async () => {
    const atCap = ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES;
    const task = makeTask({
      mergeRetries: 1,
      mergeTransientRetryCount: atCap,
      updatedAt: new Date(Date.now() - 6_000).toISOString(),
    });
    const store = makeStore({ tasks: [task, task] });
    const processPullRequestMerge = vi.fn(async () => { throw new Error("socket hang up"); });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      error: "socket hang up",
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: expect.any(Number) }));
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("transient retries exhausted"),
      "MergeTransientRetryExhausted",
    );
  });

  it("parks exhausted structured GitHub transport retries without consuming mergeRetries", async () => {
    const task = makeTask({
      mergeRetries: 1,
      mergeTransientRetryCount: ProjectEngine.MAX_AUTO_MERGE_TRANSIENT_RETRIES,
      updatedAt: new Date(Date.now() - 6_000).toISOString(),
    });
    const store = makeStore({ tasks: [task, task] });
    const structuredTimeout = Object.assign(new Error("GitHub request timed out"), { code: "timeout" });
    const processPullRequestMerge = vi.fn(async () => { throw structuredTimeout; });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      error: "GitHub request timed out",
    });
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: expect.any(Number) }));
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("transient retries exhausted"),
      "MergeTransientRetryExhausted",
    );
  });

  it("keeps PR retry metadata outside workflow custom fields", async () => {
    const customFieldPatch = { __fusionPrMergeRetryNotBefore: "2026-08-09T02:40:00.000Z" };
    expect(validateCustomFieldPatch([], customFieldPatch)).toMatchObject({
      ok: false,
      rejection: { code: "no-fields-defined" },
    });

    const updateTask = vi.fn(async (_taskId: string, patch: Record<string, unknown>) => {
      if (patch.customFields !== undefined) {
        const validation = validateCustomFieldPatch([], patch.customFields as Record<string, unknown>);
        if (!validation.ok) throw new Error(validation.rejection.detail);
      }
    });
    const store = makeStore({ updateTask });
    const processPullRequestMerge = vi.fn(async () => { throw new Error("unexpected GitHub response"); });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeRetries: 1,
      status: null,
      error: null,
    });
  });

  it("parks structured pull-request policy blocks without consuming retries", async () => {
    const store = makeStore();
    const policyError = Object.assign(new Error("Pull request is blocked by branch protection."), { code: "merge-blocked-by-policy" });
    const processPullRequestMerge = vi.fn(async () => { throw policyError; });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({
      status: "awaiting-approval",
      error: policyError.message,
      awaitingApprovalReason: "merge-blocked-by-policy",
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: expect.any(Number) }));
  });

  it("parks non-retryable structured pull-request failures honestly", async () => {
    const priorAttempt = makeTask({ mergeRetries: 2, updatedAt: new Date(Date.now() - 30_000).toISOString() });
    const store = makeStore({ tasks: [priorAttempt, priorAttempt] });
    const permissionError = Object.assign(new Error("GitHub denied access to this resource."), { code: "permission" });
    const processPullRequestMerge = vi.fn(async () => { throw permissionError; });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({
      status: "failed",
      error: permissionError.message,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ mergeRetries: 3 }));
  });

  it("keeps a policy hold parked when the public auto-enqueue surface is invoked", async () => {
    const parked = makeTask({
      status: "awaiting-approval",
      error: "Pull request is blocked by branch protection.",
    });
    const store = makeStore({ tasks: [parked] });
    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    await engine.start();

    expect(engine.enqueueMerge(TASK_ID)).toBe(true);
    await vi.waitFor(() => expect(store.getTask).toHaveBeenCalled());
    expect(processPullRequestMerge).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("resumes a policy hold through manual onMerge without changing retry counters", async () => {
    const parked = makeTask({
      status: "awaiting-approval",
      error: "Pull request is blocked by branch protection.",
      mergeRetries: 2,
      mergeTransientRetryCount: 1,
    });
    const store = makeStore({ tasks: [parked, parked, parked] });
    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    await engine.start();
    await engine.onMerge(TASK_ID);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: null,
      error: null,
      awaitingApprovalReason: null,
    });
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    // The resume itself preserves both budgets; successful completion then closes
    // that retry episode and clears the durable retry/backoff state.
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      mergeRetries: 0,
      mergeTransientRetryCount: 0,
    });
    await engine.stop();
  });

  it("resumes a policy hold through the interpreter merge requester", async () => {
    const parked = makeTask({
      status: "awaiting-approval",
      error: "Pull request is blocked by branch protection.",
      mergeRetries: 2,
      mergeTransientRetryCount: 1,
    });
    const store = makeStore({ tasks: [parked, parked, parked] });
    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    await engine.start();

    await engine.requestInterpreterMerge(TASK_ID);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: null,
      error: null,
      awaitingApprovalReason: null,
    });
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("cancels a pending PR retry wake when an operator merges during backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T04:18:00.000Z"));
    const task = makeTask();
    const store = makeStore({ tasks: [task] });
    store.getTask.mockImplementation(async () => task);
    store.updateTask.mockImplementation(async (_taskId: string, patch: Partial<MockTask>) => {
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    });
    const processPullRequestMerge = vi
      .fn<(...args: unknown[]) => Promise<"merged" | "waiting" | "skipped">>()
      .mockRejectedValueOnce(new Error("unexpected GitHub response"))
      .mockResolvedValueOnce("merged");
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    (engine as unknown as { started: boolean }).started = true;

    await runMergeCycle(engine);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    await engine.onMerge(TASK_ID);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(2);
    await engine.stop();
    vi.useRealTimers();
  });

  it("blocks the real periodic sweep until the durable PR retry backoff elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T02:39:00.000Z"));
    const task = makeTask({ updatedAt: new Date().toISOString() });
    const store = makeStore({ tasks: [task] });
    store.getTask.mockImplementation(async () => task);
    store.updateTask.mockImplementation(async (_taskId: string, patch: Partial<MockTask>) => {
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    });
    const processPullRequestMerge = vi
      .fn<(...args: unknown[]) => Promise<"merged" | "waiting" | "skipped">>()
      .mockRejectedValueOnce(new Error("unexpected GitHub response"))
      .mockResolvedValueOnce("merged");
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    (engine as unknown as { started: boolean }).started = true;
    const privateEngine = engine as unknown as {
      enqueueEligibleInReviewTasks: (tasks: Task[], settings: Pick<Settings, "autoMerge" | "maxAutoMergeRetries">) => Promise<number>;
    };

    await runMergeCycle(engine);
    expect(task.mergeRetries).toBe(1);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);

    // FNXC:AutoMergeRetries 2026-08-09-03:23: This production periodic-sweep
    // dispatcher, rather than a predicate unit test, must honor the retry anchor.
    await expect(privateEngine.enqueueEligibleInReviewTasks([task as Task], {
      autoMerge: true,
      maxAutoMergeRetries: 3,
    })).resolves.toBe(0);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("keeps a re-blocked policy hold out of sweeps and preserves both retry counters", async () => {
    const task = makeTask({
      status: "awaiting-approval",
      error: "Pull request is blocked by branch protection.",
      mergeRetries: 2,
      mergeTransientRetryCount: 1,
    });
    const store = makeStore({ tasks: [task] });
    store.getTask.mockImplementation(async () => task);
    store.updateTask.mockImplementation(async (_taskId: string, patch: Partial<MockTask>) => {
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    });
    const policyError = Object.assign(new Error("Pull request is blocked by branch protection."), {
      code: "merge-blocked-by-policy",
    });
    const processPullRequestMerge = vi.fn(async () => { throw policyError; });
    const engine = createEngine(store, { getMergeStrategy: () => "pull-request", processPullRequestMerge });
    await engine.start();
    const privateEngine = engine as unknown as {
      enqueueEligibleInReviewTasks: (tasks: Task[], settings: Pick<Settings, "autoMerge" | "maxAutoMergeRetries">) => Promise<number>;
    };

    await expect(privateEngine.enqueueEligibleInReviewTasks([task as Task], {
      autoMerge: true,
      maxAutoMergeRetries: 3,
    })).resolves.toBe(0);
    expect(processPullRequestMerge).not.toHaveBeenCalled();

    await engine.onMerge(TASK_ID);
    expect(processPullRequestMerge).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("awaiting-approval");
    expect(task.mergeRetries).toBe(2);
    expect(task.mergeTransientRetryCount).toBe(1);
    expect(task.error).toBe(policyError.message);
    await engine.stop();
  });

  it("treats absent or malformed pull-request retry anchors as elapsed", () => {
    const store = makeStore();
    const engine = createEngine(store);
    const privateEngine = engine as unknown as { canMergeTask: (task: MockTask, cap: number, review?: boolean, enforcePrBackoff?: boolean) => boolean };
    expect(privateEngine.canMergeTask(makeTask(), 3, undefined, true)).toBe(true);
    expect(privateEngine.canMergeTask(makeTask({ mergeRetries: 1, updatedAt: "not-a-date" }), 3, undefined, true)).toBe(true);
    expect(privateEngine.canMergeTask(makeTask({ status: "awaiting-approval" }), 3, undefined, true)).toBe(false);
  });

  it("treats post-finalize verification failures as a no-op diagnostic", async () => {
    const verificationError = new Error("Deterministic test verification failed: assertion mismatch in workspace");
    verificationError.name = "VerificationError";
    vi.mocked(runAiMerge).mockRejectedValueOnce(verificationError);

    const store = makeStore({
      tasks: [
        makeTask({
          column: "in-review",
          status: "merging",
          verificationFailureCount: 2,
        }),
        makeTask({
          column: "done",
          status: null,
          verificationFailureCount: 2,
          mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
        }),
      ],
    });
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ status: "merging-fix" }),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ verificationFailureCount: 3 }),
    );
    expect(store.addTaskComment).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Please fix the failing"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("[verification] post-finalize verification failed for already-on-main fast-path; no action"),
      "VerificationError",
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:post-finalize-verification-no-op",
      target: TASK_ID,
      metadata: expect.objectContaining({
        taskId: TASK_ID,
        commitSha: "abcdef1234567890",
        failedCommand: null,
        exitCode: null,
      }),
    }));
  });

  it("moves task back to in-progress with merge-remediation status on verification errors", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(runAiMerge).mockRejectedValueOnce(verificationError);

    const store = makeStore();
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Deterministic test verification failed during merge"),
      "agent",
    );
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "merging-fix",
      mergeRetries: 0,
      error: null,
      verificationFailureCount: 1,
    });
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      "Deterministic test verification failed (1/3) — moved back to in-progress with status=merging-fix for remediation",
    );
    expect(logSpy).toHaveBeenCalledWith(
      `Auto-merge: ${TASK_ID} deterministic test verification failed (1/3) — moved to in-progress with status=merging-fix`,
    );
  });

  it("leaves task in-review without bounce when VerificationError is an unrecovered missing-workspace-entry environment fault", async () => {
    const verificationError = new VerificationError("Deterministic test verification failed", {
      allPassed: false,
      failedCommand: "testCommand",
      environmentFault: {
        kind: "missing-workspace-entry",
        packageName: "@fusion/dashboard",
        recovered: false,
      },
    });
    vi.mocked(runAiMerge).mockRejectedValueOnce(verificationError);

    const store = makeStore({
      tasks: [makeTask({ verificationFailureCount: 2, status: "in-review" })],
    });
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ verificationFailureCount: 3 }),
    );
  });

  it("increments verificationFailureCount across consecutive verification bounces", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(runAiMerge).mockRejectedValueOnce(verificationError);

    const store = makeStore({
      tasks: [makeTask({ verificationFailureCount: 1, status: "merging-fix" })],
    });
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "merging-fix",
      mergeRetries: 0,
      error: null,
      verificationFailureCount: 2,
    });
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "in-progress");
  });



  it("logs when verification-error recovery fails", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(runAiMerge).mockRejectedValueOnce(verificationError);

    const store = makeStore({
      updateTask: vi.fn(async () => {
        throw new Error("write unavailable");
      }),
    });
    const engine = createEngine(store);

    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(store.addTaskComment).toHaveBeenCalledTimes(1);
    expect(hasErrorLog(errorSpy, `failed to return ${TASK_ID} to in-progress after verification failure`)).toBe(
      true,
    );
  });

  /*
  FNXC:MergeQueue 2026-07-15-09:41 / 10:05:
  Repro for board-wide hung merge pump: active AI merge ignores AbortSignal (wedged tool), operator pauses the card, and without an outer race drainMergeQueue never settles so no later task gets status=merging.
  Generation latch: FN-next must not start until the orphan wedged body settles.
  */
  it("unblocks the merge pump when a paused active merge ignores abort, and waits for orphan body settle", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let wedgedPaused = false;
    // Empty listedTasks so startup merge sweep does not race the test.
    const store = makeStore({ listedTasks: [], tasks: [] });
    store.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    });
    store.getTask = vi.fn(async (id: string) =>
      makeTask({
        id,
        paused: id === "FN-wedged" ? wedgedPaused : false,
        status: null,
        mergeRetries: 0,
      }),
    );
    store.listTasks = vi.fn(async () => []);

    let wedgedStarted = false;
    let releaseWedged: (() => void) | undefined;
    const disposeSession = vi.fn();
    const startedOrder: string[] = [];
    vi.mocked(runAiMerge).mockReset();
    vi.mocked(runAiMerge).mockImplementation(async (...args: unknown[]) => {
      const taskId = args[2] as string;
      const options = args[3] as { signal?: AbortSignal; onSession?: (session: { dispose: () => void }) => void };
      options.onSession?.({ dispose: disposeSession });
      startedOrder.push(taskId);
      if (taskId === "FN-wedged") {
        wedgedStarted = true;
        // Hang until test releases — ignores abort signal (wedged agent tool).
        await new Promise<void>((resolve) => {
          releaseWedged = resolve;
        });
      }
      return {
        merged: true,
        task: makeTask({ id: taskId }),
        branch: `fusion/${taskId.toLowerCase()}`,
      } as never;
    });

    const engine = createEngine(store);
    const privateEngine = engine as unknown as {
      mergeRunning: boolean;
      activeMergeTaskId: string | null;
      mergeActive: Set<string>;
      mergeBodyInFlight: Promise<unknown> | null;
      mergeBodySettleTimeoutMs: number;
      enqueueMerge: (taskId: string) => void;
    };

    await engine.start();
    privateEngine.enqueueMerge("FN-wedged");

    await vi.waitFor(() => {
      expect(wedgedStarted).toBe(true);
      expect(privateEngine.activeMergeTaskId).toBe("FN-wedged");
    });

    const updatedHandlers = [...(listeners.get("task:updated") ?? [])];
    expect(updatedHandlers.length).toBeGreaterThan(0);
    wedgedPaused = true;
    for (const handler of updatedHandlers) {
      await handler({ id: "FN-wedged", column: "in-review", paused: true });
    }

    await vi.waitFor(() => {
      expect(disposeSession).toHaveBeenCalled();
      expect(privateEngine.activeMergeTaskId).toBeNull();
      expect(privateEngine.mergeActive.has("FN-wedged")).toBe(false);
      expect(privateEngine.mergeRunning).toBe(false);
    });

    // Orphan body still in flight — next generation must wait.
    expect(privateEngine.mergeBodyInFlight).not.toBeNull();
    privateEngine.enqueueMerge("FN-next");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(startedOrder).toEqual(["FN-wedged"]);

    // Settle orphan body → next merge may start.
    releaseWedged?.();
    await vi.waitFor(() => {
      expect(runAiMerge).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        "FN-next",
        expect.anything(),
      );
    });
    expect(startedOrder).toEqual(["FN-wedged", "FN-next"]);

    await engine.stop();
  });

  it("PR merge path races abort so pause unblocks the pump", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let prStarted = false;
    let releasePr: (() => void) | undefined;
    const store = makeStore({ listedTasks: [], tasks: [] });
    store.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    });
    store.getTask = vi.fn(async (id: string) =>
      makeTask({ id, paused: false, status: null, mergeRetries: 0 }),
    );
    store.listTasks = vi.fn(async () => []);

    const processPullRequestMerge = vi.fn(async () => {
      prStarted = true;
      await new Promise<void>((resolve) => {
        releasePr = resolve;
      });
      return "merged" as const;
    });

    const engine = createEngine(store, {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge,
    });
    const privateEngine = engine as unknown as {
      activeMergeTaskId: string | null;
      mergeRunning: boolean;
      enqueueMerge: (taskId: string) => void;
    };

    await engine.start();
    privateEngine.enqueueMerge("FN-pr");

    await vi.waitFor(() => {
      expect(prStarted).toBe(true);
      expect(privateEngine.activeMergeTaskId).toBe("FN-pr");
    });

    const updatedHandlers = [...(listeners.get("task:updated") ?? [])];
    for (const handler of updatedHandlers) {
      await handler({ id: "FN-pr", column: "in-review", paused: true });
    }

    await vi.waitFor(() => {
      expect(privateEngine.activeMergeTaskId).toBeNull();
      expect(privateEngine.mergeRunning).toBe(false);
    });

    releasePr?.();
    await engine.stop();
  });
  /*
  FNXC:AutostashRecovery 2026-07-29-11:20 (U9):
  Replaces the deleted "creates one recovery follow-up for live autostash orphans"
  test. The follow-up-CARD engine is gone (project-engine.ts:4801); a `live`
  autostash orphan is now surfaced by a durable log entry PLUS an operator comment
  on the parent, because the parent may already be `done` and merged — if nothing
  is said the stash becomes invisible and real uncommitted work is silently lost.

  The production comment is explicit that `record.label` "must never be dropped
  from the message or truncated" — it is the handle `git stash` recovery needs.
  That is the invariant under test here, and it had NO working assertion: the file
  was red, so every claim it made was inert.

  Only `live` orphans notify: a subsumed/dead stash holds no unique work, and
  commenting on those would train operators to ignore the notice.
  */
  it("surfaces a live autostash orphan as a log entry and parent comment that keep the stash label", async () => {
    const store = makeStore();
    const engine = createEngine(store);
    await engine.start();

    const handler = store.on.mock.calls.find(
      (call: unknown[]) => call[0] === "merger:autostashOrphans",
    )?.[1] as ((payload: { rootDir: string; records: unknown[] }) => Promise<void>) | undefined;
    if (!handler) throw new Error("merger:autostashOrphans handler was not registered");

    try {
    await handler({
      rootDir: "/tmp/proj_test",
      records: [
        {
          classification: "live",
          sha: "abcdef1234567890",
          label: "fusion-autostash/FN-2084/pre-merge",
          sourceTaskId: "FN-2084",
          detectedByTaskId: "FN-9001",
          sourcePhase: "pre-merge",
        },
        // A non-live orphan must stay silent.
        {
          classification: "subsumed",
          sha: "999999999999",
          label: "fusion-autostash/FN-2084/subsumed",
          sourceTaskId: "FN-2084",
        },
      ],
    });

    // Exactly one notification pair — the subsumed record is not surfaced.
    expect(store.addTaskComment).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);

    const [commentTaskId, commentBody] = store.addTaskComment.mock.calls[0] as [string, string];
    expect(commentTaskId).toBe("FN-2084");
    // The stash label is the recovery handle: it must survive verbatim, untruncated.
    expect(commentBody).toContain("fusion-autostash/FN-2084/pre-merge");
    expect(commentBody).toContain("abcdef1");
    expect(commentBody).toContain("FN-9001");
    expect(commentBody).toContain("pre-merge");

    const [logTaskId, logMessage, logDetail] = store.logEntry.mock.calls[0] as [string, string, string];
    expect(logTaskId).toBe("FN-2084");
    expect(logMessage).toContain("fusion-autostash/FN-2084/pre-merge");
    expect(logDetail).toContain("fusion-autostash/FN-2084/pre-merge");
    } finally {
      // Always stop: a thrown assertion that leaves the engine running kills the
      // vitest worker, and a crashed run reports NO failures at all — which reads
      // as "this guard is untested" instead of "this guard just failed".
      await engine.stop();
    }
  });

});
