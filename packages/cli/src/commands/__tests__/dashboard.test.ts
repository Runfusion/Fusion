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

// ── Mock @hai/core ──────────────────────────────────────────────────

vi.mock("@hai/core", () => ({
  TaskStore: vi.fn().mockImplementation(() => makeMockStore()),
}));

// ── Mock @hai/dashboard ─────────────────────────────────────────────

const mockListen = vi.fn();
vi.mock("@hai/dashboard", () => ({
  createServer: vi.fn(() => ({ listen: mockListen })),
}));

// ── Mock @hai/engine ────────────────────────────────────────────────

vi.mock("@hai/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hai/engine")>();
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
    const { TaskStore } = await import("@hai/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
  });

  it("passes authStorage and modelRegistry to createServer", async () => {
    const { createServer } = await import("@hai/dashboard");

    await runDashboard(0, { open: false });

    expect(createServer).toHaveBeenCalledTimes(1);
    const serverOpts = (createServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(serverOpts).toHaveProperty("authStorage", mockAuthStorage);
    expect(serverOpts).toHaveProperty("modelRegistry", mockModelRegistry);
  });

  it("creates AuthStorage via AuthStorage.create()", async () => {
    const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, { open: false });

    expect(AuthStorage.create).toHaveBeenCalledTimes(1);
  });

  it("creates ModelRegistry with the authStorage instance", async () => {
    const { ModelRegistry } = await import("@mariozechner/pi-coding-agent");

    await runDashboard(0, { open: false });

    expect(ModelRegistry).toHaveBeenCalledTimes(1);
    expect(ModelRegistry).toHaveBeenCalledWith(mockAuthStorage);
  });
});
