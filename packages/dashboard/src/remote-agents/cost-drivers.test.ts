import { describe, expect, it } from "vitest";
import { priceUsage } from "./pricing.js";
import { categoryCharges, costDrivers, summarizeTurnCost } from "./session-cost.js";

const raw = (over: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5", inputTokens: 100000, cachedInputTokens: 60000, cacheWriteTokens: 20000,
  cacheWriteHourTokens: 5000, outputTokens: 8000, reasoningTokens: 1000, fast: false, longContext: false, ...over,
});

describe("measured cost drivers", () => {
  it("category charges reconcile exactly with the record's own total", () => {
    const priced = priceUsage(raw(), "claude_code")!;
    expect(priced.usd).not.toBeNull();
    const drivers = costDrivers([priced]);
    const summed = Object.values(drivers.charges).reduce((a, b) => a + b, 0);
    // A breakdown that does not add up to the total looks like an explanation while being wrong.
    expect(summed).toBeCloseTo(priced.usd!, 9);
    expect(drivers.totalUsd).toBeCloseTo(priced.usd!, 9);
  });

  // The cost popover shows these per-record charges; they must add up to the figure beside them.
  it("gives one record's category charges that sum to its total, and none for an unpriced record", () => {
    const priced = priceUsage(raw(), "claude_code")!;
    const charges = categoryCharges(priced)!;
    expect(Object.values(charges).reduce((a, b) => a + b, 0)).toBeCloseTo(priced.usd!, 9);
    expect(charges.output).toBeGreaterThan(0);
    expect(categoryCharges(priceUsage(raw({ model: "model-with-no-rate" }), "claude_code")!)).toBeNull();
  });

  it("names the largest measured category rather than guessing a cause", () => {
    const outputHeavy = priceUsage(raw({ outputTokens: 500000, inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0 }), "claude_code")!;
    expect(costDrivers([outputHeavy]).dominant).toBe("output");
    const cacheHeavy = priceUsage(raw({ outputTokens: 10, reasoningTokens: 0, inputTokens: 400000, cachedInputTokens: 399000, cacheWriteTokens: 0, cacheWriteHourTokens: 0 }), "claude_code")!;
    expect(costDrivers([cacheHeavy]).dominant).toBe("cachedInput");
  });

  it("counts measured request volume across records", () => {
    const priced = priceUsage(raw(), "claude_code")!;
    const drivers = costDrivers([priced, priced, priced]);
    expect(drivers.requests).toBe(3);
    expect(drivers.totalUsd).toBeCloseTo(priced.usd! * 3, 9);
  });

  it("reports an unpriced record as unexplained instead of folding it in at zero", () => {
    const priced = priceUsage(raw(), "claude_code")!;
    const unpriced = priceUsage(raw({ model: "model-with-no-rate" }), "claude_code")!;
    expect(unpriced.usd).toBeNull();
    const drivers = costDrivers([priced, unpriced]);
    expect(drivers.requests).toBe(1);
    expect(drivers.unexplained).toBe(1);
    expect(drivers.totalUsd).toBeCloseTo(priced.usd!, 9);
  });

  it("has no dominant category when nothing priced", () => {
    const unpriced = priceUsage(raw({ model: "model-with-no-rate" }), "claude_code")!;
    const drivers = costDrivers([unpriced]);
    expect(drivers.dominant).toBeNull();
    expect(drivers.dominantUsd).toBe(0);
    expect(drivers.unexplained).toBe(1);
  });

  it("exposes drivers through the turn summary used everywhere else", () => {
    const summary = summarizeTurnCost({ usage: [raw()], usageComplete: true }, "claude");
    expect(summary.drivers.requests).toBe(1);
    expect(summary.drivers.dominant).not.toBeNull();
    expect(summary.drivers.totalUsd).toBeCloseTo(summary.estimatedUsd!, 9);
  });
});
