import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";
import { runtimeLog } from "../logger.js";
import { aiMergeTask } from "../merger.js";
import { TunnelProcessManager } from "../remote-access/tunnel-process-manager.js";

const mocks = vi.hoisted(() => ({
  syncInsightExtractionAutomation: vi.fn(),
  syncAutoSummarizeAutomation: vi.fn(),
  syncMemoryDreamsAutomation: vi.fn(),
  automationStoreInit: vi.fn(async () => undefined),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
  cronRunnerStart: vi.fn(),
  cronRunnerStop: vi.fn(),
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  aiMergeTask: vi.fn(),
  execFile: vi.fn(),
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
    syncMemoryDreamsAutomation: mocks.syncMemoryDreamsAutomation,
  };
});

vi.mock("../cron-runner.js", () => {
  return {
    CronRunner: vi.fn().mockImplementation(() => ({
      start: mocks.cronRunnerStart,
      stop: mocks.cronRunnerStop,
    })),
    createAiPromptExecutor: mocks.createAiPromptExecutor,
  };
});

vi.mock("../merger.js", () => ({
  aiMergeTask: mocks.aiMergeTask,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: mocks.execFile,
  };
});

vi.mock("../pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(() => ({
    onNewComments: vi.fn(),
  })),
}));

vi.mock("../pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(() => ({
    handleNewComments: vi.fn(),
  })),
}));

vi.mock("../notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
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
  let settings = structuredClone(initialSettings);
  const settingsHandlers = new Set<(payload: SettingsHandlerPayload) => void | Promise<void>>();

  const store = {
    getSettings: vi.fn(async () => structuredClone(settings)),
    listTasks: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    getTask: vi.fn(async (taskId: string): Promise<Record<string, unknown>> => ({
      id: taskId,
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
    })),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
      settings = {
        ...settings,
        ...patch,
      };
      return structuredClone(settings);
    }),
    logEntry: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
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
    settings = structuredClone(next);
    for (const handler of settingsHandlers) {
      await handler({ settings: structuredClone(next), previous: structuredClone(previous) });
    }
  };

  const getCurrentSettings = () => structuredClone(settings);

  return { store, emitSettingsUpdated, getCurrentSettings };
}

const baseRemoteAccess = {
  enabled: true,
  activeProvider: "cloudflare" as const,
  providers: {
    tailscale: {
      enabled: true,
      hostname: "tail.example.ts.net",
      targetPort: 4040,
      acceptRoutes: false,
    },
    cloudflare: {
      enabled: true,
      quickTunnel: false,
      tunnelName: "demo",
      tunnelToken: "cf-secret-token",
      ingressUrl: "https://remote.example.com",
    },
  },
  tokenStrategy: {
    persistent: {
      enabled: true,
      token: "frt_persistent",
    },
    shortLived: {
      enabled: true,
      ttlMs: 120_000,
      maxTtlMs: 86_400_000,
    },
  },
  lifecycle: {
    rememberLastRunning: true,
    wasRunningOnShutdown: false,
    lastRunningProvider: null,
  },
};

