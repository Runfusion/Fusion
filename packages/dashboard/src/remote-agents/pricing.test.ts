import { describe, expect, it } from "vitest";
import { priceUsage } from "./pricing.js";

const rates = { inputPer1M: 10, cacheReadPer1M: 1, cacheWritePer1M: 12.5, outputPer1M: 50, source: "test override" };
const usage = { model: "fixture", inputTokens: 1000000, cachedInputTokens: 200000, cacheWriteTokens: 100000, cacheWriteHourTokens: 0, outputTokens: 10000, reasoningTokens: 5000, fast: false, longContext: false };
describe("remote session accounting", () => {
  it("prices disjoint categories and counts reasoning only inside output", () => {
    const actual = priceUsage(usage, "claude_code", { "anthropic:fixture": rates });
    expect(actual).toMatchObject({ input: 700000, cached: 200000, cacheWrite: 100000, output: 10000, reasoning: 5000, usd: 8.95, rates });
  });
  it("keeps unknown models and unsupported tiers unavailable", () => {
    expect(priceUsage(usage, "codex_cli")?.usd).toBeNull();
    for (const extra of [{ fast: true }, { longContext: true }]) expect(priceUsage({ ...usage, ...extra }, "claude_code", { "anthropic:fixture": rates })?.usd).toBeNull();
  });
  it("keeps unsupported providers unavailable even when the model matches a catalog entry", () => {
    expect(priceUsage(usage, "runtime", { "openai-codex:fixture": rates })).toMatchObject({ rates: null, usd: null, reason: "Provider rate unavailable" });
  });
  it("prices mixed cache durations once and handles the observed native Claude receipt", () => {
    expect(priceUsage({ ...usage, cacheWriteHourTokens: 40000 }, "claude_code", { "anthropic:fixture": rates })).toMatchObject({ cacheWrite: 60000, cacheWriteHour: 40000, usd: 9.25 });
    const native = priceUsage({ ...usage, model: "claude-haiku-4-5-20251001", inputTokens: 20817, cachedInputTokens: 13607, cacheWriteTokens: 7200, cacheWriteHourTokens: 7200, outputTokens: 379, reasoningTokens: null }, "claude_code");
    expect(native?.usd).toBeCloseTo(0.0176657, 9);
  });
  it("rejects missing/negative and overlapping counters instead of guessing zero", () => {
    for (const extra of [{ outputTokens: undefined }, { inputTokens: -1 }, { cachedInputTokens: 1000001 }, { reasoningTokens: 10001 }]) expect(priceUsage({ ...usage, ...extra }, "claude_code")).toBeNull();
  });
});
