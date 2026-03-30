import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Capture instances & arguments ───────────────────────────────────

let capturedExecutorOpts: Record<string, unknown> | undefined;

// Minimal mock store backed by EventEmitter so `store.on` works
function makeMockStore() {
  const emitter = new EventEmitter();
  return {
    init: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: false,
      pollIntervalMs: 60_000,
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({ column: "in-review", paused: false }),
    updateTask: vi.fn().mockResolvedValue({}),
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

vi.mock("@kb/dashboard", () => ({
  createServer: vi.fn(() => ({ listen: mockListen })),
}));

// ── Mock @kb/engine ────────────────────────────────────────────────

// We need the real WorktreePool class so we can assert `instanceof`.
const { WorktreePool } = await import("@kb/engine");

vi.mock("@kb/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kb/engine")>();
  return {
    ...original,
    // Keep real WorktreePool & AgentSemaphore
    WorktreePool: original.WorktreePool,
    AgentSemaphore: original.AgentSemaphore,
    // Stub heavy classes/functions
    TriageProcessor: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    TaskExecutor: vi.fn().mockImplementation((_store: unknown, _cwd: unknown, opts: unknown) => {
      capturedExecutorOpts = opts as Record<string, unknown>;
      return {
        resumeOrphaned: vi.fn().mockResolvedValue(undefined),
      };
    }),
    Scheduler: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    aiMergeTask: vi.fn().mockImplementation(() => Promise.resolve({ merged: true })),
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
    cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  };
});

// ── Import module under test (after mocks) ──────────────────────────

const { runDashboard } = await import("./dashboard.js");

// ── Tests ───────────────────────────────────────────────────────────

describe("runDashboard — WorktreePool wiring", () => {
  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    // Re-set TaskStore mock (clearAllMocks wipes implementations)
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    // Re-set engine mocks
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("passes a WorktreePool instance to TaskExecutor", async () => {
    await runDashboard(0, { open: false });

    expect(capturedExecutorOpts).toBeDefined();
    expect(capturedExecutorOpts!.pool).toBeInstanceOf(WorktreePool);
  });

  it("passes a WorktreePool instance to aiMergeTask via rawMerge", async () => {
    const { aiMergeTask } = await import("@kb/engine");
    const { createServer } = await import("@kb/dashboard");

    await runDashboard(0, { open: false });

    // rawMerge is exposed as the onMerge callback wired into createServer.
    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls[0];
    const serverOpts = createServerCall[1] as { onMerge: (taskId: string) => Promise<unknown> };

    // Invoke the merge handler
    await serverOpts.onMerge("KB-TEST");

    expect(aiMergeTask).toHaveBeenCalled();
    const mergeCallOpts = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(mergeCallOpts.pool).toBeInstanceOf(WorktreePool);
  });

  it("shares the same WorktreePool instance between executor and merger", async () => {
    const { aiMergeTask } = await import("@kb/engine");
    const { createServer } = await import("@kb/dashboard");

    await runDashboard(0, { open: false });

    // Trigger merger via onMerge
    const createServerCall = (createServer as ReturnType<typeof vi.fn>).mock.calls[0];
    const serverOpts = createServerCall[1] as { onMerge: (taskId: string) => Promise<unknown> };
    await serverOpts.onMerge("KB-TEST");

    const executorPool = capturedExecutorOpts!.pool;
    const mergerPool = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls[0][3].pool;

    expect(executorPool).toBeInstanceOf(WorktreePool);
    expect(mergerPool).toBeInstanceOf(WorktreePool);
    expect(executorPool).toBe(mergerPool);
  });
});

describe("runDashboard — auto-merge pause exclusion", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("does not enqueue paused in-review tasks for auto-merge on task:moved", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });

    await runDashboard(0, { open: false });

    const { aiMergeTask } = await import("@kb/engine");

    // Emit task:moved with a paused task
    mockStore.emit("task:moved", {
      task: { id: "KB-PAUSED", column: "in-review", paused: true },
      from: "in-progress",
      to: "in-review",
    });

    // Give async handlers time to process
    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("does not enqueue paused in-review tasks during startup sweep", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "KB-PAUSED", column: "in-review", paused: true },
      { id: "KB-ACTIVE", column: "in-review", paused: false },
    ]);

    const { aiMergeTask } = await import("@kb/engine");
    // Reset after import
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    // Give async handlers time to process
    await new Promise((r) => setTimeout(r, 50));

    // Only the non-paused task should be enqueued
    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).not.toContain("KB-PAUSED");
  });
});

