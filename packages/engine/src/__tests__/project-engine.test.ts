import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { ProjectEngine, __resetDeterministicMergerModeDeprecationWarned } from "../project-engine.js";
// Resolves to the vi.mock factory above (the mocked merger-ai exports the real-shaped
// workspace land error classes so the dispatch's `instanceof` matching is exercised).
import { WorkspacePartialLandError, WorkspaceRepoLandBusyError } from "../merger-ai.js";
import { runtimeLog } from "../logger.js";
import { TunnelProcessManager } from "../remote-access/tunnel-process-manager.js";
import { NtfyNotifier } from "../notifier.js";
import { NotificationService, OAuthAlertStateStore, OAuthExpiryMonitor, OAuthValidityLogger } from "../notification/index.js";

const mocks = vi.hoisted(() => ({
  syncInsightExtractionAutomation: vi.fn(),
  syncAutoSummarizeAutomation: vi.fn(),
  syncMemoryDreamsAutomation: vi.fn(),
  syncScheduledEvalBatchAutomation: vi.fn(),
  automationStoreInit: vi.fn(async () => undefined),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
  cronRunnerStart: vi.fn(),
  cronRunnerStop: vi.fn(),
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  runtimeResumeAfterUnpause: vi.fn(async () => undefined),
  getSelfHealingManager: vi.fn(() => undefined),
  runAiMerge: vi.fn(),
  landWorkspaceTask: vi.fn(),
  execFile: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
  notifierStart: vi.fn(async () => undefined),
  notifierStop: vi.fn(),
  notifierNotifyGridlock: vi.fn(),
  notificationServiceStart: vi.fn(async () => undefined),
  notificationServiceStop: vi.fn(),
  oauthExpiryMonitorStart: vi.fn(async () => undefined),
  oauthExpiryMonitorStop: vi.fn(),
  oauthValidityLoggerStart: vi.fn(async () => undefined),
  oauthValidityLoggerStop: vi.fn(),
  // FNXC:EngineOAuth 2026-07-07-08:25: FN-7574 added OAuthRefreshScheduler (proactive access-token refresh) to the notification module; mirror its start/stop seams here alongside the sibling OAuth monitors.
  oauthRefreshSchedulerStart: vi.fn(async () => undefined),
  oauthRefreshSchedulerStop: vi.fn(),
  runtimeConfigurePrMonitoring: vi.fn(),
  deliverPostgresMigrationCompleteNotice: vi.fn(async () => "no-migration"),
  prHandlerCreateFollowUpTask: vi.fn(async () => undefined),
}));

vi.mock("../postgres-migration-notice.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../postgres-migration-notice.js")>();
  return {
    ...actual,
    deliverPostgresMigrationCompleteNoticeIfNeeded: mocks.deliverPostgresMigrationCompleteNotice,
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    AutomationStore: class MockAutomationStore {
      constructor(_cwd: string) {}

      init = mocks.automationStoreInit;
    },
    syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomation,
    syncAutoSummarizeAutomation: mocks.syncAutoSummarizeAutomation,
    syncMemoryDreamsAutomation: mocks.syncMemoryDreamsAutomation,
    syncScheduledEvalBatchAutomation: mocks.syncScheduledEvalBatchAutomation,
  });
});

vi.mock("../cron-runner.js", () => {
  return {
    CronRunner: vi.fn().mockImplementation(function () {
      return {
        start: mocks.cronRunnerStart,
        stop: mocks.cronRunnerStop,
      };
    }),
    createAiPromptExecutor: mocks.createAiPromptExecutor,
  };
});

// FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 unified the merge
// dispatch onto runAiMerge (merger-ai.js). project-engine no longer imports
// aiMergeTask; the merge seam these tests mock/assert is now runAiMerge.
vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => ({ dropped: 0, retained: 0 })),
  VerificationError: class VerificationError extends Error {},
}));

// FNXC:Workspace 2026-06-22-05:10 (Phase C review B7): the dispatch now matches the
// workspace land errors via `instanceof`, and routes workspace tasks through
// `landWorkspaceTask`. The mock must export REAL error classes (so `instanceof` is callable)
// and a mockable `landWorkspaceTask`; otherwise `err instanceof WorkspacePartialLandError`
// throws "not callable" and the workspace dispatch can't be exercised. The classes are
// declared INSIDE the (hoisted) factory so they exist when the mock is evaluated.
vi.mock("../merger-ai.js", () => {
  class WorkspaceRepoLandBusyError extends Error {
    public readonly retryable = true;
    constructor(
      public readonly repoRel: string,
      public readonly holderTaskId: string,
      public readonly requestingTaskId: string,
    ) {
      super(`workspace sub-repo ${repoRel} land is in progress for task ${holderTaskId}`);
      this.name = "WorkspaceRepoLandBusyError";
    }
  }
  class WorkspacePartialLandError extends Error {
    public readonly retryable = true;
    constructor(
      public readonly landedCount: number,
      public readonly failedRepos: string[],
      message: string,
    ) {
      super(message);
      this.name = "WorkspacePartialLandError";
    }
  }
  return {
    runAiMerge: mocks.runAiMerge,
    landWorkspaceTask: mocks.landWorkspaceTask,
    WorkspaceRepoLandBusyError,
    WorkspacePartialLandError,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: mocks.execFile,
  };
});

vi.mock("../pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(function () {
    return {
      onNewComments: vi.fn(),
    };
  }),
}));

vi.mock("../pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(function () {
    return {
      handleNewComments: vi.fn(),
      createFollowUpTask: mocks.prHandlerCreateFollowUpTask,
    };
  }),
}));

vi.mock("../notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(function () {
    return {
      start: mocks.notifierStart,
      stop: mocks.notifierStop,
      notifyGridlock: mocks.notifierNotifyGridlock,
    };
  }),
}));

vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () {
    return {
      start: mocks.notificationServiceStart,
      stop: mocks.notificationServiceStop,
    };
  }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () {
    return {};
  }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () {
    return {
      start: mocks.oauthExpiryMonitorStart,
      stop: mocks.oauthExpiryMonitorStop,
    };
  }),
  // FNXC:EngineOAuth 2026-07-07-08:25: FN-7574 constructs `new OAuthRefreshScheduler({ authStorage })` then awaits `.start()`/`.stop()` in ProjectEngine.start/stop. Export a constructable mock (function impl returning {start,stop}) so `new` works and the canonical-listener wiring tests run instead of failing on a missing mock export.
  OAuthRefreshScheduler: vi.fn().mockImplementation(function () {
    return {
      start: mocks.oauthRefreshSchedulerStart,
      stop: mocks.oauthRefreshSchedulerStop,
    };
  }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () {
    return {
      start: mocks.oauthValidityLoggerStart,
      stop: mocks.oauthValidityLoggerStop,
    };
  }),
}));

vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    get: vi.fn(() => undefined),
  })),
  getFusionOAuthAlertStatePath: vi.fn(() => "/tmp/oauth-alert-state.json"),
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      resumeAfterUnpause: mocks.runtimeResumeAfterUnpause,
      getTaskStore: () => mocks.currentStore,
      getPluginRunner: vi.fn(() => undefined),
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      getSelfHealingManager: mocks.getSelfHealingManager,
      configurePrMonitoring: mocks.runtimeConfigurePrMonitoring,
    };
  }),
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
    getAsyncLayer: vi.fn(() => ({ kind: "test-async-layer" })),
    /*
    FNXC:OverlapSelfHealing 2026-06-26-12:00:
    ProjectEngine's broad TaskStore fake is shared by maintenance wiring tests, so it carries clearStaleBlockedBy's overlap-path seam even when individual cases only exercise merge orchestration.
    */
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
    emit: vi.fn(),
    addTaskComment: vi.fn(async () => undefined),
    getActiveMergingTask: vi.fn(() => null),
    getBranchGroup: vi.fn(() => null),
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
  // FNXC:MergerUnification 2026-06-21-19:05: U0 unified merges onto runAiMerge;
  // the onMerge tests mock/assert runAiMerge. The old `merger.mode` pin is gone
  // (the dispatch ignores it) — a dedicated test below covers the inert-mode +
  // one-time deprecation-warning behavior.
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

function createEngine(options?: ConstructorParameters<typeof ProjectEngine>[2]) {
  return new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    { skipNotifier: true, ...options },
  );
}

