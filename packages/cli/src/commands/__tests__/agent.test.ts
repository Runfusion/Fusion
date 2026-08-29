import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

// ── Mock AgentStore ──────────────────────────────────────────────────

// FN-7704: `vi.hoisted` guarantees these mock fns exist before either
// `vi.mock` factory below runs, regardless of source order between the two
// mock blocks (a prior plain-`const` version of the project-context mock
// hit "Cannot access before initialization" because Vitest's hoisting only
// reliably hoists `mock`-prefixed consts declared ahead of the FIRST
// `vi.mock` call in the file).
const { mockGetAgent, mockUpdateAgentState, mockInit, mockClose, mockResolveProjectPathOnly, mockResolveAgentStoreBase } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockUpdateAgentState: vi.fn(),
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn(),
  mockResolveProjectPathOnly: vi.fn().mockResolvedValue("/tmp/test-project"),
  mockResolveAgentStoreBase: vi.fn(async () => ({ rootDir: "/tmp/test-project", asyncLayer: {}, cleanup: vi.fn(async () => undefined) })),
}));

// AgentStore mock — vi.fn() with mockImplementation works with `new` in vitest.
// We return a plain object from the constructor which becomes the instance.
vi.mock("@fusion/core", () => ({
  AgentStore: makeConstructibleMock(() => ({
    init: mockInit,
    getAgent: mockGetAgent,
    updateAgentState: mockUpdateAgentState,
    close: mockClose,
  })),
  AGENT_VALID_TRANSITIONS: {
    idle: ["active"],
    active: ["running", "paused"],
    running: ["active", "paused", "error"],
    paused: ["active"],
    error: ["active"],
  },
}));

// ── Mock project-context ─────────────────────────────────────────────

// FN-7704: this test lives in src/commands/__tests__/, so the module under
// test's "../project-context.js" import resolves to src/project-context.js
// — the mock path here must match that resolved module ("../../
// project-context.js" from this file), not agent.ts's own relative import
// string. A prior version of this mock pointed at "../project-context.js"
// (i.e. the nonexistent src/commands/project-context.js) and silently never
// applied — getProjectPath's try/catch fallback to the REAL resolveProject
// masked it because only the mocked AgentStore mattered for these tests'
// assertions. Fixed alongside FN-7704 so the mock now actually intercepts
// the call, which enabled asserting resolveProjectPathOnly is used (i.e.
// that no TaskStore is leaked).
vi.mock("../../project-context.js", () => ({
  // FNXC:PostgresCutover 2026-07-10: branch agent commands resolve their AgentStore base (rootDir + asyncLayer) via this helper.
  resolveAgentStoreBase: mockResolveAgentStoreBase,
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
  closeProjectStore: vi.fn(async (context: { store?: { close?: () => unknown } }) => {
    try {
      await context?.store?.close?.();
    } catch {
      // best-effort
    }
  }),
  resolveProjectPathOnly: mockResolveProjectPathOnly,
}));

// ── Spies ────────────────────────────────────────────────────────────

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as any);

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ── Import after mocks ───────────────────────────────────────────────

import { runAgentStop, runAgentStart } from "../agent.js";