describe("runDashboard — immediate resume on unpause", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("registers a settings:updated listener on the store", async () => {
    await runDashboard(0, { open: false });

    // The store.on should have been called with "settings:updated" at least once
    const settingsUpdatedCalls = mockStore.on.mock.calls.filter(
      (call: any[]) => call[0] === "settings:updated",
    );
    // At least 2 listeners: one for pause→true (merge kill), one for unpause
    expect(settingsUpdatedCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls executor.resumeOrphaned() when globalPause transitions true → false", async () => {
    const { TaskExecutor } = await import("@kb/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call to resumeOrphaned
    resumeOrphaned.mockClear();

    // Trigger unpause event
    mockStore.emit("settings:updated", {
      settings: { globalPause: false, maxConcurrent: 1, autoMerge: false },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });

  it("sweeps merge queue on unpause when autoMerge is enabled", async () => {
    // Set up settings to return autoMerge: true for the drain queue check
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      globalPause: false,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "KB-MQ1", column: "in-review", paused: false },
      { id: "KB-MQ2", column: "in-review", paused: false },
    ]);
    // getTask is called inside drainMergeQueue to verify the task
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
    }));

    const { aiMergeTask } = await import("@kb/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    // Clear any calls from startup sweep
    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    // Trigger unpause event with autoMerge enabled
    mockStore.emit("settings:updated", {
      settings: { globalPause: false, maxConcurrent: 1, autoMerge: true },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 200));

    // Both in-review tasks should be enqueued for merge
    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).toContain("KB-MQ1");
    expect(mergedIds).toContain("KB-MQ2");
  });
});

describe("runDashboard — engine pause/unpause cycle", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
  });

  it("calls executor.resumeOrphaned() when enginePaused transitions true → false", async () => {
    const { TaskExecutor } = await import("@kb/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call to resumeOrphaned
    resumeOrphaned.mockClear();

    // Trigger engine unpause event
    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: false },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });
});

describe("runDashboard — port fallback on EADDRINUSE", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => makeMockStore());
    const engine = await import("@kb/engine");
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ resumeOrphaned: vi.fn().mockResolvedValue(undefined) }),
    );
    consoleSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("listens on the requested port when available", async () => {
    await runDashboard(4040, { open: false });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // mockListen should have been called with the requested port
    expect(mockListen).toHaveBeenCalledWith(4040);

    // Banner should show the requested port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:4040"),
    );

    // No warning should be printed
    const warningCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Port 4040 in use"),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it("falls back to a random port on EADDRINUSE", async () => {
    const fallbackPort = 54321;
    const serverEmitter = new EventEmitter();

    // Mock the server's own listen method (used for the retry with port 0)
    const mockServerListen = vi.fn((_port?: number) => {
      process.nextTick(() => serverEmitter.emit("listening"));
      return serverEmitter;
    });

    Object.assign(serverEmitter, {
      listen: mockServerListen,
      address: vi.fn(() => ({ port: fallbackPort, family: "IPv4", address: "127.0.0.1" })),
      close: vi.fn(),
    });

    // Override mockListen for one call: simulate EADDRINUSE
    mockListen.mockImplementationOnce((_port: number) => {
      process.nextTick(() => {
        const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        serverEmitter.emit("error", err);
      });
      return serverEmitter;
    });

    await runDashboard(4040, { open: false });

    // Wait for async events to settle
    await new Promise((r) => setTimeout(r, 100));

    // Server should have retried with port 0
    expect(mockServerListen).toHaveBeenCalledWith(0);

    // Banner should show the fallback port, not the requested port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`http://localhost:${fallbackPort}`),
    );
  });

  it("prints a warning when port fallback occurs", async () => {
    const fallbackPort = 12345;
    const serverEmitter = new EventEmitter();

    const mockServerListen = vi.fn((_port?: number) => {
      process.nextTick(() => serverEmitter.emit("listening"));
      return serverEmitter;
    });

    Object.assign(serverEmitter, {
      listen: mockServerListen,
      address: vi.fn(() => ({ port: fallbackPort, family: "IPv4", address: "127.0.0.1" })),
      close: vi.fn(),
    });

    mockListen.mockImplementationOnce((_port: number) => {
      process.nextTick(() => {
        const err = new Error("listen EADDRINUSE: address already in use") as NodeJS.ErrnoException;
        err.code = "EADDRINUSE";
        serverEmitter.emit("error", err);
      });
      return serverEmitter;
    });

    await runDashboard(4040, { open: false });

    // Wait for async events to settle
    await new Promise((r) => setTimeout(r, 100));

    // Should print warning with both the requested and actual ports
    expect(consoleSpy).toHaveBeenCalledWith(
      `⚠ Port 4040 in use, using ${fallbackPort} instead`,
    );
  });
});

