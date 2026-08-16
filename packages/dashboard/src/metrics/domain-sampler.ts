/**
 * RUFU-081 domain sampler: PostgreSQL query-rate gauge + Fusion-domain gauges
 * (project / running-agent / board-column counts) for the dashboard `/metrics`
 * endpoint.
 *
 * The PG rate closes the "poll-storm" diagnosis gap: `pg_stat_database`
 * xact_commit/xact_rollback delta, normalized to a per-second rate on the
 * tick. The Fusion-domain gauges answer the "how busy is the board" questions
 * (active/paused project split, running agents, tasks per column) from stores
 * the dashboard has ALREADY opened — never by opening a store, starting an
 * engine, or starting a watcher just to answer a scrape.
 *
 * Non-blocking by design, matching `runtime-sampler.ts`:
 *   - every read happens on a pre-read tick; `buildSnapshot` performs zero
 *     awaited I/O and only renders pre-read numeric state;
 *   - the PG read is best-effort and degrades (keeps the last-known rate, or
 *     `0` on the first invalid sample) when the layer is absent, the DB is
 *     privilege-fenced (embedded PG from agent sessions), or a pool error
 *     occurs — it never throws and never hammers the DB;
 *   - duplicate/undefined project ids are deduped so they never produce
 *     duplicate or malformed metric lines.
 *
 * All seams are injectable so tests exercise the sampler without booting
 * stores or a database (mirroring `createRuntimeSampler(init)`).
 */

import { drizzleSql } from "@fusion/core";
import type { MetricFamily } from "./prometheus-text.js";

const sql = drizzleSql;
import { listRegisteredProjectStores, countRunningAgentsInStore } from "../project-store-resolver.js";

/** A single `pg_stat_database` cumulative counter sample. */
export interface PgStats {
  /** Cumulative transactions committed since stats reset. */
  xactCommit: number;
  /** Cumulative transactions rolled back since stats reset. */
  xactRollback: number;
}

/** Reads the cumulative PG counter pair, or resolves `null` when no layer exists. */
export type PgStatsReader = () => Promise<PgStats | null>;

/**
 * A slim task view: only the column is needed to count cards per column.
 * Kept narrow so tests can hand over `{ column }` objects without a real store.
 */
export interface SlimTaskLike {
  column: string;
}

/** Registry that yields the already-open project stores (injectable). */
export type RegisteredStoreRegistry = () => Array<{ projectId: string; store: unknown }>;

/** The pre-read domain snapshot a `/metrics` render reflects. */
export interface DomainSamplerState {
  /** Per-second transaction delta, or 0/last-known when unavailable. */
  pgQueriesPerSecond: number;
  /** Registered-project split by running-agent activity. */
  projectCounts: { total: number; active: number; idle: number };
  /** projectId -> number of running agents in that project's open store. */
  runningAgentsByProject: Record<string, number>;
  /** columnId -> number of tasks in that column across all registered projects. */
  columnCounts: Record<string, number>;
}

/** Constructor options (all injectable). */
export interface DomainSamplerInit {
  /** Source of already-open project stores (defaults to `listRegisteredProjectStores`). */
  registeredStores?: RegisteredStoreRegistry;
  /** Per-store running-agent counter (defaults to `countRunningAgentsInStore`). */
  countAgentsInStore?: (store: unknown) => Promise<number>;
  /** Per-store slim task listing (defaults to `store.listTasks({ slim: true })`). */
  listTasksInStore?: (store: unknown) => Promise<SlimTaskLike[]>;
  /** PG cumulative-counter reader (defaults to the store-layer `pg_stat_database` probe). */
  pgStatsReader?: PgStatsReader;
  /** Tick cadences in ms (defaults: PG 5s / domain 5s). */
  tick?: { pgMs?: number; domainMs?: number };
  /** A fake-timer-friendly `setInterval`/`clearInterval` surface. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval: (t: { unref?: () => void }) => void;
  };
}

/** The domain sampler's public handle. */
export interface DomainSampler {
  readonly state: DomainSamplerState;
  readonly started: boolean;
  /** Read the PG rate + domain gauges into the pre-read snapshot now. */
  samplePgRate(): Promise<void>;
  sampleDomain(): Promise<void>;
  /** Start interval timers (unref'd so they never keep the process alive). */
  start(): void;
  /** Clear interval timers. */
  stopTimers(): void;
  /** Assemble the domain metric families for a scrape (synchronous, O(metric count)). */
  buildSnapshot(nowMs?: number): MetricFamily[];
}

/** Current cumulative PG counters + when they were read, for delta math. Careful constructor. */
interface PgSample {
  xactCommit: number;
  xactRollback: number;
  atMs: number;
}

/** Default timers from the global scope (fake-timer injectable). */
function defaultTimers(): DomainSamplerInit["timers"] {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as { unref?: () => void },
    clearInterval: (t) => clearInterval(t as unknown as ReturnType<typeof setInterval>),
  };
}

