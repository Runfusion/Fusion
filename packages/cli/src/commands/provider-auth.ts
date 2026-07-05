import type {
  AuthStorage,
  ModelRegistry,
  AuthCredential,
} from "@earendil-works/pi-coding-agent";
import {
  choosePreferredStoredCredential,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
  type StoredAuthCredential,
} from "@fusion/core";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

export type LoginCallbacks = Parameters<AuthStorage["login"]>[1] & {
  onManualCodeInput?: () => Promise<string>;
};

export interface DashboardAuthStorage {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(providerId: string, callbacks: LoginCallbacks): Promise<void>;
  logout(provider: string): void;
  getApiKeyProviders(): Array<{ id: string; name: string }>;
  setApiKey(providerId: string, apiKey: string): void;
  clearApiKey(providerId: string): void;
  hasApiKey(providerId: string): boolean;
  getApiKey(providerId: string): Promise<string | undefined>;
  get(providerId: string): { type?: string; key?: string } | undefined;
}

interface ReadFallbackAuthStorage {
  reload(): void;
  hasAuth(provider: string): boolean;
  getApiKey(providerId: string): Promise<string | undefined>;
  get(providerId: string): StoredCredential | undefined;
  getAll(): Record<string, StoredCredential>;
  list(): string[];
}

type StoredCredential = StoredAuthCredential;

const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";
const ANTHROPIC_STORAGE_PROVIDER_ID = "anthropic";
const ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID = "anthropic-subscription";

const BUILT_IN_API_KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: ANTHROPIC_API_KEY_PROVIDER_ID, name: "Anthropic API Key" },
  { id: "brave", name: "Brave Search" },
  { id: "kimi-coding", name: "Kimi" },
  { id: "minimax", name: "Minimax" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "opencode-go", name: "Opencode (Go)" },
  { id: "tavily", name: "Tavily" },
  { id: "zai", name: "Zai" },
];

const CLI_PROVIDER_IDS = new Set(["pi-claude-cli", "droid-cli"]);

function toApiKeyStorageProviderId(providerId: string): string {
  return providerId === ANTHROPIC_API_KEY_PROVIDER_ID ? ANTHROPIC_STORAGE_PROVIDER_ID : providerId;
}

