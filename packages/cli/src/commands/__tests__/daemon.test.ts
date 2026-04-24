import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

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

    return {
      init: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getFusionDir: vi.fn().mockReturnValue("/repo/.fusion"),
      getMissionStore: vi.fn().mockReturnValue(missionStore),
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

  const taskStoreCtor = vi.fn().mockImplementation(() => {
    const store = createTaskStoreMock();
    taskStores.push(store);
    return store;
  });

  const automationStoreCtor = vi.fn().mockImplementation(() => {
    const automationStore = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    automationStores.push(automationStore);
    return automationStore;
  });

  const agentStoreCtor = vi.fn().mockImplementation(() => {
    const agentStore = {
      init: vi.fn().mockResolvedValue(undefined),
    };
    agentStores.push(agentStore);
    return agentStore;
  });

  const centralCoreCtor = vi.fn().mockImplementation(() => {
    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockResolvedValue({ id: "project-1" }),
      getProject: vi.fn().mockImplementation((id: string) =>
        Promise.resolve({ id, name: `Project ${id}`, path: `/repo/${id}`, status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      ),
      listProjects: vi.fn().mockResolvedValue([
        { id: "project-1", name: "Test Project", path: "/repo", status: "active", isolationMode: "in-process", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]),
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

  const triageCtor = vi.fn().mockImplementation(() => {
    const triage = {
      start: vi.fn(),
      stop: vi.fn(),
      markStuckAborted: vi.fn(),
    };
    triageInstances.push(triage);
    return triage;
  });

  const executorCtor = vi.fn().mockImplementation(() => {
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

  const schedulerCtor = vi.fn().mockImplementation(() => {
    const scheduler = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    schedulerInstances.push(scheduler);
    return scheduler;
  });

  const stuckDetectorCtor = vi.fn().mockImplementation(() => {
    const detector = {
      start: vi.fn(),
      stop: vi.fn(),
      checkNow: vi.fn().mockResolvedValue(undefined),
    };
    stuckDetectorInstances.push(detector);
    return detector;
  });

  const selfHealingCtor = vi.fn().mockImplementation(() => {
    const manager = {
      start: vi.fn(),
      stop: vi.fn(),
      checkStuckBudget: vi.fn().mockResolvedValue(true),
    };
    selfHealingInstances.push(manager);
    return manager;
  });

  const cronRunnerCtor = vi.fn().mockImplementation(() => {
    const cron = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    cronRunnerInstances.push(cron);
    return cron;
  });

  const missionAutopilotCtor = vi.fn().mockImplementation(() => {
    const autopilot = {
      start: vi.fn(),
      stop: vi.fn(),
      setScheduler: vi.fn(),
    };
    missionAutopilotInstances.push(autopilot);
    return autopilot;
  });

  const missionExecutionLoopCtor = vi.fn().mockImplementation(() => {
    const loop = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      processTaskOutcome: vi.fn().mockResolvedValue(undefined),
      recoverActiveMissions: vi.fn().mockResolvedValue(undefined),
    };
    missionExecutionLoopInstances.push(loop);
    return loop;
  });

  const notifierCtor = vi.fn().mockImplementation(() => {
    const notifier = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    notifierInstances.push(notifier);
    return notifier;
  });

  const pluginStoreCtor = vi.fn().mockImplementation(() => {
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

  const pluginLoaderCtor = vi.fn().mockImplementation(() => {
    const pluginLoader = {
      loadPlugin: vi.fn().mockResolvedValue(undefined),
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

  const agentSemaphoreCtor = vi.fn().mockImplementation(() => ({
    _active: 0,
    run: (fn: () => Promise<unknown>) => fn(),
  }));

  const heartbeatMonitorCtor = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    startRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
    stopRun: vi.fn().mockResolvedValue(undefined),
  }));

  const heartbeatTriggerSchedulerCtor = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    registerAgent: vi.fn(),
    getRegisteredAgents: vi.fn().mockReturnValue([]),
  }));

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

  const projectEngineCtor = vi.fn().mockImplementation((runtimeConfig: { workingDirectory: string }, _centralCore: unknown, options: { onInsightRunProcessed?: unknown }) => {
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
    },
  };
});

vi.mock("@fusion/core", () => ({
  TaskStore: mocks.taskStoreCtor,
  AutomationStore: mocks.automationStoreCtor,
  AgentStore: mocks.agentStoreCtor,
  CentralCore: mocks.centralCoreCtor,
  PluginStore: mocks.pluginStoreCtor,
  PluginLoader: mocks.pluginLoaderCtor,
  GlobalSettingsStore: vi.fn().mockImplementation(() => mocks.globalSettingsStoreInstance),
  resolveGlobalDir: vi.fn().mockReturnValue("/home/user/.fusion"),
  getEnabledPiExtensionPaths: vi.fn(() => []),
  DaemonTokenManager: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockImplementation(() => Promise.resolve(mocks.globalSettingsData.daemonToken as string | undefined)),
    generateToken: vi.fn().mockImplementation(() => {
      const token = "fn_a1b2c3d4e5f6789012345678901234ab";
      mocks.globalSettingsData.daemonToken = token;
      return Promise.resolve(token);
    }),
  })),
  getTaskMergeBlocker: vi.fn().mockReturnValue(null),
  syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomationMock,
  INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction",
  processAndAuditInsightExtraction: mocks.processAndAuditInsightExtractionMock,
}));

vi.mock("@fusion/dashboard", () => ({
  createServer: mocks.createServerMock,
  GitHubClient: vi.fn().mockImplementation(() => ({})),
  createSkillsAdapter: vi.fn().mockReturnValue(undefined),
  getProjectSettingsPath: vi.fn().mockReturnValue("/tmp/project/.fusion/settings.json"),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@fusion/engine", () => ({
  ProjectEngine: mocks.projectEngineCtor,
  ProjectEngineManager: vi.fn().mockImplementation((centralCore: any, options: any) => {
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
  PeerExchangeService: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  TriageProcessor: mocks.triageCtor,
  TaskExecutor: mocks.executorCtor,
  Scheduler: mocks.schedulerCtor,
  AgentSemaphore: mocks.agentSemaphoreCtor,
  WorktreePool: vi.fn().mockImplementation(() => ({
    rehydrate: vi.fn(),
  })),
  aiMergeTask: vi.fn().mockResolvedValue({ merged: true }),
  UsageLimitPauser: vi.fn().mockImplementation(() => ({})),
  PRIORITY_MERGE: 100,
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  NtfyNotifier: mocks.notifierCtor,
  PrMonitor: vi.fn().mockImplementation(() => ({
    onNewComments: vi.fn(),
  })),
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
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mocks.authStorage),
  },
  DefaultPackageManager: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({ extensions: [] }),
  })),
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
}));

const { runDaemon } = await import("../daemon.js");

describe("runDaemon", () => {
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

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

  it("stops engine services during shutdown", async () => {
    await runDaemon({});

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
});

describe("runDaemon --token-only mode", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