/** Default registry: the dashboard's already-open project-store cache. */
function defaultRegistry(): RegisteredStoreRegistry {
  return () => listRegisteredProjectStores() as Array<{ projectId: string; store: unknown }>;
}

/** Default per-store running-agent counter. */
async function defaultCountAgents(store: unknown): Promise<number> {
  return countRunningAgentsInStore(store as Parameters<typeof countRunningAgentsInStore>[0]);
}

/** Default slim task listing through the store's public `listTasks({ slim: true })`. */
async function defaultListTasks(store: unknown): Promise<SlimTaskLike[]> {
  const anyStore = store as { listTasks?: (opts: { slim: true }) => Promise<SlimTaskLike[]> };
  if (typeof anyStore.listTasks !== "function") return [];
  return anyStore.listTasks({ slim: true });
}

/**
 * Default PG cumulative-counter reader. Reads `pg_stat_database` on the first
 * registered store that exposes a live async layer. Best-effort: a missing
 * layer, privilege-fenced PG, or pool error resolves `null` so the sampler
 * keeps the last-known rate instead of throwing.
 */
export function defaultPgStatsReader(): PgStatsReader {
  return async (): Promise<PgStats | null> => {
    const stores = listRegisteredProjectStores();
    for (const { store } of stores) {
      const layer = (store as { getAsyncLayer?: () => { db: { execute: (q: unknown) => Promise<unknown[]> } } | null }).getAsyncLayer?.();
      if (!layer) continue;
      try {
        const rows = (await layer.db.execute(
          sql.raw(`
            SELECT
              COALESCE(SUM(xact_commit), 0)::float8 AS xact_commit,
              COALESCE(SUM(xact_rollback), 0)::float8 AS xact_rollback
            FROM pg_stat_database
          `),
        )) as Array<{ xact_commit: number; xact_rollback: number }>;
        const row = rows[0];
        if (!row) return null;
        return {
          xactCommit: Number(row.xact_commit) || 0,
          xactRollback: Number(row.xact_rollback) || 0,
        };
      } catch {
        // Privilege-fenced / transient — degrade to null, never throw.
        return null;
      }
    }
    return null;
  };
}

