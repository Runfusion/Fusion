import { describe, it, expect } from "vitest";

import {
  costFor,
  lookupPricing,
  MODEL_PRICING,
  parseLiteLLMPricing,
  pricingAsOf,
  PRICING_STALE_AFTER_MS,
  type ModelPricingOverrides,
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

  it("prices the current runtime Anthropic Claude Sonnet 5 identity captured from token usage", () => {
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000, outputTokens: 200_000 },
      { provider: "anthropic", model: "claude-sonnet-5" },
    );

    expect(result).toMatchObject({ unavailable: false, stale: false });
    expect(result.usd).toBeCloseTo(4, 2);
  });

  it("prices direct Anthropic Claude Sonnet 5 from the restored static catalog row", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cachedTokens: 500_000,
      cacheWriteTokens: 400_000,
    };

    const anthropic = costFor(usage, { provider: "anthropic", model: "claude-sonnet-5" });
    expect(anthropic.unavailable).toBe(false);
    expect(anthropic.usd).toBeGreaterThan(0);

    const bare = costFor(usage, { model: "claude-sonnet-5" });
    expect(bare.unavailable).toBe(false);
    expect(bare.usd).toBeGreaterThan(0);
  });

  it("prices OpenAI Codex GPT-5 models instead of reporting unavailable", () => {
    // gpt-5-codex: input $1.25/1M, output $10/1M.
    // 1,000,000 input + 200,000 output = 1.25 + 2.00 = 3.25
    const result = costFor(
      { ...ZERO, inputTokens: 1_000_000, outputTokens: 200_000 },
      { provider: "openai-codex", model: "gpt-5-codex" },
    );
    expect(result.unavailable).toBe(false);
    expect(result.usd).not.toBeNull();
    expect(result.usd).toBeCloseTo(3.25, 2);
  });

  it("prices current OpenAI Codex catalog models instead of reporting unavailable", () => {
    const cases = [
      ["gpt-5.3-codex-spark", 4.55],
      ["gpt-5.4", 5.5],
      ["gpt-5.4-mini", 1.65],
      ["gpt-5.5", 11],
      ["gpt-5.6-luna", 2.2],
      ["gpt-5.6-sol", 11],
      ["gpt-5.6-terra", 5.5],
    ] as const;

    for (const [model, expectedUsd] of cases) {
      const result = costFor(
        { ...ZERO, inputTokens: 1_000_000, outputTokens: 200_000 },
        { provider: "openai-codex", model },
      );
      expect(result.unavailable).toBe(false);
      expect(result.usd).not.toBeNull();
      expect(result.usd).toBeCloseTo(expectedUsd, 2);
    }
  });

  it("prices Codex mini latest instead of reporting unavailable", () => {
    // codex-mini-latest: input $1.50/1M, output $6/1M, cached input $0.375/1M.
    const result = costFor(
      {
        ...ZERO,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedTokens: 1_000_000,
      },
      { provider: "openai-codex", model: "codex-mini-latest" },
    );
    expect(result.unavailable).toBe(false);
    expect(result.usd).not.toBeNull();
    expect(result.usd).toBeCloseTo(4.875, 3);
  });

  it("prices GLM-5.2, MiniMax-M3, Kimi K2.6, and Kimi K3 instead of reporting unavailable", () => {
    const cases = [
      { provider: "zai", model: "glm-5.2", expectedUsd: 2.28 },
      { provider: "minimax", model: "MiniMax-M3", expectedUsd: 0.54 },
      { provider: "kimi-coding", model: "kimi-k2.6-preview", expectedUsd: 1.75 },
      // K3: $3/M cache-miss input + $15/M output; 1M input + 200k output = $6.
      { provider: "kimi-coding", model: "k3", expectedUsd: 6 },
    ] as const;

    for (const { provider, model, expectedUsd } of cases) {
      const result = costFor(
        { ...ZERO, inputTokens: 1_000_000, outputTokens: 200_000 },
        { provider, model },
      );
      expect(result.unavailable).toBe(false);
      expect(result.usd).not.toBeNull();
      expect(result.usd).toBeCloseTo(expectedUsd, 2);
    }
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
    const overrides: ModelPricingOverrides = {
      "openai:gpt-4o": {
        inputPer1M: 99,
        outputPer1M: 199,
        cacheReadPer1M: 9,
        cacheWritePer1M: 29,
        source: "test override",
      },
      "acme:unknown-chat": {
        inputPer1M: 2,
        outputPer1M: 4,
        cacheReadPer1M: 1,
        cacheWritePer1M: 3,
        source: "test override",
      },
    };

    it("resolves by provider:model", () => {
      expect(
        lookupPricing({ provider: "openai", model: "gpt-4o" }),
      ).toBe(MODEL_PRICING["openai:gpt-4o"]);
    });

    it("is case-insensitive and trims", () => {
      expect(
        lookupPricing({ provider: " OpenAI ", model: " GPT-4o " }),
      ).toBe(MODEL_PRICING["openai:gpt-4o"]);
      expect(
        lookupPricing({ provider: " MiniMax ", model: " MiniMax-M3 " }),
      ).toBe(MODEL_PRICING["minimax:minimax-m3"]);
    });

    it("resolves OpenAI Codex models by explicit provider:model keys", () => {
      expect(
        lookupPricing({ provider: " OpenAI-Codex ", model: " GPT-5-Codex " }),
      ).toBe(MODEL_PRICING["openai-codex:gpt-5-codex"]);
    });

    it("resolves restored static pricing for direct Anthropic Claude Sonnet 5", () => {
      expect(
        lookupPricing({ provider: " Anthropic ", model: " Claude-Sonnet-5 " }),
      ).toBe(MODEL_PRICING["anthropic:claude-sonnet-5"]);
      expect(lookupPricing({ model: "claude-sonnet-5" })).toBe(MODEL_PRICING["anthropic:claude-sonnet-5"]);
    });

    it("falls back to a bare model id when provider is unset", () => {
      expect(lookupPricing({ model: "gemini-2.5-pro" })).toBe(
        MODEL_PRICING["google:gemini-2.5-pro"],
      );
      expect(lookupPricing({ model: "kimi-k2.6-preview" })).toBe(
        MODEL_PRICING["kimi-coding:kimi-k2.6-preview"],
      );
      expect(lookupPricing({ provider: " KIMI-CODING ", model: " K3 " })).toBe(
        MODEL_PRICING["kimi-coding:k3"],
      );
    });

    it("returns undefined for empty / unknown input", () => {
      expect(lookupPricing({})).toBeUndefined();
      expect(lookupPricing({ model: "" })).toBeUndefined();
      expect(lookupPricing({ provider: "x", model: "y" })).toBeUndefined();
    });

    it("prefers overrides over baseline and keeps baseline fallback", () => {
      expect(lookupPricing({ provider: "openai", model: "gpt-4o" }, overrides)).toBe(overrides["openai:gpt-4o"]);
      expect(lookupPricing({ provider: "anthropic", model: "claude-opus-4-8" }, overrides)).toBe(
        MODEL_PRICING["anthropic:claude-opus-4-8"],
      );
    });

    it("resolves overrides for otherwise unknown models", () => {
      expect(lookupPricing({ provider: "acme", model: "unknown-chat" }, overrides)).toBe(overrides["acme:unknown-chat"]);
      const result = costFor(
        { ...ZERO, inputTokens: 1_000_000, outputTokens: 500_000 },
        { provider: "acme", model: "unknown-chat" },
        undefined,
        overrides,
      );
      expect(result).toMatchObject({ unavailable: false, stale: false });
      expect(result.usd).toBeCloseTo(4, 2);
    });
  });

  describe("parseLiteLLMPricing", () => {
    it("maps chat rows and cache costs from the LiteLLM schema", () => {
      const parsed = parseLiteLLMPricing({
        sample_spec: { mode: "chat" },
        "gpt-test": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
          cache_read_input_token_cost: 0.00000025,
          cache_creation_input_token_cost: 0.00000125,
        },
        "claude-test": {
          litellm_provider: "anthropic",
          mode: "chat",
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
        },
        "gemini-test": {
          litellm_provider: "vertex_ai-language-models",
          mode: "chat",
          input_cost_per_token: 0.0000005,
          output_cost_per_token: 0.0000015,
        },
        "embedding-test": {
          litellm_provider: "openai",
          mode: "embedding",
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
        "missing-output": {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 0.000001,
        },
      });

      expect(parsed.count).toBe(3);
      expect(parsed.overrides["openai:gpt-test"]).toEqual({
        inputPer1M: 1,
        outputPer1M: 2,
        cacheReadPer1M: 0.25,
        cacheWritePer1M: 1.25,
        source: "litellm/model_prices_and_context_window.json",
      });
      expect(parsed.overrides["anthropic:claude-test"]).toMatchObject({
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 3,
        cacheWritePer1M: 3,
      });
      expect(parsed.overrides["google:gemini-test"]).toMatchObject({ inputPer1M: 0.5, outputPer1M: 1.5 });
      expect(parsed.overrides).not.toHaveProperty("openai:embedding-test");
      expect(parsed.overrides).not.toHaveProperty("openai:missing-output");
    });

    it("returns an empty map for malformed input", () => {
      expect(parseLiteLLMPricing(null)).toEqual({ overrides: {}, count: 0 });
      expect(parseLiteLLMPricing([])).toEqual({ overrides: {}, count: 0 });
      expect(parseLiteLLMPricing({ "gpt-test": "bad" })).toEqual({ overrides: {}, count: 0 });
    });
  });

  it("seeds Anthropic, OpenAI Codex, OpenAI, and Google providers", () => {
    const providers = new Set(
      Object.keys(MODEL_PRICING).map((k) => k.split(":")[0]),
    );
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("openai-codex");
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
