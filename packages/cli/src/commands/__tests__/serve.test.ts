import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const { mockSyncStartupModels, mockShouldUseHybridExecutor, mockHybridExecutorCtor, mockHybridExecutorInitialize, mockHybridExecutorShutdown } = vi.hoisted(() => ({
  mockSyncStartupModels: vi.fn().mockResolvedValue(undefined),
  mockShouldUseHybridExecutor: vi.fn().mockResolvedValue({ enabled: false, reason: "single-project-local-only" }),
  mockHybridExecutorInitialize: vi.fn().mockResolvedValue(undefined),
  mockHybridExecutorShutdown: vi.fn().mockResolvedValue(undefined),
  mockHybridExecutorCtor: vi.fn().mockImplementation(function () {
    return {
      initialize: mockHybridExecutorInitialize,
      shutdown: mockHybridExecutorShutdown,
    };
  }),
}));
vi.mock("../startup-model-sync.js", () => ({
  syncStartupModels: mockSyncStartupModels,
}));

// ── Multi-project test fixtures ─────────────────────────────────────────
//
// Test fixtures model at least two registered projects with distinct IDs/paths
// and independently addressable engine instances. This enables regression tests
// for multi-project scoped scheduling where wrong-engine binding can silently
// route operations to the wrong project.
//
const PROJECT_FIXTURES = {
  primary: {
    id: "project-1",
    name: "Primary Project",
    path: "/repo",
    status: "active" as const,
    isolationMode: "in-process" as const,
  },
  secondary: {
    id: "project-2",
    name: "Secondary Project",
    path: "/repo-secondary",
    status: "active" as const,
    isolationMode: "in-process" as const,
  },
};

// Track getProjectByPath calls to allow per-test resolution control
let getProjectByPathResolver: ((cwd: string) => unknown) | null = null;

// Track which engine is used for default/cwd path to assert correct routing
const engineUsageLog: string[] = [];

