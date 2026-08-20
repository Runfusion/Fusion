/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: relocated from packages/cli/src/commands/custom-provider-registry.ts into @fusion/engine
so the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share ONE
custom-provider registration implementation. packages/cli/src/commands/custom-provider-registry.ts
is now a thin re-export shim of this module; its observable behavior is unchanged.
*/
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { refreshFusionModelRegistry, type RefreshableModelRegistry } from "./model-registry-refresh.js";

interface ModelRegistryLike extends RefreshableModelRegistry {
  registerProvider: (name: string, config: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      thinkingLevelMap?: { xhigh?: string | null; max?: string | null };
      input: ("text" | "image")[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat?: {
        supportsDeveloperRole?: boolean;
        cacheControlFormat?: "anthropic";
      };
    }>;
  }) => void;
  refresh: () => unknown;
}

/*
FNXC:CustomProviders 2026-07-08-00:00:
FN-7690: resolveApiType() and pi.ts's resolveCustomProviderApiType() both translate a
custom provider's declared apiType into the api key handed to pi-ai's
ModelRegistry.registerProvider({ api }). Both call sites register into a REAL pi-ai
ModelRegistry (registerCustomProviders/reregisterCustomProviders below feed
seedDashboardProviders, used by desktop + CLI serve/dashboard/daemon), so every arm here
must return a key pi-ai's api-registry actually registers. `anthropic-compatible` resolves
to "anthropic-messages" — matching pi.ts's resolveCustomProviderApiType and the built-in
Anthropic provider config (packages/core/src/anthropic-models.ts, api: "anthropic-messages").
The bare "anthropic" key is never registered and throws "No API provider registered for
api: anthropic" the moment a task streams against it.
*/
export function resolveApiType(apiType: string): string {
  if (apiType === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (apiType === "openai-responses") {
    return "openai-responses";
  }
  // FNXC:CustomProviders 2026-08-19-15:28: Google-compatible custom providers must retain pi's Google API dialect so its shared thinking translation handles Off and every selected effort.
  if (apiType === "google-generative-ai") {
    return "google-generative-ai";
  }
  return "openai-completions";
}

/**
 * FNXC:ProviderAuth 2026-07-08-00:00:
 * FN-7689: shared model-list builder used by BOTH custom-provider registration paths
 * (this module's `toProviderConfig` and pi.ts's `createFnAgent` inline registration) so the
 * `compat.cacheControlFormat` opt-in cannot drift between them again. `api` is the pi-ai
 * api-registry key resolved by each call site's own resolver — both `resolveApiType` here and
 * pi.ts's `resolveCustomProviderApiType` return `"anthropic-messages"` for the same
 * `anthropic-compatible` input (FN-7690 reconciled the earlier naming drift; the bare
 * `"anthropic"` key is never registered by pi-ai). Only `"openai-completions"` gets
 * `compat.cacheControlFormat` — pi-ai's
 * anthropic path already auto-caches without any flag, and `openai-responses` uses OpenAI's
 * native `prompt_cache_key`/`prompt_cache_retention` mechanism (no `cache_control` marker concept
 * per pi-ai's `OpenAIResponsesCompat`), so the opt-in is inert there by construction.
 *
 * FNXC:CustomProviders 2026-08-19-15:13:
 * Custom-provider models are presumed thinking-capable without a user-declared capability. Register
 * all seven canonical levels as transmissible so pi owns Off translation and up-then-down clamping;
 * the same registration is the source for selector display and execution.
 * FNXC:CustomProviderModelWindows 2026-08-19-13:03:
 * RUFU-123 (RUFU-118 finding 2, live repro dsai1 deepseek-v4 32K window): each model's
 * contextWindow/maxTokens now come from the settings entry when present, instead of the
 * hardcoded 128000/16384 that masked every custom-provider model's true window and made
 * the RUFU-118 pre-overflow compaction gate compute a ~102,400 threshold for a 32K model.
 * Fallback contract: a value is emitted only when it is a number, finite, and > 0; anything
 * else (omitted, 0, negative, NaN, or a corrupted persisted string) falls back to the
 * registry defaults 128000 (window) / 16384 (maxTokens) so an invalid stored value can
 * never break registration or collapse a compaction threshold.
 */
const DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW = 128000;
const DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS = 16384;

/**
 * FNXC:CustomProviderModelWindows 2026-08-19-13:03:
 * RUFU-123: positive-finite guard for persisted per-model window values — see the
 * builder doc comment for the fallback contract (defaults 128000/16384).
 */
function resolveModelWindowValue(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function buildCustomProviderModels(
  provider: CustomProvider,
  api: string,
): Array<{
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap: { xhigh: string; max: string };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean; cacheControlFormat?: "anthropic" };
}> {
  const supportsDeveloperRole = provider.supportsDeveloperRole === true;
  const anthropicPromptCaching = provider.anthropicPromptCaching === true;

  return (provider.models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text" as const],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: resolveModelWindowValue(model.contextWindow, DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW),
    maxTokens: resolveModelWindowValue(model.maxTokens, DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS),
    ...(api === "openai-completions"
      ? {
          compat: {
            supportsDeveloperRole,
            ...(anthropicPromptCaching ? { cacheControlFormat: "anthropic" as const } : {}),
          },
        }
      : {}),
  }));
}

function toProviderConfig(provider: CustomProvider) {
  const api = resolveApiType(provider.apiType);

  return {
    baseUrl: provider.baseUrl,
    api,
    apiKey: provider.apiKey,
    models: buildCustomProviderModels(provider, api),
  };
}

function providersDiffer(previous: CustomProvider, current: CustomProvider): boolean {
  return JSON.stringify(toProviderConfig(previous)) !== JSON.stringify(toProviderConfig(current));
}

export async function registerCustomProviders(
  modelRegistry: ModelRegistryLike,
  customProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): Promise<void> {
  const providers = customProviders ?? [];
  for (const provider of providers) {
    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`Registered custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  /*
  FNXC:ModelRegistry 2026-07-21-17:15:
  Unbounded modelRegistry.refresh() hung dashboard startup on "Loading extensions…" when a
  provider catalog fetch never completed. Use the shared bounded refresh so custom-provider
  registration cannot block boot.
  */
  await refreshFusionModelRegistry(modelRegistry, { log: logFn });
}

export async function reregisterCustomProviders(
  modelRegistry: ModelRegistryLike,
  previousProviders: CustomProvider[] | undefined,
  currentProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): Promise<void> {
  const previousById = new Map((previousProviders ?? []).map((provider) => [provider.id, provider]));
  const providers = currentProviders ?? [];

  for (const provider of providers) {
    const previous = previousById.get(provider.id);
    if (previous && !providersDiffer(previous, provider)) {
      continue;
    }

    const registryKey = customProviderRegistryKey(provider, providers);
    try {
      modelRegistry.registerProvider(registryKey, toProviderConfig(provider));
      logFn(`${previous ? "Updated" : "Registered"} custom provider "${provider.name}" (key=${registryKey}, id=${provider.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFn(`Failed to register custom provider "${provider.name}" (key=${registryKey}, id=${provider.id}): ${message}`);
    }
  }

  await refreshFusionModelRegistry(modelRegistry, { log: logFn });
}
