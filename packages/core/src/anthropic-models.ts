type AnthropicModelInput = "text" | "image";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const CLAUDE_SONNET_5_MODEL_ID = "claude-sonnet-5";

interface AnthropicModelRegistration {
  id: string;
  name: string;
  reasoning: boolean;
  input: AnthropicModelInput[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface AnthropicProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "anthropic-messages";
  models: AnthropicModelRegistration[];
}

/*
 * FNXC:ModelCatalog 2026-06-30-12:22:
 * Claude Sonnet 5 support must not depend on the installed pi-ai catalog version or on the Claude CLI provider. Keep this supplemental Anthropic registration shared by engine sessions and dashboard model routes, and dedupe by model id so upstream catalog catch-up does not create duplicate picker rows.
 */
export const SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION: AnthropicProviderRegistration = {
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "$ANTHROPIC_API_KEY",
  api: "anthropic-messages",
  models: [
    {
      id: CLAUDE_SONNET_5_MODEL_ID,
      name: "Claude Sonnet 5",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: {
        supportsDeveloperRole: false,
      },
    },
  ],
};

type AnthropicModelLike = Partial<Omit<AnthropicModelRegistration, "name" | "compat">> & {
  id: string;
  name?: unknown;
  provider?: string;
  compat?: unknown;
};

interface AnthropicModelRegistryLike {
  registerProvider(providerName: string, config: AnthropicProviderRegistration): void;
  getAll?: () => AnthropicModelLike[];
}

type RegistryWithProviderState = AnthropicModelRegistryLike & {
  registeredProviders?: Map<string, Partial<AnthropicProviderRegistration>>;
};

function toAnthropicModelRegistration(model: AnthropicModelLike): AnthropicModelRegistration {
  const supplemental = SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.find((entry) => entry.id === model.id);
  return {
    id: model.id,
    name: String(model.name ?? supplemental?.name ?? model.id),
    reasoning: model.reasoning ?? supplemental?.reasoning ?? false,
    input: Array.isArray(model.input) ? model.input as AnthropicModelInput[] : supplemental?.input ?? ["text"],
    cost: model.cost ?? supplemental?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow ?? supplemental?.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? supplemental?.maxTokens ?? 0),
    compat: typeof model.compat === "object" && model.compat !== null
      ? { ...(model.compat as Record<string, unknown>) }
      : supplemental?.compat ? { ...supplemental.compat } : undefined,
  };
}

function cloneAnthropicProviderRegistration(config: AnthropicProviderRegistration): AnthropicProviderRegistration {
  return {
    ...config,
    models: config.models.map((model) => toAnthropicModelRegistration(model)),
  };
}

export function mergeSupplementalAnthropicModels(
  modelRegistry: AnthropicModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(ANTHROPIC_PROVIDER_ID);
    const registeredModels = registeredProvider?.models?.map((model) => toAnthropicModelRegistration(model)) ?? [];
    const currentModels = registeredModels.length > 0
      ? registeredModels
      : modelRegistry.getAll?.()
        .filter((model) => model.provider === ANTHROPIC_PROVIDER_ID)
        .map((model) => toAnthropicModelRegistration(model)) ?? [];
    const currentModelIds = new Set(currentModels.map((model) => model.id));
    const missingModels = SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models
      .filter((model) => !currentModelIds.has(model.id));

    if (missingModels.length === 0) return;

    modelRegistry.registerProvider(ANTHROPIC_PROVIDER_ID, {
      ...cloneAnthropicProviderRegistration(SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION),
      ...registeredProvider,
      models: [...currentModels, ...missingModels.map((model) => toAnthropicModelRegistration(model))],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to merge supplemental ${ANTHROPIC_PROVIDER_ID} models: ${message}`);
  }
}
