import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Settings } from "@fusion/core";

const testState = vi.hoisted(() => ({
  currentStore: null as MockTaskStore | null,
  aiMergeTask: vi.fn(),
}));

vi.mock("../merger.js", () => ({
  aiMergeTask: testState.aiMergeTask,
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getTaskStore: () => testState.currentStore,
    getAgentStore: vi.fn(),
    getMessageStore: vi.fn(),
    getRoutineStore: vi.fn(),
    getRoutineRunner: vi.fn(),
    getHeartbeatMonitor: vi.fn(),
    getTriggerScheduler: vi.fn(),
  })),
}));

import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";
import { aiMergeTask } from "../merger.js";

type MockTask = {
  id: string;
  title?: string;
  column: "triage" | "todo" | "in-progress" | "in-review" | "done" | "archived";
  mergeRetries: number;
  status: string | null;
  error: string | null;
  verificationFailureCount?: number;
  mergeConflictBounceCount?: number;
  branch?: string;
  worktree?: string;
  sourceType?: string;
  sourceParentTaskId?: string;
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
  };
}

function createEngine(
  store: MockTaskStore,
  options: {
    getMergeStrategy?: (settings: Settings) => "direct" | "pull-request";
    processPullRequestMerge?: (...args: unknown[]) => Promise<"merged" | "waiting" | "skipped">;
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
    vi.mocked(aiMergeTask).mockReset();
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
    };

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
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

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
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("Conflict while merging"));

    const engine = createEngine(store);
    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(hasErrorLog(errorSpy, `failed to bounce ${TASK_ID}`)).toBe(true);
    expect(hasErrorLog(errorSpy, "db write failed")).toBe(true);
  });

  it("parks task and creates follow-up when conflict bounce cap is exceeded", async () => {
    // Already bounced twice (cap is 2) — next bounce would be 3, exceeding cap
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({
        status: "failed",
        mergeRetries: 3,
      }),
    );
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ column: "triage", priority: "high" }),
    );
  });

  it("skips duplicate conflict follow-up creation when active recovery task exists for same parent", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-7778", column: "triage", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("follow-up already exists (FN-7778"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("skipped duplicate follow-up (existing FN-7778"),
      "MergeConflictGiveUp",
    );
  });

  it("skips conflict follow-up creation when another active recovery owns the same branch", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-8888", column: "todo", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: "FN-1111",
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("already owns branch `fusion/fn-2084`"),
      "agent",
    );
  });

  it("creates a new conflict follow-up when previous recovery tasks are done or archived", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-9001", column: "done", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
        {
          ...makeTask({ id: "FN-9002", column: "archived", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: "FN-1111",
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
      }),
    );
  });

  it("skips duplicate conflict follow-up creation when active recovery exists for parent", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-7777", column: "triage", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Skipping duplicate follow-up creation"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("skipped duplicate follow-up (existing FN-7777"),
      "MergeConflictGiveUp",
    );
  });

  it("skips conflict follow-up creation when active recovery already owns same branch", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-8888", column: "todo", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: "FN-OTHER",
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("active recovery already owns branch"),
      "MergeConflictGiveUp",
    );
  });

  it("creates new conflict follow-up when prior recovery is archived", async () => {
    const store = makeStore({
      tasks: [
        makeTask({ mergeRetries: 2, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
      ],
      listedTasks: [
        makeTask({ mergeRetries: 3, mergeConflictBounceCount: 2, branch: "fusion/fn-2084" }),
        {
          ...makeTask({ id: "FN-6666", column: "archived", branch: "fusion/fn-2084" }),
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
      ],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ column: "triage", priority: "high" }),
    );
  });

  it("stores terminal merge metadata for non-conflict direct merge errors", async () => {
    const store = makeStore();
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("remote branch missing"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: "remote branch missing",
    });
    expect(hasErrorLog(errorSpy, "after non-conflict error")).toBe(false);
  });

  it("logs when non-conflict direct merge error recovery update fails", async () => {
    const store = makeStore({
      updateTask: vi.fn(async () => {
        throw new Error("sqlite locked");
      }),
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("remote push rejected"));

    const engine = createEngine(store);
    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(hasErrorLog(errorSpy, `failed to update ${TASK_ID} after non-conflict error`)).toBe(
      true,
    );
    expect(hasErrorLog(errorSpy, "sqlite locked")).toBe(true);
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
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: "failed",
      mergeRetries: 3,
      error: "PR API timeout",
    });
    expect(hasErrorLog(errorSpy, `failed to update ${TASK_ID} after merge strategy error`)).toBe(
      true,
    );
    expect(hasErrorLog(errorSpy, "persist failed")).toBe(true);
  });

  it("moves task back to in-progress with merge-remediation status on verification errors", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

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

  it("increments verificationFailureCount across consecutive verification bounces", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

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

  it("caps verification-failure bounces and creates a follow-up task", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

    // Task already bounced 2 times — this attempt would push it to 3 (the cap)
    const store = makeStore({
      tasks: [
        makeTask({ verificationFailureCount: 2, title: "do the thing" }),
      ],
    });
    const engine = createEngine(store);

    await runMergeCycle(engine);

    // Original task is failed (not bounced back)
    expect(store.moveTask).not.toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({
      status: "failed",
      verificationFailureCount: 3,
    }));

    // Follow-up triage task created with context
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      column: "triage",
      priority: "high",
      description: expect.stringContaining(TASK_ID),
    }));

    // Comment links the follow-up
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("FN-9999"),
      "agent",
    );
  });

  it("skips duplicate verification follow-up creation when active recovery task exists", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

    const store = makeStore({
      tasks: [makeTask({ verificationFailureCount: 2, title: "do the thing" })],
      listedTasks: [
        makeTask({ verificationFailureCount: 2, title: "do the thing" }),
        {
          ...makeTask({ id: "FN-7777", column: "triage" }),
          sourceType: "recovery",
          sourceParentTaskId: TASK_ID,
        },
      ],
    });
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Reusing existing follow-up FN-7777"),
      "agent",
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("skipped creating duplicate follow-up (existing FN-7777)"),
      "VerificationError",
    );
  });

  it("logs when verification-error recovery fails", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

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
});
