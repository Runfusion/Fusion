import { appendFileSync } from "node:fs";

/** Rows deliberately limited to pg_stat_activity fields safe for test diagnostics. */
export interface PgTeardownActivityRow {
  readonly pid?: number;
  readonly datname?: string | null;
  readonly usename?: string | null;
  readonly state?: string | null;
  readonly wait_event_type?: string | null;
  readonly wait_event?: string | null;
  readonly backend_type?: string | null;
  readonly query_age?: string | null;
  readonly query?: string | null;
  readonly total_backends?: number;
}

export type PgTeardownDiagnosticTrigger = "phase-complete" | "phase-watchdog" | "teardown-watchdog" | "snapshot";

export interface PgTeardownDiagnosticRecord {
  readonly timestamp: string;
  readonly pid: number;
  readonly workerId?: string;
  readonly testFile?: string;
  readonly trigger: PgTeardownDiagnosticTrigger;
  readonly phase?: string;
  readonly phaseDurationsMs: Readonly<Record<string, number>>;
  readonly phaseIncomplete?: boolean;
  readonly elapsedAtSnapshotMs?: number;
  readonly thresholdMs: number;
  readonly hookWatchdogMs: number;
  readonly probeTimeoutMs: number;
  readonly probeRan: boolean;
  readonly probeSuppressed?: "cap" | "single-flight";
  readonly snapshotRows?: readonly PgTeardownActivityRow[];
}

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerFactory = (callback: () => void, ms: number) => TimerHandle;

export interface PgTeardownDiagnosticsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly setTimer?: TimerFactory;
  readonly clearTimer?: (timer: TimerHandle) => void;
  readonly append?: (path: string, line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly probe?: (signal: AbortSignal) => Promise<readonly PgTeardownActivityRow[]>;
  readonly testFile?: string;
}

export interface PgTeardownDiagnostics {
  readonly enabled: boolean;
  beginTeardown(): void;
  completeTeardown(): void;
  runPhase<T>(phase: string, action: () => Promise<T>): Promise<T>;
  dispose(): void;
}

let processProbeCount = 0;

/** Test-only reset for deterministic cap coverage; production never calls this. */
export function __resetPgTeardownDiagnosticsProbeCountForTest(): void {
  processProbeCount = 0;
}

function boundedEnvNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const candidate = Number(env[key]);
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : fallback;
}

/**
 * FNXC:PgTestHarnessTeardownDiagnostics 2026-08-16-19:40:
 * Keep the dedicated PostgreSQL probe's server-side bound aligned with its
 * watchdog budget, rather than allowing a lower caller-configured bound to drift.
 */
export function getPgTeardownDiagnosticsProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedEnvNumber(env, "FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_PROBE_TIMEOUT_MS", 1_500);
}

/**
 * FNXC:PgTestHarnessTeardownDiagnostics 2026-08-16-19:40:
 * The probe's PostgreSQL statement timeout must stay below the configured
 * client-side bound, including deliberately small test budgets; otherwise its
 * server query could outlive the diagnostic watchdog it is meant to respect.
 */
export function getPgTeardownDiagnosticsStatementTimeoutMs(probeTimeoutMs: number): number {
  return Math.max(1, probeTimeoutMs - 100);
}

function formatRecord(record: PgTeardownDiagnosticRecord): string {
  const rows = record.snapshotRows?.map((row) =>
    `${row.datname ?? "?"}/${row.state ?? "?"}/${row.wait_event ?? "?"}`,
  ).join(", ");
  return `[pg-teardown-diagnostics] trigger=${record.trigger} phase=${record.phase ?? "teardown"} elapsed=${record.elapsedAtSnapshotMs ?? Object.values(record.phaseDurationsMs).at(-1) ?? 0}ms${rows ? ` activity=${rows}` : ""}`;
}

/**
 * FNXC:PgTestHarnessTeardownDiagnostics 2026-08-16-19:12:
 * Register entry 7 observed a 15s afterAll abort without a reproducible phase
 * owner. This default-off recorder measures before changing teardown behavior.
 * Watchdogs fire while a phase is pending because post-hoc arithmetic is silent
 * when Vitest aborts a hung hook; their records flush synchronously because the
 * worker may be torn down immediately afterward. Timers are unref'd, and probes
 * are capped, single-flight, lazy, and hard-bounded so diagnostics cannot become
 * another connection contender or keep a worker alive during the contention being measured.
 */
