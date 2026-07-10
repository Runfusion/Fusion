/*
FNXC:ProviderRegistration 2026-07-07-00:00:
FN-7622: the Electron desktop app's in-process dashboard server (packages/desktop/src/local-runtime.ts,
local-server.ts) constructed a raw authStorage/modelRegistry and skipped the built-in provider seeding,
the API-key-provider auth wrapping, and custom-provider registration that the CLI `serve`/`dashboard`/
`daemon` commands perform — so desktop's /api/providers and /api/models returned a truncated catalog
(missing built-in API-key providers like zai/openrouter/kimi-coding and any user customProviders[])
compared to the identical config rendered by the web build. This module is the SINGLE shared helper
both the CLI paths and the desktop paths call so that sequence can never drift apart again: it
mirrors the CLI's exact order — registerBuiltInZaiProvider -> wrapAuthStorageWithApiKeyProviders ->
mergeBuiltInZaiProviderModels -> modelRegistry.refresh() -> registerCustomProviders(customProviders)
-> subscribe settings:updated -> reregisterCustomProviders — and returns the wrapped
DashboardAuthStorage callers MUST pass to `createServer(...)` (not the raw authStorage) plus a
disposer to unsubscribe the settings listener on shutdown.
*/
import {
  mergeBuiltInGrokProviderModels,
  mergeBuiltInZaiProviderModels,
  registerBuiltInGrokProvider,
  registerBuiltInZaiProvider,
  type CustomProvider,
  type TaskStore,
} from "@fusion/core";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  wrapAuthStorageWithApiKeyProviders,
  type DashboardAuthStorage,
} from "./provider-auth.js";
import { registerCustomProviders, reregisterCustomProviders } from "./custom-provider-registry.js";

export interface SeedDashboardProvidersStore {
  getGlobalSettingsStore(): {
    getSettings(): Promise<{ customProviders?: CustomProvider[] }>;
  };
  on: TaskStore["on"];
  off: TaskStore["off"];
}

export interface SeedDashboardProvidersOptions {
  /** The task store used to read `globalSettings.customProviders` and subscribe to `settings:updated`. */
  store: SeedDashboardProvidersStore;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** Optional structured logger; defaults to a no-op so callers can opt into console/trace logging. */
  log?: (scope: string, message: string) => void;
}

export interface SeedDashboardProvidersResult {
  /** The wrapped auth storage — pass this (NOT the raw authStorage) to `createServer(...)`. */
  authStorage: DashboardAuthStorage;
  /** Unsubscribes the `settings:updated` -> reregisterCustomProviders listener. Call on shutdown. */
  dispose: () => void;
}

/**
 * Performs the full provider-registration sequence the CLI `serve`/`dashboard`/`daemon` commands run
 * at startup, so any host (CLI or desktop in-process server) that calls this gets an identical
 * provider/model catalog. See the FNXC:ProviderRegistration header above for the FN-7622 motivation.
 */
export async function seedDashboardProviders(
  options: SeedDashboardProvidersOptions,
): Promise<SeedDashboardProvidersResult> {
  const { store, authStorage, modelRegistry } = options;
  const log = options.log ?? (() => {});

  registerBuiltInZaiProvider(modelRegistry, (message) => log("extensions", message));
  registerBuiltInGrokProvider(modelRegistry, (message) => log("extensions", message));
  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

  mergeBuiltInZaiProviderModels(modelRegistry, (message) => log("extensions", message));
  mergeBuiltInGrokProviderModels(modelRegistry, (message) => log("extensions", message));
  modelRegistry.refresh();

  try {
    const globalSettings = await store.getGlobalSettingsStore().getSettings();
    registerCustomProviders(
      modelRegistry,
      globalSettings.customProviders,
      (message) => log("custom-providers", message),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("custom-providers", `Failed to load custom providers from global settings: ${message}`);
  }

  const onSettingsUpdated = (data: { settings: { customProviders?: CustomProvider[] }; previous: { customProviders?: CustomProvider[] } }) => {
    const currentProviders = data.settings.customProviders;
    const previousProviders = data.previous.customProviders;
    if (JSON.stringify(currentProviders ?? []) === JSON.stringify(previousProviders ?? [])) {
      return;
    }

    reregisterCustomProviders(
      modelRegistry,
      previousProviders,
      currentProviders,
      (message) => log("custom-providers", message),
    );
  };

  store.on("settings:updated", onSettingsUpdated);

  return {
    authStorage: dashboardAuthStorage,
    dispose: () => {
      store.off("settings:updated", onSettingsUpdated);
    },
  };
}
