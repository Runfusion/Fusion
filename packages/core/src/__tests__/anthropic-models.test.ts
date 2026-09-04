import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_FABLE_5_1_MODEL_ID,
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
  it("defines Claude Fable 5.1 with its pinned catalog capabilities", () => {
    expect(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.filter((model) => model.id === CLAUDE_FABLE_5_1_MODEL_ID)).toEqual([{
      id: CLAUDE_FABLE_5_1_MODEL_ID,
      name: "Claude Fable 5.1",
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    }]);
  });

  it("adds Fable 5.1 to an empty Anthropic catalog and preserves thinking levels", () => {
    const registerProvider = vi.fn();
    const registry = { registerProvider, getAll: () => [] };

    mergeSupplementalAnthropicModels(registry);

    const config = registerProvider.mock.calls[0]?.[1];
    const model = config.models.find((entry: { id: string }) => entry.id === CLAUDE_FABLE_5_1_MODEL_ID);
    expect(model).toMatchObject({ thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } });
  });

  it("keeps an upstream Fable 5.1 row without duplication", () => {
    const upstream = {
      ...fable5,
      id: CLAUDE_FABLE_5_1_MODEL_ID,
      name: "Claude Fable 5.1 Upstream",
      contextWindow: 42,
    };
    const registerProvider = vi.fn();
    const registry = {
      registerProvider,
      registeredProviders: new Map([[ANTHROPIC_PROVIDER_ID, { models: [upstream] }]]),
    };

    mergeSupplementalAnthropicModels(registry);

    const config = registerProvider.mock.calls[0]?.[1];
    const models = config.models.filter((entry: { id: string }) => entry.id === CLAUDE_FABLE_5_1_MODEL_ID);
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
