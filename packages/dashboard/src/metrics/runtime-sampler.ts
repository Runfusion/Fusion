/**
 * RUFU-081 runtime sampler: request-path latency recorder, process CPU/memory
 * gauges, child-process spawn counter, and a bounded git-subprocess gauge.
 *
 * This module feeds the Prometheus-text `/metrics` endpoint
 * (`prometheus-text.ts`). It owns the in-process measurement state that a
 * `/metrics` scrape must render synchronously from a pre-read snapshot — a
 * scrape or sampler tick must NEVER starve the event loop, so every sampler is
 * cheap and non-blocking:
 *   - request latency is recorded per served request in O(1) and stored in a
 *     bounded ring;
 *   - process CPU/memory come from the synchronous `process.cpuUsage()` /
 *     `process.memoryUsage()` calls;
 *   - the spawn counter is a monkey-patch that delegates to the bound original
 *     via `.call(this, ...)` so child spawning is never broken and nested usage
 *     through `superviseSpawn` / `runCommandAsync` keeps working;
 *   - the git-subprocess gauge is a single-level `ps --ppid <pid>` (POSIX-only,
 *     best-effort, at most every ~15s, NEVER recursive).
 *
 * The whole module is intentionally framework-light: every dependency is
 * injectable (process, child_process, ps probe, timers) so samplers and the
 * spawn hook are unit-testable without spawning real children or booting
 * Express. The latency recorder exposes an Express-compatible
 * `(req, res, next)` middleware (see {@link createRequestLatencyMiddleware}).
 */

/*
FNXC:MetricsEndpoint 2026-08-13-17:38:
RUFU-081: serve a Prometheus-text `GET /metrics` on the dashboard exposing the
five system/runtime/Fusion-domain measurements a 2026-08-13 CPU/UI-freeze
diagnosis collected by hand (event-loop health latency, native spawn cadence,
PG query rate, git subprocess count, engine CPU/RSS). This is the RUNTIME
sampler half: request-path latency (the ONLY direct freeze indicator), process
CPU/memory gauges, the child_process spawn-count hook, and the bounded
git-subprocess probe.

Non-negotiable constraints honored here:
  - A /metrics scrape or sampler tick must NEVER starve the event loop: the
    handler renders synchronously from pre-read state, and every sampler is
    cheap/best-effort.
  - The event-loop/health-latency metric must reflect the LIVE serving path
    (the actual HTTP handler cost), not a synthetic probe. That is why the
    latency recorder is an Express middleware mounted before route handlers and
    records `finish` (real pipeline cost) on the response.
  - The spawn hook patches the live CommonJS exports object of
    node:child_process (not a statically-destructured function ref) so native
    `spawn@:-1` callers observable via `require`/`import * as cp` are counted;
    it delegates via .apply and NEVER breaks child spawning.
  - The git gauge is a single-level `ps --ppid <pid>` (POSIX-only, best-effort,
    ~15s, never recursive) that degrades to 0 on failure.
  - Metric values are numeric gauges; nothing here writes prose into the
    run-audit (FN-7158/FN-7528). No GitHub push; this lands via local main /
    operator only.
*/

import { exec } from "node:child_process";
import { createRequire } from "node:module";

import type { MetricFamily } from "./prometheus-text.js";

/**
 * The live CommonJS exports object of `node:child_process`. Monkey-patching
 * this OBJECT (instead of a statically-destructured function reference) makes
 * the spawn-count hook visible to `require("node:child_process")` and
 * `import * as cp` callers — the call-time object-access path the 2026-08-13
 * diagnosis saw as native `spawn@:-1` frames with no JS parent. Statically
 * destructured callers (e.g. `import { spawn }`) capture the original at module
 * load and are not re-routed — an accepted, inherent limit. The hook NEVER
 * breaks child spawning: the wrapper delegates to the original via `.apply`.
 */
const childProcessRequire = createRequire(import.meta.url);

/** Cap on the number of recent request durations retained for histogram math. */
export const REQUEST_LATENCY_RING_CAP = 256;
/** Default histogram bucket edges in milliseconds (Prometheus histogram). */
export const DEFAULT_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
/** Spawn-hook gauge label for the operation kind. */
const SPAWN_KIND_LABEL = "kind";

/** A process surface the sampler reads gauges from (injectable for tests). */
export interface ProcessLike {
  pid: number;
  cpuUsage: (prev?: { user: number; system: number }) => { user: number; system: number };
  memoryUsage: () => {
    rss: number;
    heapTotal: number;
    heapUsed: number;
  };
}