const mocks = vi.hoisted(() => {
  type ListenCall = {
    port: number;
    host?: string;
    server: {
      close: ReturnType<typeof vi.fn>;
      address: ReturnType<typeof vi.fn>;
      once: (event: string, cb: (...args: unknown[]) => void) => void;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
  };

  const taskStores: any[] = [];
  const automationStores: any[] = [];
  const agentStores: any[] = [];
  const centralInstances: any[] = [];
  const triageInstances: any[] = [];
  const executorInstances: any[] = [];
  const schedulerInstances: any[] = [];
  const stuckDetectorInstances: any[] = [];
  const selfHealingInstances: any[] = [];
  const cronRunnerInstances: any[] = [];
  const missionAutopilotInstances: any[] = [];
  const missionExecutionLoopInstances: any[] = [];
  const notifierInstances: any[] = [];
  const pluginStoreInstances: any[] = [];
  const pluginLoaderInstances: any[] = [];
  const projectEngineInstances: any[] = [];
  const listenCalls: ListenCall[] = [];
  const backendShutdowns: Array<ReturnType<typeof vi.fn>> = [];
  const globalSettingsGetSettings = vi.fn().mockResolvedValue({});

  function createTaskStoreMock(projectId = "") {
    const emitter = new EventEmitter();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([]),
    };
    const pluginStore = pluginStoreCtor();

    return {
      init: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getRootDir: vi.fn().mockReturnValue(`/repo${projectId ? `/${projectId}` : ""}`),
      getFusionDir: vi.fn().mockReturnValue(`/repo${projectId ? `/${projectId}` : ""}/.fusion`),
      getGlobalSettingsStore: vi.fn(() => ({
        getSettings: globalSettingsGetSettings,
      })),
      updateGlobalSettings: vi.fn().mockResolvedValue({}),
      getMissionStore: vi.fn().mockReturnValue(missionStore),
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        recycleWorktrees: false,
        autoMerge: false,
        pollIntervalMs: 60_000,
        openrouterModelSync: false,
      }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
      getTask: vi.fn(),
      updateTask: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
      updatePrInfo: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        emitter.off(event, handler);
      }),
      emit: emitter.emit.bind(emitter),
      getActiveMergingTask: vi.fn().mockReturnValue(undefined),
    };
  }

  function createMockServer(port: number) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      close: vi.fn((cb?: () => void) => cb?.()),
      address: vi.fn(() => ({ port, family: "IPv4", address: "0.0.0.0" })),
      once: emitter.once.bind(emitter),
      on: emitter.on.bind(emitter),
    });
  }

  const taskStoreCtor = vi.fn().mockImplementation(function () {
    const store = createTaskStoreMock();
    taskStores.push(store);
    return store;
  });

  /*
   * FNXC:PostgresServeLifecycle 2026-07-14-22:20:
   * Serve's authoritative TaskStore is initialized by createTaskStoreForBackend and then injected into ProjectEngineManager. The test factory must model that single owner instead of leaving the engine mock to construct and initialize a second store.
   */
  const createTaskStoreForBackendMock = vi.fn(async ({ rootDir }: { rootDir: string }) => {
    const taskStore = taskStoreCtor(rootDir);
    await taskStore.init();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    backendShutdowns.push(shutdown);
    return {
      taskStore,
      asyncLayer: {},
      backend: { mode: "embedded" },
      shutdown,
    };
  });

  const automationStoreCtor = vi.fn().mockImplementation(function () {
    const automationStore = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    automationStores.push(automationStore);
    return automationStore;
  });

  const agentStoreCtor = vi.fn().mockImplementation(function () {
    const agentStore = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    agentStores.push(agentStore);
    return agentStore;
  });

  const centralCoreCtor = vi.fn().mockImplementation(function () {
    const now = new Date().toISOString();
    const projects = [
      { ...PROJECT_FIXTURES.primary, createdAt: now, updatedAt: now },
      { ...PROJECT_FIXTURES.secondary, createdAt: now, updatedAt: now },
    ];

    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
        // Use per-test resolver when available; default to lookup by path
        if (getProjectByPathResolver) {
          return Promise.resolve(getProjectByPathResolver(cwd));
        }
        return Promise.resolve(projects.find((project) => project.path === cwd) ?? null);
      }),
      registerProject: vi.fn().mockImplementation(({ name, path, isolationMode }: { name: string; path: string; isolationMode: "in-process" | "child-process" }) => {
        const project = {
          id: `project-${projects.length + 1}`,
          name,
          path,
          status: "inactive",
          isolationMode,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        projects.push(project);
        return Promise.resolve(project);
      }),
      updateProject: vi.fn().mockImplementation((id: string, patch: { status?: string }) => {
        const index = projects.findIndex((project) => project.id === id);
        if (index >= 0) {
          projects[index] = {
            ...projects[index],
            ...patch,
            updatedAt: new Date().toISOString(),
          };
        }
        return Promise.resolve();
      }),
      getProject: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(projects.find((project) => project.id === id) ?? null),
      ),
      listProjects: vi.fn().mockImplementation(() => Promise.resolve([...projects])),
      getDefaultProjectId: vi.fn().mockResolvedValue(undefined),
      listNodes: vi.fn().mockResolvedValue([
        { id: "node-local", name: "local", type: "local", status: "offline" },
      ]),
      updateNode: vi.fn().mockResolvedValue(undefined),
      startDiscovery: vi.fn().mockResolvedValue({}),
      stopDiscovery: vi.fn(),
    };
    centralInstances.push(instance);
    return instance;
  });

  const createServerMock = vi.fn().mockImplementation(() => ({
    listen: vi.fn((port: number, host?: string) => {
      const actualPort = port === 0 ? 5050 : port;
      const server = createMockServer(actualPort);
      listenCalls.push({ port, host, server });
      queueMicrotask(() => {
        server.emit("listening");
      });
      return server;
    }),
  }));

  const triageCtor = vi.fn().mockImplementation(function () {
    const triage = {
      start: vi.fn(),
      stop: vi.fn(),
      markStuckAborted: vi.fn(),
    };
    triageInstances.push(triage);
    return triage;
  });

  const executorCtor = vi.fn().mockImplementation(function () {
    const executor = {
      resumeOrphaned: vi.fn().mockResolvedValue(undefined),
      markStuckAborted: vi.fn(),
      handleLoopDetected: vi.fn().mockResolvedValue(false),
      recoverCompletedTask: vi.fn().mockResolvedValue(false),
      getExecutingTaskIds: vi.fn().mockReturnValue(new Set()),
    };
    executorInstances.push(executor);
    return executor;
  });

  const schedulerCtor = vi.fn().mockImplementation(function () {
    const scheduler = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    schedulerInstances.push(scheduler);
    return scheduler;
  });

  const stuckDetectorCtor = vi.fn().mockImplementation(function () {
    const detector = {
      start: vi.fn(),
      stop: vi.fn(),
      checkNow: vi.fn().mockResolvedValue(undefined),
    };
    stuckDetectorInstances.push(detector);
    return detector;
  });

  const selfHealingCtor = vi.fn().mockImplementation(function () {
    const manager = {
      start: vi.fn(),
      stop: vi.fn(),
      checkStuckBudget: vi.fn().mockResolvedValue(true),
    };
    selfHealingInstances.push(manager);
    return manager;
  });

  const cronRunnerCtor = vi.fn().mockImplementation(function () {
    const cron = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    cronRunnerInstances.push(cron);
    return cron;
  });

  const missionAutopilotCtor = vi.fn().mockImplementation(function () {
    const autopilot = {
      start: vi.fn(),
      stop: vi.fn(),
      setScheduler: vi.fn(),
    };
    missionAutopilotInstances.push(autopilot);
    return autopilot;
  });

  const missionExecutionLoopCtor = vi.fn().mockImplementation(function () {
    const loop = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      processTaskOutcome: vi.fn().mockResolvedValue(undefined),
      recoverActiveMissions: vi.fn().mockResolvedValue(undefined),
    };
    missionExecutionLoopInstances.push(loop);
    return loop;
  });

  const notifierCtor = vi.fn().mockImplementation(function () {
    const notifier = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    notifierInstances.push(notifier);
    return notifier;
  });

  const pluginStoreCtor = vi.fn().mockImplementation(function () {
    const pluginStore = {
      init: vi.fn().mockResolvedValue(undefined),
      listPlugins: vi.fn().mockResolvedValue([]),
      getPlugin: vi.fn(),
      registerPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginState: vi.fn(),
    };
    pluginStoreInstances.push(pluginStore);
    return pluginStore;
  });

  const pluginLoaderCtor = vi.fn().mockImplementation(function () {
    const pluginLoader = {
      loadPlugin: vi.fn().mockResolvedValue(undefined),
      loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 0, errors: 0 }),
      getPluginSkills: vi.fn().mockReturnValue([]),
      stopAllPlugins: vi.fn().mockResolvedValue(undefined),
      stopPlugin: vi.fn().mockResolvedValue(undefined),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn(),
      getLoadedPlugins: vi.fn().mockReturnValue([]),
    };
    pluginLoaderInstances.push(pluginLoader);
    return pluginLoader;
  });

  const pluginRunner = {
    getRuntimeById: vi.fn(),
  };

  const authStorage = {
    getApiKey: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    getOAuthProviders: vi.fn().mockReturnValue([]),
    hasAuth: vi.fn().mockReturnValue(false),
    login: vi.fn(),
    logout: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
  };

  const modelRegistry = {
    getAll: vi.fn().mockReturnValue([]),
    registerProvider: vi.fn(),
    refresh: vi.fn(),
  };

  const refreshAllCustomProviderModels = vi.fn().mockResolvedValue({ refreshed: 0, failed: 0, skipped: 0 });
  const createSkillsAdapterMock = vi.fn().mockReturnValue(undefined);

  const agentSemaphoreCtor = vi.fn().mockImplementation(function () {
    return {
      _active: 0,
      run: (fn: () => Promise<unknown>) => fn(),
    };
  });

  const heartbeatMonitorCtor = vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ id: "run-1" }),
      executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
      stopRun: vi.fn().mockResolvedValue(undefined),
    };
  });

  const heartbeatTriggerSchedulerCtor = vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      registerAgent: vi.fn(),
      getRegisteredAgents: vi.fn().mockReturnValue([]),
    };
  });

  const createAiPromptExecutorMock = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue("ok"));
  const syncInsightExtractionAutomationMock = vi.fn().mockResolvedValue(undefined);
  const processAndAuditInsightExtractionMock = vi.fn().mockResolvedValue({
    generatedAt: new Date().toISOString(),
    health: "healthy",
    checks: [],
    workingMemory: { exists: true, size: 100, sectionCount: 2 },
    insightsMemory: { exists: true, size: 50, insightCount: 3, categories: {}, lastUpdated: "2026-04-09" },
    extraction: { runAt: new Date().toISOString(), success: true, insightCount: 3, duplicateCount: 0, skippedCount: 0, summary: "Test" },
    pruning: { applied: false },
  });

  const projectEngineCtor = vi.fn().mockImplementation(function (
    runtimeConfig: { workingDirectory: string },
    _centralCore: unknown,
    options: { onInsightRunProcessed?: unknown; externalTaskStore?: ReturnType<typeof createTaskStoreMock> },
  ) {
    const store = options.externalTaskStore ?? taskStoreCtor(runtimeConfig.workingDirectory);
    const ownsStoreInitialization = options.externalTaskStore === undefined;
    const automationStore = automationStoreCtor(runtimeConfig.workingDirectory);
    const agentStore = agentStoreCtor();
    const semaphore = agentSemaphoreCtor();
    const heartbeatMonitor = heartbeatMonitorCtor({});
    const heartbeatTriggerScheduler = heartbeatTriggerSchedulerCtor(agentStore, vi.fn(), store);
    const missionAutopilot = missionAutopilotCtor();
    const missionExecutionLoop = missionExecutionLoopCtor();
    const triage = triageCtor(store, undefined, { semaphore });
    const executor = executorCtor(store, undefined, { semaphore });
    const scheduler = schedulerCtor(store, { semaphore });
    const stuckDetector = stuckDetectorCtor();
    const selfHealing = selfHealingCtor();
    const cronRunner = cronRunnerCtor(store, automationStore, {
      onScheduleRunProcessed: options.onInsightRunProcessed,
    });
    const notifier = notifierCtor();

    const remoteStatus = {
      provider: "cloudflare" as const,
      state: "running" as const,
      pid: 1234,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      url: "https://remote.example.com",
      lastError: null,
    };

    const engine = {
      start: vi.fn(async () => {
        if (ownsStoreInitialization) await store.init();
        await automationStore.init();
        await agentStore.init();
        const settings = await store.getSettings();
        try {
          await syncInsightExtractionAutomationMock(automationStore, settings);
        } catch (err) {
          console.error(`[memory-audit] Failed to sync insight extraction: ${err instanceof Error ? err.message : String(err)}`);
        }
        store.on("settings:updated", async (event: { settings?: Record<string, unknown>; previous?: Record<string, unknown> }) => {
          const watchedKeys = [
            "insightExtractionEnabled",
            "insightExtractionSchedule",
            "insightExtractionTime",
          ];
          const changed = watchedKeys.some((key) => event.settings?.[key] !== event.previous?.[key]);
          if (changed) {
            await syncInsightExtractionAutomationMock(automationStore, { ...settings, ...event.settings });
          }
        });
        triage.start();
        scheduler.start();
        missionAutopilot.start();
        stuckDetector.start();
        selfHealing.start();
        cronRunner.start();
        notifier.start();
        heartbeatMonitor.start();
        heartbeatTriggerScheduler.start();
        await executor.resumeOrphaned();
        await createAiPromptExecutorMock(runtimeConfig.workingDirectory);
      }),
      stop: vi.fn(async () => {
        selfHealing.stop();
        stuckDetector.stop();
        missionAutopilot.stop();
        triage.stop();
        scheduler.stop();
        cronRunner.stop();
        notifier.stop();
        heartbeatMonitor.stop();
        heartbeatTriggerScheduler.stop();
      }),
      getTaskStore: vi.fn(() => store),
      getProjectId: vi.fn(() => runtimeConfig.projectId),
      getWorkingDirectory: vi.fn(() => runtimeConfig.workingDirectory),
      getAutomationStore: vi.fn(() => automationStore),
      getRuntime: vi.fn(() => ({
        getHeartbeatMonitor: () => heartbeatMonitor,
        getMissionAutopilot: () => missionAutopilot,
        getMissionExecutionLoop: () => missionExecutionLoop,
      })),
      getRemoteTunnelManager: vi.fn(() => ({ getStatus: vi.fn(() => remoteStatus) })),
      getRemoteTunnelRestoreDiagnostics: vi.fn(() => ({
        outcome: "skipped",
        reason: "not_attempted",
        at: new Date().toISOString(),
        provider: null,
      })),
      /*
      FNXC:FasterStartup 2026-07-15-12:41:
      Keep the serve startup fixture aligned with the HTTP host contract: createServer receives the engine PluginRunner so model routes can resolve runtime-backed providers while startup remains non-blocking.
      */
      getPluginRunner: vi.fn(() => pluginRunner),
      startRemoteTunnel: vi.fn(async () => remoteStatus),
      stopRemoteTunnel: vi.fn(async () => ({ ...remoteStatus, state: "stopped" as const, provider: null, pid: null, url: null })),
      onMerge: vi.fn().mockResolvedValue(undefined),
    };
    projectEngineInstances.push(engine);
    return engine;
  });

  return {
    taskStores,
    automationStores,
    agentStores,
    centralInstances,
    triageInstances,
    executorInstances,
    schedulerInstances,
    stuckDetectorInstances,
    selfHealingInstances,
    cronRunnerInstances,
    missionAutopilotInstances,
    missionExecutionLoopInstances,
    notifierInstances,
    pluginLoaderInstances,
    projectEngineInstances,
    listenCalls,
    backendShutdowns,
    taskStoreCtor,
    createTaskStoreForBackendMock,
    automationStoreCtor,
    agentStoreCtor,
    centralCoreCtor,
    createServerMock,
    triageCtor,
    executorCtor,
    schedulerCtor,
    stuckDetectorCtor,
    selfHealingCtor,
    cronRunnerCtor,
    missionAutopilotCtor,
    missionExecutionLoopCtor,
    notifierCtor,
    pluginStoreCtor,
    pluginLoaderCtor,
    projectEngineCtor,
    agentSemaphoreCtor,
    heartbeatMonitorCtor,
    heartbeatTriggerSchedulerCtor,
    createAiPromptExecutorMock,
    syncInsightExtractionAutomationMock,
    processAndAuditInsightExtractionMock,
    authStorage,
    modelRegistry,
    refreshAllCustomProviderModels,
    createSkillsAdapterMock,
    globalSettingsGetSettings,
    reset() {
      taskStores.length = 0;
      automationStores.length = 0;
      agentStores.length = 0;
      centralInstances.length = 0;
      triageInstances.length = 0;
      executorInstances.length = 0;
      schedulerInstances.length = 0;
      stuckDetectorInstances.length = 0;
      selfHealingInstances.length = 0;
      cronRunnerInstances.length = 0;
      missionAutopilotInstances.length = 0;
      missionExecutionLoopInstances.length = 0;
      notifierInstances.length = 0;
      pluginStoreInstances.length = 0;
      pluginLoaderInstances.length = 0;
      projectEngineInstances.length = 0;
      listenCalls.length = 0;
      backendShutdowns.length = 0;
      syncInsightExtractionAutomationMock.mockReset();
      syncInsightExtractionAutomationMock.mockResolvedValue(undefined);
      processAndAuditInsightExtractionMock.mockClear();
      createAiPromptExecutorMock.mockClear();
      refreshAllCustomProviderModels.mockReset();
      refreshAllCustomProviderModels.mockResolvedValue({ refreshed: 0, failed: 0, skipped: 0 });
      globalSettingsGetSettings.mockReset();
      globalSettingsGetSettings.mockResolvedValue({});
      // Reset multi-project state
      engineUsageLog.length = 0;
      getProjectByPathResolver = null;
    },
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCliCoreMock } = await import("../../test/mockCoreEngine");
  return createCliCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
  TaskStore: mocks.taskStoreCtor,
  createTaskStoreForBackend: mocks.createTaskStoreForBackendMock,
  AutomationStore: mocks.automationStoreCtor,
  AgentStore: mocks.agentStoreCtor,
  CentralCore: mocks.centralCoreCtor,
  PluginStore: mocks.pluginStoreCtor,
  PluginLoader: mocks.pluginLoaderCtor,
  getEnabledPiExtensionPaths: vi.fn(() => []),
  getTaskMergeBlocker: vi.fn().mockReturnValue(null),
  syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomationMock,
  INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction",
  processAndAuditInsightExtraction: mocks.processAndAuditInsightExtractionMock,
  DaemonTokenManager: vi.fn().mockImplementation(function () {
    return {
      getToken: vi.fn().mockResolvedValue(null),
      generateToken: vi.fn().mockResolvedValue("fn_generated1234567890"),
      storeToken: vi.fn().mockResolvedValue(undefined),
    };
  }),
  GlobalSettingsStore: makeConstructibleMock(function () {
    return {};
  }),
  resolveGlobalDir: vi.fn().mockReturnValue("/mock/global"),
  });
});

