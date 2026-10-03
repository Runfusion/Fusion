import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION,
  mergeSupplementalAnthropicModels,
} from "../ai/anthropic-models.js";

const EXPECTED_IDS = [CLAUDE_OPUS_5_5_MODEL_ID, CLAUDE_SONNET_5_5_MODEL_ID];

describe("SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION", () => {
  it("contains the complete Opus 5.5 and Sonnet 5.5 compatibility metadata", () => {
    expect(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models).toHaveLength(2);
    for (const model of SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models) {
      expect(model).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
      });
    }
    expect(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.map((model) => model.id)).toEqual(EXPECTED_IDS);
    expect(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.map((model) => model.cost)).toEqual([
      { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    ]);
  });
});

describe("mergeSupplementalAnthropicModels", () => {
  it("adds both models to an empty legacy registry", () => {
    const registeredProviders = new Map<string, unknown>();
    const registry = { registeredProviders, registerProvider: (id: string, config: unknown) => registeredProviders.set(id, config) };

    mergeSupplementalAnthropicModels(registry);

    const provider = registeredProviders.get(ANTHROPIC_PROVIDER_ID) as typeof SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION;
    expect(provider.models.map((model) => model.id)).toEqual(EXPECTED_IDS);
  });

  it("retains an upstream row and provider authentication unchanged while adding the missing row", () => {
    const upstream = { id: CLAUDE_OPUS_5_5_MODEL_ID, name: "Upstream Opus", reasoning: false, input: ["text"], cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 }, contextWindow: 42, maxTokens: 7 };
    const oauth = { id: "anthropic", login: async () => ({}) };
    const registeredProviders = new Map<string, any>([[ANTHROPIC_PROVIDER_ID, { name: "Upstream Anthropic", apiKey: "test-key", oauth, models: [upstream] }]]);
    const registry = { registeredProviders, registerProvider: (id: string, config: unknown) => registeredProviders.set(id, config) };

    mergeSupplementalAnthropicModels(registry);

    const provider = registeredProviders.get(ANTHROPIC_PROVIDER_ID);
    expect(provider.oauth).toBe(oauth);
    expect(provider.apiKey).toBe("test-key");
    expect(provider.models.filter((model: { id: string }) => model.id === CLAUDE_OPUS_5_5_MODEL_ID)).toEqual([upstream]);
    expect(provider.models.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(EXPECTED_IDS));
  });

  it("is idempotent and uses getAll when provider state is unavailable", () => {
    const upstream = EXPECTED_IDS.map((id) => ({ id, provider: ANTHROPIC_PROVIDER_ID }));
    const registry = {
      registerProvider: () => { throw new Error("already complete catalog must not be replaced"); },
      getAll: () => upstream,
    };

    expect(() => mergeSupplementalAnthropicModels(registry)).not.toThrow();
    expect(() => mergeSupplementalAnthropicModels(registry)).not.toThrow();
  });

  it("warns rather than throwing when registry access fails", () => {
    const warnings: string[] = [];
    const registry = { registerProvider: () => { throw new Error("boom"); } };

    expect(() => mergeSupplementalAnthropicModels(registry, (message) => warnings.push(message))).not.toThrow();
    expect(warnings).toEqual([expect.stringContaining("Failed to merge supplemental anthropic models: boom")]);
  });
});
