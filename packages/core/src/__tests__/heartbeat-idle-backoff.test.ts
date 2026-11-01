/*
FNXC:HeartbeatIdleBackoff 2026-10-31-23:54 (RUFU-268):
The ladder is the only thing standing between an idle agent and a full briefing every tick, and its
output feeds two different authorities: the scheduler that decides whether a timer tick may deliver,
and the freshness checks that decide whether an agent is Unresponsive. Both consume persisted values
they did not write — `heartbeatIdleStreak` and `heartbeatLastNoWorkAt` live in a JSON column that an
older build, a hand-edit, or a future schema may have shaped differently — so the contract these tests
pin is not "the doubling works" but "no shape of persisted input produces a throw, a NaN, an overflow,
or a deferral the operator could not recover from".

Two behavioural edges worth naming, because both were design decisions rather than accidents:
- streak 1 costs nothing. The first acknowledged no-work answer must not delay the next tick, so the
  ladder only bends from streak 2. A test that asserted streak 1 already defers would encode the
  opposite of "new work is still caught quickly".
- a bad anchor dispatches. `heartbeatLastNoWorkAt` absent, unparseable, or in the future all return
  zero deferral. A stuck deferral is invisible; one extra heartbeat is not.
*/
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS,
  resolveHeartbeatIdleDeferralMs,
  resolveHeartbeatIdleDelayMs,
  resolveHeartbeatSilenceBudgetMs,
} from "../heartbeat-idle-backoff.js";

const BASE = 5 * 60_000; // 5-minute base cadence, the ladder the operator described.
const T0 = Date.parse("2026-10-31T10:00:00.000Z");

describe("resolveHeartbeatIdleDelayMs — the ladder shape", () => {
  it("walks the operator's 5 → 10 → 20 → 30-minute ladder from a 5-minute base cadence", () => {
    expect(resolveHeartbeatIdleDelayMs({ streak: 1, baseIntervalMs: BASE })).toBe(5 * 60_000);
    expect(resolveHeartbeatIdleDelayMs({ streak: 2, baseIntervalMs: BASE })).toBe(10 * 60_000);
    expect(resolveHeartbeatIdleDelayMs({ streak: 3, baseIntervalMs: BASE })).toBe(20 * 60_000);
    expect(resolveHeartbeatIdleDelayMs({ streak: 4, baseIntervalMs: BASE })).toBe(30 * 60_000);
  });

  it("doubles per step whenever the ceiling leaves room for the doubling", () => {
    const oneMinute = 60_000;
    expect(resolveHeartbeatIdleDelayMs({ streak: 2, baseIntervalMs: oneMinute })).toBe(2 * oneMinute);
    expect(resolveHeartbeatIdleDelayMs({ streak: 3, baseIntervalMs: oneMinute })).toBe(4 * oneMinute);
    expect(resolveHeartbeatIdleDelayMs({ streak: 6, baseIntervalMs: oneMinute })).toBe(30 * oneMinute);
    expect(resolveHeartbeatIdleDelayMs({ streak: 7, baseIntervalMs: oneMinute })).toBe(HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS);
  });

  it("clamps at the ceiling and never exceeds it, however long the idle episode runs", () => {
    const capped = resolveHeartbeatIdleDelayMs({ streak: 9, baseIntervalMs: BASE });
    expect(capped).toBe(HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS);
    for (const streak of [10, 25, 40, 1_000, 1e12]) {
      expect(resolveHeartbeatIdleDelayMs({ streak, baseIntervalMs: BASE })).toBe(HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS);
    }
  });

  it("honours an explicit operator ceiling below the default", () => {
    expect(resolveHeartbeatIdleDelayMs({ streak: 6, baseIntervalMs: BASE, capMs: 12 * 60_000 })).toBe(12 * 60_000);
  });

  it("treats the first idle answer as free so the next tick stays at base cadence", () => {
    expect(resolveHeartbeatIdleDelayMs({ streak: 1, baseIntervalMs: BASE })).toBe(BASE);
  });

  it("reports no stretch at all for an agent that is not idling", () => {
    for (const streak of [undefined, null, 0, -5, Number.NaN, "not-a-number", {}, [], true]) {
      expect(resolveHeartbeatIdleDelayMs({ streak, baseIntervalMs: BASE })).toBe(0);
    }
  });

  it("survives an unusable base cadence without throwing or producing NaN", () => {
    for (const baseIntervalMs of [undefined, null, 0, -1, Number.NaN, "5m", Number.POSITIVE_INFINITY]) {
      const delay = resolveHeartbeatIdleDelayMs({ streak: 4, baseIntervalMs });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(0);
    }
  });

  it("falls back to the code ceiling when the setting holds a junk value", () => {
    for (const capMs of [undefined, null, 0, -1, Number.NaN, "cap"]) {
      expect(resolveHeartbeatIdleDelayMs({ streak: 12, baseIntervalMs: BASE, capMs })).toBe(
        HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS,
      );
    }
  });

  it("never returns a non-finite number for any persisted shape it can be handed", () => {
    for (const streak of [undefined, null, Number.NaN, 1e308, -0, "3", 3.7, {}, [], Infinity]) {
      const delay = resolveHeartbeatIdleDelayMs({ streak, baseIntervalMs: BASE });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS);
    }
  });
});