/**
 * A hookable process-command surface. `spawn`, `fork`, `execFile`, and `exec`
 * are patched by the spawn counter and restored on stop. The wrapper delegates
 * to the ORIGINAL via `.call(this, ...)` so receiver-bound callers and nested
 * usage through `superviseSpawn` / `runCommandAsync` keep working.
 */
export interface SpawnableChildProcessModule {
  spawn: (...args: unknown[]) => unknown;
  fork: (...args: unknown[]) => unknown;
  execFile: (...args: unknown[]) => unknown;
  exec: (...args: unknown[]) => unknown;
}

/** Numeric shape the spawn counter derives from the hook. */
export interface SpawnCounts {
  /** Total spawn/fork/execFile/exec invocations since the hook was installed. */
  total: number;
  /** Per-kind cumulative counts keyed by `"spawn" | "fork" | "execFile" | "exec"`. */
  byKind: Record<string, number>;
}

/** Mutable state the latency recorder updates per served request. */
export interface LatencyRecorderState {
  /** Ring of the most recent served-request durations (ms). */
  recent: number[];
  /** Max duration (ms) seen since the last reset/start. */
  maxMs: number;
  /** Monotonic cumulative request count. */
  requestCount: number;
  /** Epoch ms of the last served request, or -1 if none served yet. */
  lastServedAtMs: number;
}

/** A stubbed `ps --ppid` result: exit code and parsed child rows. */
export interface PsProbeResult {
  ok: boolean;
  /** Child process command names from a single-level `ps --ppid <pid>`. */
  childCommands: string[];
  /** When `ok` is false, set to a short reason like "ENOENT" | "non-posix". */
  reason?: string;
}

/**
 * A callable `ps` probe. Kept injectable so tests can substitute a fake
 * without spawning a real process. The production default runs a bounded,
 * single-level `ps -o comm= --ppid <pid>` scan.
 */
export type PsProbe = (pid: number) => Promise<PsProbeResult>;

/** A fake-timer-friendly interval surface. */
export interface TimerLike {
  unref?: () => void;
}

/** The runtime sampler handles samplers, hooks, and snapshot rendering. */
export interface RuntimeSampler {
  /** Latency recorder state (bounded ring + last-served timestamp). */
  readonly latency: LatencyRecorderState;
  /** Spawn counter state (cumulative + per-kind). */
  readonly spawnCounts: SpawnCounts;
  /** True while the spawn hook is installed. */
  readonly spawnHookInstalled: boolean;
  /** True while any interval timer is running. */
  readonly started: boolean;

  /** Install the spawn-count hook (idempotent). Returns true if newly installed. */
  installSpawnHook(): boolean;
  /** Remove the spawn-count hook, restoring the original functions exactly. */
  removeSpawnHook(): void;

  /** Record one served request duration (ms) into the bounded ring. */
  recordRequest(ms: number): void;

  /** Sample process CPU/memory + git-subprocess gauges now. */
  sampleProcessAndGit(): Promise<void>;

  /** Start interval timers (unref'd so they never keep the process alive). */
  start(): void;
  /** Clear interval timers; does NOT remove the spawn hook. */
  stopTimers(): void;

  /** Assemble the runtime metric families for a scrape (synchronous, O(N)). */
  buildSnapshot(nowMs?: number): MetricFamily[];
}

