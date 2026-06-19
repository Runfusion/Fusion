import { describe, it, expect } from "vitest";

import {
  costFor,
  lookupPricing,
  MODEL_PRICING,
  pricingAsOf,
  PRICING_STALE_AFTER_MS,
} from "../model-pricing.js";

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
};

describe("model-pricing", () => {
  it("exposes a pricingAsOf ISO date and a staleness threshold", () => {
    expect(pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(pricingAsOf))).toBe(false);
    expect(PRICING_STALE_AFTER_MS).toBeGreaterThan(0);
  });

  it("prices a known model + token counts to cent precision", () => {
    // claude-opus-4-8: input $5/1M, output $25/1M.
    // 1,000,000 input + 200,000 output = 5.00 + 5.00 = 10.00
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000, outputTokens: 200_000 },
      { provider: "anthropic", model: "claude-opus-4-8" },
    );
    expect(result.unavailable).toBe(false);
    expect(result.usd).not.toBeNull();
    expect(result.usd).toBeCloseTo(10.0, 2);
  });

  it("returns unavailable + null usd for an unknown model (never guesses)", () => {
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000 },
      { provider: "acme", model: "totally-made-up-model" },
    );
    expect(result.unavailable).toBe(true);
    expect(result.usd).toBeNull();
  });

  it("prices cache tokens at the cache rate, not the input rate", () => {
    // claude-opus-4-8: input $5/1M, cacheRead $0.5/1M, cacheWrite $6.25/1M.
    const model = { provider: "anthropic", model: "claude-opus-4-8" };

    const cacheRead = costFor(
      { ...ZERO, cachedTokens: 1_000_000 },
      model,
    );
    // At cache-read rate ($0.5), NOT the input rate ($5).
    expect(cacheRead.usd).toBeCloseTo(0.5, 2);
    expect(cacheRead.usd).not.toBeCloseTo(5.0, 2);

    const cacheWrite = costFor(
      { ...ZERO, cacheWriteTokens: 1_000_000 },
      model,
    );
    expect(cacheWrite.usd).toBeCloseTo(6.25, 2);

    // A pure-input baseline confirms input is the more expensive rate.
    const input = costFor({ ...ZERO, inputTokens: 1_000_000 }, model);
    expect(input.usd).toBeCloseTo(5.0, 2);
  });

  it("sums all four token kinds at their respective rates", () => {
    // 100k input(5) + 100k output(25) + 100k cacheRead(0.5) + 100k cacheWrite(6.25)
    // = 0.5 + 2.5 + 0.05 + 0.625 = 3.675
    const result = costFor(
      {
        inputTokens: 100_000,
        outputTokens: 100_000,
        cachedTokens: 100_000,
        cacheWriteTokens: 100_000,
      },
      { provider: "anthropic", model: "claude-opus-4-8" },
    );
    expect(result.usd).toBeCloseTo(3.675, 3);
  });

  it("flags stale when now is past the staleness threshold", () => {
    const asOf = Date.parse(pricingAsOf);
    const wayLater = asOf + PRICING_STALE_AFTER_MS + 24 * 60 * 60 * 1000;
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000 },
      { provider: "anthropic", model: "claude-opus-4-8" },
      wayLater,
    );
    expect(result.stale).toBe(true);
    // Cost is still computed for a stale-but-present entry.
    expect(result.usd).toBeCloseTo(5.0, 2);
  });

  it("does not flag stale within the threshold or when now is omitted", () => {
    const asOf = Date.parse(pricingAsOf);
    const model = { provider: "anthropic", model: "claude-opus-4-8" };
    const usage = { ...ZERO, inputTokens: 1_000_000 };

    // Just inside the window.
    const fresh = costFor(usage, model, asOf + PRICING_STALE_AFTER_MS - 1000);
    expect(fresh.stale).toBe(false);

    // No `now` → never stale (pure: module never reads the clock).
    const noNow = costFor(usage, model);
    expect(noNow.stale).toBe(false);
  });

  it("still reports stale for an unknown model when now is past threshold", () => {
    const asOf = Date.parse(pricingAsOf);
    const wayLater = asOf + PRICING_STALE_AFTER_MS + 1000;
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000 },
      { provider: "acme", model: "nope" },
      wayLater,
    );
    expect(result.unavailable).toBe(true);
    expect(result.usd).toBeNull();
    expect(result.stale).toBe(true);
  });

  describe("lookupPricing", () => {
    it("resolves by provider:model", () => {
      expect(
        lookupPricing({ provider: "openai", model: "gpt-4o" }),
      ).toBe(MODEL_PRICING["openai:gpt-4o"]);
    });

    it("is case-insensitive and trims", () => {
      expect(
        lookupPricing({ provider: " OpenAI ", model: " GPT-4o " }),
      ).toBe(MODEL_PRICING["openai:gpt-4o"]);
    });

    it("falls back to a bare model id when provider is unset", () => {
      expect(lookupPricing({ model: "gemini-2.5-pro" })).toBe(
        MODEL_PRICING["google:gemini-2.5-pro"],
      );
    });

    it("returns undefined for empty / unknown input", () => {
      expect(lookupPricing({})).toBeUndefined();
      expect(lookupPricing({ model: "" })).toBeUndefined();
      expect(lookupPricing({ provider: "x", model: "y" })).toBeUndefined();
    });
  });

  it("seeds Anthropic, OpenAI, and Google providers", () => {
    const providers = new Set(
      Object.keys(MODEL_PRICING).map((k) => k.split(":")[0]),
    );
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
  });

  it("every entry has all four rates and a source", () => {
    for (const [key, entry] of Object.entries(MODEL_PRICING)) {
      expect(typeof entry.inputPer1M, key).toBe("number");
      expect(typeof entry.outputPer1M, key).toBe("number");
      expect(typeof entry.cacheReadPer1M, key).toBe("number");
      expect(typeof entry.cacheWritePer1M, key).toBe("number");
      expect(entry.source.length, key).toBeGreaterThan(0);
    }
  });
});