export function createPgTeardownDiagnostics(options: PgTeardownDiagnosticsOptions = {}): PgTeardownDiagnostics {
  const env = options.env ?? process.env;
  const enabled = env.FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS === "1";
  if (!enabled) {
    return {
      enabled: false,
      beginTeardown() {},
      completeTeardown() {},
      async runPhase<T>(_phase: string, action: () => Promise<T>): Promise<T> { return action(); },
      dispose() {},
    };
  }

  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const append = options.append ?? ((path, line) => appendFileSync(path, line));
  const writeError = options.writeError ?? ((line) => console.error(line));
  const thresholdMs = boundedEnvNumber(env, "FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_THRESHOLD_MS", 2_000);
  const hookWatchdogMs = boundedEnvNumber(env, "FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_HOOK_WATCHDOG_MS", 12_000);
  const probeTimeoutMs = getPgTeardownDiagnosticsProbeTimeoutMs(env);
  const maxProbes = boundedEnvNumber(env, "FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_MAX_PROBES", 3);
  const sink = env.FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG;
  const phaseDurations: Record<string, number> = {};
  let teardownStartedAt = 0;
  let teardownWatchdog: TimerHandle | undefined;
  let teardownWatchdogFired = false;
  let disposed = false;
  let probeInFlight = false;

  const unref = (timer: TimerHandle): void => {
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const emit = (record: Omit<PgTeardownDiagnosticRecord, "timestamp" | "pid" | "workerId" | "testFile" | "phaseDurationsMs" | "thresholdMs" | "hookWatchdogMs" | "probeTimeoutMs">): void => {
    const complete: PgTeardownDiagnosticRecord = {
      ...record,
      timestamp: new Date(now()).toISOString(),
      pid: process.pid,
      ...(env.VITEST_WORKER_ID ? { workerId: env.VITEST_WORKER_ID } : {}),
      ...(options.testFile ? { testFile: options.testFile } : {}),
      phaseDurationsMs: { ...phaseDurations },
      thresholdMs,
      hookWatchdogMs,
      probeTimeoutMs,
    };
    const line = `${JSON.stringify(complete)}\n`;
    if (sink) {
      try { append(sink, line); } catch { /* diagnostic sink failures are non-fatal */ }
    }
    try { writeError(formatRecord(complete)); } catch { /* console failures are non-fatal */ }
  };

  const requestProbe = (): { probeRan: boolean; probeSuppressed?: "cap" | "single-flight" } => {
    if (!options.probe) return { probeRan: false };
    if (probeInFlight) return { probeRan: false, probeSuppressed: "single-flight" };
    if (processProbeCount >= maxProbes) return { probeRan: false, probeSuppressed: "cap" };
    processProbeCount += 1;
    probeInFlight = true;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, probeTimeoutMs);
    unref(timeout);
    const probePromise = Promise.resolve().then(() => options.probe!(controller.signal));
    void probePromise.then(
      (snapshotRows) => {
        if (!timedOut) emit({ trigger: "snapshot", probeRan: true, snapshotRows });
      },
      () => {},
    ).finally(() => {
      clearTimer(timeout);
      probeInFlight = false;
    }).catch(() => {});
    return { probeRan: true };
  };

  const fireTeardownWatchdog = (): void => {
    if (disposed || teardownWatchdogFired) return;
    teardownWatchdogFired = true;
    const probe = requestProbe();
    emit({
      trigger: "teardown-watchdog",
      phaseIncomplete: true,
      elapsedAtSnapshotMs: Math.max(0, now() - teardownStartedAt),
      ...probe,
    });
  };

  return {
    enabled: true,
    beginTeardown(): void {
      if (disposed || teardownWatchdog) return;
      teardownStartedAt = now();
      teardownWatchdog = setTimer(fireTeardownWatchdog, hookWatchdogMs);
      unref(teardownWatchdog);
    },
    completeTeardown(): void {
      if (teardownWatchdog) clearTimer(teardownWatchdog);
      teardownWatchdog = undefined;
    },
    async runPhase<T>(phase: string, action: () => Promise<T>): Promise<T> {
      const startedAt = now();
      let settled = false;
      let watchdogFired = false;
      const watchdog = setTimer(() => {
        if (settled || disposed || watchdogFired) return;
        watchdogFired = true;
        const elapsedAtSnapshotMs = Math.max(0, now() - startedAt);
        phaseDurations[phase] = elapsedAtSnapshotMs;
        const probe = requestProbe();
        emit({ trigger: "phase-watchdog", phase, phaseIncomplete: true, elapsedAtSnapshotMs, ...probe });
      }, thresholdMs);
      unref(watchdog);
      try {
        return await action();
      } finally {
        settled = true;
        clearTimer(watchdog);
        phaseDurations[phase] = Math.max(0, now() - startedAt);
        emit({ trigger: "phase-complete", phase, probeRan: false });
      }
    },
    dispose(): void {
      disposed = true;
      if (teardownWatchdog) clearTimer(teardownWatchdog);
      teardownWatchdog = undefined;
    },
  };
}
