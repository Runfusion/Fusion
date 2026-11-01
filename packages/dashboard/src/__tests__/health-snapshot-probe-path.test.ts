/**
 * RUFU-674: `/api/health` must never put awaited I/O on the watchdog's probe path.
 *
 * FNXC:HealthProbeLatency 2026-11-01-22:53:
 * The watchdog probes `curl -m 10` every 45 s and restarts after three consecutive failures. When the
 * health handler awaited the Postgres evaluation (5 s internal budget, 1.7-3.1 s measured idle), ~7 s of
 * event-loop latency was enough to lose the probe and kill a healthy server — measured at 8.9 GB RSS,
 * under the memory ceiling, aborting every live session. These tests pin the two properties that make
 * the fix real and not merely faster: the read path answers synchronously even while an evaluation is
 * outstanding, and staleness still fails closed so a genuinely wedged loop is still restarted.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHealthSnapshot, HEALTH_SNAPSHOT_STALE_CEILING_MS } from "../health-snapshot.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("health snapshot probe path (RUFU-674)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is empty rather than stale before the first evaluation lands", () => {
    const snapshot = createHealthSnapshot({ evaluate: async () => "payload", now: makeClock().now });
    const read = snapshot.read();
    expect(read.value).toBeNull();
    expect(read.stale).toBe(false);
    expect(Number.isNaN(read.ageMs)).toBe(true);
  });

  it("answers from the snapshot with no awaited work while an evaluation is still outstanding", async () => {
    // A resolve-hook the test controls: the outstanding evaluation NEVER settles, which is the shape of
    // a saturated event loop. The probe must still get the last known payload synchronously.
    let release: ((v: string) => void) | null = null;
    const snapshot = createHealthSnapshot<string>({
      evaluate: () => new Promise<string>((resolve) => { release = resolve; }),
      now: makeClock().now,
    });

    // `evaluate` is reached synchronously inside refreshNow, so the hook exists before we resolve it.
    const first = snapshot.refreshNow();
    expect(release).toBeTypeOf("function");
    release!("first");
    await first;

    // Start a second evaluation that never settles, then read without awaiting anything.
    void snapshot.refreshNow();
    const read = snapshot.read();
    expect(read.value).toBe("first");
    expect(read.stale).toBe(false);
  });

  it("fails closed once the snapshot outlives the stale ceiling", async () => {
    const clock = makeClock();
    const snapshot = createHealthSnapshot({ evaluate: async () => "payload", now: clock.now });
    await snapshot.refreshNow();
    clock.advance(HEALTH_SNAPSHOT_STALE_CEILING_MS);
    expect(snapshot.read().stale).toBe(false);
    clock.advance(1);
    expect(snapshot.read().stale).toBe(true);
    expect(snapshot.read().value).toBe("payload");
  });

  it("keeps the last good payload across a failed refresh instead of flipping to degraded", async () => {
    let fail = false;
    const snapshot = createHealthSnapshot<string>({
      evaluate: async () => {
        if (fail) throw new Error("probe read failed");
        return "good";
      },
      now: makeClock().now,
    });
    expect(await snapshot.refreshNow()).toBe("good");
    fail = true;
    expect(await snapshot.refreshNow()).toBe("good");
    expect(snapshot.read().value).toBe("good");
    expect(snapshot.read().stale).toBe(false);
  });

  it("coalesces concurrent refreshes into one evaluation", async () => {
    const evaluate = vi.fn(async () => "payload");
    const snapshot = createHealthSnapshot({ evaluate, now: makeClock().now });
    await Promise.all([snapshot.refreshNow(), snapshot.refreshNow(), snapshot.refreshNow()]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("refreshes on the interval while started and stops when stopped", async () => {
    const evaluate = vi.fn(async () => "payload");
    const snapshot = createHealthSnapshot({ evaluate, refreshMs: 1_000, now: makeClock().now });
    snapshot.start();
    await vi.advanceTimersByTimeAsync(3_000);
    const started = evaluate.mock.calls.length;
    expect(started).toBeGreaterThanOrEqual(3);
    snapshot.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluate.mock.calls.length).toBe(started);
  });
});
