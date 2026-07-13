import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  // GlobalSettingsStore mock
  let globalSettingsData: Record<string, unknown> = {};
  const globalSettingsStoreInstance = {
    getSettings: vi.fn().mockImplementation(() => Promise.resolve({ ...globalSettingsData })),
    updateSettings: vi.fn().mockImplementation((settings: Record<string, unknown>) => {
      globalSettingsData = { ...globalSettingsData, ...settings };
      return Promise.resolve();
    }),
  };

  function createTaskStoreMock() {
    const emitter = new EventEmitter();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([]),
    };
    const pluginStore = pluginStoreCtor();

    return {
      init: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getFusionDir: vi.fn().mockReturnValue("/repo/.fusion"),
      getRootDir: vi.fn().mockReturnValue("/repo"),
      getMissionStore: vi.fn().mockReturnValue(missionStore),
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
      getGlobalSettingsStore: vi.fn(() => globalSettingsStoreInstance),
      updateGlobalSettings: vi.fn().mockImplementation((settings: Record<string, unknown>) => {
        globalSettingsData = { ...globalSettingsData, ...settings };
        return Promise.resolve(globalSettingsData);
      }),
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
      { id: "project-1", name: "Test Project", path: "/repo", status: "active", isolationMode: "in-process", createdAt: now, updatedAt: now },
    ];

    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(projects.find((project) => project.path === path) ?? null),
      ),
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
      ensureProjectForPath: vi.fn().mockImplementation(async ({ path, name, isolationMode }: { path: string; name?: string; isolationMode?: "in-process" | "child-process" }) => ({
        outcome: "registered",
        project: await instance.registerProject({
          name: name ?? "unnamed",
          path,
          isolationMode: isolationMode ?? "in-process",
        }),
      })),
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
      stopPlugin: vi.fn().mockResolvedValue(undefined),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn(),
      getLoadedPlugins: vi.fn().mockReturnValue([]),
    };
    pluginLoaderInstances.push(pluginLoader);
    return pluginLoader;
  });

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

  const projectEngineCtor = vi.fn().mockImplementation(function (runtimeConfig: { workingDirectory: string }, _centralCore: unknown, options: { onInsightRunProcessed?: unknown }) {
    const store = taskStoreCtor(runtimeConfig.workingDirectory);
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

    const engine = {
      start: vi.fn(async () => {
        await store.init();
        await automationStore.init();
        await agentStore.init();
        const settings = await store.getSettings();
        try {
          await syncInsightExtractionAutomationMock(automationStore, settings);
        } catch (err) {
          console.error(`[memory-audit] Failed to sync insight extraction: ${err instanceof Error ? err.message : String(err)}`);
        }
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
    projectEngineInstances,
    listenCalls,
    globalSettingsStoreInstance,
    globalSettingsData,
    taskStoreCtor,
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
      globalSettingsData = {};
      syncInsightExtractionAutomationMock.mockReset();
      syncInsightExtractionAutomationMock.mockResolvedValue(undefined);
      processAndAuditInsightExtractionMock.mockClear();
      createAiPromptExecutorMock.mockClear();
      refreshAllCustomProviderModels.mockReset();
      refreshAllCustomProviderModels.mockResolvedValue({ refreshed: 0, failed: 0, skipped: 0 });
      globalSettingsStoreInstance.getSettings.mockReset();
      globalSettingsStoreInstance.getSettings.mockImplementation(() => Promise.resolve({ ...globalSettingsData }));
    },
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCliCoreMock } = await import("../../test/mockCoreEngine");
  return createCliCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
  TaskStore: mocks.taskStoreCtor,
  AutomationStore: mocks.automationStoreCtor,
  AgentStore: mocks.agentStoreCtor,
  CentralCore: mocks.centralCoreCtor,
  PluginStore: mocks.pluginStoreCtor,
  PluginLoader: mocks.pluginLoaderCtor,
  GlobalSettingsStore: vi.fn().mockImplementation(function () {
    return mocks.globalSettingsStoreInstance;
  }),
  resolveGlobalDir: vi.fn().mockReturnValue("/home/user/.fusion"),
  getEnabledPiExtensionPaths: vi.fn(() => []),
  DaemonTokenManager: vi.fn().mockImplementation(function () {
    return {
      getToken: vi.fn().mockImplementation(() => Promise.resolve(mocks.globalSettingsData.daemonToken as string | undefined)),
      generateToken: vi.fn().mockImplementation(function () {
        const token = "fn_a1b2c3d4e5f6789012345678901234ab";
        mocks.globalSettingsData.daemonToken = token;
        return Promise.resolve(token);
      }),
    };
  }),
  getTaskMergeBlocker: vi.fn().mockReturnValue(null),
  syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomationMock,
  INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction",
  processAndAuditInsightExtraction: mocks.processAndAuditInsightExtractionMock,
  });
});

