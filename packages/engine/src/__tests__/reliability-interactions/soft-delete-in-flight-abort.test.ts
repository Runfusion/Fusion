import "../executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoClaimSnapshotManager } from "../../scheduling/auto-claim-snapshot.js";
import { TaskExecutor } from "../../executor.js";
import { ProjectEngine } from "../../project-engine.js";
import { Scheduler } from "../../scheduler.js";
import { resetExecutorMocks } from "../executor-test-helpers.js";

const projectEngineMocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  runtimeResumeAfterUnpause: vi.fn(async () => undefined),
  runtimeConfigurePrMonitoring: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
  aiMergeTask: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});
vi.mock("../../merger.js", () => ({ aiMergeTask: projectEngineMocks.aiMergeTask, sweepStaleAutostashes: vi.fn(async () => undefined) }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: projectEngineMocks.execFile };
});
vi.mock("../../merge/pr-monitor.js", () => ({ PrMonitor: vi.fn().mockImplementation(function () { return { onNewComments: vi.fn() }; }) }));
vi.mock("../../merge/pr-comment-handler.js", () => ({ PrCommentHandler: vi.fn().mockImplementation(function () { return { handleNewComments: vi.fn() }; }) }));
vi.mock("../../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({ reload: vi.fn(), getOAuthProviders: vi.fn(() => []), get: vi.fn(() => undefined) })),
  getFusionOAuthAlertStatePath: vi.fn(() => "/tmp/oauth-alert-state.json"),
}));
vi.mock("../../util/notifier.js", () => ({ NtfyNotifier: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }) }));
vi.mock("../../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () { return {}; }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../../scheduling/cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
}));
vi.mock("../../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: projectEngineMocks.runtimeStart,
      stop: projectEngineMocks.runtimeStop,
      resumeAfterUnpause: projectEngineMocks.runtimeResumeAfterUnpause,
      getTaskStore: () => projectEngineMocks.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: projectEngineMocks.runtimeConfigurePrMonitoring,
      setActiveMergeTaskIdProvider: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
    };
  }),
}));

type Listener = (...args: any[]) => void | Promise<void>;

type TestTask = {
  id: string;
  title: string;
  description: string;
  status: string;
  column: string;
  createdAt: string;
  updatedAt: string;
  dependencies: string[];
  comments: unknown[];
  steps: unknown[];
  currentStep: number;
  log: unknown[];
  deletedAt?: string | null;
  paused?: boolean;
};

function createEventedStore(initialTasks: TestTask[] = []) {
  const listeners = new Map<string, Set<Listener>>();
  let sequence = 1;
  const tasks = initialTasks.map((task) => ({ ...task }));
  const nextTimestamp = () => new Date(1_716_000_000_000 + sequence++).toISOString();

  const store = {
    on: vi.fn((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true, maxConcurrent: 2, maxWorktrees: 2 }),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    listTasks: vi.fn(async (options?: { column?: string }) =>
      tasks
        .filter((task) => !task.deletedAt)
        .filter((task) => (options?.column ? task.column === options.column : true))
        .map((task) => ({ ...task })),
    ),
    getTask: vi.fn(async (taskId: string) => {
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task || task.deletedAt) throw new Error(`Task ${taskId} not found`);
      return { ...task };
    }),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async (id: string, column: string) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`Task ${id} not found`);
      const from = task.column;
      task.column = column;
      task.updatedAt = nextTimestamp();
      emit("task:moved", { task: { ...task }, from, to: column, source: "user" });
      return { ...task };
    }),
    deleteTask: vi.fn(async (id: string) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`Task ${id} not found`);
      if (!task.deletedAt) {
        task.deletedAt = nextTimestamp();
        task.updatedAt = task.deletedAt;
        emit("task:deleted", { ...task });
      }
      return { ...task };
    }),
    addTaskComment: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
  } as any;

  const emit = (event: string, ...args: any[]) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };

  store.emit = emit;

  return { store, emit, tasks };
}

function createProjectEngine() {
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

function makeTask(id: string, column: string = "in-progress"): TestTask {
  return {
    id,
    title: id,
    description: id,
    status: "open",
    column,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dependencies: [],
    comments: [],
    steps: [],
    currentStep: 0,
    log: [],
    deletedAt: null,
  };
}

describe("reliability interactions: soft-delete in-flight abort", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("aborts executor work while invalidating the auto-claim snapshot and leaving deleted tasks undispatchable", async () => {
    const { store } = createEventedStore([makeTask("FN-EXEC", "in-progress")]);
    const snapshotManager = new AutoClaimSnapshotManager({ taskStore: store as any });
    const invalidateSpy = vi.spyOn(snapshotManager, "invalidate");
    new Scheduler(store as any, { snapshotManager } as any);
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    (executor as any).activeSessions.set("FN-EXEC", {
      session: { abort, dispose },
      seenSteeringIds: new Set<string>(),
    });

    await store.deleteTask("FN-EXEC");
    await (executor as any).pendingTaskDisposals.get("FN-EXEC");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeSessions.has("FN-EXEC")).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith("task:deleted");
    expect((await snapshotManager.getSnapshot()).tasks.map((task) => task.id)).not.toContain("FN-EXEC");
  });

  it("aborts an active merge without double-abort errors when executor has nothing active", async () => {
    const { store } = createEventedStore([makeTask("FN-MERGE", "in-review")]);
    projectEngineMocks.currentStore = store;
    const engine = createProjectEngine();
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const abort = vi.fn();
    const dispose = vi.fn();

    await engine.start();
    (engine as any).activeMergeTaskId = "FN-MERGE";
    (engine as any).activeMergeSession = { dispose };
    (engine as any).mergeAbortController = { abort };
    (engine as any).mergeActive.add("FN-MERGE");

    store.emit("task:deleted", { ...makeTask("FN-MERGE", "in-review"), deletedAt: "2026-01-02T00:00:00.000Z" });
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((engine as any).activeMergeTaskId).toBeNull();
    expect((executor as any).activeSessions.size).toBe(0);

    await engine.stop();
  });

  it("treats task:moved followed by task:deleted as idempotent cleanup", async () => {
    const { store } = createEventedStore([makeTask("FN-RACE", "in-progress")]);
    const executor = new TaskExecutor(store as any, "/tmp/test");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();

    (executor as any).activeSessions.set("FN-RACE", {
      session: { abort, dispose },
      seenSteeringIds: new Set<string>(),
    });

    await store.moveTask("FN-RACE", "todo");
    await store.deleteTask("FN-RACE");
    await (executor as any).pendingTaskDisposals.get("FN-RACE");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).activeSessions.has("FN-RACE")).toBe(false);
  });
});