const baseSettings: Record<string, unknown> = {
  autoMerge: false,
  globalPause: false,
  enginePaused: false,
  pollIntervalMs: 15_000,
  taskStuckTimeoutMs: undefined,
  memoryAutoSummarizeEnabled: false,
  memoryAutoSummarizeThresholdChars: 50_000,
  memoryAutoSummarizeSchedule: "0 3 * * *",
  memoryDreamsEnabled: false,
  memoryDreamsSchedule: "0 4 * * *",
  insightExtractionEnabled: false,
  insightExtractionSchedule: "0 3 * * *",
  insightExtractionMinIntervalMs: 0,
  remoteAccess: baseRemoteAccess,
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

beforeEach(() => {
  mocks.execFile.mockImplementation((
    _file: string,
    _args: string[],
    _options: unknown,
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    if (typeof _options === "function") {
      (_options as (error: Error | null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: "/usr/bin/mock\n",
        stderr: "",
      });
      return {} as never;
    }

    callback?.(null, { stdout: "/usr/bin/mock\n", stderr: "" });
    return {} as never;
  });
});

describe("ProjectEngine auto-summarize wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    mocks.aiMergeTask.mockResolvedValue({
      task: { id: "FN-001", column: "done" },
      branch: "fusion/fn-001",
      merged: true,
      worktreeRemoved: false,
      branchDeleted: true,
    });
  });

  it("syncs startup memory automations using one settings snapshot", async () => {
    const engine = createEngine();

    await engine.start();

    expect(mocks.syncInsightExtractionAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1);

    const insightSettings = mocks.syncInsightExtractionAutomation.mock.calls[0][1];
    const autoSummarizeSettings = mocks.syncAutoSummarizeAutomation.mock.calls[0][1];
    const memoryDreamsSettings = mocks.syncMemoryDreamsAutomation.mock.calls[0][1];
    expect(autoSummarizeSettings).toBe(insightSettings);
    expect(memoryDreamsSettings).toBe(insightSettings);

    const cronRunnerStartOrder = mocks.cronRunnerStart.mock.invocationCallOrder[0];
    expect(mocks.syncInsightExtractionAutomation.mock.invocationCallOrder[0]).toBeLessThan(
      cronRunnerStartOrder,
    );
    expect(mocks.syncAutoSummarizeAutomation.mock.invocationCallOrder[0]).toBeLessThan(
      cronRunnerStartOrder,
    );
    expect(mocks.syncMemoryDreamsAutomation.mock.invocationCallOrder[0]).toBeLessThan(
      cronRunnerStartOrder,
    );

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

describe("ProjectEngine remote tunnel manager wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
  });

  it("is unavailable before start and available after start", async () => {
    const engine = createEngine();

    expect(engine.getRemoteTunnelManager()).toBeUndefined();

    await engine.start();

    expect(engine.getRemoteTunnelManager()).toBeInstanceOf(TunnelProcessManager);

    await engine.stop();
    expect(engine.getRemoteTunnelManager()).toBeUndefined();
  });

  it("calls tunnel manager stop once during shutdown", async () => {
    const stopSpy = vi.spyOn(TunnelProcessManager.prototype, "stop").mockResolvedValueOnce(undefined);
    const engine = createEngine();

    await engine.start();
    await engine.stop();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    stopSpy.mockRestore();
  });

  it("warns when tunnel manager shutdown fails and clears manager reference", async () => {
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});
    const stopSpy = vi.spyOn(TunnelProcessManager.prototype, "stop").mockRejectedValueOnce(new Error("tunnel stop failed"));
    const engine = createEngine();

    await engine.start();
    await engine.stop();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Tunnel process manager stop failed"),
    );
    expect(engine.getRemoteTunnelManager()).toBeUndefined();

    stopSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("ProjectEngine remote lifecycle restore policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
  });

  it("attempts restore on startup when rememberLastRunning and prior-running markers are set", async () => {
    const restoreSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        lifecycle: {
          ...baseRemoteAccess.lifecycle,
          rememberLastRunning: true,
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare" as const,
        },
      },
    };
    const mockStore = createMockStore(restoreSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);
    const engine = createEngine();

    await engine.start();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toBe("cloudflare");
    expect(engine.getRemoteTunnelRestoreDiagnostics()).toMatchObject({
      outcome: "applied",
      reason: "restore_started",
      provider: "cloudflare",
    });

    await engine.stop();
    startSpy.mockRestore();
  });

  it("skips restore when rememberLastRunning is disabled", async () => {
    const restoreSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        lifecycle: {
          ...baseRemoteAccess.lifecycle,
          rememberLastRunning: false,
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare" as const,
        },
      },
    };
    const mockStore = createMockStore(restoreSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);
    const engine = createEngine();

    await engine.start();

    expect(startSpy).not.toHaveBeenCalled();
    expect(engine.getRemoteTunnelRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "remember_last_running_disabled",
      provider: null,
    });

    expect(mockStore.store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        }),
      }),
    }));

    await engine.stop();
    startSpy.mockRestore();
  });

  it("skips restore with explicit reason and clears stale marker when prerequisites are missing", async () => {
    const restoreSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        providers: {
          ...baseRemoteAccess.providers,
          cloudflare: {
            ...baseRemoteAccess.providers.cloudflare,
            tunnelToken: null,
          },
        },
        lifecycle: {
          ...baseRemoteAccess.lifecycle,
          rememberLastRunning: true,
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare" as const,
        },
      },
    };
    const mockStore = createMockStore(restoreSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);
    const engine = createEngine();

    await engine.start();

    expect(startSpy).not.toHaveBeenCalled();
    expect(engine.getRemoteTunnelRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "provider_not_configured",
      provider: "cloudflare",
    });
    expect(mockStore.store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        }),
      }),
    }));

    await engine.stop();
    startSpy.mockRestore();
  });

  it("persists shutdown lifecycle markers and deterministically restores on next engine start", async () => {
    const restoreSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        activeProvider: "cloudflare" as const,
        lifecycle: {
          ...baseRemoteAccess.lifecycle,
          rememberLastRunning: true,
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        },
      },
    };
    const mockStore = createMockStore(restoreSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(TunnelProcessManager.prototype, "stop").mockResolvedValue(undefined);
    const getStatusSpy = vi.spyOn(TunnelProcessManager.prototype, "getStatus")
      .mockReturnValueOnce({
        provider: "cloudflare",
        state: "running",
        pid: 4321,
        startedAt: "2026-04-26T12:00:00.000Z",
        stoppedAt: null,
        url: "https://remote.example.com",
        lastError: null,
      })
      .mockReturnValue({
        provider: null,
        state: "stopped",
        pid: null,
        startedAt: null,
        stoppedAt: "2026-04-26T12:05:00.000Z",
        url: null,
        lastError: null,
      });

    const firstEngine = createEngine();
    await firstEngine.start();
    await firstEngine.stop();

    const persistedSettings = mockStore.getCurrentSettings() as {
      remoteAccess?: { lifecycle?: { wasRunningOnShutdown?: boolean; lastRunningProvider?: string | null } };
    };
    expect(persistedSettings.remoteAccess?.lifecycle).toMatchObject({
      wasRunningOnShutdown: true,
      lastRunningProvider: "cloudflare",
    });

    const secondEngine = createEngine();
    await secondEngine.start();

    expect(startSpy).toHaveBeenCalled();
    expect(secondEngine.getRemoteTunnelRestoreDiagnostics()).toMatchObject({
      outcome: "applied",
      reason: "restore_started",
      provider: "cloudflare",
    });

    await secondEngine.stop();
    expect(stopSpy).toHaveBeenCalled();

    startSpy.mockRestore();
    stopSpy.mockRestore();
    getStatusSpy.mockRestore();
  });

  it("reconciles stale persisted running marker to avoid restore loops", async () => {
    const restoreSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        providers: {
          ...baseRemoteAccess.providers,
          cloudflare: {
            ...baseRemoteAccess.providers.cloudflare,
            tunnelToken: null,
          },
        },
        lifecycle: {
          ...baseRemoteAccess.lifecycle,
          rememberLastRunning: true,
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare" as const,
        },
      },
    };
    const mockStore = createMockStore(restoreSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);

    const firstEngine = createEngine();
    await firstEngine.start();
    await firstEngine.stop();

    const secondEngine = createEngine();
    await secondEngine.start();
    await secondEngine.stop();

    expect(startSpy).not.toHaveBeenCalled();
    expect(secondEngine.getRemoteTunnelRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "no_prior_running_marker",
    });

    startSpy.mockRestore();
  });

  it("does not auto-start on settings updates and manual stop clears future restore intent", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(TunnelProcessManager.prototype, "stop").mockResolvedValue(undefined);
    const statusSpy = vi.spyOn(TunnelProcessManager.prototype, "getStatus").mockReturnValue({
      provider: null,
      state: "stopped",
      pid: null,
      startedAt: null,
      stoppedAt: null,
      url: null,
      lastError: null,
    });

    const engine = createEngine();
    await engine.start();

    await mockStore.emitSettingsUpdated(
      {
        ...baseSettings,
        remoteAccess: {
          ...baseRemoteAccess,
          activeProvider: "tailscale" as const,
        },
      },
      baseSettings,
    );

    const startsBeforeManualAction = startSpy.mock.calls.length;
    await engine.startRemoteTunnel();
    await engine.stopRemoteTunnel();

    expect(startSpy.mock.calls.length).toBe(startsBeforeManualAction + 1);
    expect(stopSpy).toHaveBeenCalled();
    expect(mockStore.store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        }),
      }),
    }));

    await engine.stop();
    startSpy.mockRestore();
    stopSpy.mockRestore();
    statusSpy.mockRestore();
  });
});