function getProviderDisplayName(providerId: string): string {
  const knownProviderNames = new Map(
    BUILT_IN_API_KEY_PROVIDERS.map((provider) => [provider.id, provider.name]),
  );

  const knownName = knownProviderNames.get(providerId);
  if (knownName) return knownName;

  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function wrapAuthStorageWithApiKeyProviders(
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  readFallbackAuthStorages: ReadFallbackAuthStorage[] = [],
): DashboardAuthStorage {
  const mergedAuthStorage = mergeAuthStorageReads(authStorage, readFallbackAuthStorages);

  const getAnthropicSubscriptionCredential = () => {
    const syntheticCredential = mergedAuthStorage.get(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID);
    if (syntheticCredential) return syntheticCredential;
    const legacyCredential = mergedAuthStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID);
    return legacyCredential?.type === "oauth" ? legacyCredential : undefined;
  };

  const migrateStoredAnthropicSubscriptionCredential = () => {
    const existingSubscription = authStorage.get(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) as StoredCredential | undefined;
    if (existingSubscription?.type === "oauth") {
      return existingSubscription;
    }

    const legacySubscription = authStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID) as StoredCredential | undefined;
    if (legacySubscription?.type !== "oauth") {
      return undefined;
    }

    /*
    FNXC:ProviderAuth 2026-06-29-23:58:
    Saving or clearing the separated `anthropic-api-key` provider overwrites the raw `anthropic` storage slot used by model execution.
    Read the primary auth storage directly and migrate legacy subscription OAuth from `anthropic` to `anthropic-subscription` before that write, because merged Anthropic reads intentionally expose `anthropic` as API-key-only.
    */
    mergedAuthStorage.set(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID, legacySubscription as AuthCredential);
    return legacySubscription;
  };

  return {
    reload: () => mergedAuthStorage.reload(),
    getOAuthProviders: () =>
      mergedAuthStorage
        .getOAuthProviders()
        .map((provider) => provider.id === ANTHROPIC_STORAGE_PROVIDER_ID
          ? ({ id: ANTHROPIC_STORAGE_PROVIDER_ID, name: "Anthropic Subscription" })
          : ({ id: provider.id, name: provider.name })),
    hasAuth: (provider) => provider === ANTHROPIC_STORAGE_PROVIDER_ID || provider === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID
      ? Boolean(getAnthropicSubscriptionCredential())
      : mergedAuthStorage.hasAuth(provider),
    login: async (providerId, callbacks) => {
      if (providerId !== ANTHROPIC_STORAGE_PROVIDER_ID && providerId !== ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
        await mergedAuthStorage.login(
          providerId as Parameters<AuthStorage["login"]>[0],
          callbacks as Parameters<AuthStorage["login"]>[1],
        );
        return;
      }

      const existingApiKey = mergedAuthStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID);
      await mergedAuthStorage.login(
        ANTHROPIC_STORAGE_PROVIDER_ID as Parameters<AuthStorage["login"]>[0],
        callbacks as Parameters<AuthStorage["login"]>[1],
      );
      const oauthCredential = authStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID) as StoredCredential | undefined;
      if (oauthCredential?.type === "oauth") {
        /*
        FNXC:ProviderAuth 2026-06-29-23:15:
        Anthropic subscription OAuth and raw Anthropic API-key auth must be separate UI providers: OAuth stays `anthropic`, while the UI/API key card uses `anthropic-api-key` and maps back to the `anthropic` model credential.
        Store subscription OAuth under an internal key after upstream login because the OAuth library writes through the same `anthropic` id used by model API-key execution.
        */
        mergedAuthStorage.set(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID, oauthCredential as AuthCredential);
        if (existingApiKey?.type === "api_key") {
          mergedAuthStorage.set(ANTHROPIC_STORAGE_PROVIDER_ID, existingApiKey as AuthCredential);
        } else {
          authStorage.remove(ANTHROPIC_STORAGE_PROVIDER_ID);
        }
      }
    },
    logout: (provider) => {
      if (provider !== ANTHROPIC_STORAGE_PROVIDER_ID && provider !== ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
        mergedAuthStorage.logout(provider);
        return;
      }
      mergedAuthStorage.logout(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID);
      /*
      FNXC:ProviderAuth 2026-06-29-23:59:
      Logging out Anthropic subscription auth must also remove pre-split OAuth credentials still stored under `anthropic`.
      Check primary storage directly because merged Anthropic reads expose `anthropic` as the model API-key credential only, so an OAuth credential would otherwise survive reload and reappear as `anthropic-subscription`.
      */
      const legacyAnthropicCredential = authStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID) as StoredCredential | undefined;
      if (legacyAnthropicCredential?.type === "oauth") {
        mergedAuthStorage.logout(ANTHROPIC_STORAGE_PROVIDER_ID);
      }
    },
    getApiKeyProviders: () => {
      const oauthProviderIds = new Set(
        mergedAuthStorage
          .getOAuthProviders()
          .map((provider) => provider.id),
      );
      const providers = new Map<string, string>();

      for (const provider of BUILT_IN_API_KEY_PROVIDERS) {
        /*
        FNXC:ProviderAuth 2026-06-29-23:32:
        Anthropic subscription OAuth and Anthropic API-key auth are separate UI providers: the API-key card is `anthropic-api-key`, but reads and writes the `anthropic` model credential through toApiKeyStorageProviderId().
        Keep OAuth-id exclusion only for registry-derived providers so OpenAI stays split as `openai-codex` OAuth plus `openai` API key, while unrelated OAuth providers are not reclassified.
        */
        providers.set(provider.id, provider.name);
      }

      for (const model of modelRegistry.getAll()) {
        const providerId = model.provider;
        if (
          !providerId ||
          oauthProviderIds.has(providerId) ||
          providers.has(providerId) ||
          CLI_PROVIDER_IDS.has(providerId)
        ) {
          continue;
        }
        providers.set(providerId, getProviderDisplayName(providerId));
      }

      return Array.from(providers, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    setApiKey: (providerId, apiKey) => {
      const storageProviderId = toApiKeyStorageProviderId(providerId);
      if (storageProviderId === ANTHROPIC_STORAGE_PROVIDER_ID) {
        migrateStoredAnthropicSubscriptionCredential();
      }
      mergedAuthStorage.set(storageProviderId, { type: "api_key", key: apiKey });
    },
    clearApiKey: (providerId) => {
      const storageProviderId = toApiKeyStorageProviderId(providerId);
      if (storageProviderId === ANTHROPIC_STORAGE_PROVIDER_ID) {
        migrateStoredAnthropicSubscriptionCredential();
      }
      mergedAuthStorage.remove(storageProviderId);
    },
    hasApiKey: (providerId) => {
      const credential = mergedAuthStorage.get(toApiKeyStorageProviderId(providerId));
      return credential?.type === "api_key" && !!credential.key;
    },
    getApiKey: async (providerId) => {
      const storageProviderId = toApiKeyStorageProviderId(providerId);
      if (storageProviderId === ANTHROPIC_STORAGE_PROVIDER_ID) {
        const credential = mergedAuthStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID);
        return credential?.type === "api_key" ? resolveStoredApiKey(credential.key) : undefined;
      }
      return mergedAuthStorage.getApiKey(storageProviderId);
    },
    get: (providerId) => {
      if (providerId === ANTHROPIC_API_KEY_PROVIDER_ID) {
        const credential = mergedAuthStorage.get(ANTHROPIC_STORAGE_PROVIDER_ID);
        return credential?.type === "api_key" ? credential : undefined;
      }
      if (providerId === ANTHROPIC_STORAGE_PROVIDER_ID) {
        return getAnthropicSubscriptionCredential();
      }
      if (providerId === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
        return getAnthropicSubscriptionCredential();
      }
      return mergedAuthStorage.get(providerId);
    },
  };
}

