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
