import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  choosePreferredStoredCredential,
  getClaudeCodeCredentialPaths,
  getCodexCliAuthPath,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
  type StoredAuthCredential,
} from "@fusion/core";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

type StoredCredential = StoredAuthCredential;

const OAUTH_REFRESH_BUFFER_MS = 60_000;
const ANTHROPIC_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_DEFAULT_SCOPES = ["user:profile"];
const OAUTH_REFRESH_TIMEOUT_MS = 10_000;
const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 30_000;

type OAuthTokenResponse = {
  access_token?: unknown;
  accessToken?: unknown;
  refresh_token?: unknown;
  refreshToken?: unknown;
  expires_in?: unknown;
  expiresIn?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
  scope?: unknown;
  scopes?: unknown;
};

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function getFusionAuthPath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "auth.json");
}

export function getFusionOAuthAlertStatePath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "oauth-alert-state.json");
}

export function getFusionModelsPath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "models.json");
}

function getLegacyAuthPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];
}

function getSupplementalAuthPaths(home = getHomeDir()): string[] {
  return [
    ...getLegacyAuthPaths(home),
    getCodexCliAuthPath(home),
    ...getClaudeCodeCredentialPaths(home),
  ];
}

function getLegacyModelsPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".pi", "agent", "models.json"),
    join(home, ".pi", "models.json"),
  ];
}

export function getModelRegistryModelsPath(home = getHomeDir()): string {
  const fusionModelsPath = getFusionModelsPath(home);
  if (existsSync(fusionModelsPath)) {
    return fusionModelsPath;
  }

  return getLegacyModelsPaths(home).find((modelsPath) => existsSync(modelsPath)) ?? fusionModelsPath;
}

function readSupplementalCredentials(authPaths = getSupplementalAuthPaths()): Record<string, StoredCredential> {
  const credentials: Record<string, StoredCredential> = {};

  for (const authPath of authPaths) {
    const parsed = readStoredCredentialsFromAuthFile(authPath);
    for (const [provider, credential] of Object.entries(parsed)) {
      credentials[provider] = choosePreferredStoredCredential(credentials[provider], credential) ?? credential;
    }
  }

  return credentials;
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

function shouldRefreshOAuthCredential(credential: StoredCredential): boolean {
  return credential.type === "oauth"
    && typeof credential.refresh === "string"
    && credential.refresh.length > 0
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires)
    && Date.now() >= credential.expires - OAUTH_REFRESH_BUFFER_MS;
}

function isSameOAuthCredentialIdentity(
  left: StoredCredential | undefined,
  right: StoredCredential,
): boolean {
  return left?.type === "oauth"
    && right.type === "oauth"
    && left.access === right.access
    && left.refresh === right.refresh
    && left.expires === right.expires;
}

function getOAuthScopes(credential: StoredCredential): string[] {
  const scopes = Array.isArray(credential.scopes)
    ? credential.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
    : [];
  return scopes.length > 0 ? scopes : ANTHROPIC_DEFAULT_SCOPES;
}

function parseExpiryMs(data: OAuthTokenResponse, now: number): number {
  const expiresAt = data.expires_at ?? data.expiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return expiresAt;
  }
  if (typeof expiresAt === "string") {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const expiresIn = data.expires_in ?? data.expiresIn;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + expiresIn * 1000;
  }

  return now + 3_600_000;
}

function parseScopes(data: OAuthTokenResponse, fallback: string[]): string[] {
  if (Array.isArray(data.scopes)) {
    const scopes = data.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
    if (scopes.length > 0) {
      return scopes;
    }
  }
  if (typeof data.scope === "string") {
    const scopes = data.scope.split(/\s+/).filter(Boolean);
    if (scopes.length > 0) {
      return scopes;
    }
  }
  return fallback;
}