export function mergeAuthStorageReads(
  authStorage: AuthStorage,
  readFallbackAuthStorages: ReadFallbackAuthStorage[] = [],
): AuthStorage {
  const readAuthStorages = [authStorage, ...readFallbackAuthStorages];

  // Providers the user has explicitly logged out from. These should not be
  // "resurrected" from supplemental credential files (e.g. ~/.claude/.credentials.json).
  // Cleared when the user re-authenticates via set().
  const loggedOutProviders = new Set<string>();

  const selectCredential = (
    providerId: string,
    storages: Array<Pick<ReadFallbackAuthStorage, "get">>,
  ): StoredCredential | undefined => {
    let best: StoredCredential | undefined;
    for (const storage of storages) {
      const credential = storage.get(providerId);
      if (providerId === ANTHROPIC_STORAGE_PROVIDER_ID) {
        if (credential?.type === "api_key") {
          best = choosePreferredStoredCredential(best, credential);
        }
        continue;
      }
      if (providerId === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
        if (credential?.type === "oauth") {
          best = choosePreferredStoredCredential(best, credential);
        }
        const legacyAnthropic = storage.get(ANTHROPIC_STORAGE_PROVIDER_ID);
        if (legacyAnthropic?.type === "oauth") {
          best = choosePreferredStoredCredential(best, legacyAnthropic);
        }
        continue;
      }
      best = choosePreferredStoredCredential(best, credential);
    }
    return best;
  };

  const getCredential = (providerId: string) => {
    if (loggedOutProviders.has(providerId)) {
      return undefined;
    }
    return selectCredential(providerId, readAuthStorages);
  };

  const syncFallbackOauthCredentials = () => {
    const providerIds = new Set(readFallbackAuthStorages.flatMap((storage) => storage.list()));
    for (const providerId of providerIds) {
      const storageProviderId = providerId === ANTHROPIC_STORAGE_PROVIDER_ID
        ? ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID
        : providerId;
      if (loggedOutProviders.has(providerId) || loggedOutProviders.has(storageProviderId)) {
        continue;
      }
      const current = authStorage.get(storageProviderId) as StoredCredential | undefined;
      const candidate = selectCredential(storageProviderId, readFallbackAuthStorages);
      if (!shouldHydrateStoredCredential(current, candidate)) {
        continue;
      }
      if (candidate && (candidate.type === "oauth" || candidate.type === "api_key")) {
        /*
        FNXC:ProviderAuth 2026-06-29-23:48:
        Legacy Anthropic OAuth files may still store subscription credentials under `anthropic`; hydrate those as `anthropic-subscription` so Anthropic model/API-key reads only trust `api_key` credentials under `anthropic`.
        */
        authStorage.set(storageProviderId, candidate as AuthCredential);
      }
    }
  };

  syncFallbackOauthCredentials();

  return new Proxy(authStorage, {
    get(target, prop, receiver) {
      if (prop === "logout") {
        return (provider: string) => {
          target.logout(provider);
          loggedOutProviders.add(provider);
        };
      }

      if (prop === "remove") {
        return (provider: string) => {
          target.remove(provider);
          loggedOutProviders.add(provider);
        };
      }

      if (prop === "set") {
        return (provider: string, credential: AuthCredential) => {
          target.set(provider, credential);
          loggedOutProviders.delete(provider);
        };
      }

      if (prop === "reload") {
        return () => {
          for (const storage of readAuthStorages) {
            storage.reload();
          }
          syncFallbackOauthCredentials();
        };
      }

      if (prop === "get") {
        return getCredential;
      }

      if (prop === "has") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          if (provider === ANTHROPIC_STORAGE_PROVIDER_ID || provider === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
            return Boolean(getCredential(provider));
          }
          return readAuthStorages.some((storage) => Boolean(storage.get(provider)));
        };
      }

      if (prop === "hasAuth") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          if (provider === ANTHROPIC_STORAGE_PROVIDER_ID || provider === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID) {
            return Boolean(getCredential(provider));
          }
          return readAuthStorages.some((storage) => storage.hasAuth(provider));
        };
      }

      if (prop === "getAll") {
        return () => {
          const providerIds = new Set(readAuthStorages.flatMap((storage) => storage.list()));
          if (providerIds.has(ANTHROPIC_STORAGE_PROVIDER_ID)) {
            providerIds.add(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID);
          }
          const merged: Record<string, StoredCredential> = {};
          for (const providerId of providerIds) {
            if (loggedOutProviders.has(providerId)) {
              continue;
            }
            const credential = getCredential(providerId);
            if (credential) {
              merged[providerId] = credential;
            }
          }
          return merged;
        };
      }

      if (prop === "list") {
        return () => {
          const providers = new Set(readAuthStorages.flatMap((storage) => storage.list()));
          if (providers.has(ANTHROPIC_STORAGE_PROVIDER_ID) && !loggedOutProviders.has(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID)) {
            providers.add(ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID);
          }
          return Array.from(providers).filter((p) => !loggedOutProviders.has(p) && getCredential(p));
        };
      }

      if (prop === "getApiKey") {
        return async (providerId: string) => {
          if (loggedOutProviders.has(providerId)) {
            return undefined;
          }
          const credential = getCredential(providerId);
          if (providerId === ANTHROPIC_STORAGE_PROVIDER_ID) {
            return credential?.type === "api_key" ? resolveStoredApiKey(credential.key) : undefined;
          }
          if (providerId === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID && credential) {
            /*
            FNXC:ProviderAuth 2026-07-05-09:10:
            Reading `anthropic-subscription` through this merge proxy must delegate to the underlying real engine `authStorage.getApiKey(...)` (the `target` primary storage) so the refresh-token HTTP round trip in packages/engine/src/auth-storage.ts actually runs. The prior local static `Date.now() >= credential.expires` check (`resolveStoredCredentialApiKey`/`resolveOAuthApiKey`) never called the real engine and silently no-oped the refresh in production, e.g. the dashboard status route's best-effort refresh-on-expiry read (register-auth-routes.ts). `target.getApiKey` internally handles both the separated `anthropic-subscription` row and the legacy `anthropic` OAuth row, so this single delegated call covers both storage permutations without duplicating that logic here. Only fall back to the read-only fallback storages' local (non-refreshing) resolution when the primary engine yields no key; a logged-out subscription is already excluded above and must never reach this delegated call.
            */
            const engineApiKey = await target.getApiKey(providerId);
            if (engineApiKey) return engineApiKey;
            for (const fallbackStorage of readFallbackAuthStorages) {
              const fallbackApiKey = await fallbackStorage.getApiKey(providerId);
              if (fallbackApiKey) return fallbackApiKey;
            }
            return undefined;
          }
          for (const storage of readAuthStorages) {
            const apiKey = await storage.getApiKey(providerId);
            if (apiKey) return apiKey;
          }
          return undefined;
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}

function resolveStoredApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return process.env[key] ?? key;
}