describe("ProjectEngine remote lifecycle quick tunnel mode", () => {
  it("starts cloudflare quick tunnel without manual tunnel fields", async () => {
    const quickTunnelSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        providers: {
          ...baseRemoteAccess.providers,
          cloudflare: {
            ...baseRemoteAccess.providers.cloudflare,
            quickTunnel: true,
            tunnelName: "",
            tunnelToken: null,
            ingressUrl: "",
          },
        },
      },
    };
    const mockStore = createMockStore(quickTunnelSettings);
    mocks.currentStore = mockStore.store;

    const startSpy = vi.spyOn(TunnelProcessManager.prototype, "start").mockResolvedValue(undefined);

    const engine = createEngine();
    await engine.start();
    await engine.startRemoteTunnel();

    expect(startSpy).toHaveBeenCalledWith(
      "cloudflare",
      expect.objectContaining({
        provider: "cloudflare",
        quickTunnel: true,
        executablePath: "cloudflared",
        args: ["tunnel", "--url", "http://localhost:4040"],
      }),
    );

    await engine.stop();
    startSpy.mockRestore();
  });

  it("surfaces runtime prerequisite missing when cloudflared is unavailable in quick tunnel mode", async () => {
    mocks.execFile.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const err = new Error("cloudflared not found");
      if (typeof _options === "function") {
        (_options as (error: Error, result: { stdout: string; stderr: string }) => void)(err, {
          stdout: "",
          stderr: "",
        });
        return {} as never;
      }

      callback?.(err, { stdout: "", stderr: "" });
      return {} as never;
    });

    const quickTunnelSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        providers: {
          ...baseRemoteAccess.providers,
          cloudflare: {
            ...baseRemoteAccess.providers.cloudflare,
            quickTunnel: true,
            tunnelName: "",
            tunnelToken: null,
            ingressUrl: "",
          },
        },
      },
    };
    const mockStore = createMockStore(quickTunnelSettings);
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    await expect(engine.startRemoteTunnel()).rejects.toThrow(
      "runtime_prerequisite_missing:cloudflared is not available on PATH",
    );
    await engine.stop();
  });

  it("keeps manual cloudflare validation unchanged when quick tunnel is disabled", async () => {
    const manualSettings = {
      ...baseSettings,
      remoteAccess: {
        ...baseRemoteAccess,
        providers: {
          ...baseRemoteAccess.providers,
          cloudflare: {
            ...baseRemoteAccess.providers.cloudflare,
        quickTunnel: false,
            tunnelToken: null,
          },
        },
      },
    };
    const mockStore = createMockStore(manualSettings);
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    await expect(engine.startRemoteTunnel()).rejects.toThrow(
      "provider_not_configured:Cloudflare tunnel token is required",
    );
    await engine.stop();
  });
});

