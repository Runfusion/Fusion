import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { customProviderRegistryKey, mergeSupplementalAnthropicModels, resolvePlanningSettingsModel } from "@fusion/core";
import type { CustomProvider } from "@fusion/core";
import { ApiError } from "../api-error.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";

/**
 * Read provider names from Fusion's own auth stores (primary + legacy .pi).
 * These represent providers the user has explicitly configured in Fusion,
 * as opposed to supplemental credentials inherited from Codex CLI,
 * Claude Code, or environment variables.
 */
function isRawAnthropicApiKeyCredential(credential: unknown): boolean {
  return Boolean(
    credential
      && typeof credential === "object"
      && (credential as { type?: unknown; key?: unknown }).type === "api_key"
      && typeof (credential as { key?: unknown }).key === "string"
      && (credential as { key: string }).key.length > 0,
  );
}

function toModelProviderId(providerId: string): string {
  return providerId === ANTHROPIC_API_KEY_PROVIDER_ID ? ANTHROPIC_PROVIDER_ID : providerId;
}

function addAuthStorageConfiguredProviders(authStorage: AuthStorageLike | undefined, providers: Set<string>): void {
  if (!authStorage) {
    return;
  }

  try {
    authStorage.reload?.();
  } catch {
    // Ignore unreadable auth storage and fall back to persisted files below.
  }

  for (const provider of authStorage.getOAuthProviders?.() ?? []) {
    const providerId = provider.id;
    if (providerId === ANTHROPIC_PROVIDER_ID || providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
      continue;
    }
    if (authStorage.hasAuth?.(providerId)) {
      providers.add(providerId);
    }
  }

  for (const provider of authStorage.getApiKeyProviders?.() ?? []) {
    const storedCredential = authStorage.get?.(provider.id);
    if (authStorage.hasApiKey?.(provider.id) || isRawAnthropicApiKeyCredential(storedCredential)) {
      providers.add(toModelProviderId(provider.id));
    }
  }

  /*
  FNXC:ProviderAuth 2026-07-01-15:10:
  Advertise the direct `anthropic` provider whenever auth storage reports usable anthropic auth — raw API key, subscription OAuth, legacy OAuth, or fallback. Restored v0.51.0 behavior (issue #1857): a subscription/OAuth token executes on the built-in `anthropic` provider via pi-ai's Claude Code impersonation, so OAuth-only users must be able to pick Claude models. `hasAuth("anthropic")` already unifies these sources.
  */
  if (authStorage.hasAuth?.(ANTHROPIC_PROVIDER_ID) || authStorage.hasAuth?.(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)) {
    providers.add(ANTHROPIC_PROVIDER_ID);
  }
}

