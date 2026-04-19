import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "./project-engine.js";
import { runtimeLog } from "./logger.js";

const mocks = vi.hoisted(() => ({
  syncInsightExtractionAutomation: vi.fn(),
  syncAutoSummarizeAutomation: vi.fn(),
  automationStoreInit: vi.fn(async () => undefined),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
  cronRunnerStart: vi.fn(),
  cronRunnerStop: vi.fn(),
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  currentStore: null as Record<string, unknown> | null,
}));

vi.mock("@fusion/core", async () => {
  class MockAutomationStore {
    constructor(_cwd: string) {}

    init = mocks.automationStoreInit;
  }

  return {
    AutomationStore: MockAutomationStore,
    syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomation,
    syncAutoSummarizeAutomation: mocks.syncAutoSummarizeAutomation,
  };
});

vi.mock("./cron-runner.js", () => {
  return {
    CronRunner: vi.fn().mockImplementation(() => ({
      start: mocks.cronRunnerStart,
      stop: mocks.cronRunnerStop,
    })),
    createAiPromptExecutor: mocks.createAiPromptExecutor,
  };
});

vi.mock("./pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(() => ({
    onNewComments: vi.fn(),
  })),
}));

vi.mock("./pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(() => ({
    handleNewComments: vi.fn(),
  })),
}));

vi.mock("./notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

vi.mock("./runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(() => ({
    start: mocks.runtimeStart,
    stop: mocks.runtimeStop,
    getTaskStore: () => mocks.currentStore,
    getAgentStore: vi.fn(),
    getMessageStore: vi.fn(),
    getRoutineStore: vi.fn(),
    getRoutineRunner: vi.fn(),
    getHeartbeatMonitor: vi.fn(),
    getTriggerScheduler: vi.fn(),
  })),
}));

type SettingsHandlerPayload = {
  settings: Record<string, unknown>;
  previous: Record<string, unknown>;
};

function createMockStore(initialSettings: Record<string, unknown>) {
  let settings = { ...initialSettings };
  const settingsHandlers = new Set<(payload: SettingsHandlerPayload) => void | Promise<void>>();

  const store = {
    getSettings: vi.fn(async () => ({ ...settings })),
    listTasks: vi.fn(async () => []),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
      if (event === "settings:updated") {
        settingsHandlers.add(handler as (payload: SettingsHandlerPayload) => void | Promise<void>);
      }
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
      if (event === "settings:updated") {
        settingsHandlers.delete(
          handler as (payload: SettingsHandlerPayload) => void | Promise<void>,
        );
      }
    }),
  };

  const emitSettingsUpdated = async (
    next: Record<string, unknown>,
    previous: Record<string, unknown>,
  ) => {
    settings = { ...next };
    for (const handler of settingsHandlers) {
      await handler({ settings: { ...next }, previous: { ...previous } });
    }
  };

  return { store, emitSettingsUpdated };
}

const baseSettings: Record<string, unknown> = {
  autoMerge: false,
  globalPause: false,
  enginePaused: false,
  pollIntervalMs: 15_000,
  taskStuckTimeoutMs: undefined,
  memoryAutoSummarizeEnabled: false,
  memoryAutoSummarizeThresholdChars: 50_000,
  memoryAutoSummarizeSchedule: "0 3 * * *",
  insightExtractionEnabled: false,
  insightExtractionSchedule: "0 3 * * *",
  insightExtractionMinIntervalMs: 0,
};

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