beforeEach(() => {
  mocks.deliverPostgresMigrationCompleteNotice.mockReset();
  mocks.deliverPostgresMigrationCompleteNotice.mockResolvedValue("no-migration");
  mocks.runtimeResumeAfterUnpause.mockClear();
  mocks.getSelfHealingManager.mockReset();
  mocks.getSelfHealingManager.mockReturnValue(undefined);
  mocks.notifierStart.mockClear();
  mocks.notifierStop.mockClear();
  mocks.notifierNotifyGridlock.mockClear();
  mocks.notificationServiceStart.mockClear();
  mocks.notificationServiceStop.mockClear();
  mocks.oauthExpiryMonitorStart.mockClear();
  mocks.oauthExpiryMonitorStop.mockClear();
  mocks.oauthValidityLoggerStart.mockClear();
  mocks.oauthValidityLoggerStop.mockClear();
  mocks.oauthRefreshSchedulerStart.mockClear();
  mocks.oauthRefreshSchedulerStop.mockClear();

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

describe("ProjectEngine notification ownership wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
  });

  it("constructs NtfyNotifier with the same NotificationService instance and starts canonical listeners once", async () => {
    const engine = createEngine({ skipNotifier: false, projectId: "proj_for_notifier" });

    await engine.start();
    await vi.waitFor(() => expect(mocks.notifierStart).toHaveBeenCalledTimes(1));

    expect(NotificationService).toHaveBeenCalledTimes(1);
    expect(OAuthAlertStateStore).toHaveBeenCalledTimes(1);
    expect(OAuthExpiryMonitor).toHaveBeenCalledTimes(1);
    expect(OAuthValidityLogger).toHaveBeenCalledTimes(1);
    expect(NtfyNotifier).toHaveBeenCalledTimes(1);
    const notifierCtorArgs = vi.mocked(NtfyNotifier).mock.calls[0];
    expect(notifierCtorArgs?.[2]).toBe(vi.mocked(NotificationService).mock.results[0]?.value);
    const alertStateInstance = vi.mocked(OAuthAlertStateStore).mock.results[0]?.value;
    expect(vi.mocked(OAuthExpiryMonitor).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ alertState: alertStateInstance }),
    );
    expect(vi.mocked(OAuthValidityLogger).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ alertState: alertStateInstance }),
    );

    expect(mocks.notificationServiceStart).toHaveBeenCalledTimes(1);
    expect(mocks.oauthExpiryMonitorStart).toHaveBeenCalledTimes(1);
    expect(mocks.notifierStart).toHaveBeenCalledTimes(1);

    // FNXC:ClaudeOAuth 2026-07-08-12:10: the proactive refresher must start BEFORE the
    // refresh-blind expiry monitor's first (awaited) check, or a stale-but-refreshable
    // access token fires a false "OAuth token expired" ntfy push on startup. Lock the order.
    expect(mocks.oauthRefreshSchedulerStart).toHaveBeenCalledTimes(1);
    expect(mocks.oauthRefreshSchedulerStart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.oauthExpiryMonitorStart.mock.invocationCallOrder[0],
    );

    await engine.stop();
    expect(mocks.oauthExpiryMonitorStop).toHaveBeenCalledTimes(1);
    expect(mocks.notificationServiceStop).toHaveBeenCalledTimes(1);
    expect(mocks.notifierStop).toHaveBeenCalledTimes(1);
  });

  it("does not recreate notification listeners on repeated start calls, preventing duplicate merged delivery", async () => {
    const engine = createEngine({ skipNotifier: false, projectId: "proj_for_notifier" });

    await engine.start();
    await engine.start();
    await vi.waitFor(() => expect(mocks.notifierStart).toHaveBeenCalledTimes(1));

    // Root cause guard: if ProjectEngine.start is called more than once, it should not
    // wire a second NotificationService/NtfyNotifier pair for the same store.
    expect(NotificationService).toHaveBeenCalledTimes(1);
    expect(OAuthAlertStateStore).toHaveBeenCalledTimes(1);
    expect(OAuthExpiryMonitor).toHaveBeenCalledTimes(1);
    expect(OAuthValidityLogger).toHaveBeenCalledTimes(1);
    expect(NtfyNotifier).toHaveBeenCalledTimes(1);
    expect(mocks.notificationServiceStart).toHaveBeenCalledTimes(1);
    expect(mocks.oauthExpiryMonitorStart).toHaveBeenCalledTimes(1);
    expect(mocks.notifierStart).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("does not create OAuth expiry monitor when notifier is skipped", async () => {
    const engine = createEngine({ skipNotifier: true, projectId: "proj_for_notifier" });

    await engine.start();

    expect(NotificationService).not.toHaveBeenCalled();
    expect(OAuthAlertStateStore).not.toHaveBeenCalled();
    expect(OAuthExpiryMonitor).not.toHaveBeenCalled();
    expect(OAuthValidityLogger).not.toHaveBeenCalled();
    expect(NtfyNotifier).not.toHaveBeenCalled();

    await engine.stop();
  });

  /*
  FNXC:PostgresMigrationInbox 2026-07-14-12:10:
  Post-migration inbox delivery is informational background work. Project startup must complete even while the database-backed notice operation is still pending.
  */
  it("does not block startup on post-migration inbox delivery", async () => {
    const mockStore = createMockStore({
      ...baseSettings,
      sqliteMigrationNotice: {
        migratedAt: "2026-07-14T18:00:00.000Z",
        migratedRows: 10,
        tables: 2,
        sqliteBackups: ["/tmp/fusion.db"],
        dismissed: false,
      },
    });
    mocks.currentStore = mockStore.store;
    mocks.deliverPostgresMigrationCompleteNotice.mockImplementation(() => new Promise(() => {}));

    const engine = createEngine();
    await expect(engine.start()).resolves.toBeUndefined();
    expect(mocks.deliverPostgresMigrationCompleteNotice).toHaveBeenCalledOnce();

    await engine.stop();
  });
});

describe("ProjectEngine planner overseer observation wiring", () => {
  it("awaits the audit persistence promise through the monitor registered by start()", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const engineInternals = engine as unknown as {
      emitOverseerObservationDeduped: (store: unknown, observation: unknown) => Promise<void>;
    };
    const emitSpy = vi.spyOn(engineInternals, "emitOverseerObservationDeduped").mockReturnValue(persistence);

    await engine.start();
    try {
      const monitor = engine.getPlannerOverseer();
      expect(monitor).toBeDefined();

      /*
      FNXC:PlannerOversight 2026-07-17-16:35:
      ProjectEngine.start() must return the audit-persistence Promise from its
      monitor callback. Awaiting only a test-local callback can hide dropped
      PostgreSQL audit writes in the production wiring.
      */
      const observed = monitor!.observeTask({ id: "FN-observation", column: "in-progress" } as Task, "autonomous");
      await vi.waitFor(() => expect(emitSpy).toHaveBeenCalledOnce());

      let settled = false;
      void observed.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      releasePersistence();
      await expect(observed).resolves.toEqual(expect.objectContaining({ taskId: "FN-observation" }));
    } finally {
      await engine.stop();
    }
  });
});

describe("ProjectEngine accessors", () => {
  it("returns configured project id", () => {
    const engine = new ProjectEngine(
      {
        projectId: "proj_accessor",
        workingDirectory: "/tmp/proj_accessor",
        isolationMode: "in-process",
        maxConcurrent: 2,
        maxWorktrees: 2,
      },
      {} as never,
      { skipNotifier: true },
    );

    expect(engine.getProjectId()).toBe("proj_accessor");
  });
});

describe("ProjectEngine PR monitoring wiring", () => {
  it("wires runtime scheduler PR monitoring with closed-PR follow-up handler", async () => {
    const { store } = createMockStore(baseSettings);
    mocks.currentStore = store;

    const engine = createEngine();
    await engine.start();

    expect(mocks.runtimeConfigurePrMonitoring).toHaveBeenCalled();
    const calls = mocks.runtimeConfigurePrMonitoring.mock.calls;
    const configArg = calls[calls.length - 1]?.[0] as {
      onClosedPrFeedback?: (taskId: string, prInfo: Record<string, unknown>, comments: unknown[]) => Promise<void> | void;
    };
    expect(typeof configArg.onClosedPrFeedback).toBe("function");

    await configArg.onClosedPrFeedback?.(
      "FN-3202",
      { number: 12, status: "merged", url: "https://example/pr/12" } as never,
      [{ id: 1, body: "please fix", user: { login: "reviewer" } }] as never,
    );

    expect(mocks.prHandlerCreateFollowUpTask).toHaveBeenCalledWith(
      "FN-3202",
      expect.objectContaining({ number: 12 }),
      expect.any(Array),
    );

    await engine.stop();
  });
});

describe("ProjectEngine auto-summarize wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    mocks.runAiMerge.mockResolvedValue({
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
    await vi.waitFor(() => expect(mocks.syncScheduledEvalBatchAutomation).toHaveBeenCalledTimes(1));

    expect(mocks.syncInsightExtractionAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncScheduledEvalBatchAutomation).toHaveBeenCalledTimes(1);

    const insightSettings = mocks.syncInsightExtractionAutomation.mock.calls[0][1];
    const autoSummarizeSettings = mocks.syncAutoSummarizeAutomation.mock.calls[0][1];
    const memoryDreamsSettings = mocks.syncMemoryDreamsAutomation.mock.calls[0][1];
    const scheduledEvalSettings = mocks.syncScheduledEvalBatchAutomation.mock.calls[0][1];
    expect(autoSummarizeSettings).toBe(insightSettings);
    expect(memoryDreamsSettings).toBe(insightSettings);
    expect(scheduledEvalSettings).toBe(insightSettings);

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
    expect(mocks.syncScheduledEvalBatchAutomation.mock.invocationCallOrder[0]).toBeLessThan(
      cronRunnerStartOrder,
    );

    await engine.stop();
  });

  it("re-syncs auto-summarize automation only when related settings change", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncAutoSummarizeAutomation).toHaveBeenCalledTimes(1));
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

describe("ProjectEngine memory dreams wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
  });

  it("starts cron after memory dreams startup sync", async () => {
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1));

    const cronRunnerStartOrder = mocks.cronRunnerStart.mock.invocationCallOrder[0];
    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncMemoryDreamsAutomation.mock.invocationCallOrder[0]).toBeLessThan(
      cronRunnerStartOrder,
    );

    await engine.stop();
  });

  it("re-syncs memory dreams automation when memoryDreamsEnabled changes", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1));
    mocks.syncMemoryDreamsAutomation.mockClear();

    const previous = { ...baseSettings };
    const next = {
      ...previous,
      memoryDreamsEnabled: true,
    };

    await mockStore.emitSettingsUpdated(next, previous);

    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledWith(expect.anything(), next);

    await engine.stop();
  });

  it("re-syncs memory dreams automation when memoryDreamsSchedule changes", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1));
    mocks.syncMemoryDreamsAutomation.mockClear();

    const previous = { ...baseSettings };
    const next = {
      ...previous,
      memoryDreamsSchedule: "0 */8 * * *",
    };

    await mockStore.emitSettingsUpdated(next, previous);

    expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("does not re-sync memory dreams automation on unrelated settings changes", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1));
    mocks.syncMemoryDreamsAutomation.mockClear();

    const previous = { ...baseSettings };
    const next = {
      ...previous,
      pollIntervalMs: 30_000,
    };

    await mockStore.emitSettingsUpdated(next, previous);

    expect(mocks.syncMemoryDreamsAutomation).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("logs warning and continues startup when memory dreams startup sync fails", async () => {
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});
    mocks.syncMemoryDreamsAutomation.mockRejectedValueOnce(new Error("dream startup sync failed"));

    const engine = createEngine();

    await expect(engine.start()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Memory dreams automation startup sync failed"),
    ));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Memory dreams automation startup sync failed"),
    );
    expect(engine.getAutomationSubsystemHealth()).toMatchObject({
      status: "degraded",
    });
    expect(engine.getCronRunner()).toBeDefined();

    await engine.stop();
    warnSpy.mockRestore();
  });

  it("catches and logs memory dreams sync failures on settings changes", async () => {
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    await vi.waitFor(() => expect(mocks.syncMemoryDreamsAutomation).toHaveBeenCalledTimes(1));
    warnSpy.mockClear();
    mocks.syncMemoryDreamsAutomation.mockRejectedValueOnce(new Error("dream settings sync failed"));

    await expect(
      mockStore.emitSettingsUpdated(
        {
          ...baseSettings,
          memoryDreamsEnabled: true,
        },
        {
          ...baseSettings,
          memoryDreamsEnabled: false,
        },
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to sync memory maintenance automation"),
    );

    await engine.stop();
    warnSpy.mockRestore();
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
    mocks.runAiMerge.mockImplementationOnce(async (...args: unknown[]) => {
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
      expect(mocks.runAiMerge).toHaveBeenCalledTimes(1);
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

    const mergeCallsBeforeRequeue = mocks.runAiMerge.mock.calls.length;
    engine.enqueueMerge("FN-after-stop");
    expect(privateEngine.mergeQueue).toHaveLength(0);
    expect(mocks.runAiMerge).toHaveBeenCalledTimes(mergeCallsBeforeRequeue);
  });
});

describe("ProjectEngine manual merge plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-5438",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: "queued",
    } as any);
    mocks.currentStore = mockStore.store;
  });

  it("passes manual=true to runAiMerge for onMerge requests", async () => {
    mocks.runAiMerge.mockResolvedValue({ merged: true, task: { id: "FN-5438" } } as any);

    const engine = createEngine();
    await engine.start();

    await engine.onMerge("FN-5438");

    expect(mocks.runAiMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "FN-5438",
      expect.objectContaining({ manual: true }),
    );

    await engine.stop();
  });
});

// FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 made runAiMerge the
// sole merge path. These tests pin the unified dispatch: every merger.mode value
// routes to runAiMerge, "deterministic" warns exactly once (never errors), and
// the R7 workspace guard rejects populated-workspaceWorktrees tasks at the engine
// merge entry point before any merge runs.
describe("ProjectEngine U0 merge unification dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // FNXC:MergerUnification 2026-06-21-19:05: the deterministic-mode deprecation
    // warning is gated by a per-project module-level ledger. Reset it before each
    // test so the once-per-project-per-process assertion is deterministic regardless
    // of which sibling test populated the ledger first (createEngine always uses the
    // same project root, so without this a prior deterministic merge would suppress
    // the warning here and the "fires once" test would see zero emissions).
    __resetDeterministicMergerModeDeprecationWarned();
  });

  async function runOnMergeWithMode(mode: string | undefined) {
    const settings = { ...baseSettings, autoMerge: true } as Record<string, unknown>;
    if (mode === undefined) {
      delete settings.merger;
    } else {
      settings.merger = { mode };
    }
    const mockStore = createMockStore(settings);
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-U0",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: "queued",
    } as any);
    mocks.currentStore = mockStore.store;
    mocks.runAiMerge.mockResolvedValue({ merged: true, task: { id: "FN-U0" } } as any);

    const engine = createEngine();
    await engine.start();
    await engine.onMerge("FN-U0");
    await engine.stop();
  }

  it.each([
    ["unset", undefined],
    ["ai", "ai"],
    ["deterministic", "deterministic"],
  ])("routes merger.mode=%s to runAiMerge (never aiMergeTask)", async (_label, mode) => {
    await runOnMergeWithMode(mode as string | undefined);
    expect(mocks.runAiMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "FN-U0",
      expect.anything(),
    );
  });

  it('logs the merger.mode "deterministic" deprecation warning exactly once per project per process (warn, not error)', async () => {
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const deprecationWarnings = () =>
      warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("merger.mode") && String(call[0]).includes("deprecated"),
      );
    try {
      // First deterministic merge: the warning must fire EXACTLY once.
      await runOnMergeWithMode("deterministic");
      expect(deprecationWarnings()).toHaveLength(1);

      // A SECOND deterministic merge in the same process (same project root) must
      // NOT warn again — the per-project ledger suppresses the repeat. Total stays 1.
      await runOnMergeWithMode("deterministic");
      expect(deprecationWarnings()).toHaveLength(1);

      // The warning is a warn (never an error), and the merge still proceeds via
      // runAiMerge despite the deprecated value.
      expect(deprecationWarnings()).toHaveLength(1);
      expect(mocks.runAiMerge).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // FNXC:Workspace 2026-06-22-05:10 (Phase C U1/U2 routing — supersedes the old R7 throw test):
  // A workspace-mode task no longer throws WorkspaceTaskMergeError at the engine dispatch; it
  // ROUTES to the per-repo land loop `landWorkspaceTask` (runAiMerge's R7 chokepoint stays as
  // defense-in-depth but is not the primary path). On a full land, the merge reports merged=true.
  it("routes a workspace-mode task to landWorkspaceTask (not runAiMerge) on full land", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-WS",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: "queued",
      branch: "fusion/fn-ws",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-ws-a" },
        "repo-b": { worktreePath: "/tmp/b", branch: "fusion/fn-ws-b" },
      },
    } as any);
    mocks.currentStore = mockStore.store;
    mocks.landWorkspaceTask.mockResolvedValue({
      allLanded: true,
      repos: [
        { repo: "repo-a", status: "landed", landedSha: "aaaa1111", integrationBranch: "main" },
        { repo: "repo-b", status: "landed", landedSha: "bbbb2222", integrationBranch: "main" },
      ],
    } as any);

    const engine = createEngine();
    await engine.start();
    const result = await engine.onMerge("FN-WS");
    expect(mocks.landWorkspaceTask).toHaveBeenCalled();
    expect(mocks.runAiMerge).not.toHaveBeenCalled();
    expect(result.merged).toBe(true);
    await engine.stop();
  });

  // FNXC:Workspace 2026-07-05-00:00 (FN-7610):
  // A workspace-mode task must route to landWorkspaceTask EVEN WHEN the project
  // is configured with mergeStrategy:"pull-request" (getMergeStrategy resolves
  // "pull-request") — the engine dispatch hoists an isWorkspaceTask check before
  // the mergeStrategy branch so processPullRequestMerge (which would call
  // getCurrentRepo against the non-git workspace root and throw "could not
  // determine repository") is never reached for workspace tasks. Covers
  // multi-repo, single-repo, and true-zero-commit no-op variants, plus asserts
  // no regression to the legacy singular-worktree PR path.
  describe("workspace tasks bypass PR-merge strategy (FN-7610)", () => {
    it("multi-repo workspaceWorktrees + mergeStrategy=pull-request routes to landWorkspaceTask, never processPullRequestMerge", async () => {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mockStore.store.getTask.mockResolvedValue({
        id: "FN-WS-PR-MULTI",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: "queued",
        branch: "fusion/fn-ws-pr-multi",
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-ws-pr-multi-a" },
          "repo-b": { worktreePath: "/tmp/b", branch: "fusion/fn-ws-pr-multi-b" },
        },
      } as any);
      mocks.currentStore = mockStore.store;
      mocks.landWorkspaceTask.mockResolvedValue({
        allLanded: true,
        repos: [
          { repo: "repo-a", status: "landed", landedSha: "aaaa1111", integrationBranch: "main" },
          { repo: "repo-b", status: "landed", landedSha: "bbbb2222", integrationBranch: "main" },
        ],
      } as any);

      const processPullRequestMerge = vi.fn(async () => "merged" as const);
      const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
      await engine.start();
      const result = await engine.onMerge("FN-WS-PR-MULTI");
      expect(processPullRequestMerge).not.toHaveBeenCalled();
      expect(mocks.landWorkspaceTask).toHaveBeenCalled();
      expect(result.merged).toBe(true);
      await engine.stop();
    });

    it("single-key workspaceWorktrees + mergeStrategy=pull-request routes to landWorkspaceTask, never processPullRequestMerge", async () => {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mockStore.store.getTask.mockResolvedValue({
        id: "FN-WS-PR-SINGLE",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: "queued",
        branch: "fusion/fn-ws-pr-single",
        workspaceWorktrees: {
          "repo-c": { worktreePath: "/tmp/c", branch: "fusion/fn-ws-pr-single-c" },
        },
      } as any);
      mocks.currentStore = mockStore.store;
      mocks.landWorkspaceTask.mockResolvedValue({
        allLanded: true,
        repos: [{ repo: "repo-c", status: "landed", landedSha: "cccc3333", integrationBranch: "main" }],
      } as any);

      const processPullRequestMerge = vi.fn(async () => "merged" as const);
      const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
      await engine.start();
      const result = await engine.onMerge("FN-WS-PR-SINGLE");
      expect(processPullRequestMerge).not.toHaveBeenCalled();
      expect(mocks.landWorkspaceTask).toHaveBeenCalled();
      expect(result.merged).toBe(true);
      await engine.stop();
    });

    it("true-zero-commit no-op workspace task under mergeStrategy=pull-request finalizes without calling processPullRequestMerge and does not park failed", async () => {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mockStore.store.getTask.mockResolvedValue({
        id: "FN-WS-PR-NOOP",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: "queued",
        branch: "fusion/fn-ws-pr-noop",
        noCommitsExpected: true,
        workspaceWorktrees: {
          "repo-d": { worktreePath: "/tmp/d", branch: "fusion/fn-ws-pr-noop-d" },
        },
      } as any);
      mocks.currentStore = mockStore.store;
      // All repos land with no real commit (empty/no-op) — landWorkspaceTask still
      // reports allLanded:true and finalizes gracefully.
      mocks.landWorkspaceTask.mockResolvedValue({
        allLanded: true,
        repos: [{ repo: "repo-d", status: "empty", integrationBranch: "main" }],
      } as any);

      const processPullRequestMerge = vi.fn(async () => "merged" as const);
      const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
      await engine.start();
      const result = await engine.onMerge("FN-WS-PR-NOOP");
      expect(processPullRequestMerge).not.toHaveBeenCalled();
      expect(mocks.landWorkspaceTask).toHaveBeenCalled();
      expect(result.ok).not.toBe(false);
      await engine.stop();
    });

    it("non-workspace task under mergeStrategy=pull-request still uses the PR path (no regression)", async () => {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mockStore.store.getTask
        .mockResolvedValueOnce({
          id: "FN-WS-PR-LEGACY",
          column: "in-review",
          paused: false,
          mergeRetries: 0,
          status: null,
          branch: "fusion/fn-ws-pr-legacy",
        })
        .mockResolvedValue({
          id: "FN-WS-PR-LEGACY",
          column: "done",
          paused: false,
          mergeRetries: 0,
          status: null,
          branch: "fusion/fn-ws-pr-legacy",
          mergeDetails: { mergeConfirmed: true, mergedAt: "2026-07-05T00:00:00.000Z", mergeTargetBranch: "main" },
        });
      mocks.currentStore = mockStore.store;

      const processPullRequestMerge = vi.fn(async () => "merged" as const);
      const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
      await engine.start();
      engine.enqueueMerge("FN-WS-PR-LEGACY");

      await vi.waitFor(() => {
        expect(processPullRequestMerge).toHaveBeenCalled();
      });
      expect(mocks.landWorkspaceTask).not.toHaveBeenCalled();

      await engine.stop();
    });
  });
});

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B1/B2/B4/B5):
Merge DISPATCH hardening for workspace tasks. These drive the REAL ProjectEngine dispatch
catch via the mocked merger-ai seam (landWorkspaceTask + the real-shaped error classes),
asserting the failure modes the review flagged: fail-closed on getTask null (B1), the
merge-confirmed reachability fast-path skipping workspace tasks (B2), busy-contention not
burning the merge-retry quota (B4), and the capped backoff (B5). No real AI, no real git
for the fast-path (the gate's git is asserted NOT to run for workspace tasks).
*/
describe("ProjectEngine workspace merge dispatch hardening (Phase C review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const workspaceTask = (overrides: Record<string, unknown> = {}) => ({
    id: "FN-WSH",
    column: "in-review",
    paused: false,
    mergeRetries: 0,
    status: "queued",
    branch: "fusion/fn-wsh",
    workspaceWorktrees: {
      "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-wsh-a" },
    },
    ...overrides,
  });

  // B1: getTask returning null in the partial-land catch must FAIL CLOSED — no retry timer.
  it("B1: partial land with getTask null fails closed (parks failed, no retry timer)", async () => {
    vi.useFakeTimers();
    try {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      // FNXC:Workspace 2026-07-07-08:30 (FN-7610 regression):
      // FN-7610 hoisted an isWorkspaceTask getTask read (mergeCandidate) into the
      // dispatch ahead of landWorkspaceTask. A fixed mockResolvedValueOnce(2x)+null
      // sequence no longer lands the null on the catch read — an earlier routing read
      // consumes it and the workspace task never reaches landWorkspaceTask, so the
      // WorkspacePartialLandError catch (and its fail-closed updateTask) never runs.
      // Flip a flag inside the landWorkspaceTask mock and return the workspace task from
      // getTask until that flag is set, so the null lands deterministically on the
      // catch-block read (DB outage) regardless of how many routing reads precede the throw.
      let landInvoked = false;
      mocks.landWorkspaceTask.mockImplementation(async () => {
        landInvoked = true;
        throw new WorkspacePartialLandError(0, ["repo-a"], "Workspace partial land for FN-WSH: 0 landed, 1 failed");
      });
      mocks.currentStore = mockStore.store;
      // getTask is typed to return a workspace task Record, but the real TaskStore
      // signature yields Task | null; cast through unknown so the DB-outage null is
      // expressible without `any`.
      mockStore.store.getTask.mockImplementation(async () =>
        (landInvoked ? null : workspaceTask()) as unknown as Record<string, unknown>,
      );

      const engine = createEngine();
      await engine.start();
      const enqueueSpy = vi.spyOn(
        engine as unknown as { internalEnqueueMerge: (id: string) => void },
        "internalEnqueueMerge",
      );
      engine.enqueueMerge("FN-WSH");

      // Drain microtasks until the catch parks the task (fail-closed path).
      await vi.waitFor(
        () => {
          expect(mockStore.store.updateTask).toHaveBeenCalledWith(
            "FN-WSH",
            expect.objectContaining({ status: "failed" }),
          );
        },
        { timeout: 2000, interval: 5 },
      );

      // No retry timer was scheduled, and no re-enqueue happened: advancing all timers
      // must not trigger another internalEnqueueMerge.
      enqueueSpy.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(enqueueSpy).not.toHaveBeenCalled();
      // It must NOT have incremented mergeRetries (it couldn't even read the row).
      expect(mockStore.store.updateTask).not.toHaveBeenCalledWith(
        "FN-WSH",
        expect.objectContaining({ mergeRetries: expect.anything(), status: null }),
      );

      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // B2: a merged workspace task (mergeConfirmed + sub-repo commitSha) must SKIP the root-cwd
  // reachability fast-path so it is finalized, not demoted/parked.
  it("B2: merge-confirmed workspace task skips the root-cwd reachability gate (not demoted)", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue(
      workspaceTask({
        status: null,
        mergeDetails: {
          mergeConfirmed: true,
          // A sub-repo squash sha — unreachable from the workspace ROOT cwd; the gate would
          // (wrongly) clear mergeConfirmed and demote the task if it ran here.
          commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          mergeTargetBranch: "main",
          mergedAt: "2026-06-22T00:00:00.000Z",
        },
      }) as any,
    );
    mockStore.store.moveTask.mockResolvedValue(
      workspaceTask({ column: "done" }) as any,
    );
    mocks.currentStore = mockStore.store;
    // If the gate ran, it would invoke `git cat-file`. Make any git call fail so a gate
    // run would be observable (and would demote). We assert it is NOT called.
    mocks.execFile.mockImplementation((
      _file: string,
      _args: string[],
      optionsOrCb: unknown,
      callback?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = (typeof optionsOrCb === "function" ? optionsOrCb : callback) as (
        e: Error | null,
        r: { stdout: string; stderr: string },
      ) => void;
      cb(new Error("git should not be called for workspace fast-path"), { stdout: "", stderr: "" });
      return {} as never;
    });

    const engine = createEngine();
    await engine.start();
    engine.enqueueMerge("FN-WSH");

    await vi.waitFor(() => {
      expect(mockStore.store.emit).toHaveBeenCalledWith(
        "task:merged",
        expect.objectContaining({ merged: true }),
      );
    });

    // The reachability gate's `git cat-file` must NOT have run (workspace skip).
    const gitCatFileCalls = (mocks.execFile.mock.calls as Array<[string, string[]]>).filter(
      (c) => Array.isArray(c[1]) && c[1][0] === "cat-file",
    );
    expect(gitCatFileCalls).toHaveLength(0);
    // The task must NOT have been demoted (mergeConfirmed cleared / status failed).
    expect(mockStore.store.updateTask).not.toHaveBeenCalledWith(
      "FN-WSH",
      expect.objectContaining({ status: "failed" }),
    );
    await engine.stop();
  });

  // B4 + B5: repeated WorkspaceRepoLandBusyError re-enqueues with capped backoff WITHOUT
  // consuming mergeRetries (pure contention does not park a never-failed task).
  it("B4/B5: busy contention re-enqueues with capped backoff, never burns mergeRetries", async () => {
    vi.useFakeTimers();
    try {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mockStore.store.getTask.mockResolvedValue(workspaceTask() as any);
      mocks.currentStore = mockStore.store;
      mocks.landWorkspaceTask.mockRejectedValue(
        new WorkspaceRepoLandBusyError("repo-a", "FN-OTHER", "FN-WSH"),
      );

      const engine = createEngine();
      await engine.start();
      const enqueueSpy = vi.spyOn(
        engine as unknown as { internalEnqueueMerge: (id: string) => void },
        "internalEnqueueMerge",
      );
      engine.enqueueMerge("FN-WSH");

      // The busy catch logs a WorkspaceRepoLandBusy entry then schedules a backoff timer.
      await vi.waitFor(
        () => {
          expect(mockStore.store.logEntry).toHaveBeenCalledWith(
            "FN-WSH",
            expect.stringContaining("busy"),
            "WorkspaceRepoLandBusy",
          );
        },
        { timeout: 2000, interval: 5 },
      );

      // It must NOT have written any mergeRetries increment (busy ≠ real failure).
      const burnedRetries = (mockStore.store.updateTask.mock.calls as Array<[string, Record<string, unknown>]>)
        .some((c) => c[0] === "FN-WSH" && typeof c[1]?.mergeRetries === "number");
      expect(burnedRetries).toBe(false);

      /*
      FNXC:Workspace 2026-06-22-09:30 (Phase C review B5b — assert the 60s CAP, not just the first retry):
      Advancing 60s once only proves the first 5s timer fired; an UNcapped exponential
      (5s,10s,20s,40s,80s,160s,…) would still pass that. Capture EVERY scheduled busy backoff delay
      across enough cycles to pass the cap point (busyCount=4 → 5000*2^4 = 80_000ms, clamped to 60_000)
      and assert no delay exceeds 60_000 AND the cap is actually reached. Each advance fires the pending
      timer → re-enqueue → landWorkspaceTask rejects busy again → next backoff is scheduled.
      */
      const scheduledBusyDelays: number[] = [];
      // `globalThis.setTimeout` is already the fake-timer impl here (vi.useFakeTimers above).
      // Wrap it to record the requested delay, then delegate to the SAME fake timer so the
      // fake clock still drives the callback — no real-timer leakage.
      const fakeSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
          if (typeof ms === "number") scheduledBusyDelays.push(ms);
          return (fakeSetTimeout as (...a: unknown[]) => unknown)(cb, ms, ...rest);
        }) as typeof setTimeout);

      try {
        // Drive enough busy cycles to climb past the cap point (busyCount 0..5 = 6 cycles).
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(60_000);
        }
      } finally {
        setTimeoutSpy.mockRestore();
      }

      // The exponential climbed (more than one distinct delay) AND every delay is capped at 60s.
      expect(scheduledBusyDelays.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...scheduledBusyDelays)).toBe(60_000);
      expect(scheduledBusyDelays.every((d) => d <= 60_000)).toBe(true);
      // The cap was actually exercised: at least one delay sits at the 60s ceiling.
      expect(scheduledBusyDelays).toContain(60_000);
      // Each fired backoff re-enqueued the merge (the contention retry loop is live).
      expect(enqueueSpy).toHaveBeenCalledWith("FN-WSH");

      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProjectEngine merge queue priority ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges higher-priority tasks before lower-priority ones regardless of enqueue order", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    const tasksById: Record<string, Record<string, unknown>> = {
      "FN-low": {
        id: "FN-low",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "low",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
      "FN-urgent": {
        id: "FN-urgent",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "urgent",
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      "FN-normal": {
        id: "FN-normal",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "normal",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    };
    mockStore.store.getTask.mockImplementation(async (id: string) => tasksById[id] ?? null);
    mocks.currentStore = mockStore.store;

    const mergeOrder: string[] = [];
    mocks.runAiMerge.mockImplementation(async (...args: unknown[]) => {
      mergeOrder.push(args[2] as string);
      return { merged: true } as never;
    });

    const engine = createEngine();
    await engine.start();

    // Enqueue lowest priority first, urgent last. Priority-aware dequeue must
    // still surface FN-urgent before FN-normal regardless of enqueue order.
    engine.enqueueMerge("FN-low");
    engine.enqueueMerge("FN-normal");
    engine.enqueueMerge("FN-urgent");

    await vi.waitFor(() => {
      expect(mergeOrder).toHaveLength(3);
    });

    // FN-low may merge first if drainMergeQueue picked it up before the other
    // enqueues landed (single-item fast path). The contract is that once 2+
    // tasks are queued together, the higher-priority one wins — so FN-urgent
    // (enqueued last) must merge before FN-normal (enqueued before it).
    const urgentIdx = mergeOrder.indexOf("FN-urgent");
    const normalIdx = mergeOrder.indexOf("FN-normal");
    expect(urgentIdx).toBeGreaterThanOrEqual(0);
    expect(normalIdx).toBeGreaterThanOrEqual(0);
    expect(urgentIdx).toBeLessThan(normalIdx);

    await engine.stop();
  });

  it("startup sweep merges higher-priority tasks first even though listTasks returns oldest-first", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    // Tasks returned in createdAt ASC order (matches store.listTasks contract).
    // Priority order is interleaved so a naive iteration would merge FN-low
    // first; priority-aware sorting must reorder to urgent → normal → low.
    const sweptTasks = [
      {
        id: "FN-low",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "low",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "FN-urgent",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "urgent",
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      {
        id: "FN-normal",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        priority: "normal",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ];
    const tasksById: Record<string, Record<string, unknown>> = Object.fromEntries(
      sweptTasks.map((t) => [t.id, t]),
    );
    mockStore.store.listTasks.mockResolvedValue(sweptTasks);
    mockStore.store.getTask.mockImplementation(async (id: string) => tasksById[id] ?? null);
    mocks.currentStore = mockStore.store;

    const mergeOrder: string[] = [];
    mocks.runAiMerge.mockImplementation(async (...args: unknown[]) => {
      mergeOrder.push(args[2] as string);
      return { merged: true } as never;
    });

    const engine = createEngine();
    await engine.start();

    await vi.waitFor(() => {
      expect(mergeOrder).toHaveLength(3);
    });

    expect(mergeOrder).toEqual(["FN-urgent", "FN-normal", "FN-low"]);

    await engine.stop();
  });

  // Direct unit-tests of pickNextMergeTaskId to exercise the multi-item
  // priority path with concurrent queue mutations during getTask awaits.
  // These are unreachable through enqueueMerge alone because the first
  // enqueue always takes the single-item fast path.
  it("picker falls back to next-priority task when the chosen one is removed from the queue during getTask awaits", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    const tasksById: Record<string, Record<string, unknown>> = {
      "FN-urgent": { id: "FN-urgent", column: "in-review", paused: false, mergeRetries: 0, status: null, priority: "urgent", createdAt: "2026-04-01T00:00:00.000Z" },
      "FN-normal-a": { id: "FN-normal-a", column: "in-review", paused: false, mergeRetries: 0, status: null, priority: "normal", createdAt: "2026-04-02T00:00:00.000Z" },
      "FN-normal-b": { id: "FN-normal-b", column: "in-review", paused: false, mergeRetries: 0, status: null, priority: "normal", createdAt: "2026-04-03T00:00:00.000Z" },
    };

    let releaseUrgent: (() => void) = () => {};
    const urgentHeld = new Promise<void>((resolve) => {
      releaseUrgent = resolve;
    });
    let urgentRequested = false;
    mockStore.store.getTask.mockImplementation(async (id: string) => {
      if (id === "FN-urgent") {
        urgentRequested = true;
        await urgentHeld;
      }
      return tasksById[id] ?? null;
    });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      pickNextMergeTaskId: (store: unknown) => Promise<string | undefined>;
    };

    privateEngine.mergeQueue = ["FN-urgent", "FN-normal-a", "FN-normal-b"];
    privateEngine.mergeActive = new Set(["FN-urgent", "FN-normal-a", "FN-normal-b"]);

    const pickPromise = privateEngine.pickNextMergeTaskId(mockStore.store);

    await vi.waitFor(() => {
      expect(urgentRequested).toBe(true);
    });

    // Simulate pause-handler removing FN-urgent mid-pick.
    privateEngine.mergeQueue = privateEngine.mergeQueue.filter((id) => id !== "FN-urgent");
    privateEngine.mergeActive.delete("FN-urgent");

    releaseUrgent();
    const chosen = await pickPromise;

    // FN-urgent was yanked; picker must fall back to next-priority survivor.
    // Both surviving tasks are "normal"; FN-normal-a wins by older createdAt.
    expect(chosen).toBe("FN-normal-a");
    expect(privateEngine.mergeQueue).toEqual(["FN-normal-b"]);

    await engine.stop();
  });

  it("picker returns undefined when shutdown lands during getTask awaits", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    const tasksById: Record<string, Record<string, unknown>> = {
      "FN-a": { id: "FN-a", column: "in-review", paused: false, mergeRetries: 0, status: null, priority: "high", createdAt: "2026-04-01T00:00:00.000Z" },
      "FN-b": { id: "FN-b", column: "in-review", paused: false, mergeRetries: 0, status: null, priority: "normal", createdAt: "2026-04-02T00:00:00.000Z" },
    };

    let release: (() => void) = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCallSeen = false;
    mockStore.store.getTask.mockImplementation(async (id: string) => {
      if (!firstCallSeen) {
        firstCallSeen = true;
        await held;
      }
      return tasksById[id] ?? null;
    });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      shuttingDown: boolean;
      pickNextMergeTaskId: (store: unknown) => Promise<string | undefined>;
    };

    privateEngine.mergeQueue = ["FN-a", "FN-b"];
    privateEngine.mergeActive = new Set(["FN-a", "FN-b"]);

    const pickPromise = privateEngine.pickNextMergeTaskId(mockStore.store);

    await vi.waitFor(() => {
      expect(firstCallSeen).toBe(true);
    });

    // Simulate shutdown while picker is awaiting getTask.
    privateEngine.shuttingDown = true;
    privateEngine.mergeQueue = [];

    release();
    const chosen = await pickPromise;

    expect(chosen).toBeUndefined();

    // Reset so engine.stop() teardown runs cleanly.
    privateEngine.shuttingDown = false;
    await engine.stop();
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

  it("emits task:merged when mergeConfirmed fast-path finalizes to done", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValueOnce({
      id: "FN-merged",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
      branch: "fusion/fn-merged",
      mergeDetails: { mergeConfirmed: true, mergedAt: "2026-05-18T00:00:00.000Z", mergeTargetBranch: "main" },
    });
    mockStore.store.moveTask.mockResolvedValueOnce({
      id: "FN-merged",
      column: "done",
      branch: "fusion/fn-merged",
      mergeDetails: { mergeConfirmed: true, mergedAt: "2026-05-18T00:00:00.000Z", mergeTargetBranch: "main" },
    } as any);
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    engine.enqueueMerge("FN-merged");

    await vi.waitFor(() => {
      expect(mockStore.store.emit).toHaveBeenCalledWith(
        "task:merged",
        expect.objectContaining({
          merged: true,
          task: expect.objectContaining({ id: "FN-merged", column: "done" }),
        }),
      );
    });

    await engine.stop();
  });

  it("FN-5627: auto-recovers fast-path refusal by clearing poisoned mergeDetails + re-enqueueing (mergeRetries < budget)", async () => {
    // Repro for the FN-5625/FN-5623 false-positive done class: the merger
    // has a TOCTOU between writing `mergeConfirmed: true` and `git update-ref`
    // succeeding. When the ref-advance fails after the optimistic write, the
    // task row is poisoned. The gate detects this, clears the lies, and
    // re-enqueues for a fresh aiMergeTask attempt — no human intervention
    // required as long as the retry budget isn't exhausted.
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValueOnce({
      id: "FN-poisoned",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
      branch: "fusion/fn-poisoned",
      baseBranch: "main",
      mergeDetails: {
        mergeConfirmed: true,
        commitSha: "abc123abc123abc123abc123abc123abc1234567",
        mergeTargetBranch: "main",
        mergedAt: "2026-05-28T19:34:17.022Z",
        landedFiles: ["packages/foo/bar.ts"],
        filesChanged: 1,
        insertions: 10,
        deletions: 2,
      },
    });
    mocks.currentStore = mockStore.store;

    // Simulate the gate: `git cat-file -e` succeeds (commit exists locally
    // on the orphan task branch), but `git merge-base --is-ancestor` fails
    // with exit code 1 (commit is NOT reachable from main).
    mocks.execFile.mockImplementation((
      _file: string,
      args: string[],
      _options: unknown,
      callback?: (error: (Error & { code?: number }) | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = (typeof _options === "function" ? _options : callback) as (
        error: (Error & { code?: number }) | null,
        result: { stdout: string; stderr: string },
      ) => void;
      if (args[0] === "cat-file") {
        cb(null, { stdout: "", stderr: "" });
        return {} as never;
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        const err = new Error("Command failed: git merge-base --is-ancestor") as Error & { code?: number };
        err.code = 1;
        cb(err, { stdout: "", stderr: "" });
        return {} as never;
      }
      // Default success for any other git call.
      cb(null, { stdout: "/usr/bin/mock\n", stderr: "" });
      return {} as never;
    });

    const engine = createEngine();
    await engine.start();
    engine.enqueueMerge("FN-poisoned");

    // Auto-recovery path: the task row is updated with cleared poisoned
    // fields, mergeRetries incremented, status null (NOT failed).
    await vi.waitFor(() => {
      const calls = (mockStore.store.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      const recoveryCall = calls.find((call) =>
        call[0] === "FN-poisoned"
        && call[1]?.mergeRetries === 1
        && call[1]?.status === null,
      );
      expect(recoveryCall).toBeDefined();
      const updates = recoveryCall![1] as {
        mergeDetails?: {
          mergeConfirmed?: boolean;
          commitSha?: string;
          mergedAt?: string;
          landedFiles?: string[];
          filesChanged?: number;
        };
      };
      // Poisoned fields cleared.
      expect(updates.mergeDetails?.mergeConfirmed).toBe(false);
      expect(updates.mergeDetails?.commitSha).toBeUndefined();
      expect(updates.mergeDetails?.mergedAt).toBeUndefined();
      expect(updates.mergeDetails?.landedFiles).toBeUndefined();
      expect(updates.mergeDetails?.filesChanged).toBeUndefined();
    });

    // Critical invariant: status is NOT failed (this is auto-recoverable).
    const failedCall = (mockStore.store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => call[0] === "FN-poisoned" && (call[1] as { status?: string })?.status === "failed");
    expect(failedCall).toBeUndefined();

    // moveTask("done") was NOT called (no false-positive completion).
    expect(mockStore.store.moveTask).not.toHaveBeenCalledWith("FN-poisoned", "done");
    // task:merged was NOT emitted for the poisoned task.
    const emitCalls = (mockStore.store.emit as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, { task?: { id: string } }]>;
    const mergedCalls = emitCalls.filter((call) => call[0] === "task:merged");
    const poisonedEmit = mergedCalls.find((call) => call[1]?.task?.id === "FN-poisoned");
    expect(poisonedEmit).toBeUndefined();

    await engine.stop();
  });

  it("FN-5627: fast-path refusal parks task as failed when mergeRetries budget is exhausted", async () => {
    // When auto-recovery has already cycled through 3 attempts without
    // landing, the next refusal is terminal. The task is parked with
    // status=failed for manual review, with no further re-enqueue. The
    // downstream FN-5488 fast-path on `clearStaleBlockedBy` recognizes this
    // as a permanent blocker so dependents aren't held forever.
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValueOnce({
      id: "FN-exhausted",
      column: "in-review",
      paused: false,
      mergeRetries: 3, // already at budget
      status: null,
      branch: "fusion/fn-exhausted",
      baseBranch: "main",
      mergeDetails: {
        mergeConfirmed: true,
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        mergeTargetBranch: "main",
        mergedAt: "2026-05-28T19:34:17.022Z",
      },
    });
    mocks.currentStore = mockStore.store;

    mocks.execFile.mockImplementation((
      _file: string,
      args: string[],
      _options: unknown,
      callback?: (error: (Error & { code?: number }) | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = (typeof _options === "function" ? _options : callback) as (
        error: (Error & { code?: number }) | null,
        result: { stdout: string; stderr: string },
      ) => void;
      if (args[0] === "cat-file") {
        cb(null, { stdout: "", stderr: "" });
        return {} as never;
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        const err = new Error("Command failed: git merge-base --is-ancestor") as Error & { code?: number };
        err.code = 1;
        cb(err, { stdout: "", stderr: "" });
        return {} as never;
      }
      cb(null, { stdout: "/usr/bin/mock\n", stderr: "" });
      return {} as never;
    });

    const engine = createEngine();
    await engine.start();
    engine.enqueueMerge("FN-exhausted");

    await vi.waitFor(() => {
      const calls = (mockStore.store.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      const terminalCall = calls.find((call) =>
        call[0] === "FN-exhausted"
        && call[1]?.status === "failed"
        && typeof call[1]?.error === "string"
        && /retry budget exhausted|after 3 attempts/.test(call[1].error as string),
      );
      expect(terminalCall).toBeDefined();
      const updates = terminalCall![1] as { mergeDetails?: { mergeConfirmed?: boolean; commitSha?: string } };
      expect(updates.mergeDetails?.mergeConfirmed).toBe(false);
      expect(updates.mergeDetails?.commitSha).toBeUndefined();
    });

    expect(mockStore.store.moveTask).not.toHaveBeenCalledWith("FN-exhausted", "done");

    await engine.stop();
  });

  it("FN-5627: fast-path still works when mergeConfirmed has no commitSha (verified-no-op path)", async () => {
    // Legitimate no-op merges have mergeConfirmed=true with no commitSha
    // (verified-short-circuit / proven-no-op / already-on-main paths). The
    // reachability gate must not break those.
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValueOnce({
      id: "FN-noop",
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
      branch: "fusion/fn-noop",
      mergeDetails: {
        mergeConfirmed: true,
        noOpMerge: true,
        mergedAt: "2026-05-28T19:34:17.022Z",
        mergeTargetBranch: "main",
        // No commitSha — verified no-op.
      },
    });
    mockStore.store.moveTask.mockResolvedValueOnce({
      id: "FN-noop",
      column: "done",
      branch: "fusion/fn-noop",
      mergeDetails: {
        mergeConfirmed: true,
        noOpMerge: true,
        mergedAt: "2026-05-28T19:34:17.022Z",
        mergeTargetBranch: "main",
      },
    } as any);
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    await engine.start();
    engine.enqueueMerge("FN-noop");

    await vi.waitFor(() => {
      expect(mockStore.store.emit).toHaveBeenCalledWith(
        "task:merged",
        expect.objectContaining({
          merged: true,
          task: expect.objectContaining({ id: "FN-noop", column: "done" }),
        }),
      );
    });

    await engine.stop();
  });

  it("emits task:merged when PR merge strategy returns merged", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask
      .mockResolvedValueOnce({
        id: "FN-pr",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        branch: "fusion/fn-pr",
      })
      .mockResolvedValue({
        id: "FN-pr",
        column: "done",
        paused: false,
        mergeRetries: 0,
        status: null,
        branch: "fusion/fn-pr",
        mergeDetails: { mergeConfirmed: true, mergedAt: "2026-05-18T00:00:00.000Z", mergeTargetBranch: "main" },
      });
    mocks.currentStore = mockStore.store;

    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
    await engine.start();
    engine.enqueueMerge("FN-pr");

    await vi.waitFor(() => {
      expect(mockStore.store.emit).toHaveBeenCalledWith(
        "task:merged",
        expect.objectContaining({
          merged: true,
          task: expect.objectContaining({ id: "FN-pr" }),
        }),
      );
    });

    await engine.stop();
  });

  it("records an audit event (not silent) when auto-promotion of a branch-group member fails (Fix #4)", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    // The dequeued + merged task is a shared branch-group member, so the engine
    // attempts branch-group promotion after the PR merges.
    const mergedMember = {
      id: "FN-bgfail",
      column: "done",
      paused: false,
      mergeRetries: 0,
      status: null,
      branch: "fusion/fn-bgfail",
      branchContext: { groupId: "BG-FAIL-1", source: "planning", assignmentMode: "shared" },
      mergeDetails: { mergeConfirmed: true, mergedAt: "2026-06-03T00:00:00.000Z", mergeTargetBranch: "fusion/groups/x" },
    };
    mockStore.store.getTask
      .mockResolvedValueOnce({
        id: "FN-bgfail",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        branch: "fusion/fn-bgfail",
        branchContext: { groupId: "BG-FAIL-1", source: "planning", assignmentMode: "shared" },
      })
      .mockResolvedValue(mergedMember);

    const recordRunAuditEvent = vi.fn(async () => undefined);
    // Drive promoteBranchGroup into throwing: getBranchGroup returns a complete-
    // looking group, but listTasksByBranchGroup rejects, so promotion throws and
    // the engine's catch must record the failure audit instead of swallowing it.
    (mockStore.store as any).getBranchGroup = vi.fn(() => ({
      id: "BG-FAIL-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    (mockStore.store as any).getBranchGroupByBranchName = vi.fn(() => null);
    (mockStore.store as any).listTasksByBranchGroup = vi.fn(async () => {
      throw new Error("boom: store unavailable");
    });
    (mockStore.store as any).updateBranchGroup = vi.fn();
    (mockStore.store as any).recordRunAuditEvent = recordRunAuditEvent;
    mocks.currentStore = mockStore.store;

    const processPullRequestMerge = vi.fn(async () => "merged" as const);
    const engine = createEngine({ processPullRequestMerge, getMergeStrategy: () => "pull-request" });
    await engine.start();
    engine.enqueueMerge("FN-bgfail");

    await vi.waitFor(() => {
      expect(recordRunAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationType: "merge:branch-group-promotion-failed",
          target: "BG-FAIL-1",
          metadata: expect.objectContaining({ groupId: "BG-FAIL-1", taskId: "FN-bgfail" }),
        }),
      );
    });

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
    expect(mocks.runAiMerge).not.toHaveBeenCalled();

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
    mocks.runAiMerge.mockImplementationOnce(async (...args: unknown[]) => {
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
      expect(mocks.runAiMerge).toHaveBeenCalledTimes(1);
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
    const inReviewTasks = [
      { id: "FN-paused", column: "in-review", paused: true, mergeRetries: 0, status: null },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ];
    // Critical stale-status cleanup reads first; deferred startup then evaluates eligibility.
    mockStore.store.listTasks.mockResolvedValueOnce([]).mockResolvedValueOnce(inReviewTasks);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledWith("FN-ready"));

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");

    await engine.stop();
  });

  it("startup merge sweep enqueues shared-group members when autoMerge is false", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: false });
    mockStore.store.getBranchGroup.mockReturnValue({ id: "BG-5819", status: "open", branchName: "fusion/groups/bg-5819" });
    const inReviewTasks = [
      {
        id: "FN-shared",
        column: "in-review",
        paused: false,
        mergeRetries: 0,
        status: null,
        branchContext: { assignmentMode: "shared", groupId: "BG-5819", source: "planning" },
      },
      { id: "FN-plain", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ];
    // Critical stale-status cleanup reads first; deferred startup then evaluates eligibility.
    mockStore.store.listTasks.mockResolvedValueOnce([]).mockResolvedValueOnce(inReviewTasks);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledWith("FN-shared"));

    expect(enqueueSpy).toHaveBeenCalledWith("FN-shared");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-plain");

    await engine.stop();
  });

  it("task:moved handoff keeps shared members blocked by global or engine pause", async () => {
    vi.useFakeTimers();
    for (const settings of [
      { ...baseSettings, autoMerge: false, globalPause: true, enginePaused: false },
      { ...baseSettings, autoMerge: false, globalPause: false, enginePaused: true },
    ]) {
      const mockStore = createMockStore(settings);
      mocks.currentStore = mockStore.store;
      const engine = createEngine();
      const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
      const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

      await engine.start();
      enqueueSpy.mockClear();
      const movedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
        | ((event: { task: Task; to: string }) => void)
        | undefined;
      if (!movedHandler) throw new Error("task:moved handler was not registered");

      movedHandler({
        task: {
          id: "FN-shared",
          column: "in-review",
          paused: false,
          steps: [],
          branchContext: { assignmentMode: "shared", groupId: "BG-5819", source: "planning" },
        } as unknown as Task,
        to: "in-review",
      });

      await vi.advanceTimersByTimeAsync(350);
      expect(enqueueSpy).not.toHaveBeenCalledWith("FN-shared");
      await engine.stop();
    }
    vi.useRealTimers();
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

  it("periodic merge sweep does not re-enqueue failed in-review tasks", async () => {
    vi.useFakeTimers();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true, pollIntervalMs: 15_000 });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    enqueueSpy.mockClear();

    mockStore.store.listTasks.mockResolvedValueOnce([
      // Retry exhausted + failed (FN-2997 observed state after merge error)
      { id: "FN-failed", column: "in-review", paused: false, mergeRetries: 3, status: "failed", updatedAt: new Date(Date.now() - 60 * 60_000).toISOString() },
      // Failed status must block even when retries are below the cap.
      { id: "FN-failed-low-retries", column: "in-review", paused: false, mergeRetries: 0, status: "failed", updatedAt: new Date().toISOString() },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null, updatedAt: new Date().toISOString() },
    ]);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-failed");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-failed-low-retries");

    await engine.stop();
    vi.useRealTimers();
  });

  it("engine unpause sweep re-enqueues only merge-eligible in-review tasks", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine({
      getTaskMergeBlocker: (task) => (task.id === "FN-blocked" ? "blocked" : null),
    });
    const privateEngine = engine as unknown as { internalEnqueueMerge: (taskId: string) => void };
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");

    await engine.start();
    enqueueSpy.mockClear();
    mockStore.store.listTasks.mockResolvedValueOnce([
      { id: "FN-paused", column: "in-review", paused: true, mergeRetries: 0, status: null },
      { id: "FN-failed", column: "in-review", paused: false, mergeRetries: 0, status: "failed" },
      { id: "FN-blocked", column: "in-review", paused: false, mergeRetries: 0, status: null },
      { id: "FN-ready", column: "in-review", paused: false, mergeRetries: 0, status: null },
    ]);

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, enginePaused: false },
      { ...baseSettings, autoMerge: true, enginePaused: true },
    );

    expect(enqueueSpy).toHaveBeenCalledWith("FN-ready");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-paused");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-failed");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-blocked");

    await engine.stop();
  });

  it("stamps engineActiveSinceMs on global and engine unpause transitions", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    mockStore.store.updateSettings.mockClear();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false },
      { ...baseSettings, autoMerge: true, globalPause: true },
    );

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, enginePaused: false },
      { ...baseSettings, autoMerge: true, enginePaused: true },
    );

    const activationStampCalls = mockStore.store.updateSettings.mock.calls.filter(
      ([patch]) => patch && typeof patch === "object" && "engineActiveSinceMs" in patch,
    );
    expect(activationStampCalls).toHaveLength(2);
    for (const [patch] of activationStampCalls) {
      expect((patch as { engineActiveSinceMs: unknown }).engineActiveSinceMs).toEqual(expect.any(Number));
    }

    await engine.stop();
  });

  it("reconciles active timing exactly once when both pause sources clear together", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const reconcileEngineDowntimeActiveTiming = vi.fn(async () => ({ shiftedTaskIds: [], downtimeMs: 120_000 }));
    mocks.getSelfHealingManager.mockReturnValue({ reconcileEngineDowntimeActiveTiming });
    const engine = createEngine();

    await engine.start();
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: false },
      {
        ...baseSettings,
        autoMerge: true,
        globalPause: true,
        enginePaused: true,
        engineLastActiveAt: "2026-07-15T11:58:00.000Z",
      },
    );

    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenCalledTimes(1);
    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenCalledWith({
      engineLastActiveAtOverride: "2026-07-15T11:58:00.000Z",
    });
    await engine.stop();
  });

  it("waits for active-timing reconciliation before resuming agentic work", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    let resolveReconcile!: () => void;
    const reconcileEngineDowntimeActiveTiming = vi.fn(() => new Promise<{ shiftedTaskIds: string[]; downtimeMs: number }>((resolve) => {
      resolveReconcile = () => resolve({ shiftedTaskIds: ["FN-active"], downtimeMs: 120_000 });
    }));
    mocks.getSelfHealingManager.mockReturnValue({ reconcileEngineDowntimeActiveTiming });
    const engine = createEngine();
    await engine.start();

    const unpause = mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false },
      { ...baseSettings, autoMerge: true, globalPause: true, engineLastActiveAt: "2026-07-15T11:58:00.000Z" },
    );
    await vi.waitFor(() => expect(reconcileEngineDowntimeActiveTiming).toHaveBeenCalledTimes(1));
    expect(mocks.runtimeResumeAfterUnpause).not.toHaveBeenCalled();

    resolveReconcile();
    await unpause;
    expect(mocks.runtimeResumeAfterUnpause).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("reconciles once for either individual unpause, but not while another pause remains", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const reconcileEngineDowntimeActiveTiming = vi.fn(async () => ({ shiftedTaskIds: [], downtimeMs: 0 }));
    mocks.getSelfHealingManager.mockReturnValue({ reconcileEngineDowntimeActiveTiming });
    const engine = createEngine();

    await engine.start();
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: true },
      { ...baseSettings, autoMerge: true, globalPause: true, enginePaused: true },
    );
    expect(reconcileEngineDowntimeActiveTiming).not.toHaveBeenCalled();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: false },
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: true, engineLastActiveAt: "engine-only" },
    );
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: false },
      { ...baseSettings, autoMerge: true, globalPause: true, enginePaused: false, engineLastActiveAt: "global-only" },
    );

    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenCalledTimes(2);
    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenNthCalledWith(1, { engineLastActiveAtOverride: "engine-only" });
    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenNthCalledWith(2, { engineLastActiveAtOverride: "global-only" });
    await engine.stop();
  });

  it("fails soft when timing reconciliation rejects or its manager is unavailable", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const reconcileEngineDowntimeActiveTiming = vi.fn(async () => {
      throw new Error("timing unavailable");
    });
    mocks.getSelfHealingManager.mockReturnValue({ reconcileEngineDowntimeActiveTiming });
    const warn = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const engine = createEngine();
    await engine.start();
    const resume = vi.fn();
    Object.defineProperty(engine.getRuntime(), "stuckTaskDetector", { get: () => ({ resume }), configurable: true });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, enginePaused: false },
      { ...baseSettings, autoMerge: true, enginePaused: true },
    );
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to reconcile engine downtime active timing"));

    mocks.getSelfHealingManager.mockReturnValue(undefined);
    await expect(mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false },
      { ...baseSettings, autoMerge: true, globalPause: true },
    )).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    await engine.stop();
  });

  it("passes the frozen heartbeat once so paused task time is discounted once", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const startedMs = Date.parse("2026-07-15T11:50:00.000Z");
    const capturedHeartbeat = "2026-07-15T11:58:00.000Z";
    let executionStartedAt = new Date(startedMs).toISOString();
    const reconcileEngineDowntimeActiveTiming = vi.fn(async ({ engineLastActiveAtOverride }: { engineLastActiveAtOverride?: string }) => {
      const downtimeMs = Date.parse("2026-07-15T12:00:00.000Z") - Date.parse(engineLastActiveAtOverride ?? "");
      executionStartedAt = new Date(startedMs + downtimeMs).toISOString();
      return { shiftedTaskIds: ["FN-active"], downtimeMs };
    });
    mocks.getSelfHealingManager.mockReturnValue({ reconcileEngineDowntimeActiveTiming });
    const engine = createEngine();
    await engine.start();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, autoMerge: true, globalPause: false, enginePaused: false, engineLastActiveAt: "2026-07-15T12:00:00.000Z" },
      { ...baseSettings, autoMerge: true, globalPause: true, enginePaused: true, engineLastActiveAt: capturedHeartbeat },
    );

    expect(reconcileEngineDowntimeActiveTiming).toHaveBeenCalledTimes(1);
    expect(executionStartedAt).toBe("2026-07-15T11:52:00.000Z");
    await engine.stop();
  });

  it("resumes deferred startup recovery on engine unpause", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();

    await engine.start();
    mocks.runtimeResumeAfterUnpause.mockClear();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );

    expect(mocks.runtimeResumeAfterUnpause).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("calls stuck detector pause/resume hooks for enginePaused transitions", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();

    const pause = vi.fn();
    const resume = vi.fn();
    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get: () => ({ pause, resume }),
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: true },
      { ...baseSettings, enginePaused: false },
    );
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );
    expect(resume).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("calls stuck detector pause/resume hooks for globalPause transitions", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();

    const pause = vi.fn();
    const resume = vi.fn();
    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get: () => ({ pause, resume }),
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: true },
      { ...baseSettings, globalPause: false },
    );
    expect(pause).toHaveBeenCalledTimes(1);

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false },
      { ...baseSettings, globalPause: true },
    );
    expect(resume).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("does not resume stuck detector until both global and engine pause are cleared", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();

    const pause = vi.fn();
    const resume = vi.fn();
    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get: () => ({ pause, resume }),
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: true, enginePaused: true },
      { ...baseSettings, globalPause: false, enginePaused: false },
    );
    expect(pause).toHaveBeenCalledTimes(1);

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false, enginePaused: true },
      { ...baseSettings, globalPause: true, enginePaused: true },
    );
    expect(resume).not.toHaveBeenCalled();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false, enginePaused: false },
      { ...baseSettings, globalPause: false, enginePaused: true },
    );
    expect(resume).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  it("reserves stuck-detector checkNow for timeout-setting changes", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();

    const checkNow = vi.fn(async () => undefined);
    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get: () => ({ pause: vi.fn(), resume: vi.fn(), checkNow }),
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: true },
      { ...baseSettings, enginePaused: false },
    );
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: true },
      { ...baseSettings, globalPause: false },
    );
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false },
      { ...baseSettings, globalPause: true },
    );

    expect(checkNow).not.toHaveBeenCalled();

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, taskStuckTimeoutMs: 600_000 },
      { ...baseSettings, taskStuckTimeoutMs: 300_000 },
    );

    expect(checkNow).toHaveBeenCalledTimes(1);

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
    await vi.waitFor(() => expect(mockStore.store.listTasks).toHaveBeenCalledTimes(2));

    mockStore.store.getSettings.mockRejectedValueOnce(new Error("db locked"));

    const handler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
      | ((payload: { task: { id: string; column: string }; to: string }) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("task:moved handler was not registered");

    // Auto-merge enqueue runs inside a setTimeout grace period (~300ms) to
    // let the executor's finally block complete before the merger starts.
    // Use fake timers so the test doesn't actually sleep 300ms.
    vi.useFakeTimers();

    await handler({
      task: { id: "FN-001", column: "in-review" },
      to: "in-review",
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge handoff (FN-001) failed: db locked"),
    );

    await engine.stop();
  });

  it("warns when startup merge sweep fails", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    // The critical stale-status read precedes the deferred enqueue sweep.
    mockStore.store.listTasks
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("connection lost"));

    const engine = createEngine();
    await engine.start();
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-merge startup enqueue failed: connection lost"),
    ));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Auto-merge startup enqueue failed: connection lost"));

    await engine.stop();
  });

  it("warns when periodic merge sweep fails", async () => {
    vi.useFakeTimers();
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    await vi.waitFor(() => expect(mockStore.store.listTasks).toHaveBeenCalledTimes(2));
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
    await vi.waitFor(() => expect(mockStore.store.listTasks).toHaveBeenCalledTimes(2));
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

  it("warns when resumeAfterUnpause dispatch fails during global unpause", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "resumeAfterUnpause", {
      get() {
        throw new Error("resume hook broken");
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, globalPause: false },
      { ...baseSettings, globalPause: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Global unpause: failed to dispatch resumeAfterUnpause"),
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

  it("warns when resumeAfterUnpause dispatch fails during engine unpause", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "resumeAfterUnpause", {
      get() {
        throw new Error("resume hook broken");
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Engine unpause: failed to dispatch resumeAfterUnpause"),
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

  it("warns when stuck-detector pause/resume hooks throw", async () => {
    const mockStore = createMockStore(baseSettings);
    mocks.currentStore = mockStore.store;
    const engine = createEngine();
    await engine.start();
    warnSpy.mockClear();

    const runtime = engine.getRuntime() as unknown as object;
    Object.defineProperty(runtime, "stuckTaskDetector", {
      get() {
        return {
          pause: () => {
            throw new Error("pause hook failed");
          },
          resume: () => {
            throw new Error("resume hook failed");
          },
        };
      },
      configurable: true,
    });

    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: true },
      { ...baseSettings, enginePaused: false },
    );
    await mockStore.emitSettingsUpdated(
      { ...baseSettings, enginePaused: false },
      { ...baseSettings, enginePaused: true },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Engine pause: stuck detector pause hook failed"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Engine unpause: stuck detector resume hook failed"),
    );

    await engine.stop();
  });
});

describe("ProjectEngine stale mergeActive rescue (FN-3900)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("task:moved into in-review clears leaked mergeActive entry before enqueue", async () => {
    vi.useFakeTimers();

    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-leaked",
      column: "in-review",
      paused: false,
      status: null,
      mergeRetries: 0,
    });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      activeMergeTaskId: string | null;
      internalEnqueueMerge: (taskId: string) => void;
    };

    await engine.start();
    privateEngine.mergeActive = new Set(["FN-leaked"]);
    privateEngine.mergeQueue = [];
    privateEngine.activeMergeTaskId = null;

    const originalEnqueue = privateEngine.internalEnqueueMerge.bind(privateEngine);
    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge").mockImplementation((taskId: string) => {
      expect(privateEngine.mergeActive.has("FN-leaked")).toBe(false);
      return originalEnqueue(taskId);
    });
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

    const taskMovedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
      | ((payload: { task: { id: string; column: string; paused?: boolean }; to: string }) => Promise<void>)
      | undefined;
    if (!taskMovedHandler) throw new Error("task:moved handler was not registered");

    await taskMovedHandler({
      task: { id: "FN-leaked", column: "in-review", paused: false },
      to: "in-review",
    });

    await vi.advanceTimersByTimeAsync(350);

    expect(enqueueSpy).toHaveBeenCalledWith("FN-leaked");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/clearing stale mergeActive before enqueue/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("FN-leaked"));

    await engine.stop();
  });

  it("FN-4084: internalEnqueueMerge reconciles leaked mergeActive entries", async () => {
    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      activeMergeTaskId: string | null;
      mergeRunning: boolean;
      internalEnqueueMerge: (taskId: string) => void;
    };
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

    await engine.start();

    privateEngine.mergeActive = new Set(["FN-leaked2"]);
    privateEngine.mergeQueue = [];
    privateEngine.activeMergeTaskId = null;
    privateEngine.mergeRunning = true;

    privateEngine.internalEnqueueMerge("FN-leaked2");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mergeActive entry is leaked"));
    expect(privateEngine.mergeQueue).toEqual(["FN-leaked2"]);
    expect(privateEngine.mergeActive.has("FN-leaked2")).toBe(true);

    await engine.stop();
  });

  it.each([
    { scenario: "queued", mergeQueue: ["FN-live"], activeMergeTaskId: null },
    { scenario: "active", mergeQueue: [], activeMergeTaskId: "FN-live" },
  ])(
    "internalEnqueueMerge does not warn for live mergeActive entry ($scenario)",
    async ({ mergeQueue, activeMergeTaskId }) => {
      const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
      mocks.currentStore = mockStore.store;

      const engine = createEngine();
      const privateEngine = engine as unknown as {
        mergeQueue: string[];
        mergeActive: Set<string>;
        activeMergeTaskId: string | null;
        internalEnqueueMerge: (taskId: string) => void;
      };
      const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

      await engine.start();

      privateEngine.mergeActive = new Set(["FN-live"]);
      privateEngine.mergeQueue = [...mergeQueue];
      privateEngine.activeMergeTaskId = activeMergeTaskId;
      const queueBefore = [...privateEngine.mergeQueue];

      privateEngine.internalEnqueueMerge("FN-live");

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("mergeActive entry is leaked"));
      expect(privateEngine.mergeQueue).toEqual(queueBefore);

      await engine.stop();
    },
  );

  it("task:moved rescue does not clear legitimate active mergeActive entry", async () => {
    vi.useFakeTimers();

    const mockStore = createMockStore({ ...baseSettings, autoMerge: true });
    mockStore.store.getTask.mockResolvedValue({
      id: "FN-busy",
      column: "in-review",
      paused: false,
      status: null,
      mergeRetries: 0,
    });
    mocks.currentStore = mockStore.store;

    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeActive: Set<string>;
      activeMergeTaskId: string | null;
      internalEnqueueMerge: (taskId: string) => void;
    };

    await engine.start();
    privateEngine.mergeActive = new Set(["FN-busy"]);
    privateEngine.activeMergeTaskId = "FN-busy";
    privateEngine.mergeQueue = [];

    const enqueueSpy = vi.spyOn(privateEngine, "internalEnqueueMerge");
    const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => {});

    const taskMovedHandler = mockStore.store.on.mock.calls.find((c: unknown[]) => c[0] === "task:moved")?.[1] as
      | ((payload: { task: { id: string; column: string; paused?: boolean }; to: string }) => Promise<void>)
      | undefined;
    if (!taskMovedHandler) throw new Error("task:moved handler was not registered");

    await taskMovedHandler({
      task: { id: "FN-busy", column: "in-review", paused: false },
      to: "in-review",
    });

    await vi.advanceTimersByTimeAsync(350);

    expect(enqueueSpy).toHaveBeenCalledWith("FN-busy");
    expect(privateEngine.mergeActive.has("FN-busy")).toBe(true);
    expect(privateEngine.activeMergeTaskId).toBe("FN-busy");
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/clearing stale mergeActive/));

    await engine.stop();
  });
});

