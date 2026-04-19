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
  column: "in-review";
  mergeRetries: number;
  status: string | null;
  error: string | null;
  updatedAt: string;
  log: Array<{ action?: string }>;
};

type MockTaskStore = {
  getSettings: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  addTaskComment: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  getActiveMergingTask: ReturnType<typeof vi.fn>;
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
  settings,
  updateTask,
}: {
  tasks?: Array<MockTask | null>;
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
  let logSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiMergeTask).mockReset();
    testState.currentStore = null;

    errorSpy = vi.spyOn(runtimeLog, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(runtimeLog, "log").mockImplementation(() => undefined);
  });

  it("clears status when conflict retries are exhausted and recovery update succeeds", async () => {
    const store = makeStore({
      tasks: [makeTask({ mergeRetries: 2 }), makeTask({ mergeRetries: 3 })],
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("merge conflict detected"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, { status: null });
    expect(hasErrorLog(errorSpy, "failed to clear status on")).toBe(false);
  });

  it("logs when clearing status fails after conflict retries are exhausted", async () => {
    const store = makeStore({
      tasks: [makeTask({ mergeRetries: 2 }), makeTask({ mergeRetries: 3 })],
      updateTask: vi.fn(async () => {
        throw new Error("db write failed");
      }),
    });
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("Conflict while merging"));

    const engine = createEngine(store);
    await expect(runMergeCycle(engine)).resolves.toBeUndefined();

    expect(hasErrorLog(errorSpy, `failed to clear status on ${TASK_ID}`)).toBe(true);
    expect(hasErrorLog(errorSpy, "db write failed")).toBe(true);
  });

  it("stores terminal merge metadata for non-conflict direct merge errors", async () => {
    const store = makeStore();
    vi.mocked(aiMergeTask).mockRejectedValueOnce(new Error("remote branch missing"));

    const engine = createEngine(store);
    await runMergeCycle(engine);

    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: null,
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
      status: null,
      mergeRetries: 3,
      error: "PR API timeout",
    });
    expect(hasErrorLog(errorSpy, `failed to update ${TASK_ID} after merge strategy error`)).toBe(
      true,
    );
    expect(hasErrorLog(errorSpy, "persist failed")).toBe(true);
  });

  it("moves task back to in-progress on verification errors", async () => {
    const verificationError = new Error("Deterministic test verification failed");
    verificationError.name = "VerificationError";
    vi.mocked(aiMergeTask).mockRejectedValueOnce(verificationError);

    const store = makeStore();
    const engine = createEngine(store);

    await runMergeCycle(engine);

    expect(store.addTaskComment).toHaveBeenCalledWith(
      TASK_ID,
      expect.stringContaining("Deterministic test verification failed during merge."),
      "agent",
    );
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, {
      status: null,
      mergeRetries: 0,
      error: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith(TASK_ID, "in-progress");
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      "Deterministic test verification failed — moved back to in-progress for remediation",
    );
    expect(logSpy).toHaveBeenCalledWith(
      `Auto-merge: ${TASK_ID} deterministic test verification failed — moved to in-progress`,
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
