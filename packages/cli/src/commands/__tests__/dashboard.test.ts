import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Use vi.hoisted to define mocks that need to be referenced in vi.mock
const { centralInstances } = vi.hoisted(() => {
  const centralInstances: any[] = [];
  return { centralInstances };
});

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

// ── Capture arguments ───────────────────────────────────────────────

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore(projectId = "test") {
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
    getFusionDir: vi.fn().mockReturnValue(`/tmp/${projectId}/.fusion`),
    getMissionStore: vi.fn().mockReturnValue(mockMissionStore),
    healthCheck: vi.fn().mockReturnValue(true),
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

// Track getProjectByPath calls to allow per-test resolution control
let getProjectByPathResolver: ((cwd: string) => unknown) | null = null;

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
  CentralCore: vi.fn().mockImplementation(() => {
    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getProjectByPath: vi.fn().mockImplementation((cwd: string) => {
        // Use per-test resolver when available; default to primary project
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
    centralInstances.push(instance);
    return instance;
  }),
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
  getEnabledPiExtensionPaths: vi.fn(() => []),
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
  createSkillsAdapter: vi.fn().mockReturnValue(undefined),
  getProjectSettingsPath: vi.fn().mockReturnValue("/tmp/project/.fusion/settings.json"),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
}));

// ── Mock @fusion/engine ────────────────────────────────────────────────

// Track which engine is used for default/cwd path to assert correct routing
const engineUsageLog: string[] = [];

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
    ProjectEngineManager: vi.fn().mockImplementation((centralCore: any, _options: any) => {
      const engines = new Map<string, any>();
      // Create mock engines that match the ProjectEngine mock shape above.
      // Each engine is independently addressable by project ID.
      const createMockEngine = (projectId: string) => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getTaskStore: vi.fn().mockImplementation(() => makeMockStore(projectId)),
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
      });
      return {
        startAll: vi.fn(async () => {
          const projects = await centralCore.listProjects();
          for (const project of projects) {
            const engine = createMockEngine(project.id);
            await engine.start();
            engines.set(project.id, engine);
          }
        }),
        getEngine: vi.fn((id: string) => {
          engineUsageLog.push(`getEngine(${id})`);
          return engines.get(id);
        }),
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
    ProjectManager: vi.fn().mockImplementation(() => ({
      getRuntime: vi.fn().mockReturnValue(undefined),
      addProject: vi.fn().mockResolvedValue({}),
      stopAll: vi.fn().mockResolvedValue(undefined),
    })),
    PeerExchangeService: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
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
  ModelRegistry: {
    create: vi.fn(() => mockModelRegistry),
    inMemory: vi.fn(() => mockModelRegistry),
  },
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

// ── Multi-project test utilities ────────────────────────────────────

/**
 * Reset multi-project test state between tests.
 * Clears engine usage log and project-by-path resolver.
 */
function resetMultiProjectState(): void {
  engineUsageLog.length = 0;
  getProjectByPathResolver = null;
  centralInstances.length = 0;
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

// ── Tests ───────────────────────────────────────────────────────────

afterEach(() => {
  disposeTrackedDashboards();
  resetMultiProjectState();
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
    expect(serverOpts.authStorage.getApiKeyProviders()).toEqual([
      { id: "kimi-coding", name: "Kimi" },
      { id: "minimax", name: "Minimax" },
      { id: "openrouter", name: "OpenRouter" },
      { id: "zai", name: "Zai" },
    ]);
  });

  it("creates AuthStorage for Fusion writes", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, {});

    expect(AuthStorage.create).toHaveBeenCalledTimes(1);
  });

  it("creates ModelRegistry with a merged auth storage reader", async () => {
    const { ModelRegistry } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, {});

    const createMock = ModelRegistry.create as unknown as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledTimes(1);
    const registryAuthStorage = createMock.mock.calls[0][0];
    expect(registryAuthStorage).not.toBe(mockAuthStorage);
    expect(registryAuthStorage.getApiKey).toBeTypeOf("function");
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

    expect(mockDiscoverAndLoadExtensions).toHaveBeenCalledWith(
      [],
      expect.any(String),
      expect.stringContaining(".fusion/disabled-auto-extension-discovery"),
    );
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

  it("passes engineManager to createServer (non-dev mode)", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("engineManager");
    expect(serverOpts.engineManager).toBeDefined();
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

    // PluginStore is initialized with store.getFusionDir() which uses the mock path
    // The path includes the project ID from the mock store
    expect(PluginStore).toHaveBeenCalledWith(expect.stringContaining("/.fusion"));
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

describe("runDashboard — per-project engine manager (multi-project)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("creates a ProjectEngineManager and calls startAll in non-dev mode", async () => {
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);
    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(managerInstance.startAll).toHaveBeenCalledTimes(1);
  });

  it("passes onProjectFirstAccessed callback to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("onProjectFirstAccessed");
    expect(serverOpts.onProjectFirstAccessed).toBeTypeOf("function");
  });

  it("onProjectFirstAccessed delegates to engineManager.onProjectAccessed", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const cb: (id: string) => void = serverOpts.onProjectFirstAccessed;

    cb("proj_new");

    expect(managerInstance.onProjectAccessed).toHaveBeenCalledWith("proj_new");
  });

  it("passes engineManager to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts.engineManager).toBe(managerInstance);
  });

  it("does not create ProjectEngine in dev mode", async () => {
    const { ProjectEngine } = await import("@fusion/engine");

    await runDashboard(0, { dev: true });

    expect(ProjectEngine).not.toHaveBeenCalled();
  });
});