function resolveOAuthApiKey(providerId: string, credential: StoredCredential): string | undefined {
  if (
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    typeof credential.refresh !== "string" ||
    typeof credential.expires !== "number" ||
    Date.now() >= credential.expires
  ) {
    return undefined;
  }

  const oauthProviderId = providerId === ANTHROPIC_SUBSCRIPTION_STORAGE_PROVIDER_ID
    ? ANTHROPIC_STORAGE_PROVIDER_ID
    : providerId;
  return getOAuthProvider(oauthProviderId)?.getApiKey(credential as OAuthCredentials);
}

function resolveStoredCredentialApiKey(providerId: string, credential: StoredCredential | undefined): string | undefined {
  if (credential?.type === "api_key") {
    return resolveStoredApiKey(credential.key);
  }
  if (providerId === ANTHROPIC_STORAGE_PROVIDER_ID) {
    return undefined;
  }
  if (credential?.type === "oauth") {
    return resolveOAuthApiKey(providerId, credential);
  }
  return undefined;
}

export function createReadOnlyAuthFileStorage(authPaths: string[]): ReadFallbackAuthStorage {
  let credentials: Record<string, StoredCredential> = {};

  const reload = () => {
    const nextCredentials: Record<string, StoredCredential> = {};
    for (const authPath of authPaths) {
      const parsed = readStoredCredentialsFromAuthFile(authPath);
      for (const [provider, credential] of Object.entries(parsed)) {
        nextCredentials[provider] = choosePreferredStoredCredential(nextCredentials[provider], credential) ?? credential;
      }
    }
    credentials = nextCredentials;
  };

  reload();

  return {
    reload,
    hasAuth: (provider) => Boolean(credentials[provider]),
    get: (provider) => credentials[provider],
    getAll: () => ({ ...credentials }),
    list: () => Object.keys(credentials),
    getApiKey: async (provider) => {
      return resolveStoredCredentialApiKey(provider, credentials[provider]);
    },
  };
}
