/**
 * FNXC:ModelRegistry 2026-07-09-00:00:
 * FN-7711 registers `grok-cli` as a built-in, OpenAI-compatible xAI provider so the
 * execution model registry (packages/engine/src/pi.ts `createFnAgent`) can resolve
 * `grok-cli/*` model selections. Before this, selecting a `grok-cli` model hard-failed
 * at session creation with "not found in the pi model registry" because FN-7705/FN-7710
 * only made Grok models appear in the `/api/models` picker — they were never registered
 * into the execution registry that `resolveConfiguredModel()` reads from.
 *
 * The operator-installed `grok` CLI binary (landed by FN-7705) remains discovery/probe
 * only — this module does not shell out to it. The Grok plugin's `GrokRuntimeAdapter` is
 * a no-op streaming stub, so once this provider exists, execution streams against xAI's
 * OpenAI-compatible endpoint (`https://api.x.ai/v1`, api type `openai-completions`) via
 * the standard pi/openai-completions path, not the plugin runtime.
 *
 * This module mirrors `zai-provider.ts` (the canonical built-in-provider pattern):
 * a static provider registration, `registerBuiltInGrokProvider` to seed it, and
 * `mergeBuiltInGrokProviderModels` to re-add any built-in models an extension's
 * provider registration may have dropped (pi's `registerProvider()` replaces the
 * provider's model list wholesale rather than merging).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_CLI_PROVIDER_ID = "grok-cli";

type GrokModelInput = "text" | "image";

interface GrokModelRegistration {
  id: string;
  name: string;
  reasoning: boolean;
  input: GrokModelInput[];
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
  };
}

export interface GrokProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: GrokModelRegistration[];
}

// pi registerProvider() replaces the provider's model list, so keep every
// currently built-in Grok model here and append new models as xAI ships them.
export const GROK_PROVIDER_REGISTRATION: GrokProviderRegistration = {
  name: "Grok",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "$GROK_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 65536,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "grok-4",
      name: "Grok 4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 65536,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "grok-code-fast-1",
      name: "Grok Code Fast 1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "grok-3",
      name: "Grok 3",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "grok-3-mini",
      name: "Grok 3 Mini",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
      compat: {
        supportsDeveloperRole: false,
      },
    },
  ],
};

type GrokModelLike = Partial<Omit<GrokModelRegistration, "name" | "api" | "baseUrl" | "compat">> & {
  id: string;
  name?: unknown;
  provider?: string;
  baseUrl?: unknown;
  api?: unknown;
  compat?: unknown;
};

interface GrokModelRegistryLike {
  registerProvider(providerName: string, config: GrokProviderRegistration): void;
  getAll?: () => GrokModelLike[];
}

type RegistryWithProviderState = GrokModelRegistryLike & {
  registeredProviders?: Map<string, Partial<GrokProviderRegistration>>;
};

function toGrokModelRegistration(model: GrokModelLike): GrokModelRegistration & { baseUrl?: string; api?: string } {
  return {
    id: model.id,
    name: String(model.name ?? model.id),
    api: typeof model.api === "string" ? model.api : undefined,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? model.input as GrokModelInput[] : ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(model.contextWindow ?? 0),
    maxTokens: Number(model.maxTokens ?? 0),
    compat: typeof model.compat === "object" && model.compat !== null
      ? { ...(model.compat as GrokModelRegistration["compat"]) }
      : GROK_PROVIDER_REGISTRATION.models.find((builtInModel) => builtInModel.id === model.id)?.compat ?? {
        supportsDeveloperRole: false,
      },
  };
}

function cloneGrokProviderRegistration(config: GrokProviderRegistration): GrokProviderRegistration {
  return {
    ...config,
    models: config.models.map((model) => toGrokModelRegistration(model)),
  };
}

/**
 * FNXC:ModelRegistry 2026-07-09-00:00:
 * Seeds the built-in `grok-cli` provider (mirrors `registerBuiltInZaiProvider`). Registration
 * is unconditional and harmless without a `GROK_API_KEY` — a missing key only surfaces as a
 * normal downstream auth error at stream time, never as the "not found in the pi model
 * registry" hard-fail this task fixes. Always pass a cloned config because pi's
 * registerProvider() stores and mutates the config object during later upserts.
 */
