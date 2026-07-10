/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: relocated from packages/cli/src/commands/custom-provider-registry.ts into @fusion/engine
so the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share ONE
custom-provider registration implementation. packages/cli/src/commands/custom-provider-registry.ts
is now a thin re-export shim of this module; its observable behavior is unchanged.
*/
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";

interface ModelRegistryLike {
  registerProvider: (name: string, config: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
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
  refresh: () => void;
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
 */
export function buildCustomProviderModels(
  provider: CustomProvider,
  api: string,
): Array<{
  id: string;
  name: string;
  reasoning: boolean;
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
    reasoning: false,
    input: ["text" as const],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 16384,
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

export function registerCustomProviders(
  modelRegistry: ModelRegistryLike,
  customProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): void {
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

  modelRegistry.refresh();
}

export function reregisterCustomProviders(
  modelRegistry: ModelRegistryLike,
  previousProviders: CustomProvider[] | undefined,
  currentProviders: CustomProvider[] | undefined,
  logFn: (message: string) => void,
): void {
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

  modelRegistry.refresh();
}