describe("allowInReviewMergeProcessing per-task autoMerge override", () => {
  const gate = (task: Partial<Task>, settings: { autoMerge: boolean }, branchGroup: { status: "open" | "finalized" | "abandoned" } | null = null): Promise<boolean> =>
    (createEngine() as any).allowInReviewMergeProcessing(task, settings, { getBranchGroup: vi.fn(() => branchGroup) });

  it("lets an explicit per-task autoMerge:true through when the global setting is off", async () => {
    await expect(gate({ autoMerge: true }, { autoMerge: false })).resolves.toBe(true);
  });

  it("blocks tasks without a per-task override when the global setting is off", async () => {
    await expect(gate({}, { autoMerge: false })).resolves.toBe(false);
    await expect(gate({ autoMerge: false }, { autoMerge: false })).resolves.toBe(false);
  });

  it("keeps everything flowing when the global setting is on — explicit autoMerge:false is parked manual-required downstream", async () => {
    await expect(gate({}, { autoMerge: true })).resolves.toBe(true);
    await expect(gate({ autoMerge: false }, { autoMerge: true })).resolves.toBe(true);
  });

  it("still exempts live shared-branch-group member integration when the global setting is off", async () => {
    await expect(gate(
      { branchContext: { assignmentMode: "shared", groupId: "grp-1" } as Task["branchContext"] },
      { autoMerge: false },
      { status: "open" },
    )).resolves.toBe(true);
  });

  it.each([
    ["missing", null],
    ["finalized", { status: "finalized" as const }],
    ["abandoned", { status: "abandoned" as const }],
  ])("blocks shared-branch-group member integration for %s groups when global autoMerge is off", async (_label, branchGroup) => {
    await expect(gate(
      { branchContext: { assignmentMode: "shared", groupId: "grp-1" } as Task["branchContext"] },
      { autoMerge: false },
      branchGroup,
    )).resolves.toBe(false);
  });

  it.each([
    ["api", { sourceType: "api" }],
    ["user-created", { sourceType: undefined }],
    ["engine-created", { sourceType: "unknown", sourceMetadata: { fusionBranchContext: { assignmentMode: "shared", groupId: "grp-1", source: "mission" } } }],
  ])("applies the dissolved-group manual hold regardless of %s provenance", async (_label, provenance) => {
    await expect(gate(
      {
        ...provenance,
        autoMerge: undefined,
        branchContext: { assignmentMode: "shared", groupId: "grp-1", source: "mission" } as Task["branchContext"],
      },
      { autoMerge: false },
      null,
    )).resolves.toBe(false);
  });
});