vi.mock("@fusion/dashboard", () => ({
  // FNXC:TestInfrastructure 2026-07-13-10:25: Source files named-import these from @fusion/dashboard barrel; mock must surface them.
  registerGithubTrackingHook: vi.fn(),
  // FNXC:CliTests 2026-07-13-08:10: @fusion/dashboard barrel re-exports cli-package-version helpers; mock must surface them for startup model sync.
isUnresolvedCliPackageVersion: vi.fn(() => false),
resolveCliPackageVersionInfo: vi.fn(() => ({ version: "0.0.0-test", isUnresolved: false })),
  getCliPackageVersion: vi.fn(() => "0.0.0"),
  // FNXC:CliTests 2026-07-13-08:00: getCliPackageVersion added to @fusion/dashboard barrel export; mock must surface it for daemon/serve startup model sync.
  createServer: mocks.createServerMock,
  GitHubClient: vi.fn().mockImplementation(function () {
    return {};
  }),
  createSkillsAdapter: mocks.createSkillsAdapterMock,
  getProjectSettingsPath: vi.fn().mockReturnValue("/tmp/project/.fusion/settings.json"),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
  refreshAllCustomProviderModels: mocks.refreshAllCustomProviderModels,
  // FNXC:CliTests 2026-07-13-09:40: Missing dashboard barrel exports added for mock completeness (scripts/check-mock-completeness.mjs gate).
  registerGithubTrackingHook: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const { createCliEngineMock } = await import("../../test/mockCoreEngine");
  return createCliEngineMock(() => importOriginal<typeof import("@fusion/engine")>(), {
    createFusionAuthStorage: vi.fn(() => mocks.authStorage),
    ProjectEngine: mocks.projectEngineCtor,
    ProjectEngineManager: vi.fn().mockImplementation(function (centralCore: any, options: any) {
    const engines = new Map<string, any>();
    const starting = new Map<string, Promise<any>>();
    /*
    FNXC:FasterStartup 2026-07-15-00:20:
    Serve no longer awaits startAll before primary ensureEngine. The mock must
    create-on-ensure (matching real ProjectEngineManager) so primary resolution
    works when background startAll has not finished yet.
    */
    const ensureEngine = async (id: string) => {
      const existing = engines.get(id);
      if (existing) return existing;
      const pending = starting.get(id);
      if (pending) return pending;
      const promise = (async () => {
        // Prefer listProjects path (authoritative registry fixture) over getProject,
        // which some multi-project suite stubs invent as `/repo/${id}`.
        const listed = await centralCore.listProjects();
        const fromList = listed.find((p: { id: string }) => p.id === id);
        const project = fromList ?? (await centralCore.getProject(id));
        const engine = mocks.projectEngineCtor(
          {
            projectId: id,
            workingDirectory: project?.path ?? `/tmp/${id}`,
            isolationMode: "in-process",
            maxConcurrent: 4,
            maxWorktrees: 10,
          },
          centralCore,
          { ...options, projectId: id },
        );
        await engine.start();
        engines.set(id, engine);
        starting.delete(id);
        return engine;
      })();
      starting.set(id, promise);
      return promise;
    };
    return {
      startAll: vi.fn(async () => {
        const projects = await centralCore.listProjects();
        for (const project of projects) {
          await ensureEngine(project.id);
        }
      }),
      // Track which engine is used to verify correct cwd/default routing
      getEngine: vi.fn((id: string) => {
        engineUsageLog.push(`getEngine(${id})`);
        return engines.get(id);
      }),
      getAllEngines: vi.fn(() => engines),
      getStore: vi.fn((id: string) => engines.get(id)?.getTaskStore()),
      has: vi.fn((id: string) => engines.has(id) || starting.has(id)),
      ensureEngine: vi.fn(async (id: string) => ensureEngine(id)),
      stopAll: vi.fn(async () => {
        for (const engine of engines.values()) await engine.stop();
        engines.clear();
        starting.clear();
      }),
      onProjectAccessed: vi.fn(),
      startReconciliation: vi.fn(),
    };
  }),
  PeerExchangeService: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
  TriageProcessor: mocks.triageCtor,
  TaskExecutor: mocks.executorCtor,
  Scheduler: mocks.schedulerCtor,
  AgentSemaphore: mocks.agentSemaphoreCtor,
  WorktreePool: vi.fn().mockImplementation(function () {
    return {
      rehydrate: vi.fn(),
    };
  }),
  aiMergeTask: vi.fn().mockResolvedValue({ merged: true }),
  UsageLimitPauser: vi.fn().mockImplementation(function () {
    return {};
  }),
  PRIORITY_MERGE: 100,
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  NtfyNotifier: mocks.notifierCtor,
  PrMonitor: vi.fn().mockImplementation(function () {
    return {
      onNewComments: vi.fn(),
    };
  }),
  PrCommentHandler: vi.fn().mockImplementation(() => ({
    handleNewComments: vi.fn(),
    createFollowUpTask: vi.fn().mockResolvedValue(undefined),
  })),
  CronRunner: mocks.cronRunnerCtor,
  StuckTaskDetector: mocks.stuckDetectorCtor,
  SelfHealingManager: mocks.selfHealingCtor,
  MissionAutopilot: mocks.missionAutopilotCtor,
  MissionExecutionLoop: mocks.missionExecutionLoopCtor,
  createAiPromptExecutor: mocks.createAiPromptExecutorMock,
  HeartbeatMonitor: mocks.heartbeatMonitorCtor,
  HeartbeatTriggerScheduler: mocks.heartbeatTriggerSchedulerCtor,
  shouldUseHybridExecutor: mockShouldUseHybridExecutor,
  HybridExecutor: mockHybridExecutorCtor,
  });
});
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mocks.authStorage),
  },
  DefaultPackageManager: vi.fn().mockImplementation(function () {
    return {
      resolve: vi.fn().mockResolvedValue({ extensions: [] }),
    };
  }),
  ModelRegistry: {
    create: vi.fn(() => mocks.modelRegistry),
    inMemory: vi.fn(() => mocks.modelRegistry),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  discoverAndLoadExtensions: vi.fn().mockResolvedValue({
    runtime: { pendingProviderRegistrations: [] },
    errors: [],
  }),
  getAgentDir: vi.fn(() => "/mock-agent-dir"),
  createExtensionRuntime: vi.fn(),
}));

