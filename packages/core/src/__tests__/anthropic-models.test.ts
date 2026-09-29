import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_MODEL_ID,
  mergeSupplementalAnthropicModels,
  SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION,
} from "../ai/anthropic-models.js";

const fable5 = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

describe("supplemental Anthropic models", () => {
  it.each([
    [CLAUDE_OPUS_5_5_MODEL_ID, "Claude Opus 5.5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    [CLAUDE_SONNET_5_5_MODEL_ID, "Claude Sonnet 5.5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ])("defines %s with complete pinned catalog capabilities", (id, name, cost) => {
    expect(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.filter((model) => model.id === id)).toEqual([{
      id,
      name,
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    }]);
  });

  it("adds both 5.5 models to an empty Anthropic catalog with supported thinking levels", () => {
    const registerProvider = vi.fn();
    mergeSupplementalAnthropicModels({ registerProvider, getAll: () => [] });

    const config = registerProvider.mock.calls[0]?.[1];
    for (const id of [CLAUDE_OPUS_5_5_MODEL_ID, CLAUDE_SONNET_5_5_MODEL_ID]) {
      expect(config.models.find((entry: { id: string }) => entry.id === id)).toMatchObject({
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
    }
  });

  it.each([CLAUDE_OPUS_5_5_MODEL_ID, CLAUDE_SONNET_5_5_MODEL_ID])("keeps an upstream %s row without duplication", (id) => {
    const upstream = { ...fable5, id, name: `${id} Upstream`, contextWindow: 42 };
    const registerProvider = vi.fn();
    const registry = { registerProvider, registeredProviders: new Map([[ANTHROPIC_PROVIDER_ID, { models: [upstream] }]]) };

    mergeSupplementalAnthropicModels(registry);

    const models = registerProvider.mock.calls[0]?.[1].models.filter((entry: { id: string }) => entry.id === id);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: upstream.name, contextWindow: upstream.contextWindow });
  });

  it("logs and swallows a failed provider registration", () => {
    const logWarning = vi.fn();
    mergeSupplementalAnthropicModels({
      getAll: () => [],
      registerProvider: () => { throw new Error("registry unavailable"); },
    }, logWarning);

    expect(logWarning).toHaveBeenCalledWith("Failed to merge supplemental anthropic models: registry unavailable");
  });

  it("keeps existing Fable 5 rows while adding the supplemental entries", () => {
    const registerProvider = vi.fn();
    const registry = {
      registerProvider,
      registeredProviders: new Map([[ANTHROPIC_PROVIDER_ID, { models: [fable5] }]]),
    };

    mergeSupplementalAnthropicModels(registry);

    const config = registerProvider.mock.calls[0]?.[1];
    expect(config.models.find((entry: { id: string }) => entry.id === fable5.id)).toMatchObject(fable5);
    expect(config.models.some((entry: { id: string }) => entry.id === CLAUDE_FABLE_5_1_MODEL_ID)).toBe(true);
  });
});
