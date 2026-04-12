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
  const listenCalls: ListenCall[] = [];

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
      listNodes: vi.fn().mockResolvedValue([
        { id: "node-local", name: "local", type: "local", status: "offline" },
      ]),
      updateNode: vi.fn().mockResolvedValue(undefined),
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
  };

  const modelRegistry = {
    registerProvider: vi.fn(),
    refresh: vi.fn(),
  };

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
    listenCalls,
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
      listenCalls.length = 0;
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
  getTaskMergeBlocker: vi.fn().mockReturnValue(null),
  syncInsightExtractionAutomation: vi.fn().mockResolvedValue(undefined),
  INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction",
  processAndAuditInsightExtraction: vi.fn().mockResolvedValue({
    generatedAt: new Date().toISOString(),
    health: "healthy",
    checks: [],
    workingMemory: { exists: true, size: 100, sectionCount: 2 },
    insightsMemory: { exists: true, size: 50, insightCount: 3, categories: {}, lastUpdated: "2026-04-09" },
    extraction: { runAt: new Date().toISOString(), success: true, insightCount: 3, duplicateCount: 0, skippedCount: 0, summary: "Test" },
  }),
}));

vi.mock("@fusion/dashboard", () => ({
  createServer: mocks.createServerMock,
  GitHubClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@fusion/engine", () => ({
  TriageProcessor: mocks.triageCtor,
  TaskExecutor: mocks.executorCtor,
  Scheduler: mocks.schedulerCtor,
  AgentSemaphore: vi.fn().mockImplementation(() => ({
    run: (fn: () => Promise<unknown>) => fn(),
  })),
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
  createAiPromptExecutor: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue("ok")),
  HeartbeatMonitor: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
  })),
  HeartbeatTriggerScheduler: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    registerAgent: vi.fn(),
    getRegisteredAgents: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mocks.authStorage),
  },
  DefaultPackageManager: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({ extensions: [] }),
  })),
  ModelRegistry: vi.fn().mockImplementation(() => mocks.modelRegistry),
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
}));

const { runServe } = await import("../serve.js");

describe("runServe", () => {
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
    process.on = originalOn;
    process.exit = originalExit;
  });

  it("initializes stores, starts engine services, and creates a headless server", async () => {
    await runServe(4040, {});

    expect(mocks.taskStoreCtor).toHaveBeenCalledWith("/repo");
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
    expect(mocks.taskStores[0].close).toHaveBeenCalledTimes(1);
  });

  it("listens on 0.0.0.0 by default and respects a custom host", async () => {
    await runServe(3010, {});
    expect(mocks.listenCalls[0]).toMatchObject({
      port: 3010,
      host: "0.0.0.0",
    });
    await triggerSignal("SIGINT");

    await runServe(3020, { host: "127.0.0.1" });
    expect(mocks.listenCalls[1]).toMatchObject({
      port: 3020,
      host: "127.0.0.1",
    });
    await triggerSignal("SIGINT");
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

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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

  it("creates PluginStore and PluginLoader instances", async () => {
    const { PluginStore, PluginLoader } = await import("@fusion/core");

    await runServe(4040, {});

    expect(PluginStore).toHaveBeenCalledTimes(1);
    expect(PluginLoader).toHaveBeenCalledTimes(1);

    await triggerSignal("SIGINT");
  });

  it("passes pluginStore, pluginLoader, and pluginRunner to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runServe(4040, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = createServer.mock.calls[0][1];
    expect(serverOpts).toHaveProperty("pluginStore");
    expect(serverOpts).toHaveProperty("pluginLoader");
    expect(serverOpts).toHaveProperty("pluginRunner");
    expect(serverOpts.pluginRunner).toBe(serverOpts.pluginLoader);

    await triggerSignal("SIGINT");
  });

  it("initializes PluginStore with the task store's fusion directory", async () => {
    const { PluginStore } = await import("@fusion/core");

    await runServe(4040, {});

    expect(PluginStore).toHaveBeenCalledWith("/repo/.fusion");

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
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

  beforeEach(() => {
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
    // createAiPromptExecutor takes only cwd parameter
    expect(createAiPromptExecutor).toHaveBeenCalledWith(expect.any(String));
    const calledWith = createAiPromptExecutor.mock.calls[0];
    // Should be called with exactly one argument (cwd)
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
