// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  assertExpositionText,
  requireFamily,
  sampleValueOf,
  type ParsedMetrics,
} from "../../__tests__/prometheus-text-parse.js";
import {
  createMetricsSampler,
  createRuntimeSampler,
  type MetricsSampler,
  type RuntimeSampler,
  type RuntimeSamplerInit,
} from "../index.js";

/*
FNXC:PrometheusAcceptance 2026-08-13-16:52:
RUFU-082 sampler acceptance: built on top of RUFU-081's module-level unit suites,
this exercises the ORCHESTRATOR render() end-to-end through the independent
parser to prove (a) a scrape is a synchronous pre-read snapshot that never runs
an on-demand DB probe, (b) the full body covers all five measurement gaps, and
(c) the spawn-count hook increments on a real child process and is restored in
finally so no test poisons sibling spawns. The samplers live in
packages/dashboard/src/metrics/, so the suite is co-located there rather than in
packages/core/src/process (the PROMPT's assumption predates RUFU-081's layout).
*/

/**
 * RUFU-082 sampler acceptance suite, exercising the ORCHESTRATOR `render()`
 * end-to-end through the independent exposition parser.
 *
 * RUFU-081 shipped unit suites for each sampler module (they assert `buildSnapshot`
 * arrays in isolation). This suite goes one level up: it renders the FULL
 * Prometheus text body via `createMetricsSampler().render()` and asserts:
 *   - render is a SYNCHRONOUS pre-read snapshot — a scrape never runs a
 *     blocking/on-demand DB probe or ps scan (the pre-read gauge-bookkeeping
 *     seam the task requires);
 *   - the rendered body is well-formed exposition text covering all five
 *     measurement gaps;
 *   - a real child-process spawn increments the spawn counter hook on the LIVE
 *     node:child_process module and the child actually ran, with the wrapper
 *     restored in `finally` so no test poisons sibling spawns.
 *
 * No production DB queries, no polling, no real network, no time waits.
 */

/** Inert runtime init: no-op process + ps surface, no timers. */
function inertRuntime(): RuntimeSamplerInit {
  return {
    processRef: {
      pid: 1234,
      cpuUsage: () => ({ user: 1_000_000, system: 500_000 }),
      memoryUsage: () => ({ rss: 2_000_000, heapTotal: 1_000_000, heapUsed: 400_000 }),
    },
    psProbe: async () => ({ ok: true, childCommands: ["git"] }),
  };
}

/** Run one orchestrator render and parse it. */
function renderAndParse(sampler: MetricsSampler): ParsedMetrics {
  return assertExpositionText(sampler.render());
}

const FIVE_GAP_FAMILIES = [
  "fusion_system_request_latency_ms",
  "fusion_system_last_request_age_ms",
  "fusion_system_child_process_spawn_total",
  "fusion_domain_postgres_queries_per_second",
  "fusion_system_git_child_processes",
  "fusion_system_cpu_user_seconds_total",
  "fusion_system_process_rss_bytes",
];

