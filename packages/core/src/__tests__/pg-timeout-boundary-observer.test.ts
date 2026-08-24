import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPgTimeoutBoundaryObserverProbeCountForTest,
  createPgTimeoutBoundaryObserver,
  MAX_CONCURRENT_PROBES_CEILING,
  type PgTimeoutBoundaryProbePayload,
} from "../__test-utils__/pg-timeout-boundary-observer.js";

const payload: PgTimeoutBoundaryProbePayload = {
  cluster: { activity: [{ pid: 1, state: "active" }], totalBackends: 4 },
  template: { goldenTemplateName: "fusion_schema_template_test", markerPresent: true },
};

const env = {
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER: "1",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LOG: "memory",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_THRESHOLD_MS: "0",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_MS: "10",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_TIMEOUT_MS: "100",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_STATEMENT_TIMEOUT_MS: "50",
  FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_DRAIN_TIMEOUT_MS: "100",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function records(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.useRealTimers();
  __resetPgTimeoutBoundaryObserverProbeCountForTest();
});

describe("PG timeout boundary observer", () => {
  it("is completely inert while disabled for wrapping and paired APIs", async () => {
    const setTimer = vi.fn(setTimeout);
    const append = vi.fn();
    const probe = vi.fn();
    const observer = createPgTimeoutBoundaryObserver({ env: {}, setTimer, append, probe });
    await expect(observer.observeBoundary("setup", "store.init", async () => "value")).resolves.toBe("value");
    await expect(observer.observeBoundary("setup", "store.init", async () => { throw new Error("unchanged"); })).rejects.toThrow("unchanged");
    observer.closeBoundary(observer.openBoundary("body", "shared.body", "body-key"));
    await observer.flush();
    await observer.dispose();
    expect(observer.enabled).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("arms before the action and retains a watchdog payload after a boundary settles", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const pending = deferred<PgTimeoutBoundaryProbePayload>();
    const probe = vi.fn(() => pending.promise);
    const observer = createPgTimeoutBoundaryObserver({ env, probe, append: (_path, line) => lines.push(line), writeError: () => {} });
    let release!: () => void;
    const action = new Promise<void>((resolve) => { release = resolve; });
    const observed = observer.observeBoundary("body", "shared.body", () => action);
    await vi.advanceTimersByTimeAsync(10);
    expect(probe).toHaveBeenCalledTimes(1);
    release();
    await observed;
    pending.resolve(payload);
    await vi.advanceTimersByTimeAsync(0);
    expect(records(lines)).toContainEqual(expect.objectContaining({
      trigger: "boundary-watchdog", kind: "watchdog", boundary: "body", phase: "shared.body", boundaryIncomplete: true,
      settledDuringProbe: true, cluster: payload.cluster, template: payload.template,
    }));
    await observer.dispose();
  });

  it("records progress-only ladder bounds for an abandoned boundary and clears unref'd timers", async () => {
    const lines: string[] = [];
    let now = 0;
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const clearTimer = vi.fn();
    const observer = createPgTimeoutBoundaryObserver({
      env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LADDER_MS: "5" },
      now: () => now,
      setTimer: ((callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: clearTimer as typeof clearTimeout,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    observer.openBoundary("body", "shared.body", "abandoned");
    now = 5;
    timers.find((timer) => timer.ms === 5)?.callback();
    now = 10;
    timers.at(-1)?.callback();
    await observer.dispose();

    const progress = records(lines).filter((record) => record.kind === "progress");
    expect(progress).toEqual([
      expect.objectContaining({ joinKey: "abandoned:1", elapsedMs: 5, boundaryIncomplete: true }),
      expect.objectContaining({ joinKey: "abandoned:1", elapsedMs: 10, boundaryIncomplete: true }),
    ]);
    expect(records(lines).some((record) => record.kind === "terminal")).toBe(false);
    expect(timers.every((timer) => timer.unref.mock.calls.length === 1)).toBe(true);
    expect(clearTimer).toHaveBeenCalledTimes(4);
  });

  it("keeps an abandoned shared-harness body window distinct from a later healthy body", async () => {
    const lines: string[] = [];
    let now = 0;
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const observer = createPgTimeoutBoundaryObserver({
      env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LADDER_MS: "5" },
      now: () => now,
      testFile: "/repo/packages/core/src/__tests__/postgres/shared-bodies.pg.test.ts",
      setTimer: ((callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: () => {},
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    // This is the file-level key passed by createSharedPgTaskStoreTestHarness
    // for consecutive beforeEach/afterEach body windows.
    const sharedHarnessKey = `${process.pid}:main:/repo/packages/core/src/__tests__/postgres/shared-bodies.pg.test.ts`;
    observer.openBoundary("body", "shared.body", sharedHarnessKey);
    now = 5;
    timers.find((timer) => timer.ms === 5)?.callback();
    const healthyBody = observer.openBoundary("body", "shared.body", sharedHarnessKey);
    observer.closeBoundary(healthyBody);

    const emitted = records(lines);
    const abandonedProgress = emitted.find((record) => record.kind === "progress");
    const healthyTerminal = emitted.find((record) => record.kind === "terminal");
    expect(abandonedProgress).toMatchObject({ supersessionKey: sharedHarnessKey, boundary: "body", elapsedMs: 5 });
    expect(healthyTerminal).toMatchObject({ supersessionKey: sharedHarnessKey, boundary: "body" });
    expect(abandonedProgress?.joinKey).not.toBe(healthyTerminal?.joinKey);
    await observer.dispose();
  });

  it("records a payload-free breach before an abandoned probe can resolve", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const pending = deferred<PgTimeoutBoundaryProbePayload>();
    const observer = createPgTimeoutBoundaryObserver({
      env,
      probe: () => pending.promise,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    observer.openBoundary("setup", "database.clone", "abandoned-watchdog");
    await vi.advanceTimersByTimeAsync(10);
    expect(records(lines)).toContainEqual(expect.objectContaining({
      kind: "breach",
      payloadFree: true,
      joinKey: "abandoned-watchdog:1",
      boundary: "setup",
    }));
    const disposing = observer.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await disposing;
  });

  it("records watchdog scheduling drift as event-loop lag for host attribution", async () => {
    const lines: string[] = [];
    let now = 0;
    let watchdog: (() => void) | undefined;
    const observer = createPgTimeoutBoundaryObserver({
      env,
      now: () => now,
      setTimer: (callback) => { watchdog = callback; return 0 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
      hostSample: (eventLoopLagMs = 0) => ({ loadavg1: 0, loadavg5: 0, loadavg15: 0, cpuCount: 8, eventLoopLagMs }),
      probe: async () => payload,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    const handle = observer.openBoundary("body", "shared.body", "lagged-body");
    now = 125;
    watchdog?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    observer.closeBoundary(handle);
    expect(records(lines)).toContainEqual(expect.objectContaining({
      trigger: "boundary-watchdog",
      boundary: "body",
      host: expect.objectContaining({ eventLoopLagMs: 115 }),
    }));
    await observer.dispose();
  });

  it("records all three concurrent boundaries at a raised concurrency limit", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const probes = [deferred<PgTimeoutBoundaryProbePayload>(), deferred<PgTimeoutBoundaryProbePayload>(), deferred<PgTimeoutBoundaryProbePayload>()];
    let index = 0;
    const observer = createPgTimeoutBoundaryObserver({
      env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_CONCURRENT_PROBES: "3", FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_PROBES: "3" },
      probe: () => probes[index++]!.promise,
      append: (_path, line) => lines.push(line), writeError: () => {},
    });
    const setup = observer.openBoundary("setup", "template.ensure", "setup");
    const body = observer.openBoundary("body", "shared.body", "body");
    const teardown = observer.openBoundary("teardown", "dropDatabase", "teardown");
    await vi.advanceTimersByTimeAsync(10);
    observer.closeBoundary(setup); observer.closeBoundary(body); observer.closeBoundary(teardown);
    probes.forEach((entry) => entry.resolve(payload));
    await vi.advanceTimersByTimeAsync(0);
    expect(records(lines).filter((record) => record.trigger === "boundary-watchdog" && record.cluster)).toHaveLength(3);
    await observer.dispose();
  });

  it("suppresses a concurrent watchdog at the default limit and releases its slot for a later probe", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const first = deferred<PgTimeoutBoundaryProbePayload>();
    const second = deferred<PgTimeoutBoundaryProbePayload>();
    const probe = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const observer = createPgTimeoutBoundaryObserver({ env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_PROBES: "3" }, probe, append: (_path, line) => lines.push(line), writeError: () => {} });
    observer.openBoundary("setup", "template.ensure", "first");
    observer.openBoundary("body", "shared.body", "second");
    await vi.advanceTimersByTimeAsync(10);
    expect(records(lines)).toContainEqual(expect.objectContaining({ probeSuppressed: "concurrency", boundary: "body" }));
    first.resolve(payload);
    await vi.advanceTimersByTimeAsync(0);
    observer.openBoundary("teardown", "dropDatabase", "third");
    await vi.advanceTimersByTimeAsync(10);
    expect(probe).toHaveBeenCalledTimes(2);
    second.resolve(payload);
    await vi.advanceTimersByTimeAsync(0);
    await observer.dispose();
  });

  it("records threshold-zero completions and accepts a short watchdog with a long independent probe timeout", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const observer = createPgTimeoutBoundaryObserver({
      env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_BODY_MS: "5", FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_TIMEOUT_MS: "100" },
      append: (_path, line) => lines.push(line), writeError: () => {},
    });
    const handle = observer.openBoundary("body", "shared.body", "body");
    observer.closeBoundary(handle);
    expect(records(lines)).toContainEqual(expect.objectContaining({ trigger: "boundary-complete", watchdogMs: 5, probeTimeoutMs: 100 }));
    await observer.dispose();
  });

  it("clamps concurrency to its ceiling and never fabricates paired completion on a superseded window", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const observer = createPgTimeoutBoundaryObserver({
      env: { ...env, FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_CONCURRENT_PROBES: "999" },
      append: (_path, line) => lines.push(line), writeError: () => {},
    });
    const stale = observer.openBoundary("body", "shared.body", "same");
    const fresh = observer.openBoundary("body", "shared.body", "same");
    observer.closeBoundary(stale);
    observer.closeBoundary(fresh);
    const complete = records(lines).find((record) => record.trigger === "boundary-complete");
    expect(complete).toMatchObject({ maxConcurrentProbes: MAX_CONCURRENT_PROBES_CEILING, boundsClamped: true });
    expect(records(lines).filter((record) => record.trigger === "boundary-complete")).toHaveLength(1);
    await observer.dispose();
  });
});
