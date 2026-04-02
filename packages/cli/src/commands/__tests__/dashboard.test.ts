import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Capture arguments ───────────────────────────────────────────────

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore() {
  const emitter = new EventEmitter();
  return {
    init: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: false,
      pollIntervalMs: 60_000,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    }),
    emit: emitter.emit.bind(emitter),
  };
}

// ── Mock @fusion/core ──────────────────────────────────────────────────

vi.mock("@fusion/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
  AutomationStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    listSchedules: vi.fn().mockResolvedValue([]),
    getDueSchedules: vi.fn().mockResolvedValue([]),
  })),
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
  };
});

// ── Mock @mariozechner/pi-coding-agent ──────────────────────────────

const mockAuthStorage = { getAuth: vi.fn(), setAuth: vi.fn() };
const mockModelRegistry = {
  getModels: vi.fn().mockResolvedValue([]),
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

  it("passes authStorage and modelRegistry to createServer", async () => {
    const { createServer } = await import("@fusion/dashboard");

    await runDashboard(0, {});

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("authStorage", mockAuthStorage);
    expect(serverOpts).toHaveProperty("modelRegistry", mockModelRegistry);
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("kb board"));
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
});
