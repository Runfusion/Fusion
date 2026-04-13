import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Capture arguments ───────────────────────────────────────────────

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore() {
  const emitter = new EventEmitter();
  // runDashboard registers several independent settings listeners by design;
  // keep the test mock above Node's low default threshold while still checking
  // startup wiring behavior.
  emitter.setMaxListeners(20);
  const mockMissionStore = {
    listMissions: vi.fn().mockReturnValue([]),
    getMission: vi.fn(),
    updateMission: vi.fn(),
    listMilestones: vi.fn().mockReturnValue([]),
    listFeatures: vi.fn().mockReturnValue([]),
  };
  return {
    init: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
    close: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: false,
      pollIntervalMs: 60_000,
      openrouterModelSync: true,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    getMissionStore: vi.fn().mockReturnValue(mockMissionStore),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.off(event, handler);
    }),
    emit: emitter.emit.bind(emitter),
  };
}

// ── Mock @fusion/core ──────────────────────────────────────────────────

const mockSyncInsightExtraction = vi.fn().mockResolvedValue(undefined);
const mockProcessAndAudit = vi.fn().mockResolvedValue({
  generatedAt: new Date().toISOString(),
  health: "healthy",
  checks: [],
  workingMemory: { exists: true, size: 100, sectionCount: 2 },
  insightsMemory: { exists: true, size: 50, insightCount: 3, categories: {}, lastUpdated: "2026-04-09" },
  extraction: { runAt: new Date().toISOString(), success: true, insightCount: 3, duplicateCount: 0, skippedCount: 0, summary: "Test" },
});

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
  CentralCore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getProjectByPath: vi.fn().mockResolvedValue({ id: "project-1" }),
  })),
  AutomationStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    listSchedules: vi.fn().mockResolvedValue([]),
    getDueSchedules: vi.fn().mockResolvedValue([]),
  })),
  AgentStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    createAgent: vi.fn(),
    updateAgentState: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    deleteAgent: vi.fn(),
  })),
  PluginStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue([]),
    getPlugin: vi.fn(),
    registerPlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    updatePluginSettings: vi.fn(),
    unregisterPlugin: vi.fn(),
    updatePluginState: vi.fn(),
  })),
  PluginLoader: vi.fn().mockImplementation(() => ({
    loadPlugin: vi.fn().mockResolvedValue(undefined),
    stopPlugin: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
    getPluginRoutes: vi.fn().mockReturnValue([]),
    getPlugin: vi.fn(),
    getLoadedPlugins: vi.fn().mockReturnValue([]),
  })),
  getTaskMergeBlocker: vi.fn().mockReturnValue(undefined),
  syncInsightExtractionAutomation: mockSyncInsightExtraction,
  INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction",
  processAndAuditInsightExtraction: mockProcessAndAudit,
}));

// ── Mock @fusion/dashboard ─────────────────────────────────────────────

/** Create a mock server (EventEmitter) that simulates net.Server behavior. */
function createMockServer(portToReturn: number = 0) {
  const emitter = new EventEmitter();
  const server = Object.assign(emitter, {
    listen: vi.fn((_port?: number) => {
      process.nextTick(() => emitter.emit("listening"));
      return server;
    }),
    address: vi.fn(() => ({ port: portToReturn, family: "IPv4", address: "127.0.0.1" })),
    close: vi.fn(),
  });
  return server;
}

const mockListen = vi.fn((port: number) => {
  const server = createMockServer(port);
  process.nextTick(() => server.emit("listening"));
  return server;
});

const MockGitHubClient = vi.fn().mockImplementation(() => ({
  findPrForBranch: vi.fn(),
  createPr: vi.fn(),
  getPrMergeStatus: vi.fn(),
  mergePr: vi.fn(),
}));

vi.mock("@fusion/dashboard", () => ({
  createServer: vi.fn(() => ({ listen: mockListen })),
  GitHubClient: MockGitHubClient,
}));

// ── Mock @fusion/engine ────────────────────────────────────────────────