// ## Surface Enumeration
//
// Known in-review merge entry surfaces in ProjectEngine, and how each enforces
// the per-task `autoMerge` override invariant (a task with `autoMerge:true` must
// still be enqueued for merge even when the global `autoMerge` setting is off):
//
//   1. Startup merge sweep            (project-engine.ts ~:2857) ─┐
//   2. Periodic merge retry sweep     (project-engine.ts ~:2916) ─┼─ all call
//   3. Resume-after-unpause sweep     (project-engine.ts ~:2977) ─┘ enqueueEligibleInReviewTasks(...)
//   4. task:moved fast path           (project-engine.ts ~:1506) ─── inline allowInReviewMergeProcessing(...)
//
// Surfaces 1–3 funnel through `enqueueEligibleInReviewTasks`, whose filter is
// `!t.paused && canMergeTask(t) && allowInReviewMergeProcessing(t, settings)`.
// The behavior tests below exercise that shared funnel directly on a real engine
// instance (with `internalEnqueueMerge` stubbed), so a regression in any of the
// three sweep wrappers (wireAutoMerge / startupMergeSweep / scheduleMergeRetry /
// resumeAfterUnpauseAndSweepInReview) that still routes through the funnel is
// caught. Surface 4 (the task:moved fast path) shares the same
// `allowInReviewMergeProcessing` gate, which is covered by the direct helper
// tests above.

