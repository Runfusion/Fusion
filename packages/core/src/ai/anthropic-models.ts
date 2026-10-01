import type { ThinkingLevel } from "../types/board/board.js";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../provider-instance.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";
export const CLAUDE_OPUS_5_5_MODEL_ID = "claude-opus-5-5";
export const CLAUDE_SONNET_5_5_MODEL_ID = "claude-sonnet-5-5";

type AnthropicModelInput = "text" | "image";

export interface AnthropicModelRegistration {
  id: string;
  name: string;
  api?: "anthropic-messages";
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input: AnthropicModelInput[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface AnthropicProviderRegistration {
  name: string;
  baseUrl: string;
  api?: "anthropic-messages";
  apiKey: string;
  oauth?: unknown;
  models: AnthropicModelRegistration[];
}

type AnthropicModelLike = Partial<Omit<AnthropicModelRegistration, "name" | "api" | "compat" | "thinkingLevelMap">> & {
  id: string;
  name?: unknown;
  api?: string;
  provider?: string;
  compat?: unknown;
  thinkingLevelMap?: unknown;
};

interface AnthropicModelRegistryLike {
  registerProvider(providerName: string, config: AnthropicProviderRegistration): void;
  getAll?: () => AnthropicModelLike[];
}

type RegistryWithProviderState = AnthropicModelRegistryLike & {
  registeredProviders?: Map<string, Partial<AnthropicProviderRegistration>>;
};

/*
FNXC:ModelCatalog 2026-10-01-02:51:
The bundled Pi 0.86.1 Anthropic catalog omits Claude Opus 5.5 and Claude Sonnet 5.5 even though Fusion already has their published usage prices and OAuth identity support. Supply only these additive compatibility rows until Pi includes them; upstream rows always win unchanged.
*/
export const SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION: AnthropicProviderRegistration = {
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "$ANTHROPIC_API_KEY",
  api: "anthropic-messages",
  models: [
    {
      id: CLAUDE_OPUS_5_5_MODEL_ID,
      name: "Claude Opus 5.5",
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    },
    {
      id: CLAUDE_SONNET_5_5_MODEL_ID,
      name: "Claude Sonnet 5.5",
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    },
  ],
};

function toAnthropicModelRegistration(model: AnthropicModelLike): AnthropicModelRegistration {
  const supplemental = SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION.models.find((entry) => entry.id === model.id);
  return {
    id: model.id,
    name: String(model.name ?? supplemental?.name ?? model.id),
    api: model.api === "anthropic-messages" ? model.api : supplemental?.api,
    reasoning: model.reasoning ?? supplemental?.reasoning ?? false,
    thinkingLevelMap: typeof model.thinkingLevelMap === "object" && model.thinkingLevelMap !== null
      ? { ...(model.thinkingLevelMap as Record<string, string | null>) }
      : supplemental?.thinkingLevelMap ? { ...supplemental.thinkingLevelMap } : undefined,
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
  return { ...config, models: config.models.map((model) => toAnthropicModelRegistration(model)) };
}

/**
 * Add Fusion's temporary Anthropic compatibility records without replacing rows supplied by Pi.
 */
export function mergeSupplementalAnthropicModels(
  modelRegistry: AnthropicModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(ANTHROPIC_PROVIDER_ID);
    const registeredModels = registeredProvider?.models ?? [];
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

/*
FNXC:ProviderAuth 2026-08-15-20:57:
Anthropic's subscription and API-key card ids identify credential/auth surfaces, not pi-ai providers. Normalize stale persisted selections before model lookup or runtime session creation so subscription OAuth continues to execute through pi-ai's built-in `anthropic` provider without registering a fake provider.
*/
export function toExecutionModelProviderId(providerId: string): string {
  return providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID || providerId === ANTHROPIC_API_KEY_PROVIDER_ID
    ? ANTHROPIC_PROVIDER_ID
    : providerId;
}
