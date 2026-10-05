import { describe, expect, it } from "vitest";
import { summarizeIncrementCost, summarizeTurnCost } from "./session-cost.js";

const band = (model: string, input: number, output: number) => ({ model, inputTokens: input, cachedInputTokens: 0,
  cacheWriteTokens: 0, cacheWriteHourTokens: 0, outputTokens: output, reasoningTokens: null, fast: false, longContext: false });
const rate = (input: number, output: number, source = "docs") => ({ inputPer1M: input, outputPer1M: output,
  cacheReadPer1M: 0, cacheWritePer1M: 0, source });

describe("session cost from per-revision increments", () => {
  it("prices each increment at the rates recorded with it, not one basis for the whole session", () => {
    // The same model, priced cheaply early and expensively later: the early work must keep the early rate.
    const increments = [
      { usage: [band("m", 1_000_000, 0)], pricing: { asOf: "2026-07-16", source: "early", rates: { "claude_code:m": rate(3, 15) } } },
      { usage: [band("m", 1_000_000, 0)], pricing: { asOf: "2026-09-24", source: "later", rates: { "claude_code:m": rate(9, 45) } } },
    ];
    const summary = summarizeIncrementCost(increments as never, "claude");
    expect(summary.estimatedUsd).toBeCloseTo(3 + 9, 9);
    // Repricing the whole 2M tokens at the later rate would be 18: the bug this decision removes.
    expect(summary.estimatedUsd).not.toBeCloseTo(18, 9);
    expect(summary.bases.sort()).toEqual(["2026-07-16", "2026-09-24"]);
  });

  it("keeps a mid-session model change on its own rate", () => {
    const increments = [
      { usage: [band("model-a", 1_000_000, 0)], pricing: { asOf: "2026-07-16", source: "s", rates: { "claude_code:model-a": rate(3, 0) } } },
      { usage: [band("model-b", 1_000_000, 0)], pricing: { asOf: "2026-07-16", source: "s", rates: { "claude_code:model-b": rate(30, 0) } } },
    ];
    expect(summarizeIncrementCost(increments as never, "claude").estimatedUsd).toBeCloseTo(33, 9);
  });

  it("makes the whole total partial when an increment carried no usable rate", () => {
    const increments = [
      { usage: [band("m", 1_000_000, 0)], pricing: { asOf: "2026-07-16", source: "s", rates: { "claude_code:m": rate(3, 0) } } },
      { usage: [band("unpriced-model", 1_000_000, 0)], pricing: null },
    ];
    const summary = summarizeIncrementCost(increments as never, "claude");
    // A floor, not a figure: reporting 3 as the estimate would hide the unpriced half.
    expect(summary.estimatedUsd).toBeNull();
    expect(summary.partialUsd).toBeCloseTo(3, 9);
    expect(summary.unpricedIncrements).toBe(1);
  });

  it("reports nothing priced rather than zero when no increment could be priced", () => {
    const summary = summarizeIncrementCost([{ usage: [band("unpriced-model", 10, 1)], pricing: null }] as never, "claude");
    expect(summary.estimatedUsd).toBeNull();
    expect(summary.partialUsd).toBeNull();
    expect(summary.pricedIncrements).toBe(0);
  });

  it("agrees with the single-increment turn summary, so one seam prices everything", () => {
    const usage = [band("m", 1_000_000, 100_000)];
    const pricing = { asOf: "2026-07-16", source: "s", rates: { "claude_code:m": rate(3, 15) } };
    const viaIncrements = summarizeIncrementCost([{ usage, pricing }] as never, "claude");
    const viaTurn = summarizeTurnCost({ usage: usage as never, usageComplete: true, pricing: pricing as never }, "claude");
    expect(viaIncrements.estimatedUsd).toBeCloseTo(viaTurn.estimatedUsd!, 9);
  });

  it("ignores an increment that recorded no usage", () => {
    const summary = summarizeIncrementCost([{ usage: [], pricing: null }] as never, "claude");
    expect(summary.pricedIncrements).toBe(0);
    expect(summary.unpricedIncrements).toBe(0);
  });
});