/** Constructor options (all injectable for tests). */
export interface RuntimeSamplerInit {
  /** Process API surface (defaults to the global `process`). */
  processRef?: ProcessLike;
  /** child_process surface to patch (defaults to the live Node module). */
  spawnModule?: SpawnableChildProcessModule;
  /** Injectable `ps --ppid` probe (defaults to the real single-level scan). */
  psProbe?: PsProbe;
  /** Latency histogram bucket edges in ms (defaults to {@link DEFAULT_LATENCY_BUCKETS_MS}). */
  latencyBucketsMs?: number[];
  /** Ring cap for recent request durations (defaults to {@link REQUEST_LATENCY_RING_CAP}). */
  ringCap?: number;
  /** Tick cadences in ms (defaults: latency 5s / process 5s / git 15s). */
  tick?: { latencyMs?: number; processMs?: number; gitMs?: number };
  /** A fake-timer-friendly `setInterval`/`clearInterval` surface. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => TimerLike;
    clearInterval: (t: TimerLike) => void;
  };
}

/**
 * Build an Express-style `(req, res, next)` request-latency recorder head.
 * Must be mounted on the app BEFORE route handlers so it times the LIVE serving
 * path (including `GET /api/health`), never a synthetic probe. The recorder
 * attaches a `finish` listener on the response (when it has one) so it measures
 * the full request pipeline cost, and always calls `next()`.
 */
export function createRequestLatencyMiddleware(state: LatencyRecorderState) {
  return (
    // req/res are typed loosely: the recorder only needs the response `once`.
    _req: unknown,
    res: unknown,
    next?: () => void,
  ): void => {
    const startedAt = Date.now();
    if (isResponseLike(res)) {
      res.once("finish", () => {
        recordRequest(state, Date.now() - startedAt);
      });
    } else {
      // Non-response contexts (unit tests): record synchronously.
      recordRequest(state, Date.now() - startedAt);
    }
    if (typeof next === "function") {
      next();
    }
  };
}

/** true when the object behaves like an HTTP response (`once` method). */
function isResponseLike(res: unknown): res is { once: (event: string, cb: () => void) => unknown } {
  return (
    typeof res === "object" && res !== null && typeof (res as { once?: unknown }).once === "function"
  );
}

/** O(1) bound-ring insert for one served-request duration. */
export function recordRequest(
  state: LatencyRecorderState,
  ms: number,
  ringCap = REQUEST_LATENCY_RING_CAP,
): void {
  const capped = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  state.recent.push(capped);
  if (state.recent.length > ringCap) {
    state.recent.shift();
  }
  if (capped > state.maxMs) state.maxMs = capped;
  state.requestCount += 1;
  state.lastServedAtMs = Date.now();
}

/** Compute a percentile over the recent durations ring (0 when empty). */
function percentile(recent: number[], pct: number): number {
  if (recent.length === 0) return 0;
  const sorted = [...recent].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/** Build the bounded histogram bucket counts over the recent ring. */
function buildBuckets(recent: number[], edges: number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[String(edge)] = recent.filter((d) => d <= edge).length;
  }
  return counts;
}

/** The production single-level `ps -o comm= --ppid <pid>` probe (POSIX-only). */
export function defaultPsProbe(pid: number): Promise<PsProbeResult> {
  const platform = typeof process !== "undefined" ? process.platform : "posix";
  if (platform === "win32") {
    return Promise.resolve({ ok: false, childCommands: [], reason: "non-posix" });
  }
  return new Promise((resolve) => {
    exec(`ps -o comm= --ppid ${Number(pid)}`, { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, childCommands: [], reason: "probe-error" });
        return;
      }
      const commands = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "COMMAND");
      resolve({ ok: true, childCommands: commands });
    });
  });
}

/** Default process surface adapter for the production `process`. */
function defaultProcessLike(): ProcessLike {
  return {
    pid: process.pid,
    cpuUsage: () => process.cpuUsage(),
    memoryUsage: () => process.memoryUsage(),
  };
}

/** Default timers from the global scope (fake-timer injectable). */
function defaultTimers(): {
  setInterval: (fn: () => void, ms: number) => TimerLike;
  clearInterval: (t: TimerLike) => void;
} {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerLike,
    clearInterval: (t) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
  };
}

/**
 * Create a runtime sampler.
 *
 * The spawn hook is NOT installed until {@link RuntimeSampler.installSpawnHook}
 * is called; the interval timers are NOT started until
 * {@link RuntimeSampler.start} is called. `start()` uses `unref()`'d timers so
 * a running sampler never keeps the process alive.
 */
