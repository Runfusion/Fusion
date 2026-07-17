import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { customProviderRegistryKey, mergeSupplementalAnthropicModels, mergeSupplementalOpenAiCodexModels, resolvePlanningSettingsModel } from "@fusion/core";
import type { CustomProvider } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { getCursorPickerModels, CURSOR_PICKER_PROVIDER_ID } from "../cursor-model-cache.js";
import { getGrokPickerModels, GROK_PICKER_PROVIDER_ID } from "../grok-model-cache.js";
import { getOmpPickerModels, OMP_PICKER_PROVIDER_ID } from "../omp-model-cache.js";
import { getHermesPickerModels, HERMES_PICKER_PROVIDER_ID } from "../hermes-model-cache.js";
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
    let cursorCliBinaryPath: string | undefined;
    let useGrokCli = false;
    let grokCliBinaryPath: string | undefined;
    let useOmpCli = false;
    let ompCliBinaryPath: string | undefined;
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
        /*
        FNXC:CursorCli 2026-07-08-00:20:
        FN-7699 (follow-up to FN-7696): the machine-local `cursorCliBinaryPath`
        operator override must apply to model-picker discovery too, not just
        the auth/probe/status paths (register-auth-routes.ts's
        normalizeCursorCliBinaryPath). Mirror the same trim/blank->undefined
        normalization here so a blank/unset override preserves PATH
        auto-detection byte-for-byte, and a set override threads through to
        getCursorPickerModels below so discovery spawns the exact same
        cursor-agent executable the settings card already validated.
        */
        const rawCursorCliBinaryPath = (globalSettings as Record<string, unknown>).cursorCliBinaryPath;
        cursorCliBinaryPath =
          typeof rawCursorCliBinaryPath === "string" ? rawCursorCliBinaryPath.trim() || undefined : undefined;
        useGrokCli = (globalSettings as Record<string, unknown>).useGrokCli === true;
        /*
        FNXC:GrokCli 2026-07-08-00:20:
        FN-7705: mirror the cursorCliBinaryPath override handling above so a
        machine-local grokCliBinaryPath override applies to model-picker
        discovery, not just the auth/probe/status paths.
        */
        const rawGrokCliBinaryPath = (globalSettings as Record<string, unknown>).grokCliBinaryPath;
        grokCliBinaryPath =
          typeof rawGrokCliBinaryPath === "string" ? rawGrokCliBinaryPath.trim() || undefined : undefined;
        /*
        FNXC:OmpAcp 2026-07-13-22:50:
        useOmpCli toggle + ompCliBinaryPath override for model-picker discovery (mirrors Grok).
        */
        useOmpCli = (globalSettings as Record<string, unknown>).useOmpCli === true;
        const rawOmpCliBinaryPath = (globalSettings as Record<string, unknown>).ompCliBinaryPath;
        ompCliBinaryPath =
          typeof rawOmpCliBinaryPath === "string" ? rawOmpCliBinaryPath.trim() || undefined : undefined;
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
      await options.modelRegistry.refresh();
      if (options.modelRegistry.registerProvider) {
        mergeSupplementalAnthropicModels(options.modelRegistry as Parameters<typeof mergeSupplementalAnthropicModels>[0], (message) => runtimeLogger.child("models").warn(message));
        /*
         * FNXC:ModelCatalog 2026-07-09-12:30:
         * FN-7745: additively merge the GPT-5.6 codenamed OpenAI Codex variants
         * (gpt-5.6-luna/sol/terra), mirroring the mergeSupplementalAnthropicModels call
         * above. Strictly additive/dedupe-safe — an existing pinned-catalog row for any
         * of the three ids always wins, no row is displaced or duplicated.
         */
        mergeSupplementalOpenAiCodexModels(options.modelRegistry as unknown as Parameters<typeof mergeSupplementalOpenAiCodexModels>[0], (message) => runtimeLogger.child("models").warn(message));
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
      if (!useGrokCli) {
        models = models.filter((m) => m.provider !== "grok-cli");
      }
      if (!useOmpCli) {
        models = models.filter((m) => m.provider !== "omp-cli");
      }

      /*
      FNXC:ModelCatalog 2026-07-07-09:05:
      FN-7636 (deferred item 1 of FN-7630/GitHub #1931): additively surface
      Hermes-configured models (`hermes profile list`) under the stable
      "hermes" provider id so picker selections route to the Hermes runtime
      (HERMES_RUNTIME_ID). Fetched through getHermesPickerModels, which is
      backed by a short-TTL, single-flight cache — this call NEVER spawns the
      `hermes` CLI per request, and NEVER throws (a missing/failed binary
      degrades to []). Hermes rows are merged respecting the existing
      seenModelKeys provider/id dedup so an existing row always wins over a
      colliding Hermes row — this is purely additive and must never displace,
      overwrite, or filter out an existing row.
      */
      const hermesModels = await getHermesPickerModels();
      // Track "configured" by profile presence, not by how many rows survived
      // the seenModelKeys dedup: even when every Hermes-derived id collides
      // with an already-present row (existing row wins, see FN-7636 Surface
      // Enumeration), the user still has Hermes profiles configured, so the
      // "hermes" provider must remain selectable below.
      const hermesRowsAdded = hermesModels.length > 0;
      for (const hermesModel of hermesModels) {
        const key = `${hermesModel.provider}/${hermesModel.id}`;
        if (seenModelKeys.has(key)) continue;
        seenModelKeys.add(key);
        models.push(hermesModel);
      }

      /*
      FNXC:ModelCatalog 2026-07-08-00:05:
      FN-7696: additively surface Cursor CLI-discovered models
      (`cursor-agent models --json`, with text/`model list` fallbacks) under
      the stable "cursor-cli" provider id, mirroring the FN-7636 Hermes merge
      above. Unlike Hermes (whose profile presence IS the enable signal),
      Cursor has its own settings toggle (useCursorCli) — the toggle IS the
      signal here, so discovery is only attempted when useCursorCli is true.
      Fetched through getCursorPickerModels, backed by a short-TTL,
      single-flight cache keyed by binary path — this call NEVER spawns
      cursor-agent per request, and NEVER throws (a missing/failed/
      unavailable binary degrades to []). Cursor rows are merged respecting
      the existing seenModelKeys provider/id dedup so an existing row always
      wins over a colliding Cursor row — purely additive, must never
      displace, overwrite, or filter out an existing row.

      FNXC:CursorCli 2026-07-08-00:20:
      FN-7699: thread the normalized cursorCliBinaryPath operator override
      (see the globalSettings read block above) into getCursorPickerModels so
      discovery spawns the exact same machine-local cursor-agent executable
      already validated by the auth/probe/status paths. Blank/undefined
      preserves PATH auto-detection unchanged; the cache is keyed per
      resolved binary path so the override participates correctly in
      TTL/single-flight caching.
      */
      if (useCursorCli) {
        // getCursorPickerModels never throws by contract (see
        // cursor-model-cache.ts), but this try/catch is a defensive belt so
        // a Cursor discovery failure can never reject the /models handler or
        // drop existing rows — degrade to zero Cursor rows instead.
        try {
          const cursorModels = await getCursorPickerModels({ binaryPath: cursorCliBinaryPath });
          for (const cursorModel of cursorModels) {
            const key = `${cursorModel.provider}/${cursorModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(cursorModel);
          }
        } catch (cursorErr: unknown) {
          const message = cursorErr instanceof Error ? cursorErr.message : String(cursorErr);
          runtimeLogger.child("models").warn(`Failed to load cursor-cli models: ${message}`);
        }
      }

      /*
      FNXC:GrokCli 2026-07-08-00:05:
      FN-7705: additively surface Grok CLI-discovered models (`grok models`)
      under the stable "grok-cli" provider id, mirroring the cursor-cli merge
      above. Grok has its own settings toggle (useGrokCli) — the toggle IS the
      signal here, so discovery is only attempted when useGrokCli is true.
      Fetched through getGrokPickerModels, backed by a short-TTL, single-flight
      cache keyed by binary path — this call NEVER spawns grok per request, and
      NEVER throws (a missing/failed/unavailable binary degrades to []). Grok
      rows are merged respecting the existing seenModelKeys provider/id dedup
      so an existing row always wins over a colliding Grok row — purely
      additive, must never displace, overwrite, or filter out an existing row.
      */
      if (useGrokCli) {
        // getGrokPickerModels never throws by contract (see
        // grok-model-cache.ts), but this try/catch is a defensive belt so a
        // Grok discovery failure can never reject the /models handler or drop
        // existing rows — degrade to zero Grok rows instead.
        try {
          const grokModels = await getGrokPickerModels({ binaryPath: grokCliBinaryPath });
          for (const grokModel of grokModels) {
            const key = `${grokModel.provider}/${grokModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(grokModel);
          }
        } catch (grokErr: unknown) {
          const message = grokErr instanceof Error ? grokErr.message : String(grokErr);
          runtimeLogger.child("models").warn(`Failed to load grok-cli models: ${message}`);
        }
      }

      /*
      FNXC:OmpAcp 2026-07-13-22:50:
      Surface omp models under omp-cli when useOmpCli is on (additive; never displace existing rows).
      */
      if (useOmpCli) {
        try {
          const ompModels = await getOmpPickerModels({ binaryPath: ompCliBinaryPath });
          for (const ompModel of ompModels) {
            const key = `${ompModel.provider}/${ompModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(ompModel);
          }
        } catch (ompErr: unknown) {
          const message = ompErr instanceof Error ? ompErr.message : String(ompErr);
          runtimeLogger.child("models").warn(`Failed to load omp-cli models: ${message}`);
        }
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
      // FNXC:ModelCatalog 2026-07-08-00:05 (FN-7696): allow-list "cursor-cli"
      // through the final filter whenever the toggle is on — independent of
      // any auth.json/models.json cursor-cli entry and independent of
      // whether discovery actually contributed rows (mirrors
      // useClaudeCli/useDroidCli/useLlamaCpp exactly; unlike hermesRowsAdded,
      // Cursor's own toggle IS the signal, not row presence). This closes the
      // previously-missing configuredProviders.add("cursor-cli") gap that
      // silently dropped Cursor rows even when the plugin surfaced them.
      if (useCursorCli) configuredProviders.add(CURSOR_PICKER_PROVIDER_ID);
      // FNXC:GrokCli 2026-07-08-00:05 (FN-7705): allow-list "grok-cli" through
      // the final filter whenever the toggle is on, mirroring cursor-cli above.
      if (useGrokCli) configuredProviders.add(GROK_PICKER_PROVIDER_ID);
      // FNXC:OmpAcp 2026-07-13-22:50: allow-list omp-cli when toggle is on.
      if (useOmpCli) configuredProviders.add(OMP_PICKER_PROVIDER_ID);
      // FNXC:ModelCatalog 2026-07-07-09:05 (FN-7636): only allow-list "hermes"
      // through the final filter when Hermes rows were actually contributed
      // above, mirroring the useClaudeCli/useDroidCli toggle pattern (Hermes
      // has no separate settings toggle — profile presence IS the signal).
      if (hermesRowsAdded) configuredProviders.add(HERMES_PICKER_PROVIDER_ID);
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