function makeAgent(state: string, taskId?: string) {
  return {
    id: "agent-test123",
    name: "test-agent",
    role: "executor" as const,
    state,
    taskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runAgentStop", () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue(makeAgent("running"));
    mockUpdateAgentState.mockResolvedValue(makeAgent("paused"));
    mockInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should stop a running agent", async () => {
    await runAgentStop("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "paused");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Agent agent-test123 stopped"));
    // FN-7704: store must be closed on the happy path so the CLI process
    // does not keep a lingering SQLite handle alive after work is done.
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should stop an active agent", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("active"));

    await runAgentStop("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "paused");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Agent agent-test123 stopped"));
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("stops an assigned agent through the agent-store-only bridge", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("running", "FN-user-paused"));

    await runAgentStop("agent-test123");

    // FNXC:AgentLifecyclePause 2026-07-19-00:00: CLI stop changes only the
    // agent row; this command constructs no TaskStore and cannot cascade an
    // assigned task's user pause or reason.
    expect(mockUpdateAgentState).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "paused");
    expect(mockResolveAgentStoreBase).toHaveBeenCalledTimes(1);
  });

  it("should report when agent is not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    await expect(runAgentStop("agent-nonexistent")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("agent-nonexistent not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    // FN-7704: store must be closed before process.exit on the not-found path.
    // (closeAgentStoreSafely may run twice here: once explicitly before
    // process.exit, and once more via the outer catch when the mocked
    // process.exit throws to unwind the test — both are safe/idempotent.)
    expect(mockClose).toHaveBeenCalled();
  });

  it("should report when agent is already paused", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("paused"));

    await runAgentStop("agent-test123");

    // Should NOT call updateAgentState
    expect(mockUpdateAgentState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already paused"));
    // FN-7704: store must be closed on the already-in-state early-return path.
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should reject stopping an idle agent (invalid transition)", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("idle"));

    await expect(runAgentStop("agent-test123")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cannot transition to 'paused'"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    // FN-7704: store must be closed on the invalid-transition path.
    expect(mockClose).toHaveBeenCalled();
  });

  it("should reject stopping an error agent (invalid transition)", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("error"));

    await expect(runAgentStop("agent-test123")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cannot transition to 'paused'"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockClose).toHaveBeenCalled();
  });

  it("should close the store and resolve the project path without leaking a TaskStore", async () => {
    await runAgentStop("agent-test123");

    // FN-7704 (branch adaptation): agent commands resolve their AgentStore base
    // via resolveAgentStoreBase (rootDir + borrowed asyncLayer) rather than
    // upstream's resolveProjectPathOnly; the invariant is still that no ad-hoc
    // TaskStore is constructed/leaked by this command itself.
    expect(mockResolveAgentStoreBase).toHaveBeenCalled();
  });

  it("fast-fails with a clear error and non-zero exit when the store mutation never resolves", async () => {
    vi.useFakeTimers();
    try {
      // Simulate a store mutation that never resolves (e.g. a stuck/contended write).
      mockUpdateAgentState.mockImplementation(() => new Promise(() => {}));

      const resultPromise = runAgentStop("agent-test123");
      // Suppress unhandled rejection warnings until we assert below.
      resultPromise.catch(() => {});

      // Advance past the default bounded fast-fail deadline (10s).
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(resultPromise).rejects.toThrow("process.exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Failed to stop agent agent-test123`));
      expect(exitSpy).toHaveBeenCalledWith(1);
      // Even on the fast-fail timeout path, the store must still be closed so
      // the CLI process exits promptly instead of hanging on the stuck op.
      expect(mockClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

describe("runAgentStart", () => {
  beforeEach(() => {
    mockGetAgent.mockResolvedValue(makeAgent("paused"));
    mockUpdateAgentState.mockResolvedValue(makeAgent("active"));
    mockInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should start a paused agent", async () => {
    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "active");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Agent agent-test123 started"));
    // FN-7704: store must be closed on the happy path.
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should start an idle agent", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("idle"));
    mockUpdateAgentState.mockResolvedValue(makeAgent("active"));

    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "active");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Agent agent-test123 started"));
  });

  it("starts an assigned agent through the agent-store-only bridge", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("paused", "FN-agent-paused"));

    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "active");
    expect(mockResolveAgentStoreBase).toHaveBeenCalledTimes(1);
  });

  it("should start an error agent", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("error"));
    mockUpdateAgentState.mockResolvedValue(makeAgent("active"));

    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-test123", "active");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("✓ Agent agent-test123 started"));
  });

  it("should report when agent is not found", async () => {
    mockGetAgent.mockResolvedValue(null);

    await expect(runAgentStart("agent-nonexistent")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("agent-nonexistent not found"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    // FN-7704: store must be closed on the not-found path.
    expect(mockClose).toHaveBeenCalled();
  });

  it("should report when agent is already active", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("active"));

    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    // FN-7704: store must be closed on the already-in-state early-return path.
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should report when agent is already running", async () => {
    mockGetAgent.mockResolvedValue(makeAgent("running"));

    await runAgentStart("agent-test123");

    expect(mockUpdateAgentState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("fast-fails with a clear error and non-zero exit when the store mutation never resolves", async () => {
    vi.useFakeTimers();
    try {
      mockUpdateAgentState.mockImplementation(() => new Promise(() => {}));

      const resultPromise = runAgentStart("agent-test123");
      resultPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(resultPromise).rejects.toThrow("process.exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Failed to start agent agent-test123`));
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
