import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";

/*
FNXC:CapacityModel 2026-07-28-09:40:
MERGE CONCURRENCY IS FIXED AT 1 AND IS NOT A SETTING.

The capacity model is exactly two CONFIGURABLE numbers per project (total agents,
maxWorktrees) plus this one FIXED invariant. Merge is where the irreversible work
happens — main advances, branches are deleted, worktrees are torn down — so every
merge-safety guard in the repo (file-scope overlap, diff-volume shrinkage,
post-squash audit, contamination auto-recovery) is written against the assumption
that exactly one merge is in flight per project at a time. None of them are
concurrency-safe against a second merge advancing main underneath them.

This file is the RATCHET for that assumption. It is deliberately NOT a test of the
merge-queue LEASE: `acquireMergeQueueLease` leases a per-task queue ROW
(`primaryKey([projectId, taskId])`), so two different tasks can hold leases
simultaneously by construction, and it has exactly one caller (the worktree-reuse
handoff in `merger-integration-worktree.ts`). Ordinary merges never take it. The
serialization lives HERE, in the pump:

  1. `drainMergeQueue`'s `mergeRunning` re-entrancy latch  (project-engine.ts)
  2. `activeMergeTaskId` — a single-slot identity, never a counter
  3. `mergeBodyInFlight` — blocks the NEXT generation until an aborted orphan settles
  4. one `ProjectEngine` per projectId (`project-engine-manager.ts` engines Map)

Do not "fix" a failure here by adding a limiter. Nothing in the product may make
merge concurrency configurable — see `rejects any settings key that would make
merge concurrency configurable` below, which is the half of this ratchet that
fails when someone adds the knob.
*/

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  currentStore: null as Record<string, unknown> | null,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});

vi.mock("../merger.js", () => ({ aiMergeTask: vi.fn(), sweepStaleAutostashes: vi.fn(async () => undefined) }));
vi.mock("../pr-monitor.js", () => ({ PrMonitor: vi.fn().mockImplementation(function () { return { onNewComments: vi.fn() }; }) }));
vi.mock("../pr-comment-handler.js", () => ({ PrCommentHandler: vi.fn().mockImplementation(function () { return { handleNewComments: vi.fn() }; }) }));
vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({ reload: vi.fn(), getOAuthProviders: vi.fn(() => []), get: vi.fn(() => undefined) })),
  getFusionOAuthAlertStatePath: vi.fn(() => "/tmp/oauth-alert-state.json"),
}));
vi.mock("../notifier.js", () => ({ NtfyNotifier: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }) }));
vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () { return {}; }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
}));
vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      resumeAfterUnpause: vi.fn(async () => undefined),
      getTaskStore: () => mocks.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
    };
  }),
}));

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const SETTINGS = { autoMerge: true, globalPause: false, enginePaused: false };

/**
 * A store whose `getSettings` parks on a gate the test controls. `getSettings` is
 * the first await inside `drainMergeQueue`'s while-loop body, so parking it holds
 * the pump mid-iteration with `mergeRunning === true` — exactly the window a
 * second concurrent drain must be refused in.
 *
 * The gate is ARMED explicitly, because `ProjectEngine.start()` also reads settings
 * — an always-on gate deadlocks startup instead of the pump, and every test in this
 * file times out rather than asserting anything.
 */
function createGatedStore(gate: Deferred) {
  const state = { armed: false, throwAfterGate: false };
  const getSettings = vi.fn(async () => {
    if (!state.armed) return SETTINGS;
    await gate.promise;
    if (state.throwAfterGate) throw new Error("merge pump exploded");
    return SETTINGS;
  });
  return {
    state,
    getSettings,
    getRootDir: () => "/tmp/proj_test",
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async (taskId: string) => ({
      id: taskId, column: "in-review", paused: false, userPaused: false,
      mergeRetries: 0, status: null, createdAt: "2026-01-01T00:00:00Z", priority: "normal",
    })),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    emit: vi.fn(),
    getActiveMergingTask: vi.fn(async () => null),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createEngine() {
  return new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    { skipNotifier: true },
  );
}