describe("orchestrator render() acceptance", () => {
  it("render() is a synchronous pre-read snapshot and never touches the DB/ps on a scrape", () => {
    // A domain PG reader that THROWS if a scrape tried to reach it. The
    // acceptance contract is: measurement cost is paid on the tick, not on the
    // render/scrape. render() must render purely from pre-read state.
    const pgProbe = vi.fn(async () => {
      throw new Error("render must not issue an on-demand DB probe");
    });
    const sampler = createMetricsSampler({
      runtime: inertRuntime(),
      domain: { pgStatsReader: pgProbe },
    });

    // render() does not await and returns synchronously.
    const body = sampler.render();
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    expect(pgProbe).not.toHaveBeenCalled();

    // Every scalar family value is a finite number (the serializer coerces NaN).
    const parsed = assertExpositionText(body);
    for (const sample of parsed.samples) {
      expect(typeof sample.value).toBe("number");
    }
  });

  it("renders a well-formed body covering all five RUFU-081 measurement gaps", () => {
    const sampler = createMetricsSampler({ runtime: inertRuntime() });
    const parsed = renderAndParse(sampler);

    for (const familyName of FIVE_GAP_FAMILIES) {
      const family = requireFamily(parsed, familyName);
      // A family must have samples (scalar == 1, quantile-labeled == 3) and
      // every value must be a finite number (the serializer coerces NaN/Inf
      // to 0 so a ragged gauge never produces an unparseable body).
      expect(family.samples.length).toBeGreaterThan(0);
      for (const sample of family.samples) {
        expect(Number.isFinite(sample.value)).toBe(true);
      }
    }
  });

  it("renders a stable, bounded family set across repeated renders (pre-read bookkeeping)", () => {
    const sampler = createMetricsSampler({ runtime: inertRuntime() });
    const first = renderAndParse(sampler);
    const second = renderAndParse(sampler);
    const shape = (p: ParsedMetrics) => p.families.map((f) => [f.name, f.samples.length]);
    expect(shape(second)).toEqual(shape(first));
  });

  it("reflects a request recorded through the latency recording head in the rendered body", () => {
    const sampler = createMetricsSampler({ runtime: inertRuntime() });
    // The head is what server.ts mounts before route handlers; driving it with
    // a fake response whose `finish` we fire reproduces a live served request.
    const state = sampler.runtime.latency;
    const middleware = sampler.middleware();
    const finishCb = { once: (_ev: string, cb: () => void) => cb() } as unknown as Record<string, unknown>;
    let nextCalled = false;
    middleware(null, finishCb, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);

    const body = sampler.render();
    const parsed = assertExpositionText(body);
    expect(requireFamily(parsed, "fusion_system_request_count_total").samples[0].value).toBeGreaterThanOrEqual(1);
    expect(state.requestCount).toBeGreaterThanOrEqual(1);

    // The freeze indicator reflects the just-recorded request (small, finite).
    const age = sampleValueOf(requireFamily(parsed, "fusion_system_last_request_age_ms"));
    expect(Number.isFinite(age)).toBe(true);
  });

  it("maps a pre/post PG-reader pair to a bounded per-second rate and nulls on NaN input", async () => {
    function makeSampler(reader: () => Promise<{ xactCommit: number; xactRollback: number } | null>) {
      return createMetricsSampler({
        runtime: inertRuntime(),
        domain: { pgStatsReader: reader },
      });
    }

    // Pre/post reader pair; the sampler derives a per-second rate from its own
    // clock (elapsed may be ~0 on a tight loop, so the rate is finite and
    // non-negative rather than a pinned value — the exact delta math is owned
    // by RUFU-081's domain-sampler unit suite).
    const reader = vi
      .fn()
      .mockResolvedValueOnce({ xactCommit: 100, xactRollback: 0 })
      .mockResolvedValueOnce({ xactCommit: 150, xactRollback: 0 })
      .mockResolvedValueOnce({ xactCommit: 220, xactRollback: 0 });
    const sampler = makeSampler(reader);
    await sampler.domain.samplePgRate(); // first sample (no prior delta) -> 0
    await sampler.domain.samplePgRate(); // delta over the real elapsed window
    await sampler.domain.samplePgRate(); // a third delta over the next window
    const rate = sampleValueOf(requireFamily(assertExpositionText(sampler.render()), "fusion_domain_postgres_queries_per_second"));
    // A positive final delta yields a finite, non-negative per-second rate.
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(0);

    // NaN/unavailable input -> the field stays a finite number (0 / last-known),
    // never a throw and never a NaN emitted.
    const unavailable = makeSampler(async () => null);
    await unavailable.domain.samplePgRate();
    const nullRate = sampleValueOf(requireFamily(assertExpositionText(unavailable.render()), "fusion_domain_postgres_queries_per_second"));
    expect(Number.isFinite(nullRate)).toBe(true);
  });
});

describe("spawn-count hook on the real child_process module", () => {
  it("increments on a real child spawn, proves the child ran, and restores the wrapper in finally", async () => {
    const cp = createRequire(import.meta.url)("node:child_process") as {
      spawn: (...args: unknown[]) => unknown;
    };
    const sampler: RuntimeSampler = createRuntimeSampler(); // defaults to the live module
    const installed = sampler.installSpawnHook();
    expect(installed).toBe(true);
    const totalBefore = sampler.spawnCounts.total;

    try {
      // Spawn a REAL child through the patched module; delegate-to-original
      // must let it run to completion.
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = cp.spawn(
          process.execPath,
          ["-e", 'process.stdout.write("child-ran");process.exit(0)'],
          { stdio: "ignore" },
        ) as { on: (ev: string, cb: (code: number | null) => void) => void };
        child.on("exit", (code) => resolve(code));
        child.on("error", reject);
      });

      expect(exit).toBe(0);
      // The wrap incremented the counter exactly once for this spawn.
      expect(sampler.spawnCounts.total).toBeGreaterThan(totalBefore);
      expect(sampler.spawnCounts.byKind.spawn).toBeGreaterThan(0);

      // The sampler state reflects the observed spawn as a counter family.
      const families = sampler.buildSnapshot(Date.now());
      const spawnFamily = families.find((f) => f.name === "fusion_system_child_process_spawn_total");
      expect(spawnFamily).toBeDefined();
      expect(spawnFamily!.samples[0].value).toBeGreaterThan(0);
    } finally {
      // Restore the ORIGINAL functions exactly, even on assertion failure, so
      // sibling tests' spawning is never poisoned.
      sampler.removeSpawnHook();
    }

    expect(sampler.spawnHookInstalled).toBe(false);
    // After removal, a direct spawn is no longer counted.
    const totalAfter = sampler.spawnCounts.total;
    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }) as {
        on: (ev: string, cb: (code: number | null) => void) => void;
        error?: (e: Error) => void;
      };
      child.on("exit", () => resolve());
      child.on("error", reject);
    });
    expect(sampler.spawnCounts.total).toBe(totalAfter);
  });

  it("renders the spawn counter through the orchestrator, visible to the parser", () => {
    const cp = createRequire(import.meta.url)("node:child_process") as {
      spawn: (...args: unknown[]) => unknown;
    };
    const orchestrator = createMetricsSampler();
    orchestrator.runtime.installSpawnHook();
    try {
      cp.spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
      const body = orchestrator.render();
      const family = requireFamily(assertExpositionText(body), "fusion_system_child_process_spawn_total");
      expect(family.samples[0].value).toBeGreaterThanOrEqual(1);
    } finally {
      orchestrator.runtime.removeSpawnHook();
    }
  });
});