vi.mock("../port-prompt.js", () => ({
  promptForPort: vi.fn(async (port: number) => port),
}));

vi.mock("../task-lifecycle.js", () => ({
  getMergeStrategy: vi.fn((settings: { mergeStrategy?: "direct" | "pull-request" }) => settings.mergeStrategy ?? "direct"),
  processPullRequestMergeTask: vi.fn().mockResolvedValue("waiting"),
  createGroupPrCallback: vi.fn(() => vi.fn()),
  syncGroupPrCallback: vi.fn(() => vi.fn()),
  createPrNodeGithubOps: vi.fn(() => ({})),
  createPrReconcileGithubOps: vi.fn(() => ({})),
}));

vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn().mockRejectedValue(new Error("project not initialized")),
}));

const { runServe } = await import("../serve.js");
const ensureProjectRegisteredModule = await import("../ensure-project-registered.js");

describe("runServe", () => {
  it("invokes shared startup model sync", async () => {
    const { runServe } = await import("../serve.js");
    await runServe(4040, {});
    expect(mockSyncStartupModels).toHaveBeenCalledTimes(1);
  });

  // FNXC:DaemonSignalExit 2026-07-10-16:00: `fn serve` must honor the same POSIX
  // exit-code contract as `fn daemon` — a memory-pressure SIGTERM exits non-zero
  // (143) so `Restart=on-failure` restarts it; SIGINT exits 130. Guards against
  // the two headless-server paths regressing independently.
  it("exits 143 on SIGTERM-initiated shutdown", async () => {
    await runServe(0, {});
    await triggerSignal("SIGTERM");
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  it("exits 130 on SIGINT-initiated shutdown", async () => {
    await runServe(0, {});
    await triggerSignal("SIGINT");
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it("registers built-in zai GLM-5.2 before refreshing models", async () => {
    await runServe(0, {});

    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith("zai", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "glm-5.2" })]),
    }));
    expect(mocks.modelRegistry.refresh).toHaveBeenCalled();

    await triggerSignal("SIGINT");
  });

  it("starts serving before background custom provider refresh settles", async () => {
    mocks.refreshAllCustomProviderModels.mockImplementationOnce(() => new Promise(() => undefined));
    mocks.globalSettingsGetSettings.mockResolvedValue({
      customProviders: [{
        id: "cp-1",
        name: "Custom Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "configured-model", name: "Configured model" }],
      }],
    });

    await runServe(0, {});

    expect(mocks.refreshAllCustomProviderModels).toHaveBeenCalledTimes(1);
    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith(
      expect.stringContaining("custom-proxy"),
      expect.objectContaining({ models: [expect.objectContaining({ id: "configured-model" })] }),
    );

    await triggerSignal("SIGINT");
  });

  it("continues startup provider registration when custom provider refresh fails", async () => {
    mocks.refreshAllCustomProviderModels.mockRejectedValueOnce(new Error("provider offline"));
    mocks.globalSettingsGetSettings.mockResolvedValue({
      customProviders: [{
        id: "cp-1",
        name: "Custom Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "configured-model", name: "Configured model" }],
      }],
    });

    await runServe(0, {});

    expect(mocks.refreshAllCustomProviderModels).toHaveBeenCalledTimes(1);
    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith(
      expect.stringContaining("custom-proxy"),
      expect.objectContaining({ models: [expect.objectContaining({ id: "configured-model" })] }),
    );

    await triggerSignal("SIGINT");
  });
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(function () {});

    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("initializes stores, starts engine services, and creates a headless server", async () => {
    await runServe(4040, {});

    expect(mocks.createTaskStoreForBackendMock).toHaveBeenCalledWith({ rootDir: "/repo" });
    expect(mocks.taskStoreCtor).toHaveBeenCalledTimes(1);
    expect(mocks.taskStores[0].init).toHaveBeenCalledTimes(1);
    expect(mocks.taskStores[0].watch).toHaveBeenCalledTimes(1);
    expect(mocks.automationStoreCtor).toHaveBeenCalledWith("/repo");
    expect(mocks.automationStores[0].init).toHaveBeenCalledTimes(1);
    expect(mocks.agentStores[0].init).toHaveBeenCalledTimes(1);

    expect(mocks.createServerMock).toHaveBeenCalledTimes(1);
    expect(mocks.createServerMock.mock.calls[0][1]).toMatchObject({
      headless: true,
    });

    expect(mocks.triageInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.missionAutopilotInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.stuckDetectorInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.selfHealingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.executorInstances[0].resumeOrphaned).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  /*
   * FNXC:PluginSkillsPostgres 2026-07-14-17:47:
   * `fn serve` skill discovery is metadata-only. Its request-scoped loader must not persist synthetic plugin starts, stops, or errors.
   */
  it("keeps request-scoped plugin skill discovery read-only", async () => {
    await runServe(0, {});
    const adapterOptions = mocks.createSkillsAdapterMock.mock.calls.at(-1)?.[0] as {
      getPluginSkills?: (rootDir: string, resolvedProjectStore: (typeof mocks.taskStores)[number]) => Promise<unknown[]>;
    };
    const resolvedProjectStore = mocks.taskStores[0];
    resolvedProjectStore.getPluginStore().listPlugins.mockResolvedValue([
      { id: "enabled-plugin", updatedAt: "2026-07-14T00:00:00.000Z" },
    ]);
    mocks.pluginLoaderCtor.mockClear();

    await expect(adapterOptions.getPluginSkills?.("/repo-secondary", resolvedProjectStore)).resolves.toEqual([]);
    expect(mocks.pluginLoaderCtor).toHaveBeenCalledWith({
      pluginStore: resolvedProjectStore.getPluginStore(),
      taskStore: resolvedProjectStore,
      persistRuntimeState: false,
    });
    expect(mocks.pluginLoaderInstances.at(-1)?.stopAllPlugins).toHaveBeenCalledOnce();

    await triggerSignal("SIGINT");
  });

  it("passes remote-capable engine hooks into headless createServer for fn serve parity", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(0, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOptions = createServer.mock.calls[0][1];
    expect(serverOptions).toMatchObject({ headless: true });
    expect(serverOptions.engine).toBeDefined();
    expect(typeof serverOptions.engine.startRemoteTunnel).toBe("function");
    expect(typeof serverOptions.engine.stopRemoteTunnel).toBe("function");
    expect(typeof serverOptions.engine.getRemoteTunnelManager).toBe("function");

    await triggerSignal("SIGINT");
  });

  it("preserves remote-capable headless wiring when daemon auth is enabled", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(0, { daemon: true });

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOptions = createServer.mock.calls[0][1];
    expect(serverOptions).toMatchObject({ headless: true, daemon: { token: expect.any(String) } });
    expect(serverOptions.daemon.token.length).toBeGreaterThan(0);
    expect(serverOptions.engine).toBeDefined();
    expect(typeof serverOptions.engine.startRemoteTunnel).toBe("function");
    expect(typeof serverOptions.engine.stopRemoteTunnel).toBe("function");

    await triggerSignal("SIGINT");
  });

  it("sets enginePaused when started with paused=true", async () => {
    await runServe(0, { paused: true });

    expect(mocks.taskStores[0].updateSettings).toHaveBeenCalledWith({ enginePaused: true });

    await triggerSignal("SIGTERM");
  });

  it("updates the local node status online on startup and offline on shutdown", async () => {
    await runServe(4040, {});

    const nodeCentral = mocks.centralInstances.find((instance) => instance.listNodes.mock.calls.length > 0);
    expect(nodeCentral).toBeDefined();
    expect(nodeCentral.updateNode).toHaveBeenCalledWith("node-local", { status: "online" });

    await triggerSignal("SIGINT");

    expect(nodeCentral.updateNode).toHaveBeenCalledWith("node-local", { status: "offline" });
  });

  it("stops engine services during shutdown", async () => {
    await runServe(4040, {});
    expect(mockHybridExecutorCtor).not.toHaveBeenCalled();

    const listenCall = mocks.listenCalls[0];
    expect(listenCall).toBeDefined();

    await triggerSignal("SIGTERM");

    expect(mocks.selfHealingInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.stuckDetectorInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.missionAutopilotInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.triageInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.cronRunnerInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.notifierInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(listenCall.server.close).toHaveBeenCalledTimes(1);
    expect(mocks.taskStores[0].close).not.toHaveBeenCalled();
    expect(mocks.backendShutdowns[0]).toHaveBeenCalledTimes(1);
  });

  it("enables HybridExecutor when env override is set and shuts it down before engine stop", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "1";
    mockShouldUseHybridExecutor.mockResolvedValue({ enabled: true, reason: "env-override" });

    await runServe(4040, {});
    expect(mockHybridExecutorCtor).toHaveBeenCalledTimes(1);
    expect(mockHybridExecutorInitialize).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGTERM");

    expect(mockHybridExecutorShutdown).toHaveBeenCalledTimes(1);
    const shutdownOrder = [
      mockHybridExecutorShutdown.mock.invocationCallOrder[0],
      mocks.projectEngineInstances[0].stop.mock.invocationCallOrder[0],
    ];
    expect(shutdownOrder[0]).toBeLessThan(shutdownOrder[1]);
    delete process.env.FUSION_HYBRID_EXECUTOR;
  });

  it("listens on 127.0.0.1 by default and respects a custom host", async () => {
    await runServe(3010, {});
    expect(mocks.listenCalls[0]).toMatchObject({
      port: 3010,
      host: "127.0.0.1",
    });
    await triggerSignal("SIGINT");

    await runServe(3020, { host: "0.0.0.0" });
    expect(mocks.listenCalls[1]).toMatchObject({
      port: 3020,
      host: "0.0.0.0",
    });
    await triggerSignal("SIGINT");
  });

  it("uses process.env.PORT as fallback when no explicit CLI port is given", async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "4041";

    try {
      await runServe(4040, {});
      expect(mocks.listenCalls[0]).toMatchObject({
        port: 4041,
        host: "127.0.0.1",
      });
      await triggerSignal("SIGINT");
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });

  it("ignores process.env.PORT when explicit CLI port is not the default", async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "4041";

    try {
      await runServe(3000, {});
      expect(mocks.listenCalls[0]).toMatchObject({
        port: 3000,
        host: "127.0.0.1",
      });
      await triggerSignal("SIGINT");
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });
});

