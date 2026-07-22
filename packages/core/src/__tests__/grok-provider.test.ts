import { describe, expect, it } from "vitest";
import {
  GROK_CLI_PROVIDER_ID,
  GROK_PROVIDER_REGISTRATION,
  mergeBuiltInGrokProviderModels,
  registerBuiltInGrokProvider,
} from "../ai/grok-provider.js";
import { ZAI_PROVIDER_ID, ZAI_PROVIDER_REGISTRATION, registerBuiltInZaiProvider } from "../ai/zai-provider.js";

const EXPECTED_GROK_MODELS = ["grok-4.5", "grok-4", "grok-code-fast-1", "grok-3", "grok-3-mini"];

describe("GROK_PROVIDER_REGISTRATION", () => {
  it("uses the xAI OpenAI-compatible endpoint and API-key auth", () => {
    expect(GROK_CLI_PROVIDER_ID).toBe("grok-cli");
    expect(GROK_PROVIDER_REGISTRATION).toMatchObject({
      name: "Grok",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "$GROK_API_KEY",
      api: "openai-completions",
    });
  });

  it("seeds the reported default model plus a conservative catalog", () => {
    const modelIds = GROK_PROVIDER_REGISTRATION.models.map((model) => model.id);
    expect(modelIds).toEqual(EXPECTED_GROK_MODELS);
    expect(modelIds).toContain("grok-4.5");
  });

  it("does not copy Z.ai's thinkingFormat compat field", () => {
    for (const model of GROK_PROVIDER_REGISTRATION.models) {
      expect(model.compat).not.toHaveProperty("thinkingFormat");
    }
  });
});

describe("registerBuiltInGrokProvider", () => {
  it("registers grok-cli with the expected baseUrl/api/models", () => {
    const registeredProviders = new Map<string, unknown>();
    const registry = {
      registeredProviders,
      registerProvider(providerName: string, config: unknown) {
        registeredProviders.set(providerName, config);
      },
    };

    registerBuiltInGrokProvider(registry);

    const registered = registeredProviders.get(GROK_CLI_PROVIDER_ID) as typeof GROK_PROVIDER_REGISTRATION;
    expect(registered).toMatchObject({
      name: "Grok",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "$GROK_API_KEY",
      api: "openai-completions",
    });
    expect(registered.models.map((model) => model.id)).toEqual(EXPECTED_GROK_MODELS);
  });

  it("is additive — does not displace a pre-existing zai provider registration", () => {
    const registeredProviders = new Map<string, unknown>();
    const registry = {
      registeredProviders,
      registerProvider(providerName: string, config: unknown) {
        registeredProviders.set(providerName, config);
      },
    };

    registerBuiltInZaiProvider(registry);
    registerBuiltInGrokProvider(registry);

    expect(registeredProviders.has(ZAI_PROVIDER_ID)).toBe(true);
    expect(registeredProviders.has(GROK_CLI_PROVIDER_ID)).toBe(true);
    expect((registeredProviders.get(ZAI_PROVIDER_ID) as typeof ZAI_PROVIDER_REGISTRATION).models.map((m) => m.id))
      .toEqual(ZAI_PROVIDER_REGISTRATION.models.map((m) => m.id));
  });

  it("does not throw when registerProvider throws", () => {
    const registry = {
      registerProvider() {
        throw new Error("boom");
      },
    };
    const warnings: string[] = [];
    expect(() => registerBuiltInGrokProvider(registry, (message) => warnings.push(message))).not.toThrow();
    expect(warnings[0]).toContain("Failed to register built-in grok-cli provider");
  });
});

describe("mergeBuiltInGrokProviderModels", () => {
  it("re-adds missing built-in models after a user grok extension replacement", () => {
    const extensionModels = GROK_PROVIDER_REGISTRATION.models
      .filter((model) => model.id !== "grok-4.5")
      .map((model) => ({ ...model }));
    const registeredProviders = new Map<string, Partial<typeof GROK_PROVIDER_REGISTRATION>>();
    const registry = {
      registeredProviders,
      registerProvider(providerName: string, config: typeof GROK_PROVIDER_REGISTRATION) {
        registeredProviders.set(providerName, { ...registeredProviders.get(providerName), ...config });
      },
    };

    registerBuiltInGrokProvider(registry);
    registry.registerProvider(GROK_CLI_PROVIDER_ID, {
      ...GROK_PROVIDER_REGISTRATION,
      name: "User Grok extension",
      models: extensionModels,
    });

    mergeBuiltInGrokProviderModels(registry);

    const mergedIds = registeredProviders.get(GROK_CLI_PROVIDER_ID)?.models?.map((model) => model.id);
    expect(mergedIds).toEqual(expect.arrayContaining(EXPECTED_GROK_MODELS));
    expect(mergedIds).toContain("grok-4.5");
    expect(registeredProviders.get(GROK_CLI_PROVIDER_ID)?.name).toBe("User Grok extension");
  });

  it("is a no-op when all built-in models are already present", () => {
    const registeredProviders = new Map<string, Partial<typeof GROK_PROVIDER_REGISTRATION>>();
    const registry = {
      registeredProviders,
      registerProvider(providerName: string, config: typeof GROK_PROVIDER_REGISTRATION) {
        registeredProviders.set(providerName, { ...registeredProviders.get(providerName), ...config });
      },
    };

    registerBuiltInGrokProvider(registry);
    expect(() => mergeBuiltInGrokProviderModels(registry)).not.toThrow();
    const mergedIds = registeredProviders.get(GROK_CLI_PROVIDER_ID)?.models?.map((model) => model.id);
    expect(mergedIds).toEqual(EXPECTED_GROK_MODELS);
  });
});