/**
 * FNXC:ProviderAuth 2026-07-09-00:00:
 * FN-7714 honors a Grok API key stored in `~/.grok/user-settings.json` (`{ "apiKey": ... }`)
 * when `GROK_API_KEY` is not set in the environment. `GROK_PROVIDER_REGISTRATION.apiKey` is
 * the static env reference `"$GROK_API_KEY"`, which pi resolves from `process.env.GROK_API_KEY`
 * at request time — so the fix hydrates that env var (never the provider config, which would
 * leak the raw key via `/api/models`-style reads and logs) from the settings file, only when
 * the env var is currently unset/empty. An already-set `GROK_API_KEY` always wins and the file
 * is never read in that case. A missing (ENOENT), malformed, or empty/absent-`apiKey` settings
 * file is fail-soft: never throw, never mutate env. This exactly mirrors the precedence and
 * fail-soft behavior of `probeGrokApiKeyPresence` in
 * `plugins/fusion-plugin-grok-runtime/src/probe.ts` (env-first, `.trim().length > 0`, same
 * `~/.grok/user-settings.json` path), kept synchronous here because
 * `registerBuiltInGrokProvider` itself is synchronous.
 */
export function hydrateGrokApiKeyFromUserSettings(
  logWarning: (message: string) => void = () => {},
): void {
  const envKey = process.env.GROK_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    // Env var always wins; never read or overwrite from the settings file.
    return;
  }

  try {
    const settingsPath = join(homedir(), ".grok", "user-settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0) {
      process.env.GROK_API_KEY = parsed.apiKey.trim();
    }
  } catch (error) {
    // Fail-soft: a missing (ENOENT), malformed, or unreadable settings file must never throw
    // or mutate process.env — only unexpected errors are worth a warning; ENOENT is routine.
    const isEnoent = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    if (!isEnoent) {
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`Failed to read ~/.grok/user-settings.json for GROK_API_KEY fallback: ${message}`);
    }
  }
}

export function registerBuiltInGrokProvider(
  modelRegistry: GrokModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  hydrateGrokApiKeyFromUserSettings(logWarning);
  try {
    modelRegistry.registerProvider(GROK_CLI_PROVIDER_ID, cloneGrokProviderRegistration(GROK_PROVIDER_REGISTRATION));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to register built-in ${GROK_CLI_PROVIDER_ID} provider: ${message}`);
  }
}

/**
 * FNXC:ModelRegistry 2026-07-09-00:00:
 * pi's registerProvider() treats a provider config with models as a full provider replacement,
 * and user extensions load after Fusion's built-in provider registration. Re-merge missing
 * built-in Grok models after extension registration so grok-4.5 remains visible wherever the
 * user's existing Grok extension models are visible, without deleting extension-supplied models
 * (mirrors `mergeBuiltInZaiProviderModels`).
 */
export function mergeBuiltInGrokProviderModels(
  modelRegistry: GrokModelRegistryLike,
  logWarning: (message: string) => void = () => {},
): void {
  try {
    const registryWithState = modelRegistry as RegistryWithProviderState;
    const registeredProvider = registryWithState.registeredProviders?.get(GROK_CLI_PROVIDER_ID);
    if (!registeredProvider && !modelRegistry.getAll) return;
    const registeredModels = registeredProvider?.models?.map((model) => toGrokModelRegistration(model)) ?? [];
    const currentModels = registeredModels.length > 0
      ? registeredModels
      : modelRegistry.getAll?.()
        .filter((model) => model.provider === GROK_CLI_PROVIDER_ID)
        .map((model) => toGrokModelRegistration(model)) ?? [];
    const currentModelIds = new Set(currentModels.map((model) => model.id));
    const missingBuiltInModels = GROK_PROVIDER_REGISTRATION.models.filter((model) => !currentModelIds.has(model.id));

    if (missingBuiltInModels.length === 0) return;

    modelRegistry.registerProvider(GROK_CLI_PROVIDER_ID, {
      ...cloneGrokProviderRegistration(GROK_PROVIDER_REGISTRATION),
      ...registeredProvider,
      models: [...currentModels, ...missingBuiltInModels.map((model) => toGrokModelRegistration(model))],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarning(`Failed to merge built-in ${GROK_CLI_PROVIDER_ID} models: ${message}`);
  }
}
