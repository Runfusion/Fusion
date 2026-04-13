import type {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

export type LoginCallbacks = Parameters<AuthStorage["login"]>[1];

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

const BUILT_IN_API_KEY_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: "kimi-coding", name: "Kimi" },
  { id: "minimax", name: "Minimax" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "zai", name: "Zai" },
];

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
): DashboardAuthStorage {
  return {
    reload: () => authStorage.reload(),
    getOAuthProviders: () =>
      authStorage
        .getOAuthProviders()
        .map((provider) => ({ id: provider.id, name: provider.name })),
    hasAuth: (provider) => authStorage.hasAuth(provider),
    login: (providerId, callbacks) =>
      authStorage.login(providerId as Parameters<AuthStorage["login"]>[0], callbacks),
    logout: (provider) => authStorage.logout(provider),
    getApiKeyProviders: () => {
      const oauthProviderIds = new Set(
        authStorage.getOAuthProviders().map((provider) => provider.id),
      );
      const providers = new Map<string, string>();

      for (const provider of BUILT_IN_API_KEY_PROVIDERS) {
        if (!oauthProviderIds.has(provider.id)) {
          providers.set(provider.id, provider.name);
        }
      }

      for (const model of modelRegistry.getAll()) {
        const providerId = model.provider;
        if (!providerId || oauthProviderIds.has(providerId) || providers.has(providerId)) {
          continue;
        }
        providers.set(providerId, getProviderDisplayName(providerId));
      }

      return Array.from(providers, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    setApiKey: (providerId, apiKey) => {
      authStorage.set(providerId, { type: "api_key", key: apiKey });
    },
    clearApiKey: (providerId) => {
      authStorage.remove(providerId);
    },
    hasApiKey: (providerId) => {
      const credential = authStorage.get(providerId);
      return credential?.type === "api_key" || authStorage.hasAuth(providerId);
    },
    getApiKey: (providerId) => authStorage.getApiKey(providerId),
    get: (providerId) => authStorage.get(providerId),
  };
}