describe("runDashboard — enginePaused (soft pause)", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
  });

  it("does not enqueue tasks for auto-merge when enginePaused on task:moved", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      enginePaused: true,
    });

    await runDashboard(0, { open: false });

    const { aiMergeTask } = await import("@kb/engine");

    // Emit task:moved
    mockStore.emit("task:moved", {
      task: { id: "KB-EP1", column: "in-review", paused: false },
      from: "in-progress",
      to: "in-review",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(aiMergeTask).not.toHaveBeenCalled();
  });

  it("calls executor.resumeOrphaned() when enginePaused transitions true → false", async () => {
    const { TaskExecutor } = await import("@kb/engine");
    const resumeOrphaned = vi.fn().mockResolvedValue(undefined);
    (TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned };
      },
    );

    await runDashboard(0, { open: false });

    // Clear the startup call
    resumeOrphaned.mockClear();

    // Trigger engine unpause event
    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: false },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resumeOrphaned).toHaveBeenCalled();
  });

  it("sweeps merge queue on engine unpause when autoMerge is enabled", async () => {
    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });
    mockStore.listTasks.mockResolvedValue([
      { id: "KB-EP2", column: "in-review", paused: false },
    ]);
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
    }));

    const { aiMergeTask } = await import("@kb/engine");
    (aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );

    await runDashboard(0, { open: false });

    (aiMergeTask as ReturnType<typeof vi.fn>).mockClear();

    mockStore.emit("settings:updated", {
      settings: { enginePaused: false, maxConcurrent: 1, autoMerge: true },
      previous: { enginePaused: true },
    });

    await new Promise((r) => setTimeout(r, 200));

    const mergedIds = (aiMergeTask as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: any[]) => call[2],
    );
    expect(mergedIds).toContain("KB-EP2");
  });
});

describe("runDashboard — --paused flag", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("calls store.updateSettings({ enginePaused: true }) when paused: true is passed", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(mockStore.updateSettings).toHaveBeenCalledWith({ enginePaused: true });
  });

  it("logs a message when starting in paused mode", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[engine] Starting in paused mode — automation disabled",
    );
  });

  it("does NOT set enginePaused when paused option is absent", async () => {
    await runDashboard(0, { open: false });

    // updateSettings should not be called with enginePaused during normal startup
    const enginePausedCalls = mockStore.updateSettings.mock.calls.filter(
      (call: any[]) => call[0]?.enginePaused !== undefined,
    );
    expect(enginePausedCalls).toHaveLength(0);
  });

  it("does NOT log paused message when starting normally", async () => {
    await runDashboard(0, { open: false });

    const pausedMessageCalls = consoleSpy.mock.calls.filter(
      (args) => args[0] === "[engine] Starting in paused mode — automation disabled",
    );
    expect(pausedMessageCalls).toHaveLength(0);
  });
});

describe("runDashboard — --paused flag", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ resumeOrphaned: vi.fn().mockResolvedValue(undefined) }),
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("calls store.updateSettings({ enginePaused: true }) when paused: true is passed", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(mockStore.updateSettings).toHaveBeenCalledWith({ enginePaused: true });
    expect(mockStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("does NOT call store.updateSettings when paused flag is absent", async () => {
    await runDashboard(0, { open: false });

    expect(mockStore.updateSettings).not.toHaveBeenCalled();
  });

  it("logs paused mode message when starting with paused: true", async () => {
    await runDashboard(0, { open: false, paused: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[engine] Starting in paused mode — automation disabled",
    );
  });

  it("does NOT log paused mode message when paused flag is absent", async () => {
    await runDashboard(0, { open: false });

    const pausedMessageCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("paused mode"),
    );
    expect(pausedMessageCalls).toHaveLength(0);
  });
});