describe("merge is single-flight per project — fixed at 1, not configurable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /*
  THE CORE RATCHET. Reverting `if (this.mergeRunning) return;` in drainMergeQueue
  makes the second drain enter the loop body and call getSettings a second time
  while the first is still parked — this assertion goes red.
  */
  it("refuses a second concurrent drain while one merge is in flight", async () => {
    const gate = deferred();
    const store = createGatedStore(gate);
    mocks.currentStore = store as never;
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeRunning: boolean;
      drainMergeQueue(): Promise<void>;
    };

    await engine.start();
    store.state.armed = true;
    store.getSettings.mockClear();
    privateEngine.mergeQueue = ["FN-1", "FN-2"];

    // First drain enters and parks on the gated getSettings.
    const first = privateEngine.drainMergeQueue();
    await vi.waitFor(() => expect(store.getSettings).toHaveBeenCalledTimes(1));
    expect(privateEngine.mergeRunning).toBe(true);

    /*
    Second drain, issued while the first is mid-flight, must be a no-op.

    Deliberately NOT awaited. Without the latch the second drain parks on the same
    gate and never returns, so awaiting it would turn a reverted latch into a 30s
    test TIMEOUT — a real failure, but one that reports "timed out" instead of
    naming the defect. Firing it and letting the microtask queue drain makes the
    reverted case fail on THIS assertion (getSettings called twice), which says
    what actually broke.
    */
    const second = privateEngine.drainMergeQueue();
    await new Promise((r) => setImmediate(r));
    expect(store.getSettings).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.allSettled([first, second]);
    await engine.stop();
  });

  /*
  The latch must RELEASE on the failure path too. A merge body that throws must not
  leave mergeRunning latched — that is the FNXC:MergeQueue 2026-07-15-09:50 wedge
  (no merging badge board-wide, later enqueues silently no-op). Reverting the
  `finally { this.mergeRunning = false; }` turns this red.
  */
  it("releases the single-flight latch when the pump throws", async () => {
    const gate = deferred();
    const store = createGatedStore(gate);
    mocks.currentStore = store as never;
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      mergeQueue: string[];
      mergeRunning: boolean;
      drainMergeQueue(): Promise<void>;
    };

    await engine.start();
    store.state.armed = true;
    store.state.throwAfterGate = true;
    store.getSettings.mockClear();
    privateEngine.mergeQueue = ["FN-1"];

    const first = privateEngine.drainMergeQueue();
    await vi.waitFor(() => expect(store.getSettings).toHaveBeenCalledTimes(1));
    gate.resolve();
    await first.catch(() => undefined);

    expect(privateEngine.mergeRunning).toBe(false);
    await engine.stop();
  });

  /*
  `activeMergeTaskId` is an IDENTITY, not a counter. If it ever became a count or a
  set, "one merge at a time" would stop being expressible and the guard trio above
  would silently admit a second. Pin the single-slot shape.
  */
  it("tracks the active merge as a single-slot identity, never a count", async () => {
    const store = createGatedStore(deferred());
    mocks.currentStore = store as never;
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      claimActiveMerge(taskId: string): AbortSignal;
      clearActiveMergeClaim(taskId: string): void;
      activeMergeTaskId: string | null;
    };

    await engine.start();
    expect(engine.getActiveMergeTaskId()).toBeNull();

    privateEngine.claimActiveMerge("FN-1");
    expect(engine.getActiveMergeTaskId()).toBe("FN-1");
    expect(typeof privateEngine.activeMergeTaskId).toBe("string");

    // A second claim REPLACES rather than accumulating — there is exactly one slot.
    privateEngine.claimActiveMerge("FN-2");
    expect(engine.getActiveMergeTaskId()).toBe("FN-2");

    privateEngine.clearActiveMergeClaim("FN-2");
    expect(engine.getActiveMergeTaskId()).toBeNull();

    await engine.stop();
  });
});