describe("resolveHeartbeatIdleDeferralMs — when a timer tick may deliver", () => {
  it("defers a tick that arrives before the agent's own ladder step has elapsed", () => {
    // streak 3 from a 5-minute base = a 20-minute wait; the tick arrived 6 minutes in.
    expect(resolveHeartbeatIdleDeferralMs({
      streak: 3,
      baseIntervalMs: BASE,
      lastNoWorkAt: new Date(T0).toISOString(),
      nowMs: T0 + 6 * 60_000,
    })).toBe(20 * 60_000 - 6 * 60_000);
  });

  it("releases the tick exactly at the deadline, not a tick later", () => {
    expect(resolveHeartbeatIdleDeferralMs({
      streak: 3,
      baseIntervalMs: BASE,
      lastNoWorkAt: new Date(T0).toISOString(),
      nowMs: T0 + 20 * 60_000,
    })).toBe(0);
  });

  it("never defers past the ceiling", () => {
    expect(resolveHeartbeatIdleDeferralMs({
      streak: 40,
      baseIntervalMs: BASE,
      lastNoWorkAt: new Date(T0).toISOString(),
      nowMs: T0 + HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS,
    })).toBe(0);
    expect(resolveHeartbeatIdleDeferralMs({
      streak: 40,
      baseIntervalMs: BASE,
      lastNoWorkAt: new Date(T0).toISOString(),
      nowMs: T0 + HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS - 1,
    })).toBe(1);
  });

  it("dispatches rather than defers on a missing, unparseable, or future-dated anchor", () => {
    const deferredShape = { streak: 5, baseIntervalMs: BASE, nowMs: T0 + 60_000 };
    for (const lastNoWorkAt of [undefined, null, "", "not-a-date", "2026-13-45", 12345, {}, new Date(T0 + 60 * 60_000).toISOString()]) {
      expect(resolveHeartbeatIdleDeferralMs({ ...deferredShape, lastNoWorkAt })).toBe(0);
    }
  });

  it("never defers for a non-idling agent, whatever its anchor says", () => {
    expect(resolveHeartbeatIdleDeferralMs({
      streak: 0,
      baseIntervalMs: BASE,
      lastNoWorkAt: new Date(T0).toISOString(),
      nowMs: T0,
    })).toBe(0);
  });
});

describe("resolveHeartbeatSilenceBudgetMs — the read-side grace base", () => {
  it("is byte-identical to the base cadence for an agent that is not idling", () => {
    expect(resolveHeartbeatSilenceBudgetMs({ streak: undefined, baseIntervalMs: BASE })).toBe(BASE);
    expect(resolveHeartbeatSilenceBudgetMs({ streak: 0, baseIntervalMs: BASE })).toBe(BASE);
  });

  it("grows with that agent's own ladder step and stops at the ceiling", () => {
    expect(resolveHeartbeatSilenceBudgetMs({ streak: 1, baseIntervalMs: BASE })).toBe(BASE);
    expect(resolveHeartbeatSilenceBudgetMs({ streak: 3, baseIntervalMs: BASE })).toBe(20 * 60_000);
    expect(resolveHeartbeatSilenceBudgetMs({ streak: 99, baseIntervalMs: BASE })).toBe(HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS);
  });

  it("never shrinks below the base cadence, even if a bad cap is configured", () => {
    expect(resolveHeartbeatSilenceBudgetMs({ streak: 4, baseIntervalMs: BASE, capMs: 1_000 })).toBe(BASE);
  });
});
