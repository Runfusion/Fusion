import type {
  AuthStorage,
  ModelRegistry,
  AuthCredential,
} from "@mariozechner/pi-coding-agent";
import {
  choosePreferredStoredCredential,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
  type StoredAuthCredential,
} from "@fusion/core";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

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

const BUILT_IN_API_KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: "brave", name: "Brave Search" },
  { id: "kimi-coding", name: "Kimi" },
  { id: "minimax", name: "Minimax" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "opencode-go", name: "Opencode (Go)" },
  { id: "tavily", name: "Tavily" },
  { id: "zai", name: "Zai" },
];

const CLI_PROVIDER_IDS = new Set(["pi-claude-cli", "droid-cli"]);

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

  return {
    reload: () => mergedAuthStorage.reload(),
    getOAuthProviders: () =>
      mergedAuthStorage
        .getOAuthProviders()
        .map((provider) => ({ id: provider.id, name: provider.name })),
    hasAuth: (provider) => mergedAuthStorage.hasAuth(provider),
    login: (providerId, callbacks) =>
      mergedAuthStorage.login(
        providerId as Parameters<AuthStorage["login"]>[0],
        callbacks as Parameters<AuthStorage["login"]>[1],
      ),
    logout: (provider) => mergedAuthStorage.logout(provider),
    getApiKeyProviders: () => {
      const oauthProviderIds = new Set(
        mergedAuthStorage
          .getOAuthProviders()
          .map((provider) => provider.id),
      );
      const providers = new Map<string, string>();

      for (const provider of BUILT_IN_API_KEY_PROVIDERS) {
        if (!oauthProviderIds.has(provider.id)) {
          providers.set(provider.id, provider.name);
        }
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
      mergedAuthStorage.set(providerId, { type: "api_key", key: apiKey });
    },
    clearApiKey: (providerId) => {
      mergedAuthStorage.remove(providerId);
    },
    hasApiKey: (providerId) => {
      const credential = mergedAuthStorage.get(providerId);
      return credential?.type === "api_key" && !!credential.key;
    },
    getApiKey: (providerId) => mergedAuthStorage.getApiKey(providerId),
    get: (providerId) => mergedAuthStorage.get(providerId),
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
      best = choosePreferredStoredCredential(best, storage.get(providerId));
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
      if (loggedOutProviders.has(providerId)) {
        continue;
      }
      const current = authStorage.get(providerId) as StoredCredential | undefined;
      const candidate = selectCredential(providerId, readFallbackAuthStorages);
      if (!shouldHydrateStoredCredential(current, candidate)) {
        continue;
      }
      if (candidate && (candidate.type === "oauth" || candidate.type === "api_key")) {
        authStorage.set(providerId, candidate as AuthCredential);
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
          return readAuthStorages.some((storage) => Boolean(storage.get(provider)));
        };
      }

      if (prop === "hasAuth") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          return readAuthStorages.some((storage) => storage.hasAuth(provider));
        };
      }

      if (prop === "getAll") {
        return () => {
          const providerIds = new Set(readAuthStorages.flatMap((storage) => storage.list()));
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
          const providers = readAuthStorages.flatMap((storage) => storage.list());
          return Array.from(new Set(providers.filter((p) => !loggedOutProviders.has(p))));
        };
      }

      if (prop === "getApiKey") {
        return async (providerId: string) => {
          if (loggedOutProviders.has(providerId)) {
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

  return getOAuthProvider(providerId)?.getApiKey(credential as OAuthCredentials);
}

function resolveStoredCredentialApiKey(providerId: string, credential: StoredCredential | undefined): string | undefined {
  if (credential?.type === "api_key") {
    return resolveStoredApiKey(credential.key);
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