/** Create a domain sampler. Timers are NOT started until {@link DomainSampler.start}. */
export function createDomainSampler(init: DomainSamplerInit = {}): DomainSampler {
  const registry = init.registeredStores ?? defaultRegistry();
  const countAgents = init.countAgentsInStore ?? defaultCountAgents;
  const listTasks = init.listTasksInStore ?? defaultListTasks;
  const pgReader = init.pgStatsReader ?? defaultPgStatsReader();
  const tick = { pgMs: init.tick?.pgMs ?? 5000, domainMs: init.tick?.domainMs ?? 5000 };
  const timers = init.timers ?? defaultTimers();

  const state: DomainSamplerState = {
    pgQueriesPerSecond: 0,
    projectCounts: { total: 0, active: 0, idle: 0 },
    runningAgentsByProject: {},
    columnCounts: {},
  };
  let previousPg: PgSample | undefined;
  let started = false;

  const timersMap = new Map<string, { unref?: () => void }>();

  async function samplePgRate(): Promise<void> {
    let stats: PgStats | null = null;
    try {
      stats = await pgReader();
    } catch {
      stats = null;
    }
    const now = Date.now();
    if (!stats) {
      /*
       * FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #1, RUFU-106):
       * A transient reader failure (null or thrown) must NOT reset the PG baseline. Resetting
       * `previousPg = undefined` here made the next good sample look like a FIRST sample and
       * report rate 0, even though real queries kept flowing. On failure we keep the last-known
       * `previousPg` and `state.pgQueriesPerSecond`; only a successful counter read
       * establishes/advances the baseline (a first-ever failure still leaves the rate at 0).
       */
      return;
    }
    const currentTotal = stats.xactCommit + stats.xactRollback;
    if (!previousPg) {
      previousPg = { ...stats, atMs: now };
      state.pgQueriesPerSecond = 0;
      return;
    }
    const prevTotal = previousPg.xactCommit + previousPg.xactRollback;
    const elapsedMs = now - previousPg.atMs;
    const delta = currentTotal - prevTotal;
    previousPg = { ...stats, atMs: now };
    if (elapsedMs <= 0 || delta < 0) {
      // Clock skew or a stats reset (pg_stat_reset) — keep the last-known rate.
      return;
    }
    state.pgQueriesPerSecond = (delta / elapsedMs) * 1000;
  }

  async function sampleDomain(): Promise<void> {
    // Registry entries are keyed by projectId; dedupe so a duplicate/undefined
    // project id can never produce duplicate or malformed metric lines.
    const entries = new Map<string, { store: unknown }>();
    for (const entry of registry()) {
      const projectId = entry?.projectId;
      if (typeof projectId !== "string" || projectId.length === 0) continue;
      // First registration of a project id is canonical; later duplicates are
      // dropped so a duplicate id can never double-count a column or an agent.
      if (!entries.has(projectId)) entries.set(projectId, { store: entry.store });
    }
    // Use the deduped keys so both per-project and aggregate counts agree.
    const projectIds = [...entries.keys()];
    const runningByProject: Record<string, number> = {};
    const columnCounts: Record<string, number> = {};

    await Promise.all(
      projectIds.map(async (projectId) => {
        const { store } = entries.get(projectId)!;
        let running = 0;
        try {
          running = await countAgents(store);
        } catch {
          running = 0;
        }
        runningByProject[projectId] = running;

        let tasks: SlimTaskLike[] = [];
        try {
          tasks = await listTasks(store);
        } catch {
          tasks = [];
        }
        for (const task of tasks) {
          // Each slim task row contributes one card to its column. Column ids
          // are strings; guard against undefined/malformed rows.
          const column = task?.column;
          if (typeof column !== "string" || column.length === 0) continue;
          columnCounts[column] = (columnCounts[column] ?? 0) + 1;
        }
      }),
    );

    const total = projectIds.length;
    const active = projectIds.filter((id) => (runningByProject[id] ?? 0) > 0).length;
    state.runningAgentsByProject = runningByProject;
    state.columnCounts = columnCounts;
    state.projectCounts = { total, active, idle: total - active };
  }

  function start(): void {
    if (started) return;
    started = true;
    // Per-sampler in-flight flags so a tick that fires while the previous one is
    // still awaiting is SKIPPED: samplers never run concurrently and a slow
    // sample never queues (RUFU-081 Greptile P1 #2, RUFU-106).
    const inFlight = new Set<string>();
    const arm = (key: string, intervalMs: number, run: () => Promise<void>): void => {
      const timer = timers!.setInterval(() => {
        /*
         * FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #2, RUFU-106):
         * An async sample that outlasts its interval must never overlap the next tick. If this
         * sampler's previous run is still awaiting, skip the tick entirely; otherwise set the flag,
         * run the sample, and clear it in `finally` so the next interval arm is armed again.
         */
        if (inFlight.has(key)) return;
        inFlight.add(key);
        void run()
          .catch(() => undefined)
          .finally(() => inFlight.delete(key));
      }, intervalMs);
      timer.unref?.();
      timersMap.set(key, timer);
    };
    arm("pg", tick.pgMs, samplePgRate);
    arm("domain", tick.domainMs, sampleDomain);
  }

  function stopTimers(): void {
    started = false;
    for (const key of [...timersMap.keys()]) {
      const timer = timersMap.get(key);
      if (timer) {
        try {
          timers!.clearInterval(timer);
        } catch {
          /* ignore */
        }
        timersMap.delete(key);
      }
    }
  }

  function buildSnapshot(_nowMs?: number): MetricFamily[] {
    const families: MetricFamily[] = [];

    // ── PostgreSQL query rate ──────────────────────────────────────────────
    families.push({
      name: "fusion_domain_postgres_queries_per_second",
      help: "PostgreSQL transaction rate (xact_commit + xact_rollback delta per second); degrades to last-known when unreadable",
      type: "gauge",
      samples: [{ value: state.pgQueriesPerSecond }],
    });

    // ── Project + running-agent counts ─────────────────────────────────────
    families.push({
      name: "fusion_domain_projects_total",
      help: "Registered open projects (already-open stores only)",
      type: "gauge",
      samples: [{ value: state.projectCounts.total }],
    });
    families.push({
      name: "fusion_domain_projects_active",
      help: "Registered projects currently running at least one agent",
      type: "gauge",
      samples: [{ value: state.projectCounts.active }],
    });
    families.push({
      name: "fusion_domain_projects_idle",
      help: "Registered projects running zero agents (idle/unpaused park)",
      type: "gauge",
      samples: [{ value: state.projectCounts.idle }],
    });
    const agentProjectSamples = Object.entries(state.runningAgentsByProject).map(([projectId, count]) => ({
      labelValues: [projectId],
      value: count,
    }));
    families.push({
      name: "fusion_domain_project_running_agents",
      help: "Running agents per registered project",
      type: "gauge",
      labels: ["project"],
      samples: agentProjectSamples,
    });

    // ── Board task counts per column ───────────────────────────────────────
    const columnSamples = Object.entries(state.columnCounts).map(([column, count]) => ({
      labelValues: [column],
      value: count,
    }));
    families.push({
      name: "fusion_domain_board_tasks",
      help: "Tasks per board column across all registered projects",
      type: "gauge",
      labels: ["column"],
      samples: columnSamples,
    });

    return families;
  }

  return {
    state,
    get started() {
      return started;
    },
    samplePgRate,
    sampleDomain,
    start,
    stopTimers,
    buildSnapshot,
  };
}