describe("runDashboard — Peer exchange and discovery", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    centralInstances.length = 0;
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("creates PeerExchangeService with CentralCore and calls start() in non-dev mode", async () => {
    const { PeerExchangeService } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(PeerExchangeService).toHaveBeenCalledTimes(1);
    const peerExchangeInstance = PeerExchangeService.mock.results[0]?.value;
    expect(peerExchangeInstance.start).toHaveBeenCalledTimes(1);
  });

  it("creates CentralCore with startDiscovery and updateNode methods in non-dev mode", async () => {
    await runDashboard(0, {});

    // Verify CentralCore was created with the required methods
    expect(centralInstances.length).toBeGreaterThanOrEqual(1);
    const meshCentral = centralInstances[0];
    expect(meshCentral).toBeDefined();
    expect(typeof meshCentral.startDiscovery).toBe("function");
    expect(typeof meshCentral.updateNode).toBe("function");
  });

  it("creates CentralCore and PeerExchangeService in dev mode", async () => {
    const { PeerExchangeService: PeerExchangeServiceEngine } = await import("@fusion/engine");

    await runDashboard(0, { dev: true });

    // In dev mode, we create a separate CentralCore for mesh
    expect(centralInstances.length).toBeGreaterThanOrEqual(1);
    expect(PeerExchangeServiceEngine).toHaveBeenCalledTimes(1);
    const peerExchangeInstance = PeerExchangeServiceEngine.mock.results[0]?.value;
    expect(peerExchangeInstance.start).toHaveBeenCalledTimes(1);
  });

  it("creates CentralCore with startDiscovery and updateNode methods in dev mode", async () => {
    await runDashboard(0, { dev: true });

    expect(centralInstances.length).toBeGreaterThanOrEqual(1);
    const meshCentral = centralInstances[0];
    expect(meshCentral).toBeDefined();
    expect(typeof meshCentral.startDiscovery).toBe("function");
    expect(typeof meshCentral.updateNode).toBe("function");
  });
});