describe("runDashboard — --dev mode", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("does NOT start TriageProcessor in dev mode", async () => {
    const { TriageProcessor } = await import("@kb/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(TriageProcessor).not.toHaveBeenCalled();
  });

  it("does NOT start TaskExecutor in dev mode", async () => {
    const { TaskExecutor } = await import("@kb/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(TaskExecutor).not.toHaveBeenCalled();
  });

  it("does NOT start Scheduler in dev mode", async () => {
    const { Scheduler } = await import("@kb/engine");
    await runDashboard(0, { open: false, dev: true });
    expect(Scheduler).not.toHaveBeenCalled();
  });

  it("starts the server correctly in dev mode", async () => {
    const { createServer } = await import("@kb/dashboard");
    await runDashboard(4040, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Server should have been created and listen called
    expect(createServer).toHaveBeenCalled();
    expect(mockListen).toHaveBeenCalledWith(4040);

    // Banner should show the port
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:4040"),
    );
  });

  it("shows 'AI engine: disabled (dev mode)' in dev mode", async () => {
    await runDashboard(0, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should show disabled message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✗ disabled (dev mode)"),
    );
  });

  it("does NOT show triage/scheduler details in dev mode", async () => {
    await runDashboard(0, { open: false, dev: true });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should NOT show triage/scheduler details
    const triageCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("• triage"),
    );
    const schedulerCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("• scheduler"),
    );
    expect(triageCall).toBeUndefined();
    expect(schedulerCall).toBeUndefined();
  });

  it("starts all engine components when dev is false (default)", async () => {
    const { TriageProcessor, TaskExecutor, Scheduler } = await import("@kb/engine");
    await runDashboard(0, { open: false });

    expect(TriageProcessor).toHaveBeenCalled();
    expect(TaskExecutor).toHaveBeenCalled();
    expect(Scheduler).toHaveBeenCalled();
  });

  it("shows 'AI engine: ✓ active' when not in dev mode", async () => {
    await runDashboard(0, { open: false });

    // Wait for async 'listening' event
    await new Promise((r) => setTimeout(r, 50));

    // Should show active message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("✓ active"),
    );
  });
});

describe("runDashboard — merge conflict retry logic", () => {
  let mockStore: ReturnType<typeof makeMockStore>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    capturedExecutorOpts = undefined;
    vi.clearAllMocks();
    mockStore = makeMockStore();
    const { TaskStore } = await import("@kb/core");
    (TaskStore as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);

    // Default mock store.getTask implementation
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 0,
    }));

    const engine = await import("@kb/engine");
    (engine.aiMergeTask as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ merged: true }),
    );
    (engine.TaskExecutor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_store: unknown, _cwd: unknown, opts: unknown) => {
        capturedExecutorOpts = opts as Record<string, unknown>;
        return { resumeOrphaned: vi.fn().mockResolvedValue(undefined) };
      },
    );
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("increments mergeRetries and re-enqueues on conflict error", async () => {
    const { aiMergeTask } = await import("@kb/engine");

    // Simulate merge failure with conflict
    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected in package-lock.json"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    mockStore.listTasks.mockResolvedValue([
      { id: "KB-RETRY", column: "in-review", paused: false },
    ]);

    await runDashboard(0, { open: false });

    // Wait for retry scheduling
    await new Promise((r) => setTimeout(r, 100));

    // Should have incremented mergeRetries
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "KB-RETRY",
      expect.objectContaining({ mergeRetries: 1 }),
    );

    // Should log retry attempt
    const retryLog = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("retry 1/3"),
    );
    expect(retryLog).toBeDefined();
  });

  it("gives up after max retries (3) exceeded", async () => {
    const { aiMergeTask } = await import("@kb/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    // Task already has 3 retries
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 3,
    }));

    mockStore.listTasks.mockResolvedValue([
      { id: "KB-MAX", column: "in-review", paused: false, mergeRetries: 3 },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 50));

    // Should log max retries exceeded
    const maxRetryLog = consoleSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("max retries (3) exceeded"),
    );
    expect(maxRetryLog).toBeDefined();

    // Should reset mergeRetries on the task
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "KB-MAX",
      expect.objectContaining({ status: null }),
    );
  });

  it("skips retry when autoResolveConflicts is disabled", async () => {
    const { aiMergeTask } = await import("@kb/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Merge conflict detected"),
    );

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: false, // Disabled
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    mockStore.listTasks.mockResolvedValue([
      { id: "KB-NO-AUTO", column: "in-review", paused: false },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 50));

    // Should log that auto-resolve is disabled
    const disabledLog = consoleSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("autoResolveConflicts disabled"),
    );
    expect(disabledLog).toBeDefined();
  });

  it("clears mergeRetries on successful merge after retries", async () => {
    const { aiMergeTask } = await import("@kb/engine");

    (aiMergeTask as ReturnType<typeof vi.fn>).mockResolvedValue({ merged: true });

    mockStore.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: true,
      autoResolveConflicts: true,
      pollIntervalMs: 60_000,
      enginePaused: false,
      globalPause: false,
    });

    // Task had previous retries
    mockStore.getTask = vi.fn().mockImplementation(async (id: string) => ({
      id,
      column: "in-review",
      paused: false,
      mergeRetries: 2,
    }));

    mockStore.listTasks.mockResolvedValue([
      { id: "KB-SUCCESS", column: "in-review", paused: false, mergeRetries: 2 },
    ]);

    await runDashboard(0, { open: false });

    await new Promise((r) => setTimeout(r, 100));

    // Should clear mergeRetries on success
    expect(mockStore.updateTask).toHaveBeenCalledWith(
      "KB-SUCCESS",
      expect.objectContaining({ mergeRetries: 0 }),
    );
  });
});
