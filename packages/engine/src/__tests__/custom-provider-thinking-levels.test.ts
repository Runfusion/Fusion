import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type CustomProvider } from "@fusion/core";
import { describe, expect, it } from "vitest";
import { buildCustomProviderModels, resolveApiType } from "../auth/custom-provider-registry.js";

const API_TYPES = [
  "openai-compatible",
  "openai-responses",
  "anthropic-compatible",
  "google-generative-ai",
] as const;

describe("custom-provider thinking levels", () => {
  it.each(API_TYPES)("registers every %s model with the canonical transmissible thinking levels", (apiType) => {
    const provider: CustomProvider = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Custom Provider",
      apiType,
      baseUrl: "https://custom.example/v1",
      models: [{ id: "custom-model", name: "Custom Model" }],
    };

    const resolvedApi = resolveApiType(apiType);
    const [model] = buildCustomProviderModels(provider, resolvedApi);

    expect(resolvedApi).toBe(
      apiType === "openai-compatible" ? "openai-completions"
        : apiType === "anthropic-compatible" ? "anthropic-messages"
          : apiType,
    );
    expect(model).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
    expect(getSupportedThinkingLevels(model)).toEqual(THINKING_LEVELS);
  });

  it("keeps providers with absent or empty model lists empty", () => {
    const provider = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Custom Provider",
      apiType: "openai-compatible",
      baseUrl: "https://custom.example/v1",
    } as CustomProvider;

    expect(buildCustomProviderModels(provider, "openai-completions")).toEqual([]);
    expect(buildCustomProviderModels({ ...provider, models: [] }, "openai-completions")).toEqual([]);
  });
});
