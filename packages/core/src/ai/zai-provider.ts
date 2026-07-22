export const ZAI_PROVIDER_ID = "zai";

type ZaiModelInput = "text" | "image";

interface ZaiModelRegistration {
  id: string;
  name: string;
  reasoning: boolean;
  input: ZaiModelInput[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    thinkingFormat: "zai";
    zaiToolStream?: boolean;
  };
}

export interface ZaiProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: ZaiModelRegistration[];
}

// pi registerProvider() replaces the provider's model list, so keep every
// currently built-in Z.ai model here and append new models such as GLM-5.2.
export const ZAI_PROVIDER_REGISTRATION: ZaiProviderRegistration = {
  name: "ZAI",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  apiKey: "$ZAI_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "glm-4.5-air",
      name: "GLM-4.5-Air",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 98304,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
      },
    },
    {
      id: "glm-4.7",
      name: "GLM-4.7",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5V-Turbo",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
  ],
};

type ZaiModelLike = Partial<Omit<ZaiModelRegistration, "name" | "api" | "baseUrl" | "compat">> & {
  id: string;
  name?: unknown;
  provider?: string;
  baseUrl?: unknown;
  api?: unknown;
  compat?: unknown;
};

interface ZaiModelRegistryLike {
  registerProvider(providerName: string, config: ZaiProviderRegistration): void;
  getAll?: () => ZaiModelLike[];
}

type RegistryWithProviderState = ZaiModelRegistryLike & {
  registeredProviders?: Map<string, Partial<ZaiProviderRegistration>>;
};

function toZaiModelRegistration(model: ZaiModelLike): ZaiModelRegistration & { baseUrl?: string; api?: string } {
  return {
    id: model.id,
    name: String(model.name ?? model.id),
    api: typeof model.api === "string" ? model.api : undefined,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? model.input as ZaiModelInput[] : ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? 0),
    compat: typeof model.compat === "object" && model.compat !== null
      ? { ...(model.compat as ZaiModelRegistration["compat"]) }
      : ZAI_PROVIDER_REGISTRATION.models.find((builtInModel) => builtInModel.id === model.id)?.compat ?? {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
      },
  };
}

function cloneZaiProviderRegistration(config: ZaiProviderRegistration): ZaiProviderRegistration {
  return {
    ...config,
    models: config.models.map((model) => toZaiModelRegistration(model)),
  };
}

/**
 * FNXC:ModelRegistry 2026-06-13-22:04:
 * pi's registerProvider() treats a provider config with models as a full provider replacement, and user extensions load after Fusion's built-in provider registration.
 * Re-merge missing built-in Z.ai models after extension registration so zai/glm-5.2 remains visible wherever the user's existing Z.ai extension models are visible, without deleting extension-supplied models.
 * Always pass cloned configs because pi stores and mutates registered provider objects during later upserts.
 */
export function registerBuiltInZaiProvider(
  modelRegistry: ZaiModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    modelRegistry.registerProvider(ZAI_PROVIDER_ID, cloneZaiProviderRegistration(ZAI_PROVIDER_REGISTRATION));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to register built-in ${ZAI_PROVIDER_ID} provider: ${message}`);
  }
}

export function mergeBuiltInZaiProviderModels(
  modelRegistry: ZaiModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(ZAI_PROVIDER_ID);
    if (!registeredProvider && !modelRegistry.getAll) return;
    const registeredModels = registeredProvider?.models?.map((model) => toZaiModelRegistration(model)) ?? [];
    const currentModels = registeredModels.length > 0
      ? registeredModels
      : modelRegistry.getAll?.()
        .filter((model) => model.provider === ZAI_PROVIDER_ID)
        .map((model) => toZaiModelRegistration(model)) ?? [];
    const currentModelIds = new Set(currentModels.map((model) => model.id));
    const missingBuiltInModels = ZAI_PROVIDER_REGISTRATION.models.filter((model) => !currentModelIds.has(model.id));

    if (missingBuiltInModels.length === 0) return;

    modelRegistry.registerProvider(ZAI_PROVIDER_ID, {
      ...cloneZaiProviderRegistration(ZAI_PROVIDER_REGISTRATION),
      ...registeredProvider,
      models: [...currentModels, ...missingBuiltInModels.map((model) => toZaiModelRegistration(model))],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to merge built-in ${ZAI_PROVIDER_ID} models: ${message}`);
  }
}