async function refreshAnthropicOAuthCredential(credential: StoredCredential): Promise<StoredCredential | undefined> {
  const refresh = credential.refresh;
  if (!refresh) {
    return undefined;
  }

  const scopes = getOAuthScopes(credential);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_REFRESH_TIMEOUT_MS);

  try {
    /*
    FNXC:ClaudeOAuth 2026-06-13-22:46:
    Fusion must renew expired Claude OAuth credentials with the stored refresh token so users are not forced through repeated manual Claude re-login when the access token expires.
    Persist the rotated access token in Fusion auth storage because model execution and dashboard usage resolve credentials through different runtime paths.
    */
    const response = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-code-fusion-dashboard",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        scope: scopes.join(" "),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return undefined;
    }

    const data = await response.json() as OAuthTokenResponse;
    const access = typeof data.access_token === "string"
      ? data.access_token
      : typeof data.accessToken === "string"
        ? data.accessToken
        : undefined;
    if (!access) {
      return undefined;
    }

    const now = Date.now();
    const nextRefresh = typeof data.refresh_token === "string"
      ? data.refresh_token
      : typeof data.refreshToken === "string"
        ? data.refreshToken
        : refresh;

    return {
      ...credential,
      type: "oauth",
      access,
      refresh: nextRefresh,
      expires: parseExpiryMs(data, now),
      scopes: parseScopes(data, scopes),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshOAuthCredential(providerId: string, credential: StoredCredential): Promise<StoredCredential | undefined> {
  if (!shouldRefreshOAuthCredential(credential)) {
    return credential;
  }
  if (providerId !== "anthropic") {
    return undefined;
  }
  return refreshAnthropicOAuthCredential(credential);
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

/**
 * Reads API keys from the resolved models.json file.
 *
 * Some providers (e.g., kimi-coding, lmstudio, ollama) store their API keys
 * in `models.json` under `providers.<providerId>.apiKey` rather than in
 * `auth.json`. This function extracts those keys so the auth storage proxy
 * can return them as a fallback when neither Fusion auth nor legacy auth.json
 * contains a key for the provider.
 */
function readModelsJsonApiKeys(home = getHomeDir()): Map<string, string> {
  const apiKeys = new Map<string, string>();
  const modelsPath = getModelRegistryModelsPath(home);

  if (!existsSync(modelsPath)) {
    return apiKeys;
  }

  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const providers = parsed?.providers;
    if (providers) {
      for (const [providerId, config] of Object.entries(providers)) {
        if (config.apiKey) {
          apiKeys.set(providerId, config.apiKey);
        }
      }
    }
  } catch {
    // Ignore invalid models.json files.
  }

  return apiKeys;
}

export function createFusionAuthStorage(): AuthStorage {
  const primary = AuthStorage.create(getFusionAuthPath());
  let supplementalCredentials = readSupplementalCredentials();
  // models.json provider API keys — final fallback after primary auth and supplemental auth.json files
  let modelsJsonApiKeys = readModelsJsonApiKeys();
  /*
  FNXC:ClaudeOAuth 2026-06-13-22:46:
  Dashboard auth-status polling can run while model execution also resolves credentials, so expired Claude credentials need one refresh attempt per provider at a time.
  Cache an in-flight refresh and briefly cool down failed attempts so repeated polls do not stampede the Anthropic token endpoint.
  */
  const oauthRefreshInFlight = new Map<string, Promise<StoredCredential | undefined>>();
  const oauthRefreshCooldownUntil = new Map<string, number>();

  // Providers the user has explicitly logged out from. These should not be
  // "resurrected" from supplemental credential files (e.g. ~/.claude/.credentials.json).
  // Cleared when the user re-authenticates via set().
  const loggedOutProviders = new Set<string>();

  const syncSupplementalOauthCredentials = () => {
    for (const [provider, credential] of Object.entries(supplementalCredentials)) {
      if (loggedOutProviders.has(provider)) {
        continue;
      }
      const current = primary.get(provider) as StoredCredential | undefined;
      if (!shouldHydrateStoredCredential(current, credential)) {
        continue;
      }
      if (credential.type === "oauth") {
        if (typeof credential.expires !== "number" || Date.now() >= credential.expires) {
          continue;
        }
        primary.set(provider, credential as AuthCredential);
        continue;
      }
      if (credential.type === "api_key") {
        primary.set(provider, credential as AuthCredential);
      }
    }
  };

  const refreshProviderOAuthCredential = async (
    provider: string,
    credential: StoredCredential,
  ): Promise<StoredCredential | undefined> => {
    if (!shouldRefreshOAuthCredential(credential)) {
      return credential;
    }

    const now = Date.now();
    const cooldownUntil = oauthRefreshCooldownUntil.get(provider);
    if (cooldownUntil && cooldownUntil > now) {
      return undefined;
    }

    const existing = oauthRefreshInFlight.get(provider);
    if (existing) {
      return existing;
    }

    const refreshPromise = refreshOAuthCredential(provider, credential)
      .then((refreshed) => {
        if (refreshed) {
          oauthRefreshCooldownUntil.delete(provider);
        } else {
          oauthRefreshCooldownUntil.set(provider, Date.now() + OAUTH_REFRESH_FAILURE_COOLDOWN_MS);
        }
        return refreshed;
      })
      .catch(() => {
        oauthRefreshCooldownUntil.set(provider, Date.now() + OAUTH_REFRESH_FAILURE_COOLDOWN_MS);
        return undefined;
      })
      .finally(() => {
        oauthRefreshInFlight.delete(provider);
      });

    oauthRefreshInFlight.set(provider, refreshPromise);
    return refreshPromise;
  };

  syncSupplementalOauthCredentials();

  return new Proxy(primary, {
    // Forward property writes to the target so that methods like
    // `setFallbackResolver` (called by ModelRegistry) correctly update the
    // underlying AuthStorage. Without this trap, writes land on the Proxy
    // object itself and the target's fallbackResolver stays undefined.
    set(target: AuthStorage, prop: string | symbol, value: unknown) {
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },

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
          oauthRefreshCooldownUntil.delete(provider);
        };
      }

      if (prop === "reload") {
        return () => {
          target.reload();
          supplementalCredentials = readSupplementalCredentials();
          syncSupplementalOauthCredentials();
          modelsJsonApiKeys = readModelsJsonApiKeys();
        };
      }

      if (prop === "get") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return undefined;
          }
          return choosePreferredStoredCredential(
            target.get(provider) as StoredCredential | undefined,
            supplementalCredentials[provider],
          );
        };
      }

      if (prop === "has") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          return target.has(provider) || provider in supplementalCredentials || modelsJsonApiKeys.has(provider);
        };
      }

      if (prop === "hasAuth") {
        return (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          return target.hasAuth(provider) || Boolean(supplementalCredentials[provider]) || modelsJsonApiKeys.has(provider);
        };
      }

      if (prop === "getAll") {
        return () => {
          const providerIds = new Set([
            ...Object.keys(target.getAll() as Record<string, StoredCredential>),
            ...(loggedOutProviders.size > 0
              ? Object.keys(supplementalCredentials).filter((p) => !loggedOutProviders.has(p))
              : Object.keys(supplementalCredentials)),
          ]);
          const merged: Record<string, StoredCredential> = {};
          for (const providerId of providerIds) {
            if (loggedOutProviders.has(providerId)) {
              continue;
            }
            const credential = choosePreferredStoredCredential(
              (target.get(providerId) as StoredCredential | undefined),
              supplementalCredentials[providerId],
            );
            if (credential) {
              merged[providerId] = credential;
            }
          }
          return merged;
        };
      }

      if (prop === "list") {
        return () => {
          const providers = new Set([...target.list()]);
          for (const p of modelsJsonApiKeys.keys()) {
            if (!loggedOutProviders.has(p)) {
              providers.add(p);
            }
          }
          for (const p of Object.keys(supplementalCredentials)) {
            if (!loggedOutProviders.has(p)) {
              providers.add(p);
            }
          }
          return Array.from(providers).filter((p) => !loggedOutProviders.has(p));
        };
      }

      if (prop === "getApiKey") {
        return async (provider: string) => {
          if (loggedOutProviders.has(provider)) {
            return undefined;
          }

          // 1. Primary Fusion auth
          const primaryKey = await target.getApiKey(provider);
          if (primaryKey) return primaryKey;

          // 2. Supplemental auth.json credentials (.pi + .codex)
          const refreshCandidate = choosePreferredStoredCredential(
            target.get(provider) as StoredCredential | undefined,
            supplementalCredentials[provider],
          ) ?? {};
          const refreshWasNeeded = shouldRefreshOAuthCredential(refreshCandidate);
          const refreshedCredential = await refreshProviderOAuthCredential(provider, refreshCandidate);
          if (refreshedCredential?.type === "oauth" && refreshedCredential.access) {
            if (refreshWasNeeded) {
              /*
              FNXC:ClaudeOAuth 2026-06-13-22:46:
              A manual re-login or replacement credential must win over an older in-flight refresh response.
              Re-check the credential identity before persisting so a delayed refresh cannot restore stale OAuth material after the user already fixed auth.
              */
              const latestCredential = choosePreferredStoredCredential(
                target.get(provider) as StoredCredential | undefined,
                supplementalCredentials[provider],
              );
              if (!isSameOAuthCredentialIdentity(latestCredential, refreshCandidate)) {
                return resolveStoredCredentialApiKey(provider, latestCredential);
              }
            }
            target.set(provider, refreshedCredential as AuthCredential);
            loggedOutProviders.delete(provider);
            return resolveStoredCredentialApiKey(provider, refreshedCredential);
          }

          const supplementalKey = resolveStoredCredentialApiKey(provider, supplementalCredentials[provider]);
          if (supplementalKey) return supplementalKey;

          // 3. models.json provider API keys (e.g., kimi-coding, lmstudio)
          return modelsJsonApiKeys.get(provider);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}