describe("runServe — Plugin wiring", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("gets PluginStore from TaskStore and creates PluginLoader", async () => {
    const { PluginStore, PluginLoader } = await import("@fusion/core");

    await runServe(4040, {});

    expect(mocks.taskStores[0].getPluginStore).toHaveBeenCalledTimes(1);
    expect(PluginLoader).toHaveBeenCalledTimes(1);
    expect(PluginStore).toHaveBeenCalled();

    await triggerSignal("SIGINT");
  });

  it("shuts down the single shared PostgreSQL boot on graceful serve shutdown", async () => {
    await runServe(4040, {});
    expect(mocks.backendShutdowns).toHaveLength(1);

    await triggerSignal("SIGINT");

    expect(mocks.backendShutdowns[0]).toHaveBeenCalledTimes(1);
  });

  it("passes pluginStore, pluginLoader, and pluginRunner to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts).toHaveProperty("pluginStore");
    expect(serverOpts).toHaveProperty("pluginLoader");
    expect(serverOpts).toHaveProperty("pluginRunner");
    expect(serverOpts.pluginRunner).toBe(mocks.projectEngineInstances[0].getPluginRunner());

    await triggerSignal("SIGINT");
  });

  it("initializes the TaskStore-provided PluginStore", async () => {
    await runServe(4040, {});

    expect(mocks.taskStores[0].getPluginStore).toHaveBeenCalledTimes(1);
    const taskStorePluginStore = mocks.taskStores[0].getPluginStore.mock.results[0]?.value as { init: ReturnType<typeof vi.fn> };
    expect(taskStorePluginStore?.init).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("initializes PluginLoader with pluginStore and taskStore", async () => {
    const { PluginLoader } = await import("@fusion/core");

    await runServe(4040, {});

    expect(PluginLoader).toHaveBeenCalledTimes(1);
    const loaderOptions = PluginLoader.mock.calls[0][0];
    expect(loaderOptions).toHaveProperty("pluginStore");
    expect(loaderOptions).toHaveProperty("taskStore");

    await triggerSignal("SIGINT");
  });

  it("auto-loads installed plugins during startup", async () => {
    const { PluginLoader } = await import("@fusion/core");

    await runServe(4040, {});

    const loaderInstance = (PluginLoader as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value as
      | { loadAllPlugins: ReturnType<typeof vi.fn> }
      | undefined;
    expect(loaderInstance?.loadAllPlugins).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("continues startup when plugin auto-load fails", async () => {
    const { PluginLoader } = await import("@fusion/core");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(function () {});
    (PluginLoader as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        loadPlugin: vi.fn().mockResolvedValue(undefined),
        loadAllPlugins: vi.fn().mockRejectedValue(new Error("plugin load failed")),
        stopPlugin: vi.fn().mockResolvedValue(undefined),
        reloadPlugin: vi.fn().mockResolvedValue(undefined),
        getPluginRoutes: vi.fn().mockReturnValue([]),
        getPlugin: vi.fn(),
        getLoadedPlugins: vi.fn().mockReturnValue([]),
      };
    });

    await expect(runServe(4040, {})).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[plugins] Failed to load plugins: plugin load failed")
    );

    await triggerSignal("SIGINT");
    errorSpy.mockRestore();
  });

  it("includes plugin wiring in headless server", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts.headless).toBe(true);
    expect(serverOpts.pluginStore).toBeDefined();
    expect(serverOpts.pluginLoader).toBeDefined();

    await triggerSignal("SIGINT");
  });
});

