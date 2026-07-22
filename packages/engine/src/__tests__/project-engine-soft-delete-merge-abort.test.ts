import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  runtimeResumeAfterUnpause: vi.fn(async () => undefined),
  runtimeConfigurePrMonitoring: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
  aiMergeTask: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});

vi.mock("../merger.js", () => ({ aiMergeTask: mocks.aiMergeTask, sweepStaleAutostashes: vi.fn(async () => undefined) }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mocks.execFile };
});
vi.mock("../merge/pr-monitor.js", () => ({ PrMonitor: vi.fn().mockImplementation(function () { return { onNewComments: vi.fn() }; }) }));
vi.mock("../merge/pr-comment-handler.js", () => ({ PrCommentHandler: vi.fn().mockImplementation(function () { return { handleNewComments: vi.fn() }; }) }));
vi.mock("../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({ reload: vi.fn(), getOAuthProviders: vi.fn(() => []), get: vi.fn(() => undefined) })),
  getFusionOAuthAlertStatePath: vi.fn(() => "/tmp/oauth-alert-state.json"),
}));
vi.mock("../util/notifier.js", () => ({ NtfyNotifier: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }) }));
vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () { return {}; }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../scheduling/cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
}));
vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      resumeAfterUnpause: mocks.runtimeResumeAfterUnpause,
      getTaskStore: () => mocks.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: mocks.runtimeConfigurePrMonitoring,
      setActiveMergeTaskIdProvider: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
    };
  }),
}));

type Listener = (...args: any[]) => void | Promise<void>;

function createMockStore() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    store: {
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async () => []),
      getTask: vi.fn(async (taskId: string) => ({ id: taskId, column: "in-review", paused: false, mergeRetries: 0, status: null })),
      updateTask: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      addTaskComment: vi.fn(async () => undefined),
      emit: vi.fn(),
      getActiveMergingTask: vi.fn(() => null),
      on: vi.fn((event: string, listener: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
      }),
      off: vi.fn((event: string, listener: Listener) => {
        listeners.get(event)?.delete(listener);
      }),
    },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

function createEngine() {
  return new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    { skipNotifier: true },
  );
}

describe("ProjectEngine soft-delete merge interruption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts and disposes the active merge when the task is soft-deleted", async () => {
    const mockStore = createMockStore();
    mocks.currentStore = mockStore.store;
    const logSpy = vi.spyOn(runtimeLog, "log").mockImplementation(() => {});
    const engine = createEngine();
    const privateEngine = engine as any;
    const abort = vi.fn();
    const dispose = vi.fn();

    await engine.start();
    privateEngine.activeMergeTaskId = "FN-TEST-1";
    privateEngine.activeMergeSession = { dispose };
    privateEngine.mergeAbortController = { abort };
    privateEngine.mergeActive.add("FN-TEST-1");

    mockStore.emit("task:deleted", { id: "FN-TEST-1" });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(privateEngine.activeMergeTaskId).toBeNull();
    expect(privateEngine.activeMergeSession).toBeNull();
    expect(privateEngine.mergeAbortController).toBeNull();
    expect(privateEngine.mergeActive.has("FN-TEST-1")).toBe(false);
    /*
    FNXC:EngineTests 2026-07-15-11:50:
    Soft-delete merge interrupt logs through abortActiveMerge with a shared reason tag
    (`task-soft-deleted`), not a separate "Soft-deleted task interrupting..." line.
    */
    expect(logSpy).toHaveBeenCalledWith("Aborting active merge for FN-TEST-1 (task-soft-deleted)");

    await engine.stop();
  });

  it("removes queued soft-deleted tasks without touching another active merge", async () => {
    const mockStore = createMockStore();
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as any;

    await engine.start();
    privateEngine.mergeQueue = ["FN-TEST-2", "FN-OTHER"];
    privateEngine.mergeActive.add("FN-TEST-2");
    privateEngine.activeMergeTaskId = "FN-ACTIVE";

    mockStore.emit("task:deleted", { id: "FN-TEST-2" });

    expect(privateEngine.mergeQueue).toEqual(["FN-OTHER"]);
    expect(privateEngine.mergeActive.has("FN-TEST-2")).toBe(false);
    expect(privateEngine.activeMergeTaskId).toBe("FN-ACTIVE");

    await engine.stop();
  });

  it("removes soft-deleted tasks from pausedReviewTaskIds", async () => {
    const mockStore = createMockStore();
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as any;

    await engine.start();
    privateEngine.pausedReviewTaskIds.add("FN-TEST-3");

    mockStore.emit("task:deleted", { id: "FN-TEST-3" });

    expect(privateEngine.pausedReviewTaskIds.has("FN-TEST-3")).toBe(false);

    await engine.stop();
  });

  it("detaches the task:deleted handler on stop", async () => {
    const mockStore = createMockStore();
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as any;

    await engine.start();
    await engine.stop();
    privateEngine.mergeQueue = ["FN-TEST-4"];

    mockStore.emit("task:deleted", { id: "FN-TEST-4" });

    expect(privateEngine.mergeQueue).toEqual(["FN-TEST-4"]);
  });
});