describe("ProjectEngine shutdown merge handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
  });

  it("aborts active merges, clears pending queue, and blocks new merges after stop", async () => {
    const engine = createEngine();
    await engine.start();

    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      mergeAbortController: AbortController | null;
      mergeRetryTimer: ReturnType<typeof setTimeout> | null;
      activeMergeSession: { dispose: () => void } | null;
    };

    let capturedSignal: AbortSignal | undefined;
    mocks.aiMergeTask.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { signal?: AbortSignal } | undefined;
      capturedSignal = options?.signal;
      await new Promise<never>((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const abortError = new Error("merge aborted");
          abortError.name = "MergeAbortedError";
          reject(abortError);
        }, { once: true });
      });
    });

    const manualMergePromise = engine.onMerge("FN-123");
    engine.enqueueMerge("FN-queued");

    await vi.waitFor(() => {
      expect(mocks.aiMergeTask).toHaveBeenCalledTimes(1);
    });

    expect(capturedSignal?.aborted).toBe(false);

    await engine.stop();

    await expect(manualMergePromise).rejects.toThrow("Engine shutting down");

    expect(capturedSignal?.aborted).toBe(true);
    expect(privateEngine.mergeQueue).toHaveLength(0);
    expect(privateEngine.mergeRetryTimer).toBeNull();
    expect(privateEngine.activeMergeSession).toBeNull();
    await vi.waitFor(() => {
      expect(privateEngine.mergeActive.has("FN-123")).toBe(false);
    });
    expect(privateEngine.mergeAbortController).toBeNull();

    const mergeCallsBeforeRequeue = mocks.aiMergeTask.mock.calls.length;
    engine.enqueueMerge("FN-after-stop");
    expect(privateEngine.mergeQueue).toHaveLength(0);
    expect(mocks.aiMergeTask).toHaveBeenCalledTimes(mergeCallsBeforeRequeue);
  });
});

