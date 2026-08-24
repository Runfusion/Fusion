import { appendFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

export const MIN_WATCHDOG_MS = 1;
export const MIN_PROBE_TIMEOUT_MS = 10;
export const MIN_STATEMENT_TIMEOUT_MS = 1;
export const MAX_CONCURRENT_PROBES_CEILING = 8;

export type PgTimeoutBoundary = "setup" | "body" | "teardown";
export type PgTimeoutBoundaryTrigger = "boundary-complete" | "boundary-watchdog";
export type PgTimeoutBoundaryRecordKind = "progress" | "terminal" | "breach" | "watchdog";
export type PgTimeoutBoundarySuppression = "cap" | "concurrency" | "bounds-floor" | "drain-timeout" | "error";

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerFactory = (callback: () => void, ms: number) => TimerHandle;

export interface PgTimeoutBoundaryHostSample {
  readonly loadavg1: number;
  readonly loadavg5: number;
  readonly loadavg15: number;
  readonly cpuCount: number;
  readonly resolvedWorkers?: number;
  readonly eventLoopLagMs: number;
}

export interface PgTimeoutBoundaryProbePayload {
  readonly cluster: Record<string, unknown>;
  readonly template: Record<string, unknown>;
}

/** Resolved observer bounds passed to the production maintenance probe. */
export interface PgTimeoutBoundaryProbeBounds {
  readonly probeTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface PgTimeoutBoundaryRecord {
  readonly timestamp: string;
  readonly pid: number;
  readonly workerId?: string;
  readonly testFile?: string;
  readonly testName?: string;
  readonly boundary: PgTimeoutBoundary;
  readonly phase: string;
  /** Stable lifecycle label used to join reporter failures without line order. */
  readonly position: string;
  /** Per-window identity; progress-only keys prove an abandoned boundary. */
  readonly joinKey: string;
  /** Caller-owned lifecycle identity used only to supersede stale open windows. */
  readonly supersessionKey?: string;
  readonly kind: PgTimeoutBoundaryRecordKind;
  readonly trigger: PgTimeoutBoundaryTrigger;
  readonly elapsedMs: number;
  readonly boundaryIncomplete: boolean;
  /** A breach was synchronously recorded before its optional probe begins. */
  readonly payloadFree?: boolean;
  readonly settledDuringProbe?: boolean;
  readonly probeLatencyMs?: number;
  readonly probeStartDelayMs?: number;
  readonly supersededOpenWindow?: boolean;
  readonly outcome?: "resolved" | "rejected";
  readonly thresholdMs: number;
  readonly watchdogMs: number;
  readonly probeTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly probeDrainTimeoutMs: number;
  readonly maxConcurrentProbes: number;
  readonly probeQueueTimeoutMs: number;
  readonly boundsClamped: boolean;
  readonly probeSuppressed?: PgTimeoutBoundarySuppression;
  readonly host: PgTimeoutBoundaryHostSample;
  readonly cluster?: Record<string, unknown>;
  readonly template?: Record<string, unknown>;
}

export interface PgTimeoutBoundaryObserverOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Monotonic clock used only for elapsed durations. */
  readonly now?: () => number;
  /** Wall clock is retained solely as a cross-process join key. */
  readonly wallNow?: () => number;
  readonly setTimer?: TimerFactory;
  readonly clearTimer?: (timer: TimerHandle) => void;
  readonly append?: (path: string, line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly probe?: (signal: AbortSignal, bounds: PgTimeoutBoundaryProbeBounds) => Promise<PgTimeoutBoundaryProbePayload>;
  readonly hostSample?: (eventLoopLagMs?: number) => PgTimeoutBoundaryHostSample;
  readonly testFile?: string;
  readonly testName?: () => string | undefined;
  readonly inheritedHookBudgetMs?: number;
  readonly inheritedBodyBudgetMs?: number;
}

export interface PgTimeoutBoundaryHandle {
  readonly id: number;
}

export interface PgTimeoutBoundaryObserver {
  readonly enabled: boolean;
  observeBoundary<T>(boundary: PgTimeoutBoundary, phase: string, action: () => Promise<T>): Promise<T>;
  openBoundary(boundary: PgTimeoutBoundary, phase: string, key: string): PgTimeoutBoundaryHandle;
  closeBoundary(handle: PgTimeoutBoundaryHandle, outcome?: "resolved" | "rejected"): void;
  flush(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

let processProbeCount = 0;

/** Test-only reset for deterministic process-cap coverage. */
export function __resetPgTimeoutBoundaryObserverProbeCountForTest(): void {
  processProbeCount = 0;
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 0): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= minimum ? Math.trunc(value) : fallback;
}

/** Keep observer and census file joins stable across absolute and Windows paths. */
function normalizeTestFile(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const root = normalized.indexOf("src/__tests__/");
  if (root >= 0) return normalized.slice(root);
  return normalized;
}

function defaultHostSample(eventLoopLagMs = 0): PgTimeoutBoundaryHostSample {
  const [loadavg1, loadavg5, loadavg15] = loadavg();
  const workers = Number(process.env.VITEST_MAX_WORKERS);
  return {
    loadavg1,
    loadavg5,
    loadavg15,
    cpuCount: cpus().length,
    ...(Number.isFinite(workers) ? { resolvedWorkers: workers } : {}),
    // Watchdog scheduling drift is a bounded, allocation-free event-loop lag sample.
    eventLoopLagMs: Math.max(0, eventLoopLagMs),
  };
}

interface Bounds {
  readonly thresholdMs: number;
  readonly watchdog: Record<PgTimeoutBoundary, number>;
  readonly probeTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly probeDrainTimeoutMs: number;
  readonly maxConcurrentProbes: number;
  readonly probeQueueTimeoutMs: number;
  readonly maxProbes: number;
  /** Zero preserves the pre-FN-9150 settle/watchdog-only observer. */
  readonly ladderMs: number;
  readonly probeAllowed: boolean;
  readonly clamped: boolean;
}

function resolveBounds(env: NodeJS.ProcessEnv, hookBudget: number, bodyBudget: number): Bounds {
  let clamped = false;
  const thresholdMs = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_THRESHOLD_MS", 2_000);
  const requestedProbe = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_TIMEOUT_MS", 1_500, 1);
  const requestedStatement = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_STATEMENT_TIMEOUT_MS", Math.max(MIN_STATEMENT_TIMEOUT_MS, requestedProbe - 100), 1);
  const requestedDrain = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_DRAIN_TIMEOUT_MS", 3_000, 1);
  const ladderMs = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LADDER_MS", 0);
  const capBelowHook = Math.max(0, hookBudget - 1);
  // Floors make malformed tiny values observable, but never widen an inherited
  // budget: a budget below the floor disables probing for that boundary.
  const probeTimeoutMs = Math.min(Math.max(requestedProbe, MIN_PROBE_TIMEOUT_MS), capBelowHook);
  if (probeTimeoutMs !== requestedProbe) clamped = true;
  const probeAllowed = probeTimeoutMs >= MIN_PROBE_TIMEOUT_MS;
  if (!probeAllowed) clamped = true;
  let statementTimeoutMs = Math.min(requestedStatement, Math.max(0, probeTimeoutMs - 1));
  if (statementTimeoutMs !== requestedStatement) clamped = true;
  if (statementTimeoutMs < MIN_STATEMENT_TIMEOUT_MS) clamped = true;
  statementTimeoutMs = Math.max(MIN_STATEMENT_TIMEOUT_MS, statementTimeoutMs);
  let probeDrainTimeoutMs = Math.min(requestedDrain, capBelowHook);
  if (probeDrainTimeoutMs !== requestedDrain) clamped = true;
  probeDrainTimeoutMs = Math.max(1, probeDrainTimeoutMs);
  let maxConcurrentProbes = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_CONCURRENT_PROBES", 1, 1);
  const requestedConcurrency = maxConcurrentProbes;
  maxConcurrentProbes = Math.min(MAX_CONCURRENT_PROBES_CEILING, Math.max(1, maxConcurrentProbes));
  if (maxConcurrentProbes !== requestedConcurrency) clamped = true;
  let probeQueueTimeoutMs = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_PROBE_QUEUE_TIMEOUT_MS", 0);
  const requestedQueue = probeQueueTimeoutMs;
  probeQueueTimeoutMs = Math.min(probeQueueTimeoutMs, Math.max(0, probeTimeoutMs - 1));
  if (probeQueueTimeoutMs !== requestedQueue) clamped = true;
  const globalWatchdog = envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_MS", 12_000, 1);
  const watchdog = {} as Record<PgTimeoutBoundary, number>;
  for (const boundary of ["setup", "body", "teardown"] as const) {
    const requested = envNumber(env, `FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_WATCHDOG_${boundary.toUpperCase()}_MS`, globalWatchdog, 1);
    const budget = boundary === "body" ? bodyBudget : hookBudget;
    const upper = Math.max(0, budget - 1);
    const resolved = Math.min(requested, upper);
    watchdog[boundary] = resolved;
    if (resolved !== requested || resolved < MIN_WATCHDOG_MS) clamped = true;
  }
  return {
    thresholdMs,
    watchdog,
    probeTimeoutMs,
    statementTimeoutMs,
    probeDrainTimeoutMs,
    maxConcurrentProbes,
    probeQueueTimeoutMs,
    maxProbes: envNumber(env, "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_MAX_PROBES", 4, 1),
    ladderMs,
    probeAllowed,
    clamped,
  };
}

interface BoundaryState {
  readonly handle: PgTimeoutBoundaryHandle;
  readonly boundary: PgTimeoutBoundary;
  readonly phase: string;
  /** Unique emitted-record key; it must never be shared by adjacent test bodies. */
  readonly joinKey: string;
  /** Stable caller key that only controls stale-window supersession. */
  readonly supersessionKey?: string;
  readonly startedAt: number;
  readonly timestamp: string;
  readonly host: PgTimeoutBoundaryHostSample;
  timer?: TimerHandle;
  ladderTimer?: TimerHandle;
  settled: boolean;
  watchdogFired: boolean;
  outcome?: "resolved" | "rejected";
  supersededOpenWindow?: boolean;
}

interface PendingProbe {
  readonly state: BoundaryState;
  readonly watchdogAt: number;
  readonly host: PgTimeoutBoundaryHostSample;
  readonly controller: AbortController;
  queuedTimer?: TimerHandle;
  timeoutTimer?: TimerHandle;
  started: boolean;
  /** Monotonic delay from watchdog firing until the probe received a slot. */
  probeStartDelayMs?: number;
  /** Monotonic instant at which the probe actually started. */
  probeStartedAt?: number;
  finalized: boolean;
}

/*
FNXC:PgTimeoutBoundaryObserver 2026-08-19-13:51:
FN-9148 reproduced unrelated 27-worker PostgreSQL timeouts but left M1–M5
undecided because teardown-only snapshots cannot attribute setup or body waits.
This default-off observer records whether PostgreSQL is in-flight/blocked, the
host is starved, or golden-template ownership is convoying at a timeout.

Watchdog scheduling drift is sampled as bounded event-loop lag at the watchdog
instant. A fixed zero hid the M4 discriminator; the sample adds no timer, I/O,
or work to the observed boundary.

The paired API exists because shared-harness beforeEach and afterEach are
separate Vitest hooks: a promise wrapper cannot span a body timeout. Watchdogs
are per boundary and bounds only tighten below inherited budgets so observation
cannot extend work. A short watchdog intentionally remains independent from a
long probe timeout; probes survive settle and are drained, otherwise fast body
windows lose their only cluster payload.

Once probes survive their boundary, strict single-flight would suppress body and
teardown behind setup. The configurable limiter defaults to one (the inherited
cost profile) but is raisable for the forced wiring gate; its ceiling prevents a
bad environment from flooding PostgreSQL.

FNXC:PgTimeoutBoundaryObserver 2026-08-19-15:43:
FN-9150 needs elapsed evidence for boundaries Vitest abandons before they
settle. A payload-free checkpoint ladder is independent of probes, unref'd, and
writes synchronously so its last progress record is a lower bound rather than a
claim about PostgreSQL state. Terminal records make progress-only join keys the
explicit abandoned-boundary signature.

FNXC:PgTimeoutBoundaryObserver 2026-08-19-16:06:
A watchdog must append its keyed payload-free breach before scheduling a probe.
Vitest can abandon the boundary during that residual window, so waiting for the
probe result censors the timeout population this default-off observer measures.
The breach locates a boundary but never asserts PostgreSQL state.
*/
export function createPgTimeoutBoundaryObserver(options: PgTimeoutBoundaryObserverOptions = {}): PgTimeoutBoundaryObserver {
  const env = options.env ?? process.env;
  if (env.FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER !== "1") {
    return {
      enabled: false,
      async observeBoundary<T>(_boundary: PgTimeoutBoundary, _phase: string, action: () => Promise<T>): Promise<T> { return action(); },
      openBoundary: () => ({ id: 0 }),
      closeBoundary() {},
      async flush() {},
      async dispose() {},
    };
  }

  const now = options.now ?? Date.now;
  const wallNow = options.wallNow ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const append = options.append ?? ((path, line) => appendFileSync(path, line));
  const writeError = options.writeError ?? ((line) => console.error(line));
  const hostSample = options.hostSample ?? defaultHostSample;
  const bounds = resolveBounds(env, options.inheritedHookBudgetMs ?? 15_000, options.inheritedBodyBudgetMs ?? 15_000);
  const sink = env.FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER_LOG;
  let disposed = false;
  let nextHandle = 1;
  let activeSlots = 0;
  const states = new Map<number, BoundaryState>();
  const windows = new Map<string, BoundaryState>();
  const pending = new Set<PendingProbe>();

  const unref = (timer: TimerHandle | undefined): void => {
    (timer as unknown as { unref?: () => void } | undefined)?.unref?.();
  };
  const emit = (state: BoundaryState, trigger: PgTimeoutBoundaryTrigger, kind: PgTimeoutBoundaryRecordKind, fields: Partial<PgTimeoutBoundaryRecord>, writeStderr = true): void => {
    const record: PgTimeoutBoundaryRecord = {
      timestamp: state.timestamp,
      pid: process.pid,
      ...(env.VITEST_WORKER_ID ? { workerId: env.VITEST_WORKER_ID } : {}),
      ...(options.testFile ? { testFile: normalizeTestFile(options.testFile) } : {}),
      ...(options.testName?.() ? { testName: options.testName() } : {}),
      boundary: state.boundary,
      phase: state.phase,
      position: state.phase,
      joinKey: state.joinKey,
      ...(state.supersessionKey ? { supersessionKey: state.supersessionKey } : {}),
      kind,
      trigger,
      elapsedMs: Math.max(0, now() - state.startedAt),
      boundaryIncomplete: !state.settled,
      thresholdMs: bounds.thresholdMs,
      watchdogMs: bounds.watchdog[state.boundary],
      probeTimeoutMs: bounds.probeTimeoutMs,
      statementTimeoutMs: bounds.statementTimeoutMs,
      probeDrainTimeoutMs: bounds.probeDrainTimeoutMs,
      maxConcurrentProbes: bounds.maxConcurrentProbes,
      probeQueueTimeoutMs: bounds.probeQueueTimeoutMs,
      boundsClamped: bounds.clamped,
      host: state.host,
      ...fields,
    };
    if (sink) {
      try { append(sink, `${JSON.stringify(record)}\n`); } catch { /* sink failures must not affect a test */ }
    }
    if (writeStderr) {
      try { writeError(`[pg-timeout-boundary-observer] ${trigger} ${state.boundary}/${state.phase}`); } catch { /* diagnostic stderr is best effort */ }
    }
  };
  const finalize = (pendingProbe: PendingProbe, suppression?: PgTimeoutBoundarySuppression, payload?: PgTimeoutBoundaryProbePayload): void => {
    if (pendingProbe.finalized) return;
    pendingProbe.finalized = true;
    pending.delete(pendingProbe);
    if (pendingProbe.queuedTimer) clearTimer(pendingProbe.queuedTimer);
    if (pendingProbe.timeoutTimer) clearTimer(pendingProbe.timeoutTimer);
    if (pendingProbe.started) {
      activeSlots = Math.max(0, activeSlots - 1);
      admitQueued();
    }
    const state = pendingProbe.state;
    emit(state, "boundary-watchdog", "watchdog", {
      elapsedMs: bounds.watchdog[state.boundary],
      boundaryIncomplete: true,
      settledDuringProbe: state.settled,
      ...(pendingProbe.probeStartedAt !== undefined ? { probeLatencyMs: Math.max(0, now() - pendingProbe.probeStartedAt) } : {}),
      ...(pendingProbe.probeStartDelayMs !== undefined ? { probeStartDelayMs: pendingProbe.probeStartDelayMs } : {}),
      ...(state.supersededOpenWindow ? { supersededOpenWindow: true } : {}),
      ...(state.outcome ? { outcome: state.outcome } : {}),
      ...(suppression ? { probeSuppressed: suppression } : {}),
      ...(payload ? { cluster: payload.cluster, template: payload.template } : {}),
      host: pendingProbe.host,
    });
  };
  const startProbe = (pendingProbe: PendingProbe): void => {
    if (pendingProbe.finalized) return;
    if (processProbeCount >= bounds.maxProbes) {
      finalize(pendingProbe, "cap");
      return;
    }
    processProbeCount += 1;
    pendingProbe.started = true;
    pendingProbe.probeStartDelayMs = Math.max(0, now() - pendingProbe.watchdogAt);
    pendingProbe.probeStartedAt = now();
    activeSlots += 1;
    pendingProbe.timeoutTimer = setTimer(() => {
      pendingProbe.controller.abort();
      finalize(pendingProbe, "error");
    }, bounds.probeTimeoutMs);
    unref(pendingProbe.timeoutTimer);
    void Promise.resolve().then(() => options.probe?.(pendingProbe.controller.signal, {
      probeTimeoutMs: bounds.probeTimeoutMs,
      statementTimeoutMs: bounds.statementTimeoutMs,
    })).then(
      (payload) => finalize(pendingProbe, undefined, payload),
      () => finalize(pendingProbe, "error"),
    );
  };
  const admitQueued = (): void => {
    for (const candidate of pending) {
      if (activeSlots >= bounds.maxConcurrentProbes) return;
      if (!candidate.started && !candidate.finalized) startProbe(candidate);
    }
  };
  const requestProbe = (state: BoundaryState, eventLoopLagMs: number): void => {
    const watchdogAt = now();
    const host = hostSample(eventLoopLagMs);
    // This synchronous first phase survives disposal/worker termination while a
    // maintenance connection is still queued or executing.
    emit(state, "boundary-watchdog", "breach", {
      elapsedMs: bounds.watchdog[state.boundary],
      boundaryIncomplete: true,
      payloadFree: true,
      host,
    });
    const pendingProbe: PendingProbe = { state, watchdogAt, host, controller: new AbortController(), started: false, finalized: false };
    if (!options.probe) return finalize(pendingProbe, "error");
    if (!bounds.probeAllowed) return finalize(pendingProbe, "bounds-floor");
    pending.add(pendingProbe);
    if (activeSlots < bounds.maxConcurrentProbes) {
      startProbe(pendingProbe);
      return;
    }
    if (bounds.probeQueueTimeoutMs === 0) return finalize(pendingProbe, "concurrency");
    pendingProbe.queuedTimer = setTimer(() => finalize(pendingProbe, "concurrency"), bounds.probeQueueTimeoutMs);
    unref(pendingProbe.queuedTimer);
  };
  const fireWatchdog = (state: BoundaryState): void => {
    if (disposed || state.settled || state.watchdogFired) return;
    state.watchdogFired = true;
    // The overdue watchdog callback measures scheduling delay at the same instant
    // as the host/cluster snapshot, without adding another timer or I/O path.
    requestProbe(state, Math.max(0, now() - (state.startedAt + bounds.watchdog[state.boundary])));
  };
  const armLadder = (state: BoundaryState): void => {
    if (bounds.ladderMs === 0) return;
    const checkpoint = (): void => {
      if (state.ladderTimer) clearTimer(state.ladderTimer);
      if (disposed || state.settled) return;
      emit(state, "boundary-complete", "progress", { boundaryIncomplete: true }, false);
      state.ladderTimer = setTimer(checkpoint, bounds.ladderMs);
      unref(state.ladderTimer);
    };
    state.ladderTimer = setTimer(checkpoint, bounds.ladderMs);
    unref(state.ladderTimer);
  };
  const arm = (state: BoundaryState): void => {
    state.timer = setTimer(() => fireWatchdog(state), bounds.watchdog[state.boundary]);
    unref(state.timer);
    armLadder(state);
  };
  const complete = (state: BoundaryState, outcome: "resolved" | "rejected"): void => {
    if (state.settled) return;
    state.settled = true;
    state.outcome = outcome;
    if (state.timer) clearTimer(state.timer);
    if (state.ladderTimer) clearTimer(state.ladderTimer);
    states.delete(state.handle.id);
    if (state.supersessionKey && windows.get(state.supersessionKey) === state) windows.delete(state.supersessionKey);
    // A terminal record is emitted regardless of threshold. Progress-only keys
    // are therefore the durable, resolution-bounded signature of abandonment.
    const reportCompletion = !state.watchdogFired && Math.max(0, now() - state.startedAt) >= bounds.thresholdMs;
    emit(state, "boundary-complete", "terminal", { outcome, boundaryIncomplete: false }, reportCompletion);
  };
  const beforeExit = (): void => { void flush(); };
  process.on("beforeExit", beforeExit);

  const flush = async (timeoutMs = bounds.probeDrainTimeoutMs): Promise<void> => {
    if (pending.size === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimer(() => {
        for (const item of [...pending]) finalize(item, "drain-timeout");
        resolve();
      }, Math.max(1, timeoutMs));
      unref(timer);
      const check = (): void => {
        if (pending.size === 0) {
          clearTimer(timer);
          resolve();
        } else setTimer(check, 1);
      };
      check();
    });
  };

  return {
    enabled: true,
    observeBoundary<T>(boundary: PgTimeoutBoundary, phase: string, action: () => Promise<T>): Promise<T> {
      const handle = { id: nextHandle++ };
      const state: BoundaryState = { handle, boundary, phase, joinKey: `${process.pid}:${env.VITEST_WORKER_ID ?? "main"}:${normalizeTestFile(options.testFile ?? "unknown")}:${phase}:${handle.id}`, startedAt: now(), timestamp: new Date(wallNow()).toISOString(), host: hostSample(), settled: false, watchdogFired: false };
      states.set(state.handle.id, state);
      arm(state);
      let result: Promise<T>;
      try { result = action(); } catch (error) { complete(state, "rejected"); throw error; }
      return result.then((value) => { complete(state, "resolved"); return value; }, (error: unknown) => { complete(state, "rejected"); throw error; });
    },
    openBoundary(boundary: PgTimeoutBoundary, phase: string, key: string): PgTimeoutBoundaryHandle {
      const prior = windows.get(key);
      const superseded = Boolean(prior && !prior.settled);
      if (prior && !prior.settled) {
        if (prior.timer) clearTimer(prior.timer);
        if (prior.ladderTimer) clearTimer(prior.ladderTimer);
        prior.settled = true;
        states.delete(prior.handle.id);
      }
      const handle = { id: nextHandle++ };
      /*
      FNXC:PgTimeoutBoundaryObserver 2026-08-19-16:56:
      Shared-harness body hooks reuse a file-level lifecycle key across tests.
      That key may supersede a stale handle, but every body window needs its own
      emitted join key: a later healthy terminal must not mask an earlier
      abandoned body's ladder records in the failure census.
      */
      const state: BoundaryState = { handle, boundary, phase, joinKey: `${key}:${handle.id}`, supersessionKey: key, startedAt: now(), timestamp: new Date(wallNow()).toISOString(), host: hostSample(), settled: false, watchdogFired: false, ...(superseded ? { supersededOpenWindow: true } : {}) };
      windows.set(key, state);
      states.set(state.handle.id, state);
      arm(state);
      return state.handle;
    },
    closeBoundary(handle: PgTimeoutBoundaryHandle, outcome = "resolved"): void {
      const state = states.get(handle.id);
      if (state) complete(state, outcome);
    },
    flush,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const state of states.values()) {
        if (state.timer) clearTimer(state.timer);
        if (state.ladderTimer) clearTimer(state.ladderTimer);
      }
      states.clear();
      windows.clear();
      await flush();
      process.removeListener("beforeExit", beforeExit);
    },
  };
}
