import { describe, expect, it } from "vitest";
import {
  mergeBuiltInZaiProviderModels,
  registerBuiltInZaiProvider,
  ZAI_PROVIDER_ID,
  ZAI_PROVIDER_REGISTRATION,
} from "../zai-provider.js";

const EXISTING_ZAI_MODELS = [
  "glm-4.5-air",
  "glm-4.7",
  "glm-5-turbo",
  "glm-5.1",
  "glm-5v-turbo",
];

describe("ZAI_PROVIDER_REGISTRATION", () => {
  it("uses the existing zai auth surface and API endpoint", () => {
    expect(ZAI_PROVIDER_ID).toBe("zai");
    expect(ZAI_PROVIDER_REGISTRATION).toMatchObject({
      name: "ZAI",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "$ZAI_API_KEY",
      api: "openai-completions",
    });
  });

  it("preserves existing built-in models and appends glm-5.2", () => {
    const modelIds = ZAI_PROVIDER_REGISTRATION.models.map((model) => model.id);

    expect(modelIds).toEqual([...EXISTING_ZAI_MODELS, "glm-5.2"]);
    for (const id of EXISTING_ZAI_MODELS) {
      expect(modelIds).toContain(id);
    }
  });

  it("registers GLM-5.2 with upstream model capabilities", () => {
    expect(ZAI_PROVIDER_REGISTRATION.models.find((model) => model.id === "glm-5.2")).toMatchObject({
      id: "glm-5.2",
      name: "GLM-5.2",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    });
  });

  it("re-merges missing built-in models after a user zai extension replacement", () => {
    const extensionModels = ZAI_PROVIDER_REGISTRATION.models
      .filter((model) => model.id !== "glm-5.2")
      .map((model) => ({ ...model }));
    const registeredProviders = new Map<string, Partial<typeof ZAI_PROVIDER_REGISTRATION>>();
    const registry = {
      registeredProviders,
      registerProvider(providerName: string, config: typeof ZAI_PROVIDER_REGISTRATION) {
        registeredProviders.set(providerName, { ...registeredProviders.get(providerName), ...config });
      },
    };

    registerBuiltInZaiProvider(registry);
    registry.registerProvider(ZAI_PROVIDER_ID, {
      ...ZAI_PROVIDER_REGISTRATION,
      name: "User ZAI extension",
      models: extensionModels,
    });

    mergeBuiltInZaiProviderModels(registry);

    const mergedIds = registeredProviders.get(ZAI_PROVIDER_ID)?.models?.map((model) => model.id);
    expect(mergedIds).toEqual([...EXISTING_ZAI_MODELS, "glm-5.2"]);
    expect(registeredProviders.get(ZAI_PROVIDER_ID)?.name).toBe("User ZAI extension");
  });
});
