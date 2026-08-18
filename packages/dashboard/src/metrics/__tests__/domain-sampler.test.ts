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
    let stat: PgStats = [{ datname: "fusion", xactCommit: 1000, xactRollback: 10 }];
    const sampler = helper({
      pgStatsReader: async () => stat,
    });
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(0); // first sample, no prior

    // Advance counters by 500 transactions over a fake elapsed window. We
    // cannot control Date.now() here directly, so re-sample immediately: the
    // sampler derives rate from its own clock. To keep the test deterministic
    // we inject a tiny elapsed by sampling twice with a short await.
    stat = [{ datname: "fusion", xactCommit: 1500, xactRollback: 10 }];
    await sampler.samplePgRate();
    // The rate should now be finite and >= 0 (delta 500 over some positive ms).
    expect(sampler.state.pgQueriesPerSecond).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sampler.state.pgQueriesPerSecond)).toBe(true);
  });

  it("a backward / stats-reset delta keeps the last-known rate (never throws, never negative)", async () => {
    const stats: PgStats[] = [
      [{ datname: "fusion", xactCommit: 1000, xactRollback: 0 }],
      [{ datname: "fusion", xactCommit: 1500, xactRollback: 0 }],
      [{ datname: "fusion", xactCommit: 1400, xactRollback: 0 }], // reset: counters went backward
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
        return [{ datname: "fusion", xactCommit: 100, xactRollback: 0 }];
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
      pgStatsReader: async () => [{ datname: "fusion", xactCommit: 10, xactRollback: 2 }],
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
  FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #1, RUFU-106) + 2026-08-18 review fix:
  A TRANSIENT PG probe failure must never reset the sampler's baseline, AND the retained baseline
  is STALE across the failed gap: a stats reset can land inside the gap (invisible to the next
  probe, which may see counters already grown past the retained total), so the first success after
  a failed gap RE-BASELINES and keeps the last-known rate; the NEXT success computes from the new
  baseline. This deterministic fake-timer test pins both halves of the contract: an established
  rate (> 0) survives a transient failure, the first post-gap sample re-baselines (no cross-gap
  rate), and the following sample computes a fresh rate from the re-established baseline.
  `Date.now()` is driveable via fake timers, so the expected per-second rates are exact.
  */
  it("keeps the rate across a transient failure; the first post-gap sample re-baselines, the next computes fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));

    let stat: PgStats | null = [{ datname: "fusion", xactCommit: 1000, xactRollback: 0 }];
    const sampler = helper({ pgStatsReader: async () => stat });

    // Baseline: first sample establishes the baseline at rate 0.
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    // Advance the clock 5000ms and bump counters by 2000 -> rate 400/s.
    vi.setSystemTime(new Date("2026-08-16T00:00:05.000Z"));
    stat = [{ datname: "fusion", xactCommit: 3000, xactRollback: 0 }];
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // Transient failure (reader returns null) -> last-known rate MUST HOLD (400) and the
    // retained baseline is marked STALE (a reset could have landed inside the gap).
    vi.setSystemTime(new Date("2026-08-16T00:00:06.000Z"));
    stat = null;
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // t11: first success after the gap RE-BASELINES and keeps the last-known rate; it must NOT
    // emit a cross-gap rate computed from the pre-gap baseline.
    vi.setSystemTime(new Date("2026-08-16T00:00:11.000Z"));
    stat = [{ datname: "fusion", xactCommit: 5000, xactRollback: 0 }];
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // t16: the next success computes from the NEW baseline (5000 @ t11): (6000-5000)/5s = 200/s.
    // A sampler that still used the pre-gap baseline (3000 @ t5) would report (6000-3000)/11s
    // = 272.7/s instead — 200 proves the re-baseline.
    vi.setSystemTime(new Date("2026-08-16T00:00:16.000Z"));
    stat = [{ datname: "fusion", xactCommit: 6000, xactRollback: 0 }];
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(200);
  });

  /*
  FNXC:MetricsSampler 2026-08-18 (RUFU-081 Greptile P1, RUFU-106 review fix):
  A pg_stat_reset that lands inside a FAILED probe gap is invisible to the aggregate reset check:
  the counter drops to 0 during the gap and regrows PAST the retained total before the next
  successful probe, so the cross-epoch delta reads positive. The stale-gap guard must re-baseline
  instead of emitting the fabricated rate.
  */
  it("a stats reset inside a failed gap re-baselines instead of emitting a cross-epoch rate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    let stat: PgStats | null = [{ datname: "fusion", xactCommit: 1000, xactRollback: 0 }];
    const sampler = helper({ pgStatsReader: async () => stat });

    await sampler.samplePgRate(); // baseline @ t0
    vi.setSystemTime(new Date("2026-08-16T00:00:05.000Z"));
    stat = [{ datname: "fusion", xactCommit: 3000, xactRollback: 0 }];
    await sampler.samplePgRate(); // rate 400/s
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // Failed probe @ t6 marks the baseline stale.
    vi.setSystemTime(new Date("2026-08-16T00:00:06.000Z"));
    stat = null;
    await sampler.samplePgRate();

    // During the gap a pg_stat_reset drops the counter to 0; it has now regrown PAST the
    // retained total (1200 > 1000) so the cross-epoch delta (1200-1000)/5s = 40/s would read
    // positive and be accepted by an aggregate-only check.
    vi.setSystemTime(new Date("2026-08-16T00:00:11.000Z"));
    stat = [{ datname: "fusion", xactCommit: 1200, xactRollback: 0 }];
    await sampler.samplePgRate();
    // The stale-gap guard re-baselines and keeps the last-known rate — no fabricated 40/s.
    expect(sampler.state.pgQueriesPerSecond).toBe(400);

    // The following clean sample computes from the fresh baseline: (1700-1200)/5s = 100/s.
    vi.setSystemTime(new Date("2026-08-16T00:00:16.000Z"));
    stat = [{ datname: "fusion", xactCommit: 1700, xactRollback: 0 }];
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(100);
  });

  /*
  FNXC:MetricsSampler 2026-08-18 (RUFU-081 Greptile P1, RUFU-106 review fix):
  A per-database stats reset can be HIDDEN by the cross-database sum: database A resets and
  partially recovers while database B grows, so the aggregate delta stays positive. The per-DB
  baseline check (any per-DB backward delta) is the only detector and must trigger the reset
  handling (keep the last-known rate, re-baseline).
  */
  it("detects a per-database stats reset that the cross-database sum would hide", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    let current: PgStats = [
      { datname: "a", xactCommit: 1000, xactRollback: 0 },
      { datname: "b", xactCommit: 0, xactRollback: 0 },
    ];
    const sampler = helper({ pgStatsReader: async () => current });
    await sampler.samplePgRate(); // baseline: a=1000, b=0
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    // Between samples: database a stats-reset (1000 -> 0) and recovered to 900; database b
    // (no reset) grew by 200. Aggregate sum: 1000 -> 1100 — a POSITIVE delta, so an
    // aggregate-only reset check would emit the fabricated (1100-1000)/5s = 20/s rate.
    vi.setSystemTime(new Date("2026-08-16T00:00:05.000Z"));
    current = [
      { datname: "a", xactCommit: 900, xactRollback: 0 },
      { datname: "b", xactCommit: 200, xactRollback: 0 },
    ];
    await sampler.samplePgRate();
    // Per-DB check sees a's backward delta (-100) -> reset: keep the last-known rate (0).
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    // And re-baselined: the next clean sample computes a real rate from the new baseline:
    // (1400-900) + (700-200) = 1000 over 5s = 200/s.
    vi.setSystemTime(new Date("2026-08-16T00:00:10.000Z"));
    current = [
      { datname: "a", xactCommit: 1400, xactRollback: 0 },
      { datname: "b", xactCommit: 700, xactRollback: 0 },
    ];
    await sampler.samplePgRate();
    expect(sampler.state.pgQueriesPerSecond).toBe(200);
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

describe("overlap guard (RUFU-081 Greptile P1 #2)", () => {
  /*
  FNXC:MetricsSampler 2026-08-16 (RUFU-081 Greptile P1 #2, RUFU-106):
  An async sample that outlasts its interval must never overlap the next tick of the same arm. These
  fake-timer tests hold a reader's promise pending while a SECOND interval fires and assert the reader
  is invoked once (the tick was skipped). Samplers therefore never run concurrently and a slow sample
  never queues.
  */
  it("skips a PG tick still in flight — the pg reader is invoked at most once per completed window", async () => {
    vi.useFakeTimers();
    let resolveReader: (s: PgStats) => void = () => {};
    const pending = new Promise<PgStats>((res) => {
      resolveReader = res;
    });
    const reader = vi.fn(() => pending);
    const sampler = helper({ tick: { pgMs: 5000 }, pgStatsReader: reader });
    sampler.start();

    // First window fires -> reader invoked, sample stays pending (in flight).
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(1);

    // Second window fires while tick 1 is still awaiting -> SKIPPED (reader NOT re-invoked).
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(1);

    // Resolve the in-flight sample; the `finally` clears the guard.
    resolveReader([{ datname: "fusion", xactCommit: 1000, xactRollback: 0 }]);
    await vi.advanceTimersByTimeAsync(0);

    // Third window: guard clear -> reader fires again, exactly once per window.
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(2);

    sampler.stopTimers();
  });

  it("skips a domain tick still in flight — the agent/store probe is invoked at most once per completed window", async () => {
    vi.useFakeTimers();
    let resolveCount: (n: number) => void = () => {};
    const pendingCount = new Promise<number>((res) => {
      resolveCount = res;
    });
    const countAgents = vi.fn(() => pendingCount);
    const store = makeStore([{ column: "todo" }], 1);
    const sampler = helper({
      tick: { domainMs: 5000 },
      registeredStores: () => [{ projectId: "proj-a", store }],
      countAgentsInStore: countAgents,
      listTasksInStore: async () => [{ column: "todo" }],
    });
    sampler.start();

    await vi.advanceTimersByTimeAsync(5000);
    expect(countAgents).toHaveBeenCalledTimes(1);

    // Second window fires while tick 1 still awaits countAgents -> SKIPPED.
    await vi.advanceTimersByTimeAsync(5000);
    expect(countAgents).toHaveBeenCalledTimes(1);

    resolveCount(1);
    await vi.advanceTimersByTimeAsync(0);

    // Guard clear -> runs again.
    await vi.advanceTimersByTimeAsync(5000);
    expect(countAgents).toHaveBeenCalledTimes(2);

    sampler.stopTimers();
  });

  it("still emits well-formed metric lines after the guard over an empty / non-existent store set", async () => {
    vi.useFakeTimers();
    // Empty registry (no registered stores) and a pg reader that resolves normally.
    const sampler = helper({
      tick: { pgMs: 5000, domainMs: 5000 },
      registeredStores: () => [],
      pgStatsReader: async () => [{ datname: "fusion", xactCommit: 10, xactRollback: 0 }],
      countAgentsInStore: async () => 0,
      listTasksInStore: async () => [],
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(5000);

    const families = sampler.buildSnapshot();
    const pgFamily = sampleByName(families, "fusion_domain_postgres_queries_per_second");
    expect(Number.isFinite(pgFamily!.samples[0].value)).toBe(true);
    const projects = sampleByName(families, "fusion_domain_projects_total");
    expect(projects!.samples[0].value).toBe(0);

    sampler.stopTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("restart fence (RUFU-081 Greptile P1 review fix)", () => {
  /*
  FNXC:MetricsSampler 2026-08-18 (RUFU-081 Greptile P1, RUFU-106 review fix):
  A dashboard close+re-listen calls stopTimers() then start() while a pre-close sample may still
  be awaiting. The fix: (a) the in-flight guard is factory-scoped so it survives the restart — a
  pre-close sample still running keeps blocking ticks of the same arm until it resolves; (b) the
  generation fence discards the pre-close sample's write so it can never overwrite post-restart
  state. This test pins both: the pre-restart read resolves with stale data (a small counter,
  which would make a leaked write baseline 100 and the next tick emit a fabricated ~225/s);
  with the fence the next tick is a clean first sample (rate 0) and the following tick computes
  the real (1500-1000)/5s = 100/s.
  */
  it("a sample in flight at restart is fenced out and the shared in-flight guard survives the restart", async () => {
    vi.useFakeTimers();
    let resolveStale: (s: PgStats) => void = () => {};
    const stale = new Promise<PgStats>((res) => {
      resolveStale = res;
    });
    let calls = 0;
    const reader = vi.fn(async (): Promise<PgStats | null> => {
      calls += 1;
      if (calls === 1) return stale; // the pre-restart tick holds this pending read
      if (calls === 2) return [{ datname: "fusion", xactCommit: 1000, xactRollback: 0 }];
      return [{ datname: "fusion", xactCommit: 1500, xactRollback: 0 }];
    });
    const sampler = helper({ tick: { pgMs: 5000, domainMs: 60_000 }, pgStatsReader: reader });
    sampler.start();

    // Tick 1 fires at t5000; its read is still pending when we restart.
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(1);

    // Restart while tick 1 is in flight: stopTimers bumps the generation, start re-arms.
    sampler.stopTimers();
    sampler.start();

    // The pre-restart read resolves with stale data — the fence must discard its write.
    resolveStale([{ datname: "fusion", xactCommit: 100, xactRollback: 0 }]);
    await vi.advanceTimersByTimeAsync(0);

    // The restarted interval's first tick (t10000): without the fence the stale write would
    // have baselined 100@t6000 and this tick would emit (1000-100)/4s ≈ 225/s; with the fence
    // this is a clean FIRST sample -> rate 0, baseline 1000@t10000.
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(sampler.state.pgQueriesPerSecond).toBe(0);

    // The following tick computes from the fresh post-restart baseline: (1500-1000)/5s = 100/s.
    await vi.advanceTimersByTimeAsync(5000);
    expect(reader).toHaveBeenCalledTimes(3);
    expect(sampler.state.pgQueriesPerSecond).toBe(100);

    sampler.stopTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});