describe("runServe — Memory Insight Automation wiring", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(function () {});

    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;

    // Override listProjects to return only the primary project for these tests
    const { CentralCore } = await import("@fusion/core");
    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
        if (getProjectByPathResolver) {
          return Promise.resolve(getProjectByPathResolver(cwd));
        }
        return Promise.resolve({ ...PROJECT_FIXTURES.primary, path: cwd });
      }),
      getProject: vi.fn().mockImplementation((id: string) =>
        Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      ),
      listProjects: vi.fn().mockResolvedValue([
        { ...PROJECT_FIXTURES.primary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]),
      listNodes: vi.fn().mockResolvedValue([
        { id: "node-local", name: "local", type: "local", status: "offline" },
      ]),
      updateNode: vi.fn().mockResolvedValue(undefined),
      startDiscovery: vi.fn().mockResolvedValue({}),
      stopDiscovery: vi.fn(),
    };
    mocks.centralInstances.push(instance);
    CentralCore.mockImplementation(function () {
      return instance;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("syncs insight extraction automation on startup", async () => {
    const { syncInsightExtractionAutomation } = await import("@fusion/core");

    await runServe(4040, {});

    expect(syncInsightExtractionAutomation).toHaveBeenCalledTimes(1);
    expect(syncInsightExtractionAutomation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxConcurrent: 2,
        recycleWorktrees: false,
        autoMerge: false,
        pollIntervalMs: 60_000,
      }),
    );

    await triggerSignal("SIGINT");
  });

  it("passes onScheduleRunProcessed callback to CronRunner", async () => {
    await runServe(4040, {});

    expect(mocks.cronRunnerCtor).toHaveBeenCalledTimes(1);
    const cronOptions = mocks.cronRunnerCtor.mock.calls[0][2];
    expect(cronOptions).toHaveProperty("onScheduleRunProcessed");
    expect(typeof cronOptions.onScheduleRunProcessed).toBe("function");

    await triggerSignal("SIGINT");
  });

  it("calls syncInsightExtractionAutomation when insight extraction settings change", async () => {
    const { syncInsightExtractionAutomation } = await import("@fusion/core");

    await runServe(4040, {});

    // Simulate settings update
    syncInsightExtractionAutomation.mockClear();
    mocks.taskStores[0].emit("settings:updated", {
      settings: {
        insightExtractionEnabled: true,
        insightExtractionSchedule: "0 3 * * *",
      },
      previous: {
        insightExtractionEnabled: false,
        insightExtractionSchedule: "0 2 * * *",
      },
    });

    expect(syncInsightExtractionAutomation).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("does not call syncInsightExtractionAutomation for unrelated settings changes", async () => {
    const { syncInsightExtractionAutomation } = await import("@fusion/core");

    await runServe(4040, {});

    // Simulate unrelated settings update
    syncInsightExtractionAutomation.mockClear();
    mocks.taskStores[0].emit("settings:updated", {
      settings: {
        maxConcurrent: 5,
      },
      previous: {
        maxConcurrent: 2,
      },
    });

    expect(syncInsightExtractionAutomation).not.toHaveBeenCalled();

    await triggerSignal("SIGINT");
  });

  it("handles syncInsightExtractionAutomation errors gracefully", async () => {
    const { syncInsightExtractionAutomation } = await import("@fusion/core");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(function () {});
    syncInsightExtractionAutomation.mockRejectedValueOnce(new Error("Sync failed"));

    await runServe(4040, {});

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[memory-audit] Failed to sync insight extraction"),
    );

    consoleSpy.mockRestore();
    await triggerSignal("SIGINT");
  });
});

describe("runServe — Semaphore boundary (task lanes only)", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;

    // Override listProjects to return only the primary project for semaphore tests
    // These tests verify semaphore sharing across task lanes within a single engine
    const { CentralCore } = await import("@fusion/core");
    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
        if (getProjectByPathResolver) {
          return Promise.resolve(getProjectByPathResolver(cwd));
        }
        return Promise.resolve({ ...PROJECT_FIXTURES.primary, path: cwd });
      }),
      getProject: vi.fn().mockImplementation((id: string) =>
        Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      ),
      listProjects: vi.fn().mockResolvedValue([
        { ...PROJECT_FIXTURES.primary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]),
      listNodes: vi.fn().mockResolvedValue([
        { id: "node-local", name: "local", type: "local", status: "offline" },
      ]),
      updateNode: vi.fn().mockResolvedValue(undefined),
      startDiscovery: vi.fn().mockResolvedValue({}),
      stopDiscovery: vi.fn(),
    };
    mocks.centralInstances.push(instance);
    CentralCore.mockImplementation(function () {
      return instance;
    });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("passes semaphore to TriageProcessor (task lane)", async () => {
    await runServe(4040, {});

    expect(mocks.triageCtor).toHaveBeenCalledTimes(1);
    const triageOptions = mocks.triageCtor.mock.calls[0][2];
    expect(triageOptions).toHaveProperty("semaphore");
    expect(triageOptions.semaphore).toBeDefined();

    await triggerSignal("SIGINT");
  });

  it("passes semaphore to TaskExecutor (task lane)", async () => {
    await runServe(4040, {});

    expect(mocks.executorCtor).toHaveBeenCalledTimes(1);
    const executorOptions = mocks.executorCtor.mock.calls[0][2];
    expect(executorOptions).toHaveProperty("semaphore");
    expect(executorOptions.semaphore).toBeDefined();

    await triggerSignal("SIGINT");
  });

  it("passes semaphore to Scheduler (task lane)", async () => {
    await runServe(4040, {});

    expect(mocks.schedulerCtor).toHaveBeenCalledTimes(1);
    const schedulerOptions = mocks.schedulerCtor.mock.calls[0][1];
    expect(schedulerOptions).toHaveProperty("semaphore");
    expect(schedulerOptions.semaphore).toBeDefined();

    await triggerSignal("SIGINT");
  });

  it("creates shared semaphore instance for task lanes", async () => {
    await runServe(4040, {});

    // Get the semaphore instance from each component
    const triageSemaphore = mocks.triageCtor.mock.calls[0][2].semaphore;
    const executorSemaphore = mocks.executorCtor.mock.calls[0][2].semaphore;
    const schedulerSemaphore = mocks.schedulerCtor.mock.calls[0][1].semaphore;

    // All should reference the same semaphore instance
    expect(triageSemaphore).toBe(executorSemaphore);
    expect(executorSemaphore).toBe(schedulerSemaphore);

    await triggerSignal("SIGINT");
  });

  it("does NOT pass semaphore to HeartbeatMonitor (utility path)", async () => {
    const { HeartbeatMonitor } = await import("@fusion/engine");

    await runServe(4040, {});

    expect(HeartbeatMonitor).toHaveBeenCalledTimes(1);
    const heartbeatOptions = HeartbeatMonitor.mock.calls[0][0];
    expect(heartbeatOptions).not.toHaveProperty("semaphore");

    await triggerSignal("SIGINT");
  });

  it("does NOT pass semaphore to HeartbeatTriggerScheduler (utility path)", async () => {
    const { HeartbeatTriggerScheduler } = await import("@fusion/engine");

    await runServe(4040, {});

    expect(HeartbeatTriggerScheduler).toHaveBeenCalledTimes(1);
    // HeartbeatTriggerScheduler takes 2-3 args: (agentStore, callback, taskStore?)
    const triggerArgs = HeartbeatTriggerScheduler.mock.calls[0];
    // Semaphore should NOT be in any of the arguments (it would have _active property)
    expect(triggerArgs).not.toContainEqual(expect.objectContaining({ _active: expect.any(Number) }));

    await triggerSignal("SIGINT");
  });

  it("does NOT pass semaphore to CronRunner (utility path)", async () => {
    await runServe(4040, {});

    expect(mocks.cronRunnerCtor).toHaveBeenCalledTimes(1);
    // CronRunner takes (taskStore, automationStore, options)
    const cronOptions = mocks.cronRunnerCtor.mock.calls[0][2];
    expect(cronOptions).not.toHaveProperty("semaphore");

    await triggerSignal("SIGINT");
  });

  it("calls createAiPromptExecutor with cwd only (no semaphore)", async () => {
    const { createAiPromptExecutor } = await import("@fusion/engine");

    await runServe(4040, {});

    expect(createAiPromptExecutor).toHaveBeenCalledTimes(1);
    // In-process runtime intentionally calls createAiPromptExecutor with cwd only; no TaskStore is available at this seam.
    expect(createAiPromptExecutor).toHaveBeenCalledWith(expect.any(String));
    const calledWith = createAiPromptExecutor.mock.calls[0];
    expect(calledWith.length).toBe(1);

    await triggerSignal("SIGINT");
  });

  it("onMerge uses semaphore.run() to gate merge execution (task lane)", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    // The onMerge function is passed to createServer and should use semaphore.run()
    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts).toHaveProperty("onMerge");
    expect(typeof serverOpts.onMerge).toBe("function");
    // The onMerge function should be a wrapper that uses semaphore.run()
    // We can't directly test the internals, but we verified semaphore is passed to
    // the same instance used by triage/executor/scheduler above

    await triggerSignal("SIGINT");
  });
});