describe("ProjectEngine auto-summarize wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
  });

  it("syncs auto-summarize automation on startup using one settings snapshot", async () => {
    const engine = createEngine();

    await engine.start();

    expect(mocks.syncInsightExtractionAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1);

    const insightSettings = mocks.syncInsightExtractionAutomation.mock.calls[0][1];
    const autoSummarizeSettings = mocks.syncAutoSummarizeAutomation.mock.calls[0][1];
    expect(autoSummarizeSettings).toBe(insightSettings);

    await engine.stop();
  });

  it("re-syncs auto-summarize automation only when related settings change", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    mocks.syncAutoSummarizeAutomation.mockClear();

    const previous = { ...baseSettings };
    const nextEnabled = {
      ...previous,
      memoryAutoSummarizeEnabled: true,
    };

    await mockStore.emitSettingsUpdated(nextEnabled, previous);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1);

    const unrelatedChange = {
      ...nextEnabled,
      pollIntervalMs: 30_000,
    };

    await mockStore.emitSettingsUpdated(unrelatedChange, nextEnabled);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1);

    const disabled = {
      ...unrelatedChange,
      memoryAutoSummarizeEnabled: false,
    };

    await mockStore.emitSettingsUpdated(disabled, unrelatedChange);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(2);

    await engine.stop();
  });
});

describe("ProjectEngine swallowed error hardening", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("warns when settings read fails during task:moved auto-merge check", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();

    mockStore.store.getSettings.mockRejectedValueOnce(new Error("db locked"));

    const handler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
      | ((payload: { task: { id: string; column: string }; to: string }) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("task:moved handler was not registered");

    await handler({
      task: { id: "FN-001", column: "in-review" },
      to: "in-review",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge: failed to read settings for task:moved on FN-001"),
    );

    await engine.stop();
  });

  it("warns when startup merge sweep fails", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    mockStore.store.listTasks.mockRejectedValueOnce(new Error("connection lost"));

    const engine = createEngine();
    await engine.start();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Auto-merge startup sweep failed"));

    await engine.stop();
  });

  it("warns when periodic merge sweep fails", async () => {
    vi.useFakeTimers();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    mockStore.store.listTasks.mockRejectedValueOnce(new Error("sweep db error"));

    await vi.advanceTimersByTimeAsync(15_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Auto-merge periodic sweep failed"));

    await engine.stop();
  });

  it("warns and uses 15s fallback when pollIntervalMs read fails during retry scheduling", async () => {
    vi.useFakeTimers();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    mockStore.store.getSettings
      .mockResolvedValueOnce({ ...baseSettings, autoMerge: true })
      .mockRejectedValueOnce(new Error("settings read failed"));

    await vi.advanceTimersByTimeAsync(15_000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge retry: failed to read pollIntervalMs"),
    );

    await engine.stop();
  });

  it("warns when resumeOrphaned dispatch fails during global unpause", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "executor", {
      get() {
        throw new Error("executor broken");
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false },
      { ...baseSettings, globalPause: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Global unpause: failed to dispatch resumeOrphaned"),
    );

    await engine.stop();
  });

  it("warns when in-review task listing fails during global unpause", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    mockStore.store.listTasks.mockRejectedValueOnce(new Error("list failed"));

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false },
      { ...baseSettings, autoMerge: true, globalPause: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Global unpause: failed to scan in-review tasks"),
    );

    await engine.stop();
  });

  it("warns when resumeOrphaned dispatch fails during engine unpause", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "executor", {
      get() {
        throw new Error("executor broken");
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Engine unpause: failed to dispatch resumeOrphaned"),
    );

    await engine.stop();
  });

  it("warns when in-review task listing fails during engine unpause", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    mockStore.store.listTasks.mockRejectedValueOnce(new Error("list failed"));

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, enginePaused: false },
      { ...baseSettings, autoMerge: true, enginePaused: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Engine unpause: failed to scan in-review tasks"),
    );

    await engine.stop();
  });

  it("warns when stuck-detector checkNow fails on timeout change", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get() {
        return {
          checkNow: async () => {
            throw new Error("detector stuck");
          },
        };
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, taskStuckTimeoutMs: 600_000 },
      { ...baseSettings, taskStuckTimeoutMs: 300_000 },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stuck-timeout change: detector.checkNow() failed"),
    );

    await engine.stop();
  });
});
