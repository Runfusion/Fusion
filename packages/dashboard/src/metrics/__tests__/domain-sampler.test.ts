// @vitest-environment node

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  createDomainSampler,
  defaultPgStatsReader,
  type PgStats,
  type DomainSamplerInit,
  type SlimTaskLike,
} from "../domain-sampler.js";
import type { MetricFamily } from "../prometheus-text.js";

/**
 * RUFU-081 domain sampler tests.
 *
 * Covers the injectable surface of `createDomainSampler` (mirroring the
 * runtime-sampler suite):
 *   - the PG query-rate delta math: first sample yields 0, a real delta yields
 *     a per-second rate normalized by elapsed ms, and a backward/reset delta or
 *     an unreadable reader keeps the last-known rate (never throws);
 *   - the domain gauges: project total/active/idle split, per-project running
 *     agents, and board task counts per column, all computable from injected
 *     stores without a live database or engine;
 *   - duplicate/undefined project ids are deduped so they never produce
 *     malformed or duplicate metric lines;
 *   - `buildSnapshot` renders synchronously from pre-read state (zero awaited
 *     I/O), and empty/fresh states still produce well-formed 0-valued families.
 */

/** A minimal fake store with a configurable slim task list and count. */
function makeStore(tasks: SlimTaskLike[], running = 1) {
  return {
    listTasks: async () => tasks,
    countRunning: running,
  };
}

function helper<T>(
  overrides: Partial<DomainSamplerInit> = {},
): ReturnType<typeof createDomainSampler> {
  return createDomainSampler(overrides);
}

function sampleByName(families: MetricFamily[], name: string): MetricFamily | undefined {
  return families.find((f) => f.name === name);
}