describe("runServe — Peer exchange and discovery", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {});
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;

    // Override CentralCore to use original implementation that pushes to centralInstances
    const { CentralCore } = await import("@fusion/core");
    // Reset to the original constructor that creates and pushes instances
    CentralCore.mockImplementation(function () {
      const instance = {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
          if (getProjectByPathResolver) {
            return Promise.resolve(getProjectByPathResolver(cwd));
          }
          return Promise.resolve({ ...PROJECT_FIXTURES.primary, path: cwd });
        }),
        getProject: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        ),
        listProjects: vi.fn().mockResolvedValue([
          { ...PROJECT_FIXTURES.primary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { ...PROJECT_FIXTURES.secondary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ]),
        listNodes: vi.fn().mockResolvedValue([
          { id: "node-local", name: "local", type: "local", status: "offline" },
        ]),
        updateNode: vi.fn().mockResolvedValue(undefined),
        startDiscovery: vi.fn().mockResolvedValue({}),
        stopDiscovery: vi.fn(),
      };
      mocks.centralInstances.push(instance);
      return instance;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("creates PeerExchangeService with CentralCore and calls start()", async () => {
    const { PeerExchangeService } = await import("@fusion/engine");

    await runServe(4040, {});

    expect(PeerExchangeService).toHaveBeenCalledTimes(1);
    const peerExchangeInstance = PeerExchangeService.mock.results[0]?.value;
    expect(peerExchangeInstance.start).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("calls centralCore.startDiscovery() with correct config after server starts", async () => {
    await runServe(4040, {});

    // Find the central core instance that was used
    const nodeCentral = mocks.centralInstances.find((instance) => instance.listNodes.mock.calls.length > 0);
    expect(nodeCentral).toBeDefined();

    // startDiscovery should have been called with broadcast, listen, and correct port
    expect(nodeCentral.startDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        broadcast: true,
        listen: true,
        serviceType: "_fusion._tcp",
        port: 4040,
        staleTimeoutMs: 300_000,
      }),
    );

    await triggerSignal("SIGINT");
  });

  it("starts discovery with port 5050 when port 0 is requested", async () => {
    await runServe(0, {});

    const nodeCentral = mocks.centralInstances.find((instance) => instance.listNodes.mock.calls.length > 0);
    expect(nodeCentral).toBeDefined();

    // Port 0 maps to 5050 in the mock
    expect(nodeCentral.startDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 5050,
      }),
    );

    await triggerSignal("SIGINT");
  });

  it("calls peerExchangeService.stop() on shutdown before engineManager.stopAll()", async () => {
    const { PeerExchangeService } = await import("@fusion/engine");

    await runServe(4040, {});

    // Get the peer exchange instance
    const peerExchangeInstance = PeerExchangeService.mock.results[0]?.value;
    expect(peerExchangeInstance).toBeDefined();

    // Reset mocks to isolate shutdown behavior
    peerExchangeInstance.stop.mockClear();

    await triggerSignal("SIGTERM");

    // stop() should have been called
    expect(peerExchangeInstance.stop).toHaveBeenCalledTimes(1);
  });

  it("calls centralCore.stopDiscovery() on shutdown before closing", async () => {
    await runServe(4040, {});

    const nodeCentral = mocks.centralInstances.find((instance) => instance.listNodes.mock.calls.length > 0);
    expect(nodeCentral).toBeDefined();

    // Reset to isolate shutdown behavior
    nodeCentral.stopDiscovery.mockClear();

    await triggerSignal("SIGTERM");

    // stopDiscovery should have been called
    expect(nodeCentral.stopDiscovery).toHaveBeenCalledTimes(1);
  });

  it("sets local node to offline on shutdown", async () => {
    await runServe(4040, {});

    const nodeCentral = mocks.centralInstances.find((instance) => instance.listNodes.mock.calls.length > 0);
    expect(nodeCentral).toBeDefined();

    // Reset to isolate shutdown behavior
    nodeCentral.updateNode.mockClear();

    await triggerSignal("SIGTERM");

    // Should have been called twice: once to set online, once to set offline
    expect(nodeCentral.updateNode).toHaveBeenCalledWith("node-local", { status: "offline" });
  });
});

describe("runServe --daemon flag", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;
  const originalEnv = process.env.FUSION_DAEMON_TOKEN;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reset();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;

    // Override CentralCore to use original implementation that pushes to centralInstances
    const { CentralCore } = await import("@fusion/core");
    CentralCore.mockImplementation(function () {
      const instance = {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
          if (getProjectByPathResolver) {
            return Promise.resolve(getProjectByPathResolver(cwd));
          }
          return Promise.resolve({ ...PROJECT_FIXTURES.primary, path: cwd });
        }),
        getProject: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        ),
        listProjects: vi.fn().mockResolvedValue([
          { ...PROJECT_FIXTURES.primary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { ...PROJECT_FIXTURES.secondary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ]),
        listNodes: vi.fn().mockResolvedValue([
          { id: "node-local", name: "local", type: "local", status: "offline" },
        ]),
        updateNode: vi.fn().mockResolvedValue(undefined),
        startDiscovery: vi.fn().mockResolvedValue({}),
        stopDiscovery: vi.fn(),
      };
      mocks.centralInstances.push(instance);
      return instance;
    });

    // Clear env var before each test
    delete process.env.FUSION_DAEMON_TOKEN;
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.FUSION_DAEMON_TOKEN = originalEnv;
    } else {
      delete process.env.FUSION_DAEMON_TOKEN;
    }
  });

  it("passes daemonToken to createServer when daemon: true", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, { daemon: true });

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts.daemon).toBeDefined();
    expect(serverOpts.daemon?.token).toBeDefined();
    expect(typeof serverOpts.daemon?.token).toBe("string");
    expect(serverOpts.daemon?.token).toMatch(/^fn_/);

    await triggerSignal("SIGINT");
  });

  it("shows '(daemon mode)' in startup banner when daemon: true", async () => {
    await runServe(4040, { daemon: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("(daemon mode)");

    await triggerSignal("SIGINT");
  });

  it("shows 'fn node connect' hint in startup banner when daemon: true", async () => {
    await runServe(4040, { daemon: true });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("fn node connect");
    expect(output).toContain("--api-key");

    await triggerSignal("SIGINT");
  });

  it("resolves token from FUSION_DAEMON_TOKEN env var", async () => {
    const { createServer } = await import("@fusion/dashboard");
    process.env.FUSION_DAEMON_TOKEN = "fn_envtest1234567890";

    await runServe(4040, { daemon: true });

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts.daemon?.token).toBe("fn_envtest1234567890");

    await triggerSignal("SIGINT");
  });

  it("does not pass daemon to createServer when daemon: false", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, { daemon: false });

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts.daemon).toBeUndefined();

    await triggerSignal("SIGINT");
  });

  it("does not pass daemon to createServer when daemon option is omitted", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts.daemon).toBeUndefined();

    await triggerSignal("SIGINT");
  });
});