vi.mock("@fusion/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...original,
    WorktreePool: original.WorktreePool,
    AgentSemaphore: original.AgentSemaphore,
    ProjectEngine: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getTaskStore: vi.fn().mockImplementation(() => makeMockStore()),
      getRuntime: vi.fn().mockReturnValue({
        getHeartbeatMonitor: vi.fn().mockReturnValue(undefined),
        getMissionAutopilot: vi.fn().mockReturnValue(undefined),
        getMissionExecutionLoop: vi.fn().mockReturnValue(undefined),
      }),
      getAutomationStore: vi.fn().mockReturnValue(undefined),
      getHeartbeatMonitor: vi.fn().mockReturnValue(undefined),
      getHeartbeatTriggerScheduler: vi.fn().mockReturnValue(undefined),
      getWorkingDirectory: vi.fn().mockReturnValue("/tmp/test"),
      onMerge: vi.fn().mockResolvedValue({ merged: true }),
    })),
    MissionAutopilot: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      setScheduler: vi.fn(),
    })),
    TriageProcessor: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    TaskExecutor: vi.fn().mockImplementation(() => ({
      resumeOrphaned: vi.fn().mockResolvedValue(undefined),
    })),
    Scheduler: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    aiMergeTask: vi.fn().mockResolvedValue({ merged: true }),
    CronRunner: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
    cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
    createAiPromptExecutor: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue("mock AI response")),
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
  };
});

// ── Mock @mariozechner/pi-coding-agent ──────────────────────────────

const mockAuthStorage = {
  getAuth: vi.fn(),
  setAuth: vi.fn(),
  getApiKey: vi.fn(),
  reload: vi.fn(),
  getOAuthProviders: vi.fn().mockReturnValue([{ id: "anthropic", name: "Anthropic" }]),
  hasAuth: vi.fn().mockReturnValue(false),
  login: vi.fn(),
  logout: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  get: vi.fn(),
};
const mockModelRegistry = {
  getModels: vi.fn().mockResolvedValue([]),
  getAll: vi.fn().mockReturnValue([]),
  registerProvider: vi.fn(),
  refresh: vi.fn(),
};
const mockDiscoverAndLoadExtensions = vi.fn().mockResolvedValue({
  runtime: { pendingProviderRegistrations: [] },
  errors: [],
});
const mockCreateExtensionRuntime = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mockAuthStorage),
  },
  DefaultPackageManager: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({ extensions: [] }),
  })),
  ModelRegistry: vi.fn().mockImplementation(() => mockModelRegistry),
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  getAgentDir: vi.fn(() => "/mock/agent/dir"),
  discoverAndLoadExtensions: mockDiscoverAndLoadExtensions,
  createExtensionRuntime: mockCreateExtensionRuntime,
}));

// ── Import module under test (after mocks) ──────────────────────────

const { runDashboard: runDashboardImpl } = await import("../dashboard.js");
const dashboardDisposables: Array<() => void> = [];

function disposeTrackedDashboards(): void {
  for (const dispose of dashboardDisposables.splice(0)) {
    dispose();
  }
}

