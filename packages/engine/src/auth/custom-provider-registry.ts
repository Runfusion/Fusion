/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: relocated from packages/cli/src/commands/custom-provider-registry.ts into @fusion/engine
so the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share ONE
custom-provider registration implementation. packages/cli/src/commands/custom-provider-registry.ts
is now a thin re-export shim of this module; its observable behavior is unchanged.
*/
import { customProviderRegistryKey, type CustomProvider, type CustomProviderThinkingFormat } from "@fusion/core";
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
        /*
        FNXC:CustomProviderThinkingFormat 2026-08-21-05:30:
        RUFU-143: widened so the shared builder's compat.thinkingFormat is part of the
        declared registration contract (pi-ai's OpenAICompletionsCompat is the only api
        compat surface that reads it; see the builder's FNXC note for the emission rules).
        */
        thinkingFormat?: CustomProviderThinkingFormat;
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
 *
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * Per-model `timeoutSeconds` (see CustomProvider.models) is converted to `timeoutMs` on the
 * registered pi Model object: omitted/invalid -> field omitted (pi default 300s applies);
 * `N > 0` -> `N * 1000` ms; `0` -> `MAX_SDK_HTTP_TIMEOUT_MS` (2147483647, "disabled").
 * The `0` conversion is mandatory: the OpenAI SDK's fetchWithTimeout treats a LITERAL `0`
 * as "abort immediately" (only pi's own httpIdleTimeoutMs path maps 0 -> 2147483647), so a
 * disabled-by-user model would otherwise fail every request on its first byte wait.
 * `timeoutMs` rides the pi Model object as a typed (currently pi-ignored) marker; the engine
 * reads it in createPiAgentSessionRaw (pi.ts) and writes it into the per-session
 * SettingsManager `retry.provider.timeoutMs`, which streamFn honors before its 300s default.
 */
const DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW = 128000;
const DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS = 16384;
/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * "Disabled" sentinel for the per-session OpenAI SDK timeout path — identical to pi's own
 * 0 -> 2147483647 conversion in the httpIdleTimeoutMs branch of its streamFn timeout chain.
 */
const MAX_SDK_HTTP_TIMEOUT_MS = 2147483647;

/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
 * RUFU-118-style per-model timeout guard — see the builder doc comment for the conversion
 * contract (omitted/invalid -> undefined so pi's default applies; 0 -> disabled sentinel;
 * N -> N seconds in ms). The semantics are IDLE / first-byte silence, never total time.
 */
function resolveModelTimeoutMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value === 0 ? MAX_SDK_HTTP_TIMEOUT_MS : Math.floor(value * 1000);
}

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
  thinkingLevelMap?: { xhigh: string; max: string };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean; cacheControlFormat?: "anthropic"; thinkingFormat?: CustomProviderThinkingFormat };
}> {
  const supportsDeveloperRole = provider.supportsDeveloperRole === true;
  const anthropicPromptCaching = provider.anthropicPromptCaching === true;

  /*
  FNXC:CustomProviderThinkingFormat 2026-08-21-05:10:
  RUFU-143: custom-provider models are presumed thinking-capable (reasoning:true +
  thinkingLevelMap for xhigh/max), which makes pi send `reasoning_effort` to
  OpenAI-compatible gateways. Qwen3 behind LiteLLM rejects that parameter. The
  per-model flags translate as:
  - `reasoning: false` (the only meaningful explicit value) opts the model OUT of
    thinking entirely: pi receives `reasoning: false` and NO thinkingLevelMap, so
    no thinking parameter is ever emitted and /api/models exposes no levels.
  - `thinkingFormat` is forwarded as `compat.thinkingFormat` ONLY for the
    openai-completions api (pi's OpenAICompletionsCompat is the only surface that
    reads it) and only while the opt-out is not in effect — the opt-out wins over
    format when both are set.
  - `chatTemplateKwargs` is deliberately never emitted: pi-ai 0.84.1's
    qwen-chat-template branch hardcodes `{ enable_thinking: !!reasoningEffort,
    preserve_thinking: true }`, so an explicit kwargs object would only risk being
    ignored or rejected by a strict gateway.
  With neither flag set, the emitted object is byte-identical to the pre-RUFU-143
  registration (reasoning:true, thinkingLevelMap, compat keys unchanged).
  */
  return (provider.models ?? []).map((model) => {
    const reasoningEnabled = model.reasoning !== false;
    return {
      id: model.id,
      name: model.name,
      reasoning: reasoningEnabled,
      ...(reasoningEnabled ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : {}),
      input: ["text" as const],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: resolveModelWindowValue(model.contextWindow, DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW),
      maxTokens: resolveModelWindowValue(model.maxTokens, DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS),
      // FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
      // Per-model HTTP idle/first-byte timeout on the pi Model object (see builder doc). The pi
      // provider composer spreads the definition verbatim, so the field survives registry
      // resolution; createPiAgentSessionRaw reads it and injects it into the per-session
      // SettingsManager retry.provider.timeoutMs (OpenAI SDK TTFB layer).
      ...(() => {
        const timeoutMs = resolveModelTimeoutMs(model.timeoutSeconds);
        return timeoutMs === undefined ? {} : { timeoutMs };
      })(),
      ...(api === "openai-completions"
        ? {
            compat: {
              supportsDeveloperRole,
              ...(anthropicPromptCaching ? { cacheControlFormat: "anthropic" as const } : {}),
              ...(reasoningEnabled && model.thinkingFormat ? { thinkingFormat: model.thinkingFormat } : {}),
            },
          }
        : {}),
    };
  });
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