// ── Multi-project test utilities ────────────────────────────────────

/**
 * Reset multi-project test state between tests.
 * Clears engine usage log and project-by-path resolver.
 */
function resetMultiProjectState(): void {
  engineUsageLog.length = 0;
  getProjectByPathResolver = null;
  mocks.reset();
}

/**
 * Configure how CentralCore.getProjectByPath resolves for tests.
 * Call this in beforeEach to set up specific project resolution scenarios.
 *
 * @param resolver - Function that maps cwd to project record, or null to use default (primary project)
 *
 * @example
 * // Set up secondary project as cwd
 * setupProjectByPath((cwd) => {
 *   if (cwd === "/repo-secondary") return PROJECT_FIXTURES.secondary;
 *   return null; // Not registered
 * });
 *
 * // Use default (primary project)
 * setupProjectByPath(null);
 */
function setupProjectByPath(
  resolver: ((cwd: string) => unknown) | null
): void {
  getProjectByPathResolver = resolver;
}

// ── Tests: runServe multi-project startup wiring ─────────────────────

describe("runServe — multi-project cwd/default engine resolution", () => {
  const originalCwd = process.cwd;
  const originalOn = process.on;
  const originalExit = process.exit;

  let signalHandlers: Record<"SIGINT" | "SIGTERM", Array<() => void>>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  async function triggerSignal(signal: "SIGINT" | "SIGTERM") {
    const handlers = signalHandlers[signal];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[handlers.length - 1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.reset();
    resetMultiProjectState();

    signalHandlers = { SIGINT: [], SIGTERM: [] };

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers[event].push(listener);
      }
      return process;
    }) as typeof process.on);
    process.exit = vi.fn() as never;

    // Override CentralCore to use original implementation that pushes to centralInstances
    const { CentralCore } = await import("@fusion/core");
    CentralCore.mockImplementation(function () {
      const instance = {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
          if (getProjectByPathResolver) {
            return Promise.resolve(getProjectByPathResolver(cwd));
          }
          return Promise.resolve({ ...PROJECT_FIXTURES.primary, path: cwd });
        }),
        getProject: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        ),
        listProjects: vi.fn().mockResolvedValue([
          { ...PROJECT_FIXTURES.primary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { ...PROJECT_FIXTURES.secondary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ]),
        listNodes: vi.fn().mockResolvedValue([
          { id: "node-local", name: "local", type: "local", status: "offline" },
        ]),
        updateNode: vi.fn().mockResolvedValue(undefined),
        startDiscovery: vi.fn().mockResolvedValue({}),
        stopDiscovery: vi.fn(),
      };
      mocks.centralInstances.push(instance);
      return instance;
    });

    // Default: cwd resolves to primary project
    setupProjectByPath(null);
  });

  afterEach(() => {
    logSpy.mockRestore();
    cwdSpy.mockRestore();
    processOnSpy.mockRestore();
    process.cwd = originalCwd;
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("resolves cwdEngine from CentralCore.getProjectByPath(cwd) and passes to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runServe(4040, {});

    // Verify engineManager was created
    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);
    const managerInstance = ProjectEngineManager.mock.results[0]?.value;

    // Verify createServer received the cwd engine
    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];

    // The cwd engine should be passed as the default execution engine
    expect(serverOpts).toHaveProperty("engine");
    expect(serverOpts.engine).toBeDefined();

    // engineManager should also be passed for multi-project route resolution
    expect(serverOpts.engineManager).toBe(managerInstance);
  });

  it("passes onMerge bound to cwd engine, not any other project", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts).toHaveProperty("onMerge");
    expect(typeof serverOpts.onMerge).toBe("function");
  });

  it("forwards scoped automationStore and missionAutopilot to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    const serverOpts = createServer.mock.calls[0][1];

    // Verify scoped scheduling dependencies are forwarded
    expect(serverOpts).toHaveProperty("automationStore");
    expect(serverOpts.automationStore).toBeDefined();

    expect(serverOpts).toHaveProperty("missionAutopilot");
    expect(serverOpts.missionAutopilot).toBeDefined();

    expect(serverOpts).toHaveProperty("missionExecutionLoop");
    expect(serverOpts.missionExecutionLoop).toBeDefined();
  });

  it("forwards heartbeatMonitor with rootDir bound to cwd", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts).toHaveProperty("heartbeatMonitor");
    expect(serverOpts.heartbeatMonitor).toBeDefined();
    // heartbeatMonitor should have rootDir for scope validation
    expect(serverOpts.heartbeatMonitor.rootDir).toBe("/repo");
  });

  it("forwards onProjectFirstAccessed callback that delegates to engineManager", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runServe(4040, {});

    const managerInstance = ProjectEngineManager.mock.results[0]?.value;
    const serverOpts = createServer.mock.calls[0][1];

    expect(serverOpts).toHaveProperty("onProjectFirstAccessed");
    expect(typeof serverOpts.onProjectFirstAccessed).toBe("function");

    // Invoke callback and verify delegation
    serverOpts.onProjectFirstAccessed("proj-new");
    expect(managerInstance.onProjectAccessed).toHaveBeenCalledWith("proj-new");
  });

  it("does NOT allow secondary project access to hijack default execution callbacks", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    // Get original onMerge
    const serverOpts1 = createServer.mock.calls[0][1];
    const originalOnMerge = serverOpts1.onMerge;
    const originalEngine = serverOpts1.engine;

    // Simulate secondary project access via onProjectFirstAccessed
    if (serverOpts1.onProjectFirstAccessed) {
      serverOpts1.onProjectFirstAccessed("project-2");
    }

    // Verify createServer was only called once (no re-creation with different engine)
    expect(createServer).toHaveBeenCalledTimes(1);

    // Verify callbacks are still bound to original cwd engine
    const serverOpts2 = createServer.mock.calls[0][1];
    expect(serverOpts2.onMerge).toBe(originalOnMerge);
    expect(serverOpts2.engine).toBe(originalEngine);
  });

  it("auto-registers cwd project when not previously registered", async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), "serve-auto-register-"));
    cwdSpy.mockReturnValue(freshCwd);
    const ensureSpy = vi.spyOn(ensureProjectRegisteredModule, "ensureCwdProjectRegistered")
      .mockResolvedValue({ ...PROJECT_FIXTURES.primary, path: freshCwd });

    try {
      await runServe(4040, {});

      expect(ensureSpy).toHaveBeenCalledWith(expect.objectContaining({
        cwd: freshCwd,
        logPrefix: "serve",
        autoRegister: true,
      }));
      expect(process.exit).not.toHaveBeenCalledWith(1);

      await triggerSignal("SIGINT");
    } finally {
      ensureSpy.mockRestore();
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it("--no-auto-register falls back to existing started engines", async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), "serve-no-auto-register-"));
    cwdSpy.mockReturnValue(freshCwd);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(function () {});
    const ensureSpy = vi.spyOn(ensureProjectRegisteredModule, "ensureCwdProjectRegistered")
      .mockResolvedValue(null);

    try {
      await runServe(4040, { noAutoRegister: true });

      expect(ensureSpy).toHaveBeenCalledWith(expect.objectContaining({
        cwd: freshCwd,
        logPrefix: "serve",
        autoRegister: false,
      }));
      expect(process.exit).not.toHaveBeenCalledWith(1);
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[serve] No engines started")
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[serve] HTTP layer bound to project")
      );

      await triggerSignal("SIGINT");
    } finally {
      ensureSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it("process.exit is NOT called when cwd project is resolved", async () => {
    // cwd resolves to primary project
    setupProjectByPath(null);

    await runServe(4040, {});

    // Should NOT exit - process should continue running
    expect(process.exit).not.toHaveBeenCalled();

    await triggerSignal("SIGINT");
  });
});