vi.mock("@fusion/dashboard", () => ({
  // FNXC:CliTests 2026-07-13-08:10: @fusion/dashboard barrel re-exports cli-package-version helpers; mock must surface them for startup model sync.
isUnresolvedCliPackageVersion: vi.fn(() => false),
resolveCliPackageVersionInfo: vi.fn(() => ({ version: "0.0.0-test", isUnresolved: false })),
  getCliPackageVersion: vi.fn(() => "0.0.0"),
  // FNXC:CliTests 2026-07-13-08:00: getCliPackageVersion added to @fusion/dashboard barrel export; mock must surface it for daemon/serve startup model sync.
  createServer: mocks.createServerMock,
  GitHubClient: vi.fn().mockImplementation(function () {
    return {};
  }),
  createSkillsAdapter: vi.fn().mockReturnValue(undefined),
  getProjectSettingsPath: vi.fn().mockReturnValue("/tmp/project/.fusion/settings.json"),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
  refreshAllCustomProviderModels: mocks.refreshAllCustomProviderModels,
  // FNXC:CliTests 2026-07-13-09:40: Missing dashboard barrel exports added for mock completeness (scripts/check-cli-dashboard-mock-completeness.mjs gate).
  registerGithubTrackingHook: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const { createCliEngineMock } = await import("../../test/mockCoreEngine");
  return createCliEngineMock(() => importOriginal<typeof import("@fusion/engine")>(), {
    createFusionAuthStorage: vi.fn(() => mocks.authStorage),
    ProjectEngine: mocks.projectEngineCtor,
    ProjectEngineManager: vi.fn().mockImplementation(function (centralCore: any, options: any) {
    const engines = new Map<string, any>();
    return {
      startAll: vi.fn(async () => {
        const projects = await centralCore.listProjects();
        for (const project of projects) {
          const engine = mocks.projectEngineCtor(
            { projectId: project.id, workingDirectory: project.path, isolationMode: "in-process", maxConcurrent: 4, maxWorktrees: 10 },
            centralCore,
            { ...options, projectId: project.id },
          );
          await engine.start();
          engines.set(project.id, engine);
        }
      }),
      getEngine: vi.fn((id: string) => engines.get(id)),
      getAllEngines: vi.fn(() => engines),
      getStore: vi.fn((id: string) => engines.get(id)?.getTaskStore()),
      has: vi.fn((id: string) => engines.has(id)),
      ensureEngine: vi.fn(async (id: string) => engines.get(id)),
      stopAll: vi.fn(async () => {
        for (const engine of engines.values()) await engine.stop();
        engines.clear();
      }),
      onProjectAccessed: vi.fn(),
      startReconciliation: vi.fn(),
    };
  }),
  PeerExchangeService: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      updateGlobalSettings: vi.fn(),
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

const { runDaemon } = await import("../daemon.js");

describe("runDaemon", () => {
  it("invokes shared startup model sync", async () => {
    const { runDaemon } = await import("../daemon.js");
    await runDaemon({});
    expect(mockSyncStartupModels).toHaveBeenCalledTimes(1);
  });

  it("registers built-in zai GLM-5.2 before refreshing models", async () => {
    await runDaemon({});

    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith("zai", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "glm-5.2" })]),
    }));
    expect(mocks.modelRegistry.refresh).toHaveBeenCalled();

    await triggerSignal("SIGINT");
  });

  it("starts daemon before background custom provider refresh settles", async () => {
    mocks.refreshAllCustomProviderModels.mockImplementationOnce(() => new Promise(() => undefined));
    mocks.globalSettingsStoreInstance.getSettings.mockResolvedValue({
      customProviders: [{
        id: "cp-1",
        name: "Custom Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "configured-model", name: "Configured model" }],
      }],
    });

    await runDaemon({});

    expect(mocks.refreshAllCustomProviderModels).toHaveBeenCalledTimes(1);
    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith(
      expect.stringContaining("custom-proxy"),
      expect.objectContaining({ models: [expect.objectContaining({ id: "configured-model" })] }),
    );

    await triggerSignal("SIGINT");
  });

  it("continues startup provider registration when custom provider refresh fails", async () => {
    mocks.refreshAllCustomProviderModels.mockRejectedValueOnce(new Error("provider offline"));
    mocks.globalSettingsStoreInstance.getSettings.mockResolvedValue({
      customProviders: [{
        id: "cp-1",
        name: "Custom Proxy",
        apiType: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "configured-model", name: "Configured model" }],
      }],
    });

    await runDaemon({});

    expect(mocks.refreshAllCustomProviderModels).toHaveBeenCalledTimes(1);
    expect(mocks.modelRegistry.registerProvider).toHaveBeenCalledWith(
      expect.stringContaining("custom-proxy"),
      expect.objectContaining({ models: [expect.objectContaining({ id: "configured-model" })] }),
    );

    await triggerSignal("SIGINT");
  });
  const originalCwd = process.cwd;
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
    process.exit = originalExit;
  });

  it("initializes stores, starts engine services, and creates a headless server with daemon auth", async () => {
    await runDaemon({});

    expect(mocks.taskStoreCtor).toHaveBeenCalledWith("/repo");
    expect(mocks.taskStores[0].init).toHaveBeenCalledTimes(1);
    expect(mocks.taskStores[0].watch).toHaveBeenCalledTimes(1);

    expect(mocks.createServerMock).toHaveBeenCalledTimes(1);
    const serverOptions = mocks.createServerMock.mock.calls[0][1];
    expect(serverOptions).toMatchObject({
      headless: true,
    });
    // Verify daemon token was passed
    expect(serverOptions.daemon).toBeDefined();
    expect(typeof serverOptions.daemon.token).toBe("string");
    expect(serverOptions.daemon.token.startsWith("fn_")).toBe(true);

    expect(mocks.triageInstances[0].start).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerInstances[0].start).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  // FNXC:DaemonSignalExit 2026-07-10-14:00: a memory-pressure SIGTERM must exit
  // non-zero (128+signal) so a `Restart=on-failure` supervisor restarts the
  // daemon instead of treating the kill as a clean stop. Regression for the
  // "daemon exits clean under memory pressure and isn't restarted" report.
  it("exits 143 on SIGTERM-initiated shutdown", async () => {
    await runDaemon({});
    await triggerSignal("SIGTERM");
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  it("exits 130 on SIGINT-initiated shutdown", async () => {
    await runDaemon({});
    await triggerSignal("SIGINT");
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it("auto-loads installed plugins during startup", async () => {
    const { PluginLoader } = await import("@fusion/core");

    await runDaemon({});

    const loaderInstance = (PluginLoader as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value as
      | { loadAllPlugins: ReturnType<typeof vi.fn> }
      | undefined;
    expect(loaderInstance?.loadAllPlugins).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("continues startup when plugin auto-load fails", async () => {
    const { PluginLoader } = await import("@fusion/core");
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

    await expect(runDaemon({})).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[plugins] Failed to load plugins: plugin load failed")
    );

    await triggerSignal("SIGINT");
  });

  it("passes provided token to createServer daemon option", async () => {
    const providedToken = "fn_custom_token_1234567890123456";

    await runDaemon({ token: providedToken });

    expect(mocks.createServerMock).toHaveBeenCalledTimes(1);
    const serverOptions = mocks.createServerMock.mock.calls[0][1];
    expect(serverOptions.daemon).toBeDefined();
    expect(serverOptions.daemon.token).toBe(providedToken);

    await triggerSignal("SIGINT");
  });

  it("generates a token when none exists", async () => {
    // No existing token in mock data - clear it first
    mocks.globalSettingsData = {};

    await runDaemon({});

    expect(mocks.createServerMock).toHaveBeenCalledTimes(1);
    const serverOptions = mocks.createServerMock.mock.calls[0][1];
    expect(serverOptions.daemon).toBeDefined();
    expect(serverOptions.daemon.token).toMatch(/^fn_[a-f0-9]{32}$/);

    await triggerSignal("SIGINT");
  });

  it("prints banner with masked token at startup (full token never hits stdout)", async () => {
    const providedToken = "fn_fulltoken12345678901234567890";

    await runDaemon({ token: providedToken });

    // Banner should contain a MASKED form, not the raw token. The full token
    // is persisted to ~/.fusion/settings.json (chmod 0600) and retrievable via
    // `fn daemon --token-only` — printing it here would leak it to terminal
    // scrollback and CI logs.
    const allBannerArgs = logSpy.mock.calls.map((args) => String(args[0] ?? ""));
    const banner = allBannerArgs.join("\n");
    expect(banner).not.toContain(providedToken);
    expect(banner).toContain("fn_ful");
    expect(banner).toContain("7890");
    expect(banner).toContain("fn daemon --token-only");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Fusion Daemon"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("bearer token required"));

    await triggerSignal("SIGINT");
  });

  it("passes daemon token option with enginePaused when paused=true", async () => {
    await runDaemon({ paused: true });

    expect(mocks.taskStores[0].updateSettings).toHaveBeenCalledWith({ enginePaused: true });

    expect(mocks.createServerMock).toHaveBeenCalledTimes(1);
    const serverOptions = mocks.createServerMock.mock.calls[0][1];
    expect(serverOptions.daemon).toBeDefined();
    expect(serverOptions.daemon.token).toBeDefined();

    await triggerSignal("SIGINT");
  });

  it("listens on port 0 for random assignment by default", async () => {
    await runDaemon({});

    expect(mocks.listenCalls[0]).toMatchObject({
      port: 0,
      host: "127.0.0.1",
    });

    await triggerSignal("SIGINT");
  });

  it("respects custom port and host options", async () => {
    await runDaemon({ port: 8080, host: "127.0.0.1" });

    expect(mocks.listenCalls[0]).toMatchObject({
      port: 8080,
      host: "127.0.0.1",
    });

    await triggerSignal("SIGINT");
  });

  it("auto-registers cwd project when not previously registered", async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), "daemon-auto-register-"));
    cwdSpy.mockReturnValue(freshCwd);

    try {
      await runDaemon({});

      const registrationCalls = mocks.centralInstances.flatMap((instance) =>
        instance.registerProject.mock.calls,
      );
      expect(registrationCalls).toContainEqual([
        expect.objectContaining({ path: freshCwd, isolationMode: "in-process" }),
      ]);

      const updateCalls = mocks.centralInstances.flatMap((instance) =>
        instance.updateProject.mock.calls,
      );
      expect(updateCalls).toContainEqual([expect.any(String), { status: "active" }]);
      expect(process.exit).not.toHaveBeenCalledWith(1);

      await triggerSignal("SIGINT");
    } finally {
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it("--no-auto-register falls back to existing started engines", async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), "daemon-no-auto-register-"));
    cwdSpy.mockReturnValue(freshCwd);

    try {
      await runDaemon({ noAutoRegister: true });

      const registrationCalls = mocks.centralInstances.flatMap((instance) =>
        instance.registerProject.mock.calls,
      );
      expect(registrationCalls).toHaveLength(0);
      expect(process.exit).not.toHaveBeenCalledWith(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[daemon] HTTP layer bound to project")
      );

      await triggerSignal("SIGINT");
    } finally {
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });

  it("stops engine services during shutdown", async () => {
    await runDaemon({});
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
    expect(listenCall.server.close).toHaveBeenCalledTimes(1);
    expect(mocks.taskStores[0].close).toHaveBeenCalledTimes(1);
  });

  it("enables HybridExecutor with env override and shuts down before engine stop", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "1";
    mockShouldUseHybridExecutor.mockResolvedValue({ enabled: true, reason: "env-override" });

    await runDaemon({});
    expect(mockHybridExecutorCtor).toHaveBeenCalledTimes(1);
    expect(mockHybridExecutorInitialize).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGTERM");

    expect(mockHybridExecutorShutdown).toHaveBeenCalledTimes(1);
    expect(mockHybridExecutorShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.projectEngineInstances[0].stop.mock.invocationCallOrder[0],
    );
    delete process.env.FUSION_HYBRID_EXECUTOR;
  });
});

describe("runDaemon --token-only mode", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();

    logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(function () {});
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    processExitSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it("generates and prints token, then exits", async () => {
    // Clear any existing token
    mocks.globalSettingsData = {};

    // Expect process.exit(0) to be called
    await expect(runDaemon({ tokenOnly: true })).rejects.toThrow("process.exit:0");

    // Should print the generated token
    expect(logSpy).toHaveBeenCalled();
    const tokenCall = logSpy.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].startsWith("fn_")
    );
    expect(tokenCall).toBeDefined();
    expect((tokenCall as string[])[0]).toMatch(/^fn_[a-f0-9]{32}$/);

    // Should exit with code 0
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("prints existing token without generating new one", async () => {
    const existingToken = "fn_existingtoken1234567890123456";
    mocks.globalSettingsData.daemonToken = existingToken;

    // Expect process.exit(0) to be called
    await expect(runDaemon({ tokenOnly: true })).rejects.toThrow("process.exit:0");

    // Should print the existing token
    expect(logSpy).toHaveBeenCalledWith(existingToken);

    // Should exit with code 0
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
