import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Capture arguments ───────────────────────────────────────────────

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore() {
  const emitter = new EventEmitter();
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

const { runDashboard } = await import("../dashboard.js");

// ── Tests ───────────────────────────────────────────────────────────

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

describe("runDashboard — MissionAutopilot wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("creates a MissionAutopilot instance and passes it to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");
    const { MissionAutopilot } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(MissionAutopilot).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("missionAutopilot");
    expect(serverOpts.missionAutopilot).toBeDefined();
  });

  it("passes missionAutopilot and missionStore to Scheduler options", async () => {
    const { Scheduler } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(Scheduler).toHaveBeenCalledTimes(1);
    const schedulerOpts = (Scheduler as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(schedulerOpts).toHaveProperty("missionAutopilot");
    expect(schedulerOpts).toHaveProperty("missionStore");
    expect(schedulerOpts.missionAutopilot).toBeDefined();
    expect(schedulerOpts.missionStore).toBeDefined();
  });

  it("calls setScheduler on the MissionAutopilot instance after Scheduler creation", async () => {
    const { MissionAutopilot } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(MissionAutopilot).toHaveBeenCalledTimes(1);
    const autopilotInstance = (MissionAutopilot as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(autopilotInstance.setScheduler).toHaveBeenCalledTimes(1);
  });

  it("starts the MissionAutopilot service", async () => {
    const { MissionAutopilot } = await import("@fusion/engine");

    await runDashboard(0, {});

    const autopilotInstance = (MissionAutopilot as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(autopilotInstance.start).toHaveBeenCalledTimes(1);
  });
});

describe("runDashboard — Memory Insight Automation wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDiscoverAndLoadExtensions.mockResolvedValue({
      runtime: { pendingProviderRegistrations: [] },
      errors: [],
    });
    const { TaskStore } = await import("@fusion/core");
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("syncs insight extraction automation on startup", async () => {
    await runDashboard(0, {});

    expect(mockSyncInsightExtraction).toHaveBeenCalledTimes(1);
    expect(mockSyncInsightExtraction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxConcurrent: 1,
        maxWorktrees: 2,
        autoMerge: false,
        pollIntervalMs: 60_000,
      }),
    );
  });

  it("passes onScheduleRunProcessed callback to CronRunner", async () => {
    const { CronRunner } = await import("@fusion/engine");

    await runDashboard(0, {});

    expect(CronRunner).toHaveBeenCalledTimes(1);
    const cronOptions = (CronRunner as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(cronOptions).toHaveProperty("onScheduleRunProcessed");
    expect(typeof cronOptions.onScheduleRunProcessed).toBe("function");
  });

  it("calls syncInsightExtractionAutomation when insight extraction settings change", async () => {
    await runDashboard(0, {});

    // Get the store mock to emit settings change
    const { TaskStore } = await import("@fusion/core");
    const mockStore = (TaskStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

    // Simulate settings update
    mockSyncInsightExtraction.mockClear();
    mockStore.emit("settings:updated", {
      settings: {
        insightExtractionEnabled: true,
        insightExtractionSchedule: "0 3 * * *",
      },
      previous: {
        insightExtractionEnabled: false,
        insightExtractionSchedule: "0 2 * * *",
      },
    });

    expect(mockSyncInsightExtraction).toHaveBeenCalledTimes(1);
  });

  it("does not call syncInsightExtractionAutomation for unrelated settings changes", async () => {
    await runDashboard(0, {});

    // Get the store mock to emit settings change
    const { TaskStore } = await import("@fusion/core");
    const mockStore = (TaskStore as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

    // Simulate unrelated settings update
    mockSyncInsightExtraction.mockClear();
    mockStore.emit("settings:updated", {
      settings: {
        maxConcurrent: 5,
      },
      previous: {
        maxConcurrent: 1,
      },
    });

    expect(mockSyncInsightExtraction).not.toHaveBeenCalled();
  });

  it("handles syncInsightExtractionAutomation errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncInsightExtraction.mockRejectedValueOnce(new Error("Sync failed"));

    await runDashboard(0, {});

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[memory-audit] Failed to sync insight extraction"),
    );
    consoleSpy.mockRestore();
  });
});
