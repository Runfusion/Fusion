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

// ── Mock @kb/core ──────────────────────────────────────────────────

vi.mock("@kb/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
}));

// ── Mock @kb/dashboard ─────────────────────────────────────────────

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

vi.mock("@kb/dashboard", () => ({
  createServer: vi.fn(() => ({ listen: mockListen })),
  GitHubClient: MockGitHubClient,
}));

// ── Mock @kb/engine ────────────────────────────────────────────────

vi.mock("@kb/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kb/engine")>();
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
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
    cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  };
});

// ── Mock @mariozechner/pi-coding-agent ──────────────────────────────

const mockAuthStorage = { getAuth: vi.fn(), setAuth: vi.fn() };
const mockModelRegistry = { getModels: vi.fn().mockResolvedValue([]) };

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => mockAuthStorage),
  },
  ModelRegistry: vi.fn().mockImplementation(() => mockModelRegistry),
}));

// ── Import module under test (after mocks) ──────────────────────────

const { runDashboard } = await import("../dashboard.js");

// ── Tests ───────────────────────────────────────────────────────────

describe("runDashboard — AuthStorage & ModelRegistry wiring", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("passes authStorage and modelRegistry to createServer", async () => {
    const { createServer } = await import("@kb/dashboard");

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
});