async function runDashboard(...args: Parameters<typeof runDashboardImpl>): ReturnType<typeof runDashboardImpl> {
  disposeTrackedDashboards();
  const result = await runDashboardImpl(...args);
  dashboardDisposables.push(result.dispose);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

afterEach(() => {
  disposeTrackedDashboards();
});

describe("runDashboard — AuthStorage & ModelRegistry wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("passes wrapped authStorage and modelRegistry to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("modelRegistry", mockModelRegistry);
    expect(serverOpts.authStorage).toBeDefined();
    expect(serverOpts.authStorage).not.toBe(mockAuthStorage);
    expect(serverOpts.authStorage.getApiKeyProviders).toBeTypeOf("function");
    expect(serverOpts.authStorage.setApiKey).toBeTypeOf("function");
    expect(serverOpts.authStorage.clearApiKey).toBeTypeOf("function");
    expect(serverOpts.authStorage.hasApiKey).toBeTypeOf("function");
  });

  it("creates AuthStorage via AuthStorage.create()", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, {});

    expect(AuthStorage.create).toHaveBeenCalledTimes(1);
  });

  it("creates ModelRegistry with the authStorage instance", async () => {
    const { ModelRegistry } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, {});

    expect(ModelRegistry).toHaveBeenCalledTimes(1);
    expect(ModelRegistry).toHaveBeenCalledWith(mockAuthStorage);
  });

  it("discovers extensions and registers extension providers", async () => {
    mockDiscoverAndLoadExtensions.mockResolvedValueOnce({
      runtime: {
        pendingProviderRegistrations: [
          {
            name: "custom-anthropic",
            config: { models: [{ id: "claude-sonnet-4-5" }] },
            extensionPath: "/extensions/custom-anthropic",
          },
        ],
      },
      errors: [],
    });

    await runDashboard(0, {});

    expect(mockDiscoverAndLoadExtensions).toHaveBeenCalledWith([], expect.any(String), undefined);
    expect(mockModelRegistry.registerProvider).toHaveBeenCalledWith(
      "custom-anthropic",
      expect.objectContaining({ models: [{ id: "claude-sonnet-4-5" }] }),
    );
    expect(mockModelRegistry.refresh).toHaveBeenCalled();
  });

  it("logs extension load errors without aborting startup", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverAndLoadExtensions.mockResolvedValueOnce({
      runtime: { pendingProviderRegistrations: [] },
      errors: [{ path: "/extensions/bad", error: "Invalid manifest" }],
    });

    await runDashboard(0, {});

    expect(consoleSpy).toHaveBeenCalledWith("[extensions] Failed to load /extensions/bad: Invalid manifest");
    consoleSpy.mockRestore();
  });

  it("falls back gracefully when extension discovery throws", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverAndLoadExtensions.mockRejectedValueOnce(new Error("boom"));

    await runDashboard(0, {});

    expect(mockCreateExtensionRuntime).toHaveBeenCalledTimes(1);
    expect(mockModelRegistry.refresh).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("[extensions] Failed to discover extensions: boom");
    consoleSpy.mockRestore();
  });

  it("logs provider registration errors without aborting startup", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDiscoverAndLoadExtensions.mockResolvedValueOnce({
      runtime: {
        pendingProviderRegistrations: [
          {
            name: "duplicate-provider",
            config: { models: [{ id: "model-a" }] },
            extensionPath: "/extensions/duplicate-provider",
          },
        ],
      },
      errors: [],
    });
    mockModelRegistry.registerProvider.mockImplementationOnce(() => {
      throw new Error("duplicate provider");
    });

    await runDashboard(0, {});

    expect(consoleSpy).toHaveBeenCalledWith(
      "[extensions] Failed to register provider from /extensions/duplicate-provider: duplicate provider",
    );
    expect(mockModelRegistry.refresh).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("skips OpenRouter model sync when openrouterModelSync is false", async () => {
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      ...makeMockStore(),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 1,
        maxWorktrees: 2,
        autoMerge: false,
        pollIntervalMs: 60_000,
        openrouterModelSync: false,
      }),
    }));

    await runDashboard(0, {});

    expect(mockAuthStorage.getApiKey).not.toHaveBeenCalled();
  });
});

describe("runDashboard — non-dev mode engine wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("passes engine to createServer (non-dev mode)", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngine } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(ProjectEngine).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("engine");
    expect(serverOpts.engine).toBeDefined();
  });
});

describe("runDashboard — Plugin wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("creates PluginStore and PluginLoader instances", async () => {
    const { PluginStore, PluginLoader } = await import("@fusion/core");

    await runDashboard(0, {});

    expect(PluginStore).toHaveBeenCalledTimes(1);
    expect(PluginLoader).toHaveBeenCalledTimes(1);
  });

  it("passes pluginStore, pluginLoader, and pluginRunner to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    
    expect(serverOpts.pluginStore).toBeDefined();
    expect(serverOpts.pluginLoader).toBeDefined();
    expect(serverOpts.pluginRunner).toBeDefined();
    
    // pluginRunner should be the same instance as pluginLoader
    expect(serverOpts.pluginRunner).toBe(serverOpts.pluginLoader);
  });

  it("initializes PluginStore with the task store's fusion directory", async () => {
    const { PluginStore } = await import("@fusion/core");

    await runDashboard(0, {});

    expect(PluginStore).toHaveBeenCalledWith("/tmp/test/.fusion");
  });

  it("initializes PluginLoader with pluginStore and taskStore", async () => {
    const { PluginLoader } = await import("@fusion/core");

    await runDashboard(0, {});

    expect(PluginLoader).toHaveBeenCalledTimes(1);
    const loaderOptions = (PluginLoader as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(loaderOptions).toHaveProperty("pluginStore");
    expect(loaderOptions).toHaveProperty("taskStore");
  });
});