describe("ProjectEngine paused in-review auto-merge behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not enqueue paused tasks from task:moved into in-review", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();

    const taskMovedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
      | ((payload: { task: { id: string; column: string; paused?: boolean }; to: string }) => Promise<void>)
      | undefined;

    if (!taskMovedHandler) throw new Error("task:moved handler was not registered");

    await taskMovedHandler({
      task: { id: "FN-paused", column: "in-review", paused: true },
      to: "in-review",
    });

    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");

    await engine.stop();
  });

  it("re-enqueues an in-review task when it is unpaused", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    enqueueSpy.mockClear();

    const taskUpdatedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:updated")?.[1] as
      | ((task: { id: string; column: string; paused?: boolean; status?: string | null }) => Promise<void>)
      | undefined;
    if (!taskUpdatedHandler) throw new Error("task:updated handler was not registered");

    await taskUpdatedHandler({ id: "FN-unpause", column: "in-review", paused: true, status: "paused" });
    await taskUpdatedHandler({ id: "FN-unpause", column: "in-review", paused: false, status: null });

    expect(enqueueSpy).toHaveBeenCalledWith("FN-unpause");

    await engine.stop();
  });

  it("logs and skips paused tasks dequeued for auto-merge", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValueOnce({
      id: "FN-paused",
      column: "in-review",
      paused: true,
      mergeRetries: 0,
      status: null,
    });
    mocks.currentStore = mockStore.store;

    const logSpy = vi.spyOn(runtimeLog, "log").mockImplementation(() => {});
    const engine = createEngine();
    await engine.start();

    engine.enqueueMerge("FN-paused");

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Auto-merge skipping FN-paused — task is paused"));
    });
    expect(mocks.aiMergeTask).not.toHaveBeenCalled();

    logSpy.mockRestore();
    await engine.stop();
  });

  it("aborts and disposes active merge session when an in-review task is paused", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-active",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
    });
    mocks.currentStore = mockStore.store;

    let capturedSignal: AbortSignal | undefined;
    const disposeSession = vi.fn();
    mocks.aiMergeTask.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { signal?: AbortSignal; onSession?: (session: { dispose: () => void }) => void };
      capturedSignal = options.signal;
      options.onSession?.({ dispose: disposeSession });
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const abortError = new Error("merge aborted");
            abortError.name = "MergeAbortedError";
            reject(abortError);
          },
          { once: true },
        );
      });
    });

    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      activeMergeSession: { dispose: () => void } | null;
      mergeAbortController: AbortController | null;
      activeMergeTaskId: string | null;
    };

    await engine.start();
    engine.enqueueMerge("FN-active");

    await vi.waitFor(() => {
      expect(mocks.aiMergeTask).toHaveBeenCalledTimes(1);
    });

    const taskUpdatedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:updated")?.[1] as
      | ((task: { id: string; column: string; paused?: boolean }) => void)
      | undefined;
    if (!taskUpdatedHandler) throw new Error("task:updated handler was not registered");

    taskUpdatedHandler({ id: "FN-active", column: "in-review", paused: true });

    await vi.waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
    });
    expect(disposeSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(privateEngine.mergeQueue).not.toContain("FN-active");
      expect(privateEngine.mergeActive.has("FN-active")).toBe(false);
      expect(privateEngine.activeMergeSession).toBeNull();
      expect(privateEngine.mergeAbortController).toBeNull();
      expect(privateEngine.activeMergeTaskId).toBeNull();
    });

    await engine.stop();
  });

  it("startup merge sweep skips paused in-review tasks", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.listTasks.mockResolvedValueOnce([
      { id: "FN-paused", column: "in-review", paused: true, mergeRetries: 0, status: null },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ]);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");

    await engine.stop();
  });

  it("global unpause sweep does not enqueue paused in-review tasks", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    enqueueSpy.mockClear();
    mockStore.store.listTasks.mockResolvedValueOnce([
      { id: "FN-paused", column: "in-review", paused: true, mergeRetries: 0, status: null },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ]);

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false },
      { ...baseSettings, autoMerge: true, globalPause: true },
    );

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");

    await engine.stop();
  });

  it("engine unpause sweep does not enqueue paused in-review tasks", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    enqueueSpy.mockClear();
    mockStore.store.listTasks.mockResolvedValueOnce([
      { id: "FN-paused", column: "in-review", paused: true, mergeRetries: 0, status: null },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ]);

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, enginePaused: false },
      { ...baseSettings, autoMerge: true, enginePaused: true },
    );

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");

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
