import { describe, expect, it } from "vitest";
import { pricingAsOf } from "@fusion/core";
import { pricingBasis, summarizeSessionCost, summarizeTurnCost } from "./session-cost.js";

const session = (observedAt: string) => ({
  id: "a".repeat(64), hostId: "j", provider: "claude", nativeSessionId: "n", revision: 1,
  observation: { provider: "claude", nativeSessionId: "n", revision: 1, activity: "working", observedAt, usageComplete: true, usage: [] },
  receivedAt: observedAt, lastHeartbeatAt: null, collectorConnected: true, activityStale: false,
}) as never;

describe("pricing basis and historical repricing", () => {
  it("flags work older than the rate basis as a recalculation", () => {
    // Fusion keeps no rate history, so an old session priced today is a recomputation, not its billed cost.
    expect(pricingBasis(undefined, "2026-01-01T00:00:00.000Z").recalculated).toBe(true);
    expect(pricingBasis(undefined, "2026-01-01T00:00:00.000Z").asOf).toBe(pricingAsOf);
  });

  it("does not flag work that happened after the rate basis", () => {
    expect(pricingBasis(undefined, "2099-01-01T00:00:00.000Z").recalculated).toBe(false);
  });

  it("never claims a recalculation it cannot prove", () => {
    for (const at of [undefined, null, "not-a-date"]) {
      expect(pricingBasis(undefined, at).recalculated).toBe(false);
    }
  });

  it("prefers an operator-refreshed basis and its source over the built-in baseline", () => {
    const basis = pricingBasis({ modelPricingFetchedAt: "2026-08-01", modelPricingSource: "Operator refresh" }, "2026-07-01T00:00:00.000Z");
    expect(basis).toMatchObject({ asOf: "2026-08-01", source: "Operator refresh", recalculated: true });
    // The same session is NOT a recalculation once the basis predates it.
    expect(pricingBasis({ modelPricingFetchedAt: "2026-06-01" }, "2026-07-01T00:00:00.000Z").recalculated).toBe(false);
  });

  it("carries the basis on session and turn costs so neither can be read as a billed amount", () => {
    expect(summarizeSessionCost(session("2026-01-01T00:00:00.000Z")).basis.recalculated).toBe(true);
    expect(summarizeSessionCost(session("2099-01-01T00:00:00.000Z")).basis.recalculated).toBe(false);
    expect(summarizeTurnCost({}, "claude", undefined, "2026-01-01T00:00:00.000Z").basis.recalculated).toBe(true);
    expect(summarizeTurnCost({}, "claude", undefined, null).basis.recalculated).toBe(false);
  });
});

describe("rates recorded at ingest", () => {
  const usage = [{ model: "claude-sonnet-5", inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0,
    cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: null, fast: false, longContext: false }];
  const recordedRate = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "recorded" };

  it("prices a stamped turn at its recorded rates, not at today's", () => {
    const stamped = summarizeTurnCost(
      { usage, usageComplete: true, pricing: { asOf: "2026-01-01", source: "Baseline then", rates: { "claude_code:claude-sonnet-5": recordedRate } } },
      "claude", undefined, "2026-01-02T00:00:00.000Z");
    expect(stamped.basis).toMatchObject({ asOf: "2026-01-01", source: "Baseline then", recorded: true, recalculated: false });
    // 1000 input at $3/M + 100 output at $15/M.
    expect(stamped.estimatedUsd).toBeCloseTo(0.003 + 0.0015, 10);
  });

  it("does not back-fill an unstamped historical turn as a billed cost", () => {
    const bare = summarizeTurnCost({ usage, usageComplete: true }, "claude", undefined, "2026-01-01T00:00:00.000Z");
    expect(bare.basis.recorded).toBe(false);
    expect(bare.basis.recalculated).toBe(true);
  });

  it("ignores an empty stamp rather than treating it as recorded", () => {
    const empty = summarizeTurnCost({ usage, usageComplete: true, pricing: { asOf: "2026-01-01", source: "s", rates: {} } },
      "claude", undefined, "2026-01-01T00:00:00.000Z");
    expect(empty.basis.recorded).toBe(false);
  });

  it("keeps a later override correction out of an already recorded turn", () => {
    const corrected = { modelPricingOverrides: { "claude_code:claude-sonnet-5": { ...recordedRate, inputPer1M: 999, source: "corrected" } } };
    const stamped = summarizeTurnCost(
      { usage, usageComplete: true, pricing: { asOf: "2026-01-01", source: "Baseline then", rates: { "claude_code:claude-sonnet-5": recordedRate } } },
      "claude", corrected, "2026-01-02T00:00:00.000Z");
    // Policy: a frozen stamp wins. Changing this is an operator decision, not a code detail.
    expect(stamped.estimatedUsd).toBeCloseTo(0.003 + 0.0015, 10);
  });
});