describe("runDashboard — multi-project cwd/default engine resolution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    // Default: cwd resolves to primary project
    setupProjectByPath(null);
  });

  it("selects default engine via CentralCore.getProjectByPath(cwd), not by registry order", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    // Verify the engine manager was created
    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);

    // Verify CentralCore.getProjectByPath was called with cwd
    expect(centralInstances.some((instance) => instance.getProjectByPath.mock.calls.length > 0)).toBe(true);

    // Verify createServer received an engine (the cwd/default engine)
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("engine");
    expect(serverOpts.engine).toBeDefined();
  });

  it("passes engineManager to createServer for multi-project scope resolution", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // engineManager should be passed for multi-project route resolution
    expect(serverOpts.engineManager).toBe(managerInstance);
  });

  it("passes onProjectFirstAccessed callback that delegates to engineManager.onProjectAccessed", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // Verify the callback is passed
    expect(serverOpts).toHaveProperty("onProjectFirstAccessed");
    expect(typeof serverOpts.onProjectFirstAccessed).toBe("function");

    // Invoke the callback and verify delegation
    serverOpts.onProjectFirstAccessed("proj-new");
    expect(managerInstance.onProjectAccessed).toHaveBeenCalledWith("proj-new");
  });

  it("does NOT pass engine when cwd project cannot be resolved (no foreign default engine)", async () => {
    // Configure cwd to return null (project not registered)
    setupProjectByPath((_cwd) => null);

    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    // Verify engineManager was still passed (for multi-project support)
    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts.engineManager).toBe(managerInstance);

    // But NO default engine was bound (prevents wrong-project execution)
    expect(serverOpts.engine).toBeUndefined();
  });

  it("forwards scoped automation/routine lane dependencies to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // automationStore should be forwarded for scoped scheduling
    expect(serverOpts).toHaveProperty("automationStore");
    expect(serverOpts.automationStore).toBeDefined();
  });

  it("maintains correct engine binding when onProjectFirstAccessed is called", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    // Get the original engine binding
    const serverOpts1 = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const originalEngine = serverOpts1.engine;

    // Trigger onProjectFirstAccessed for a secondary project
    if (serverOpts1.onProjectFirstAccessed) {
      serverOpts1.onProjectFirstAccessed("proj-secondary");
    }

    // Verify createServer was only called once (engine binding unchanged)
    expect((createServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Verify the engine passed is still the original cwd engine
    const serverOpts2 = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts2.engine).toBe(originalEngine);
  });

  // ── Scoped lane diagnostics wiring tests (FN-1743) ─────────────────────────────────

  it("passes cwd engine's automation store for scoped scheduling", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    await runDashboard(0, {});

    // Verify ProjectEngineManager was used
    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);
    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(managerInstance).toBeDefined();

    // Verify automationStore is forwarded through the server options
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("automationStore");
    expect(serverOpts.automationStore).toBeDefined();
  });

  it("scoped lane automation store is from cwd engine, not secondary project", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { ProjectEngineManager } = await import("@fusion/engine");

    // Default: cwd resolves to primary project
    setupProjectByPath(null);

    await runDashboard(0, {});

    // Verify engineManager was created for primary project
    expect(ProjectEngineManager).toHaveBeenCalledTimes(1);
    const managerInstance = (ProjectEngineManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(managerInstance).toBeDefined();

    // Verify the engine for primary project is selected
    const engineForPrimary = managerInstance.getEngine("project-1");
    expect(engineForPrimary).toBeDefined();

    // The server should have the cwd engine (project-1)
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts.engine).toBe(engineForPrimary);
  });

  it("forwards scoped scheduling accessors that support lane diagnostics", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // Verify automationStore is forwarded for scoped scheduling
    expect(serverOpts).toHaveProperty("automationStore");
    expect(serverOpts.automationStore).toBeDefined();

    // Verify engineManager is forwarded for multi-project route resolution
    expect(serverOpts).toHaveProperty("engineManager");
    expect(serverOpts.engineManager).toBeDefined();

    // Verify engine is passed for scoped route defaults
    expect(serverOpts).toHaveProperty("engine");
    expect(serverOpts.engine).toBeDefined();
  });
});
