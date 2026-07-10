type OpenAiCodexModelInput = "text" | "image";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const GPT_5_6_LUNA_MODEL_ID = "gpt-5.6-luna";
export const GPT_5_6_SOL_MODEL_ID = "gpt-5.6-sol";
export const GPT_5_6_TERRA_MODEL_ID = "gpt-5.6-terra";

interface OpenAiCodexCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface OpenAiCodexOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface OpenAiCodexOAuthProviderRegistration {
  id?: unknown;
  name: string;
  login: (...args: never[]) => Promise<OpenAiCodexOAuthCredentials>;
  refreshToken: (credentials: OpenAiCodexOAuthCredentials) => Promise<OpenAiCodexOAuthCredentials>;
  getApiKey: (credentials: OpenAiCodexOAuthCredentials) => string;
  usesCallbackServer?: boolean;
}

interface OpenAiCodexModelRegistration {
  id: string;
  name: string;
  api?: "openai-codex-responses";
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: OpenAiCodexModelInput[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: OpenAiCodexCostTier[];
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface OpenAiCodexProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey?: string;
  oauth?: OpenAiCodexOAuthProviderRegistration;
  api: "openai-codex-responses";
  models: OpenAiCodexModelRegistration[];
}

/*
 * FNXC:ModelCatalog 2026-07-09-12:30:
 * FN-7745: FN-7742 already priced the three GPT-5.6 codenamed OpenAI Codex variants
 * (gpt-5.6-luna/sol/terra) in model-pricing.ts, but pricing does not make a model
 * selectable — the /api/models picker sources rows from the pinned pi-ai
 * ModelRegistry.getAvailable() catalog. At spec time (pi-ai 0.80.3) that pinned catalog
 * did not carry the three GPT-5.6 codenamed ids under "openai-codex", so no picker
 * surfaced them. Mirror the SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION seam
 * (anthropic-models.ts) to additively register them: if a later pi-ai bump already
 * carries an id, the merge below is a dedupe-safe no-op — the existing catalog row
 * always wins, never displaced or duplicated. Field shape (api/baseUrl) is copied
 * from the pinned catalog's openai-codex.models.js entries.
 *
 * FNXC:ModelCatalog 2026-07-09-23:55:
 * FN-7759: the real pi-coding-agent ModelRegistry rejects dynamic providers that
 * define models without `apiKey` or `oauth`, and `registerProvider` full-replaces
 * the provider's rows before getAvailable() runs. Prior mock-only tests missed that
 * the supplemental OpenAI Codex registration could be logged-and-dropped on installs
 * whose pinned catalog lacked 5.6. Keep model fields aligned with the real Codex
 * catalog (per-model api/baseUrl/thinking levels/pricing) and carry the built-in
 * OAuth provider object into the dynamic registration so validation, getAvailable()
 * auth filtering, and execution-time OAuth auth treatment stay identical to 5.3/5.4/5.5.
 */
export const SUPPLEMENTAL_OPENAI_CODEX_PROVIDER_REGISTRATION: OpenAiCodexProviderRegistration = {
  name: "OpenAI Codex",
  baseUrl: "https://chatgpt.com/backend-api",
  api: "openai-codex-responses",
  models: [
    {
      id: GPT_5_6_LUNA_MODEL_ID,
      name: "GPT-5.6 Luna",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
      input: ["text", "image"],
      cost: {
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        tiers: [{ inputTokensAbove: 272_000, input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5 }],
      },
      contextWindow: 372_000,
      maxTokens: 128_000,
    },
    {
      id: GPT_5_6_SOL_MODEL_ID,
      name: "GPT-5.6 Sol",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
      },
      contextWindow: 372_000,
      maxTokens: 128_000,
    },
    {
      id: GPT_5_6_TERRA_MODEL_ID,
      name: "GPT-5.6 Terra",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
      input: ["text", "image"],
      cost: {
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 3.125,
        tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 6.25 }],
      },
      contextWindow: 372_000,
      maxTokens: 128_000,
    },
  ],
};

