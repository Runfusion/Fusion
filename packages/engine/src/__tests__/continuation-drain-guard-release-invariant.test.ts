import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTINUATION_DRAIN_STALL_MS, InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { Scheduler } from "../scheduler.js";

const runtimeLog = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => runtimeLog),
  runtimeLog,
  schedulerLog: runtimeLog,
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function createRuntime(settings: () => Promise<Record<string, boolean>>, listDue = vi.fn(async () => [])) {
  const runtime = Object.create(InProcessRuntime.prototype) as any;
  runtime.status = "active";
  runtime.workflowContinuationDrainActive = false;
  runtime.workflowContinuationDrainSince = 0;
  runtime.workflowContinuationDrainProgressAt = 0;
  runtime.workflowContinuationDrainPhase = "idle";
  runtime.workflowContinuationDrainPending = false;
  runtime.workflowContinuationDrainGeneration = 0;
  runtime.triageProcessor = undefined;
  runtime.executor = { execute: vi.fn() };
  runtime.kickWorkflowContinuationProcessor = vi.fn();
  runtime.taskStore = {
    getSettings: vi.fn(settings),
    listDueWorkflowWorkItems: listDue,
    getRootDir: vi.fn(() => "/repo"),
  };
  return runtime;
}

async function expectReleasedAndRepolls(pausedSettings: Record<string, boolean>) {
  const getSettings = vi.fn()
    .mockResolvedValueOnce(pausedSettings)
    .mockResolvedValue({ globalPause: false, enginePaused: false });
  const runtime = createRuntime(getSettings);
  await runtime.drainWorkflowContinuations();
  expect(runtime.workflowContinuationDrainActive).toBe(false);
  expect(runtime.workflowContinuationDrainSince).toBe(0);
  await runtime.drainWorkflowContinuations();
  expect(runtime.taskStore.listDueWorkflowWorkItems).toHaveBeenCalledTimes(1);
}

describe("continuation-drain guard release invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["engine pause", { globalPause: false, enginePaused: true }],
    ["global pause", { globalPause: true, enginePaused: false }],
  ])("releases the claimed runtime guard after %s", async (_name, pausedSettings) => {
    await expectReleasedAndRepolls(pausedSettings);
    expect(runtimeLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("continuation-drain watchdog"));
  });

  it("releases the guard after unreadable settings and a due-list failure", async () => {
    const settingsFailure = vi.fn()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValue({ globalPause: false, enginePaused: false });
    const settingsRuntime = createRuntime(settingsFailure);
    await settingsRuntime.drainWorkflowContinuations();
    expect(settingsRuntime.workflowContinuationDrainActive).toBe(false);
    await settingsRuntime.drainWorkflowContinuations();
    expect(settingsRuntime.taskStore.listDueWorkflowWorkItems).toHaveBeenCalledTimes(2);

    const listDue = vi.fn()
      .mockRejectedValueOnce(new Error("due list unavailable"))
      .mockResolvedValue([]);
    const listRuntime = createRuntime(async () => ({ globalPause: false, enginePaused: false }), listDue);
    await expect(listRuntime.drainWorkflowContinuations()).rejects.toThrow("due list unavailable");
    expect(listRuntime.workflowContinuationDrainActive).toBe(false);
    await listRuntime.drainWorkflowContinuations();
    expect(listDue).toHaveBeenCalledTimes(2);
  });

  it("does not force-open a slow pass that is still making progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const due = deferred<never[]>();
    const runtime = createRuntime(async () => ({ globalPause: false, enginePaused: false }), vi.fn(() => due.promise));
    const first = runtime.drainWorkflowContinuations();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.workflowContinuationDrainPhase).toBe("settings");
    vi.advanceTimersByTime(CONTINUATION_DRAIN_STALL_MS - 1);
    void runtime.drainWorkflowContinuations();
    expect(runtime.workflowContinuationDrainPending).toBe(true);
    expect(runtimeLog.warn).not.toHaveBeenCalled();
    due.resolve([]);
    await first;
  });

  it("force-opens a non-progressing pass and fences its late completion from the successor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const firstDue = deferred<never[]>();
    const secondDue = deferred<never[]>();
    const thirdDue = deferred<never[]>();
    const listDue = vi.fn()
      .mockImplementationOnce(() => firstDue.promise)
      .mockImplementationOnce(() => secondDue.promise)
      .mockImplementationOnce(() => thirdDue.promise);
    const runtime = createRuntime(async () => ({ globalPause: false, enginePaused: false }), listDue);
    const first = runtime.drainWorkflowContinuations();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.workflowContinuationDrainPhase).toBe("settings");
    vi.advanceTimersByTime(CONTINUATION_DRAIN_STALL_MS);
    const successor = runtime.drainWorkflowContinuations();
    await Promise.resolve();
    expect(runtime.workflowContinuationDrainGeneration).toBe(2);
    const successorProgress = runtime.workflowContinuationDrainProgressAt;
    expect(runtimeLog.warn).toHaveBeenCalledWith(expect.stringContaining("last phase: settings"));

    firstDue.resolve([]);
    await first;
    /*
    FNXC:EventDrivenDispatch 2026-09-18-00:40:
    FN-519 — the invariant here is that a LATE-COMPLETING superseded pass cannot reset the
    successor's guard, not that the successor is frozen at one named phase. A phase snapshot taken
    before `await first` had become an accidental pin on the drain's phase SEQUENCE: FN-514 inserted
    a `human-merge-holds` phase between `settings` and `list-due`, so the successor legitimately
    advanced past the captured value while the old pass unwound, and the case went red without any
    change to the fencing it exists to prove. Assert the reset that must not happen — an unclaimed
    guard, a zeroed progress mark, an `idle` phase, or a regressed progress timestamp — rather than
    a specific phase name.
    */
    expect(runtime.workflowContinuationDrainActive).toBe(true);
    expect(runtime.workflowContinuationDrainGeneration).toBe(2);
    expect(runtime.workflowContinuationDrainProgressAt).toBeGreaterThanOrEqual(successorProgress);
    expect(runtime.workflowContinuationDrainPhase).not.toBe("idle");
    expect(runtime.workflowContinuationDrainSince).not.toBe(0);

    vi.advanceTimersByTime(CONTINUATION_DRAIN_STALL_MS);
    const replacement = runtime.drainWorkflowContinuations();
    await Promise.resolve();
    expect(runtimeLog.warn).toHaveBeenCalledTimes(2);
    secondDue.resolve([]);
    await successor;
    thirdDue.resolve([]);
    await replacement;
  });

  it.each([
    ["globalPause", { globalPause: true, enginePaused: false }],
    ["enginePaused", { globalPause: false, enginePaused: true }],
  ])("releases Scheduler's single-flight guard after %s", async (_key, settings) => {
    const scheduler = Object.create(Scheduler.prototype) as any;
    scheduler.running = true;
    scheduler.scheduling = false;
    scheduler.schedulingSince = 0;
    scheduler.immediateSchedulePending = false;
    scheduler.idleSemaphoreLeakCandidateSince = null;
    scheduler.store = {
      listTasks: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({ ...settings, pollIntervalMs: 15_000 })),
    };
    scheduler.options = { semaphore: undefined, getInFlightTopLevelCount: () => 0 };
    scheduler.refreshPollInterval = vi.fn();
    scheduler.renewActiveMissionSymbolLocks = vi.fn(async () => undefined);
    await scheduler.schedule();
    expect(scheduler.scheduling).toBe(false);
  });
});