async function getConfiguredProviderNames(authStorage?: AuthStorageLike): Promise<Set<string>> {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const providers = new Set<string>();

  addAuthStorageConfiguredProviders(authStorage, providers);

  // Fusion primary + legacy .pi auth files
  const authPaths = [
    join(home, ".fusion", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];

  for (const authPath of authPaths) {
    try {
      await access(authPath);
      const parsed = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, unknown>;
      for (const [key, credential] of Object.entries(parsed)) {
        if (key === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
          // A separated subscription OAuth row makes the direct `anthropic` provider usable.
          providers.add(ANTHROPIC_PROVIDER_ID);
          continue;
        }
        if (key !== ANTHROPIC_PROVIDER_ID) {
          providers.add(key);
          continue;
        }
        // Raw API key OR OAuth (legacy subscription) both configure the direct `anthropic` provider.
        const credType = credential && typeof credential === "object"
          ? (credential as { type?: unknown }).type
          : undefined;
        if (credType === "api_key" || credType === "oauth") {
          providers.add(key);
        }
      }
    } catch {
      // Ignore missing or invalid auth files
    }
  }

  /*
  FNXC:ProviderAuth 2026-07-01-15:10:
  Anthropic's three surfaces in discovery (restored v0.51.0 behavior, issue #1857): the direct `anthropic` provider is advertised for raw API-key auth (auth.json `type: api_key`, models.json apiKey, `ANTHROPIC_API_KEY`) AND for subscription/legacy OAuth (which executes on the built-in `anthropic` provider via pi-ai's Claude Code impersonation to /v1). `anthropic-subscription` is an auth/usage credential id, never its own picker row. Claude CLI models appear as `pi-claude-cli` only when the CLI picker toggle is enabled.

  FNXC:ModelCatalog 2026-07-01-13:41:
  `/api/models` must follow the same connected-state source as Settings/auth status when ServerOptions.authStorage is injected. Use auth storage first for OAuth/API-key surfaces, then fall back to legacy files/env so v0.50-style local API-key discovery still works.
  */
  if (process.env.ANTHROPIC_API_KEY) {
    providers.add(ANTHROPIC_PROVIDER_ID);
  }

  // Check models.json for providers with inline API keys
  const modelsPaths = [
    join(home, ".fusion", "agent", "models.json"),
    join(home, ".pi", "agent", "models.json"),
    join(home, ".pi", "models.json"),
  ];
  for (const modelsPath of modelsPaths) {
    try {
      await access(modelsPath);
      const parsed = JSON.parse(await readFile(modelsPath, "utf-8")) as {
        providers?: Record<string, { apiKey?: string }>;
      };
      const provs = parsed?.providers;
      if (provs) {
        for (const [providerId, config] of Object.entries(provs)) {
          if (config.apiKey) {
            providers.add(providerId);
          }
        }
      }
    } catch {
      // Ignore missing or invalid models.json
    }
  }

  return providers;
}

export const registerModelRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, store, runtimeLogger } = ctx;

  router.get("/models", async (_req, res) => {
    // Get favoriteProviders/favoriteModels and default model from global settings.
    let favoriteProviders: string[] = [];
    let favoriteModels: string[] = [];
    let defaultProvider: string | undefined;
    let defaultModelId: string | undefined;
    let useClaudeCli = false;
    let useDroidCli = false;
    let useLlamaCpp = false;
    let useCursorCli = false;
    let resolvedPlanningProvider: string | undefined;
    let resolvedPlanningModelId: string | undefined;
    let customProviders: CustomProvider[] = [];
    if (store) {
      try {
        const globalStore = store.getGlobalSettingsStore();
        const globalSettings = await globalStore.getSettings();
        favoriteProviders = globalSettings.favoriteProviders ?? [];
        favoriteModels = globalSettings.favoriteModels ?? [];
        defaultProvider = globalSettings.defaultProvider;
        defaultModelId = globalSettings.defaultModelId;
        useClaudeCli = globalSettings.useClaudeCli === true;
        useDroidCli = globalSettings.useDroidCli === true;
        useLlamaCpp = globalSettings.useLlamaCpp === true;
        useCursorCli = (globalSettings as Record<string, unknown>).useCursorCli === true;
        customProviders = globalSettings.customProviders ?? [];

        const mergedSettings = await store.getSettingsFast();
        const resolvedPlanningModel = resolvePlanningSettingsModel(mergedSettings);
        resolvedPlanningProvider = resolvedPlanningModel.provider;
        resolvedPlanningModelId = resolvedPlanningModel.modelId;
      } catch {
        // Silently ignore settings errors - just return empty favorites/default model
      }
    }

    const defaultModelResponse =
      defaultProvider && defaultModelId
        ? { defaultProvider, defaultModelId }
        : {};
    const resolvedPlanningModelResponse =
      resolvedPlanningProvider && resolvedPlanningModelId
        ? {
            resolvedPlanningProvider,
            resolvedPlanningModelId,
          }
        : {};

    // Always return 200 with empty array instead of 404 when no models available.
    // This ensures the frontend can handle empty states gracefully.
    if (!options?.modelRegistry) {
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
      return;
    }

    try {
      options.modelRegistry.refresh();
      if (options.modelRegistry.registerProvider) {
        mergeSupplementalAnthropicModels(options.modelRegistry as Parameters<typeof mergeSupplementalAnthropicModels>[0], (message) => runtimeLogger.child("models").warn(message));
      }
      let models = options.modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));

      /*
       * FNXC:ModelCatalog 2026-07-01-12:02:
       * Model visibility is provider-surface-specific: Claude CLI can advertise its own `pi-claude-cli/claude-sonnet-5` row while direct Anthropic must only show Sonnet 5 when the upstream registry returns it. Dedupe after refresh/supplemental merges so overlapping live and supplemental catalogs expose one selectable row without reintroducing static direct-Anthropic advertisement.
       */
      const seenModelKeys = new Set<string>();
      models = models.filter((model) => {
        const key = `${model.provider}/${model.id}`;
        if (seenModelKeys.has(key)) return false;
        seenModelKeys.add(key);
        return true;
      });

      // The vendored pi-claude-cli extension registers its provider as
      // "pi-claude-cli" (distinct from "anthropic") whenever it loads.
      // When the toggle is OFF, hide those entries from pickers so users
      // don't see CLI-routed models they haven't opted into. When ON,
      // surface everything so the CLI-routed entries appear alongside any
      // direct provider auth the user has connected.
      if (!useClaudeCli) {
        models = models.filter((m) => m.provider !== "pi-claude-cli");
      }
      if (!useDroidCli) {
        models = models.filter((m) => m.provider !== "droid-cli");
      }
      if (!useLlamaCpp) {
        models = models.filter((m) => m.provider !== "llama-server");
      }
      if (!useCursorCli) {
        models = models.filter((m) => m.provider !== "cursor-cli");
      }

      // Filter to only providers the user has explicitly configured in Fusion.
      // getAvailable() checks supplemental credential stores (Codex CLI,
      // Claude Code, env vars) which surface providers the user may not
      // have set up in Fusion. We restrict to providers with credentials
      // in Fusion's own auth stores (primary + legacy .pi + models.json),
      // plus any providers enabled via settings toggles (Claude CLI, etc.).
      /*
      FNXC:ModelCatalog 2026-07-07-08:00:
      FN-7630 (GitHub #1931): the Hermes Runtime plugin must be strictly additive
      — connecting/activating or disconnecting it must never narrow this
      configuredProviders allow-set. This block only ever ADDS provider ids
      (auth-storage-derived, CLI-toggle-derived, and customProviders-derived); it
      never removes an entry based on any runtime-plugin connection state, and no
      Hermes-specific branch exists here by design. customProviders' registry keys
      are added unconditionally (regardless of whether Hermes is loaded/connected)
      so a connected Hermes runtime can never deactivate independently-configured
      custom Fusion providers/models. See register-model-routes-hermes-additive.test.ts.
      */
      const configuredProviders = await getConfiguredProviderNames(options?.authStorage);
      if (useClaudeCli) configuredProviders.add("pi-claude-cli");
      if (useDroidCli) configuredProviders.add("droid-cli");
      if (useLlamaCpp) configuredProviders.add("llama-server");
      // Custom providers are configured in Fusion's global settings rather than
      // the auth.json/models.json stores, so add their registry keys explicitly.
      for (const provider of customProviders) {
        configuredProviders.add(customProviderRegistryKey(provider, customProviders));
      }
      models = models.filter((m) => configuredProviders.has(m.provider));

      res.json({
        models,
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      runtimeLogger.child("models").warn(`Failed to load models: ${message}`);
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
    }
  });
};