type OpenAiCodexModelLike = Partial<Omit<OpenAiCodexModelRegistration, "name" | "api" | "compat" | "thinkingLevelMap">> & {
  id: string;
  api?: string;
  name?: unknown;
  provider?: string;
  compat?: unknown;
  thinkingLevelMap?: unknown;
};

interface OpenAiCodexModelRegistryLike {
  registerProvider(providerName: string, config: OpenAiCodexProviderRegistration): void;
  getAll?: () => OpenAiCodexModelLike[];
}

type RegistryWithProviderState = OpenAiCodexModelRegistryLike & {
  registeredProviders?: Map<string, Partial<OpenAiCodexProviderRegistration>>;
  authStorage?: { getOAuthProviders?: () => OpenAiCodexOAuthProviderRegistration[] };
};

function getOpenAiCodexOAuthProvider(registryWithState: RegistryWithProviderState, registeredProvider: Partial<OpenAiCodexProviderRegistration> | undefined): OpenAiCodexOAuthProviderRegistration | undefined {
  return registeredProvider?.oauth
    ?? registryWithState.authStorage?.getOAuthProviders?.().find((provider) => provider.id === OPENAI_CODEX_PROVIDER_ID);
}

function toOpenAiCodexModelRegistration(model: OpenAiCodexModelLike): OpenAiCodexModelRegistration {
  const supplemental = SUPPLEMENTAL_OPENAI_CODEX_PROVIDER_REGISTRATION.models.find((entry) => entry.id === model.id);
  return {
    id: model.id,
    name: String(model.name ?? supplemental?.name ?? model.id),
    api: model.api === "openai-codex-responses" ? model.api : supplemental?.api,
    baseUrl: model.baseUrl ?? supplemental?.baseUrl,
    reasoning: model.reasoning ?? supplemental?.reasoning ?? false,
    thinkingLevelMap: typeof model.thinkingLevelMap === "object" && model.thinkingLevelMap !== null
      ? { ...(model.thinkingLevelMap as Record<string, string | null>) }
      : supplemental?.thinkingLevelMap ? { ...supplemental.thinkingLevelMap } : undefined,
    input: Array.isArray(model.input) ? model.input as OpenAiCodexModelInput[] : supplemental?.input ?? ["text"],
    cost: model.cost ?? supplemental?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow ?? supplemental?.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? supplemental?.maxTokens ?? 0),
    compat: typeof model.compat === "object" && model.compat !== null
      ? { ...(model.compat as Record<string, unknown>) }
      : supplemental?.compat ? { ...supplemental.compat } : undefined,
  };
}

function cloneOpenAiCodexProviderRegistration(config: OpenAiCodexProviderRegistration): OpenAiCodexProviderRegistration {
  return {
    ...config,
    models: config.models.map((model) => toOpenAiCodexModelRegistration(model)),
  };
}

export function mergeSupplementalOpenAiCodexModels(
  modelRegistry: OpenAiCodexModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(OPENAI_CODEX_PROVIDER_ID);
    const registeredModels = registeredProvider?.models?.map((model) => toOpenAiCodexModelRegistration(model)) ?? [];
    const currentModels = registeredModels.length > 0
      ? registeredModels
      : modelRegistry.getAll?.()
        .filter((model) => model.provider === OPENAI_CODEX_PROVIDER_ID)
        .map((model) => toOpenAiCodexModelRegistration(model)) ?? [];
    const currentModelIds = new Set(currentModels.map((model) => model.id));
    const missingModels = SUPPLEMENTAL_OPENAI_CODEX_PROVIDER_REGISTRATION.models
      .filter((model) => !currentModelIds.has(model.id));

    if (missingModels.length === 0) return;

    const oauth = getOpenAiCodexOAuthProvider(registryWithState, registeredProvider);

    modelRegistry.registerProvider(OPENAI_CODEX_PROVIDER_ID, {
      ...cloneOpenAiCodexProviderRegistration(SUPPLEMENTAL_OPENAI_CODEX_PROVIDER_REGISTRATION),
      ...registeredProvider,
      oauth,
      models: [...currentModels, ...missingModels.map((model) => toOpenAiCodexModelRegistration(model))],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to merge supplemental ${OPENAI_CODEX_PROVIDER_ID} models: ${message}`);
  }
}