export function createRuntimeSampler(init: RuntimeSamplerInit = {}): RuntimeSampler {
  const proc = init.processRef ?? defaultProcessLike();
  const spawnMod = init.spawnModule ??
    (childProcessRequire("node:child_process") as SpawnableChildProcessModule);
  const psProbe = init.psProbe ?? defaultPsProbe;
  const buckets = init.latencyBucketsMs ?? DEFAULT_LATENCY_BUCKETS_MS;
  const ringCap = init.ringCap ?? REQUEST_LATENCY_RING_CAP;
  const tick = {
    latencyMs: init.tick?.latencyMs ?? 5000,
    processMs: init.tick?.processMs ?? 5000,
    gitMs: init.tick?.gitMs ?? 15_000,
  };
  const timers = init.timers ?? defaultTimers();

  const latencyState: LatencyRecorderState = {
    recent: [],
    maxMs: 0,
    requestCount: 0,
    lastServedAtMs: -1,
  };

  const spawnCounts: SpawnCounts = { total: 0, byKind: {} };
  // Hold the ORIGINAL functions so stop() can restore them exactly.
  const originalSpawnFns: Partial<SpawnableChildProcessModule> = {};
  let spawnHookInstalled = false;
  let started = false;

  // Last sampled process gauges + git subprocess count.
  let lastCpu: { user: number; system: number } = { user: 0, system: 0 };
  let lastMem: { rss: number; heapTotal: number; heapUsed: number } = { rss: 0, heapTotal: 0, heapUsed: 0 };
  let lastGitCount = 0;

  // ── Interval timer slots ────────────────────────────────────────────────
  const timersMap = new Map<string, TimerLike>();

  // ── Spawn counter hook ──────────────────────────────────────────────────
  const SPAWN_KINDS: Array<keyof SpawnableChildProcessModule> = ["spawn", "fork", "execFile", "exec"];

  function installSpawnHook(): boolean {
    if (spawnHookInstalled) return false;
    for (const kind of SPAWN_KINDS) {
      const original = spawnMod[kind];
      if (typeof original !== "function") continue;
      originalSpawnFns[kind] = original;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        spawnCounts.total += 1;
        spawnCounts.byKind[kind] = (spawnCounts.byKind[kind] ?? 0) + 1;
        // Delegate to the ORIGINAL via .apply(this, ...) so receiver-bound
        // callers and nested usage through superviseSpawn/runCommandAsync keep
        // working.
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original;
      (spawnMod as unknown as Record<string, unknown>)[kind] = wrapped;
    }
    spawnHookInstalled = true;
    return true;
  }

  function removeSpawnHook(): void {
    if (!spawnHookInstalled) return;
    for (const kind of SPAWN_KINDS) {
      const original = originalSpawnFns[kind];
      if (original !== undefined) {
        (spawnMod as unknown as Record<string, unknown>)[kind] = original;
      }
      delete originalSpawnFns[kind];
    }
    spawnHookInstalled = false;
  }

  // ── Process + git sample ────────────────────────────────────────────────
  async function sampleProcessAndGit(): Promise<void> {
    try {
      lastCpu = proc.cpuUsage();
    } catch {
      lastCpu = { user: 0, system: 0 };
    }
    try {
      lastMem = proc.memoryUsage();
    } catch {
      lastMem = { rss: 0, heapTotal: 0, heapUsed: 0 };
    }
    try {
      const result = await psProbe(proc.pid);
      if (result.ok && result.childCommands.some((c) => c.toLowerCase().startsWith("git"))) {
        lastGitCount = result.childCommands.filter((c) => c.toLowerCase().startsWith("git")).length;
      } else {
        // Degrade to 0 rather than throwing; a ps failure is not a scrape error.
        lastGitCount = 0;
      }
    } catch {
      lastGitCount = 0;
    }
  }

  // ── Interval timers ─────────────────────────────────────────────────────
  function start(): void {
    if (started) return;
    started = true;
    // Per-sampler in-flight flags (one per arm) so a process/git tick that fires
    // while the previous one is still awaiting is SKIPPED: samplers never run
    // concurrently and a slow sample never queues (RUFU-081 Greptile P1 #2, RUFU-106).
    const inFlight = new Set<string>();
    const arm = (key: string, intervalMs: number, run: () => Promise<void>): void => {
      const timer = timers.setInterval(() => {
        /*
         * FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #2, RUFU-106):
         * An async sample that outlasts its interval must never overlap the next tick of the
         * same arm. If this sampler's previous run is still awaiting, skip the tick; otherwise
         * set the flag, run the sample, and clear it in `finally` so the next interval fires again.
         */
        if (inFlight.has(key)) return;
        inFlight.add(key);
        void run()
          .catch(() => {
            /* best-effort */
          })
          .finally(() => inFlight.delete(key));
      }, intervalMs);
      // Best-effort unref; fake timers may not expose it, but default timers
      // are unref'd so a running sampler never keeps the process alive.
      timer.unref?.();
      timersMap.set(key, timer);
    };
    arm("latency", tick.latencyMs, () => {
      // The latency "sampler" tick is a no-op marker: the useful measurements
      // already live in the ring from actual served requests.
      return Promise.resolve();
    });
    arm("process", tick.processMs, sampleProcessAndGit);
    arm("git", tick.gitMs, sampleProcessAndGit);
  }

  function stopTimers(): void {
    started = false;
    for (const key of [...timersMap.keys()]) {
      const timer = timersMap.get(key);
      if (timer) {
        try {
          timers.clearInterval(timer);
        } catch {
          /* ignore */
        }
        timersMap.delete(key);
      }
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────────
  function buildSnapshot(nowMs?: number): MetricFamily[] {
    const now = nowMs ?? Date.now();
    const families: MetricFamily[] = [];

    // ── Request latency / event-loop health ────────────────────────────────
    const lastAgeMs = latencyState.lastServedAtMs >= 0 ? Math.max(0, now - latencyState.lastServedAtMs) : 0;
    families.push({
      name: "fusion_system_request_count_total",
      help: "Total HTTP requests served through the latency recorder",
      type: "counter",
      samples: [{ value: latencyState.requestCount }],
    });
    families.push({
      name: "fusion_system_request_latency_ms",
      help: "Served request latency in milliseconds over the recent ring",
      type: "gauge",
      labels: ["quantile"],
      samples: [
        { labelValues: ["p50"], value: percentile(latencyState.recent, 50) },
        { labelValues: ["p95"], value: percentile(latencyState.recent, 95) },
        { labelValues: ["max"], value: latencyState.maxMs },
      ],
    });
    const bucketCounts = buildBuckets(latencyState.recent, buckets);
    families.push({
      name: "fusion_system_request_latency_bucket",
      help: "Cumulative count of served requests at or below the bucket edge (ms)",
      type: "gauge",
      labels: ["le"],
      samples: Object.entries(bucketCounts).map(([edge, count]) => ({
        labelValues: [edge],
        value: count,
      })),
    });
    families.push({
      name: "fusion_system_last_request_age_ms",
      help: "Milliseconds since the last served request; grows during event-loop starvation (freeze indicator)",
      type: "gauge",
      samples: [{ value: lastAgeMs }],
    });

    // ── Process CPU / memory ───────────────────────────────────────────────
    // cpuUsage() returns microseconds; expose seconds for a human-friendly gauge.
    families.push({
      name: "fusion_system_cpu_user_seconds_total",
      help: "User CPU time consumed by the server process (cumulative seconds)",
      type: "counter",
      samples: [{ value: lastCpu.user / 1_000_000 }],
    });
    families.push({
      name: "fusion_system_cpu_system_seconds_total",
      help: "System CPU time consumed by the server process (cumulative seconds)",
      type: "counter",
      samples: [{ value: lastCpu.system / 1_000_000 }],
    });
    families.push({
      name: "fusion_system_process_rss_bytes",
      help: "Resident set size of the server process",
      type: "gauge",
      samples: [{ value: lastMem.rss }],
    });
    families.push({
      name: "fusion_system_process_heap_used_bytes",
      help: "Heap used by the server process",
      type: "gauge",
      samples: [{ value: lastMem.heapUsed }],
    });
    families.push({
      name: "fusion_system_process_heap_total_bytes",
      help: "Total heap allocated to the server process",
      type: "gauge",
      samples: [{ value: lastMem.heapTotal }],
    });

    // ── Child-process spawn counters ───────────────────────────────────────
    families.push({
      name: "fusion_system_child_process_spawn_total",
      help: "Cumulative child_process spawn/fork/execFile/exec invocations since hook install",
      type: "counter",
      samples: [{ value: spawnCounts.total }],
    });
    const kindSamples = Object.entries(spawnCounts.byKind).map(([kind, count]) => ({
      labelValues: [kind],
      value: count,
    }));
    // Emit the per-kind family only when at least one kind has been observed, so
    // an empty spawn hook never produces an empty-samples family (malformed
    // output). The scalar total above is always present (0 before any spawn).
    if (kindSamples.length > 0) {
      families.push({
        name: "fusion_system_child_process_spawn_total_by_kind",
        help: "Cumulative child_process spawn/fork/execFile/exec invocations by kind",
        type: "counter",
        labels: [SPAWN_KIND_LABEL],
        samples: kindSamples,
      });
    }

    // ── Git subprocess gauge ───────────────────────────────────────────────
    families.push({
      name: "fusion_system_git_child_processes",
      help: "Live git child processes of the server process (single-level ps --ppid, best-effort)",
      type: "gauge",
      samples: [{ value: lastGitCount }],
    });

    return families;
  }

  return {
    latency: latencyState,
    spawnCounts,
    get spawnHookInstalled() {
      return spawnHookInstalled;
    },
    get started() {
      return started;
    },
    installSpawnHook,
    removeSpawnHook,
    recordRequest: (ms: number) => recordRequest(latencyState, ms, ringCap),
    sampleProcessAndGit,
    start,
    stopTimers,
    buildSnapshot,
  };
}