describe("enqueueEligibleInReviewTasks honors per-task autoMerge override (shared sweep funnel)", () => {
  const inReview = (id: string, overrides: Partial<Task> = {}): Task =>
    ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 0,
      status: null,
      ...overrides,
    }) as unknown as Task;

  const setup = () => {
    const engine = createEngine() as any;
    const enqueueSpy = vi
      .spyOn(engine, "internalEnqueueMerge")
      .mockImplementation(() => true);
    const run = (tasks: Task[], settings: { autoMerge: boolean }): Promise<number> =>
      engine.enqueueEligibleInReviewTasks(tasks, settings);
    return { engine, enqueueSpy, run };
  };

  it("enqueues an in-review task with autoMerge:true even when the global setting is off", async () => {
    const { enqueueSpy, run } = setup();
    const count = await run([inReview("FN-override", { autoMerge: true })], { autoMerge: false });
    expect(count).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-override");
  });

  it("does not enqueue a sibling task without an override in the same sweep when the global setting is off", async () => {
    const { enqueueSpy, run } = setup();
    const count = await run(
      [inReview("FN-override", { autoMerge: true }), inReview("FN-plain")],
      { autoMerge: false },
    );
    expect(count).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-override");
    expect(enqueueSpy).not.toHaveBeenCalledWith("FN-plain");
  });

  it("still enqueues a task with autoMerge:false when the global setting is on (parked manual-required downstream)", async () => {
    const { enqueueSpy, run } = setup();
    const count = await run([inReview("FN-explicit-false", { autoMerge: false })], { autoMerge: true });
    expect(count).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-explicit-false");
  });
});