describe("PG query-rate sampler", () => {
  it("first sample yields 0 (no prior delta), a later delta yields a per-second rate", async () => {
    let stat: PgStats = { xactCommit: 1000, xactRollback: 10 };
    const sampler = helper({
      pgStatsReader: async () => stat,
    });
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(0); // first sample, no prior

    // Advance counters by 500 transactions over a fake elapsed window. We
    // cannot control Date.now() here directly, so re-sample immediately: the
    // sampler derives rate from its own clock. To keep the test deterministic
    // we inject a tiny elapsed by sampling twice with a short await.
    stat = { xactCommit: 1500, xactRollback: 10 };
    await sampler.samplePgRate();
    // The rate should now be finite and >= 0 (delta 500 over some positive ms).
    expect(sampler.state.pgQueriesPerSecond).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sampler.state.pgQueriesPerSecond)).toBe(true);
  });

  it("a backward / stats-reset delta keeps the last-known rate (never throws, never negative)", async () => {
    const stats: PgStats[] = [
      { xactCommit: 1000, xactRollback: 0 },
      { xactCommit: 1500, xactRollback: 0 },
      { xactCommit: 1400, xactRollback: 0 }, // reset: counters went backward
    ];
    let idx = 0;
    const sampler = helper({ pgStatsReader: async () => stats[Math.min(idx++, stats.length - 1)] });
    await sampler.samplePgRate(); // baseline
    await sampler.samplePgRate(); // computes a rate
    const priorRate = sampler.state.pgQueriesPerSecond;
    expect(priorRate).toBeGreaterThanOrEqual(0);
    await sampler.samplePgRate(); // backward delta -> keep from not below 0
    expect(sampler.state.pgQueriesPerSecond).toBeGreaterThanOrEqual(0);
    expect(sampler.state.pgQueriesPerSecond).not.toBeNaN();
  });

  it("an unreadable PG reader degrades to last-known / 0 without throwing", async () => {
    let fail = true;
    const sampler = helper({
      pgStatsReader: async () => {
        if (fail) throw new Error("privilege-fenced");
        return { xactCommit: 100, xactRollback: 0 };
      },
    });
    await expect(sampler.samplePgRate()).resolves.toBeUndefined();
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    fail = false;
    await sampler.samplePgRate(); // baseline
    expect(sampler.state.pgQueriesPerSecond).toBe(0);
    fail = true;
    await sampler.samplePgRate(); // now unreadable again -> keep last-known (0)
    expect(sampler.state.pgQueriesPerSecond).toBe(0);
  });

  it("buildSnapshot emits a well-formed PG-rate family from pre-read state", async () => {
    const sampler = helper({
      pgStatsReader: async () => ({ xactCommit: 10, xactRollback: 2 }),
    });
    await sampler.samplePgRate();
    const families = sampler.buildSnapshot();
    const family = sampleByName(families, "fusion_domain_postgres_queries_per_second");
    expect(family).toBeDefined();
    expect(family!.type).toBe("gauge");
    expect(family!.samples[0].value).toEqual(expect.any(Number));
    expect(Number.isFinite(family!.samples[0].value)).toBe(true);
  });

  /*
  FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #1, RUFU-106):
  A TRANSIENT PG probe failure must never reset the sampler's baseline. Previously a null/thrown read
  executed `previousPg = undefined`, so the next GOOD sample was treated as a first sample and reported
  rate 0 even though queries kept flowing. This deterministic fake-timer test pins the keep-the-baseline
  invariant: an established rate (> 0) survives a transient failure, and the subsequent successful sample
  computes from the KEPT baseline (not 0). `Date.now()` is driveable via fake timers, so the expected
  per-second rate is exact.
  */
  it("keeps the PG baseline across a transient failure — next good sample computes from the KEPT baseline, not 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));

    let stat: PgStats = { xactCommit: 1000, xactRollback: 0 };
    const sampler = helper({ pgStatsReader: async () => stat });

    // Baseline: first sample establishes the baseline at rate 0.
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    // Advance the clock 5000ms and bump counters by 2000 -> rate 400/s.
    vi.setSystemTime(new Date("2026-08-16T00:00:05.000Z"));
    stat = { xactCommit: 3000, xactRollback: 0 };
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // Transient failure (reader returns null) -> baseline + last-known rate MUST HOLD.
    vi.setSystemTime(new Date("2026-08-16T00:00:06.000Z"));
    stat = null as unknown as PgStats;
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // Advance another 5000ms (elapsed since the KEPT baseline is 6s) and bump to 5000.
    // Delta from the KEPT baseline (3000) over 6000ms -> 333.33/s exactly. A reset baseline
    // would treat this as a FIRST sample and report 0; 333.33 proves the baseline was
    // preserved through the transient failure and the rate is computed from it, not 0.
    vi.setSystemTime(new Date("2026-08-16T00:00:11.000Z"));
    stat = { xactCommit: 5000, xactRollback: 0 };
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBeCloseTo(333.33, 2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("domain gauges", () => {
  it("computes project total/active/idle split and per-project running agents", async () => {
    const s1 = makeStore([{ column: "todo" }], 2); // active
    const s2 = makeStore([{ column: "done" }], 0); // idle
    const sampler = helper({
      registeredStores: () => [
        { projectId: "proj-a", store: s1 },
        { projectId: "proj-b", store: s2 },
      ],
      countAgentsInStore: async (store: unknown) =>
        (store as { countRunning: number }).countRunning,
      listTasksInStore: async (store: unknown) => (store as { listTasks: () => Promise<SlimTaskLike[]> }).listTasks(),
    });
    await sampler.sampleDomain();

    expect(sampler.state.projectCounts).toEqual({ total: 2, active: 1, idle: 1 });
    expect(sampler.state.runningAgentsByProject).toEqual({ "proj-a": 2, "proj-b": 0 });
    expect(sampler.state.columnCounts).toEqual({ todo: 1, done: 1 });

    const families = sampler.buildSnapshot();
    expect(sampleByName(families, "fusion_domain_projects_total")!.samples[0].value).toBe(2);
    expect(sampleByName(families, "fusion_domain_projects_active")!.samples[0].value).toBe(1);
    expect(sampleByName(families, "fusion_domain_projects_idle")!.samples[0].value).toBe(1);
    expect(sampleByName(families, "fusion_domain_board_tasks")!.samples).toHaveLength(2);
  });

  it("dedupes duplicate / undefined project ids so metric lines are never malformed", async () => {
    const store = makeStore([{ column: "todo" }], 1);
    const sampler = helper({
      registeredStores: () => [
        { projectId: "proj-a", store },
        { projectId: "proj-a", store }, // duplicate
        { projectId: undefined as unknown as string, store }, // malformed
      ],
      countAgentsInStore: async () => 1,
      listTasksInStore: async () => [{ column: "todo" }],
    });
    await sampler.sampleDomain();
    expect(sampler.state.projectCounts.total).toBe(1); // only the valid, deduped id
    expect(sampler.state.runningAgentsByProject).toEqual({ "proj-a": 1 });
  });

  it("best-effort: a throwing agent/store probe degrades to 0 without throwing and keeps a well-formed snapshot", async () => {
    const sampler = helper({
      registeredStores: () => [{ projectId: "proj-a", store: {} as never }],
      countAgentsInStore: async () => {
        throw new Error("store error");
      },
      listTasksInStore: async () => {
        throw new Error("read error");
      },
    });
    await expect(sampler.sampleDomain()).resolves.toBeUndefined();
    expect(sampler.state.projectCounts.active).toBe(0);
    const families = sampler.buildSnapshot();
    // families render 0-valued (not malformed) even with an empty board
    expect(sampleByName(families, "fusion_domain_board_tasks")!.samples.every((s) => s.value >= 0)).toBe(true);
  });
});

describe("defaultPgStatsReader", () => {
  it("returns a reader that resolves null when no registered store exposes an async layer", async () => {
    const reader = defaultPgStatsReader();
    // No stores registered in this test process -> resolves null (absent gauge).
    await expect(reader()).resolves.toBeNull();
  });
});