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
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

type StoredCredential = StoredAuthCredential;

/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7646: the cross-process ~/.fusion/agent/auth.json coordination invariant (concurrent
writers merge per-provider instead of clobbering each other's credentials) depends on the
vendored @earendil-works/pi-coding-agent AuthStorage backend using proper-lockfile locking
plus a per-provider read-modify-merge (FileAuthStorageBackend.persistProviderChange /
refreshOAuthTokenWithLock re-read the file under a lock and spread
{...currentData, [provider]: credential} rather than flushing a whole-file in-memory
snapshot). packages/engine/package.json already floors this at
"@earendil-works/pi-coding-agent": "^0.80.3" (caret bounds it to >=0.80.3 <0.81.0, which is
where this locked per-provider merge landed) — do not downgrade below 0.80.x, and re-verify
this comment against dist/core/auth-storage.js if the range is ever widened. See
packages/engine/src/__tests__/auth-storage-concurrency.test.ts for the regression coverage.
*/

/*
FNXC:ClaudeOAuth 2026-07-05-00:00:
FN-7574: a 60s reactive refresh buffer meant a healthy Anthropic subscription token was
only ever refreshed a few seconds before (or after) it actually expired — too late to
reliably beat a slow/failed network round trip, so subscriptions routinely lapsed and
forced a manual re-login even though the refresh token was still valid. Widen the
proactive-refresh window to 5 minutes so both the reactive getApiKey() path AND the new
background OAuthRefreshScheduler (see notification/oauth-refresh-scheduler.ts) renew the
access token well ahead of expiry, without refreshing needlessly often (the scheduler
runs on a multi-minute interval, and the in-flight dedupe + failure cooldown below still
apply so a single stuck token doesn't get hammered).
*/
const OAUTH_REFRESH_BUFFER_MS = 5 * 60_000;
const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";
const OAUTH_REFRESH_FAILURE_COOLDOWN_MS = 30_000;

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

function getOAuthResolutionProviderId(providerId: string): string {
  return providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID ? ANTHROPIC_PROVIDER_ID : providerId;
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

  return getOAuthProvider(getOAuthResolutionProviderId(providerId))?.getApiKey(credential as OAuthCredentials);
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

async function refreshAnthropicOAuthCredential(credential: StoredCredential): Promise<StoredCredential | undefined> {
  if (credential.type !== "oauth" || !credential.refresh) {
    return undefined;
  }

  try {
    /*
    FNXC:ClaudeOAuth 2026-07-14-14:25:
    Refresh through pi-ai's registered Anthropic provider—the same implementation that performs login and owns the endpoint, client id, expiry buffer, and response contract. Fusion's duplicated HTTP implementation drifted, so expired subscription OAuth degraded into a misleading missing-API-key failure after restart or PostgreSQL migration. Preserve Fusion's recorded scopes because the provider refresh result intentionally contains only runtime token fields.
    */
    const provider = getOAuthProvider(ANTHROPIC_PROVIDER_ID);
    if (!provider?.refreshToken) return undefined;
    const refreshed = await provider.refreshToken(credential as OAuthCredentials);

    return {
      ...credential,
      ...refreshed,
      ...(credential.scopes ? { scopes: credential.scopes } : {}),
    };
  } catch {
    return undefined;
  }
}

async function refreshOAuthCredential(providerId: string, credential: StoredCredential): Promise<StoredCredential | undefined> {
  if (!shouldRefreshOAuthCredential(credential)) {
    return credential;
  }
  if (getOAuthResolutionProviderId(providerId) !== ANTHROPIC_PROVIDER_ID) {
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

/*
 * FNXC:ModelRegistry 2026-07-03-07:00:
 * Shared model-registry factory so non-CLI hosts (the desktop embedded runtime) can wire the
 * dashboard's models API without depending on @earendil-works/pi-coding-agent directly. Mirrors the
 * CLI's ModelRegistry.create(authStorage, getModelRegistryModelsPath()). Without a ModelRegistry the
 * /api/models endpoint returns an empty list, so the onboarding model picker shows "no models" even
 * when a provider (e.g. Anthropic) is connected.
 */
export function createFusionModelRegistry(authStorage: AuthStorage, home?: string): ModelRegistry {
  return ModelRegistry.create(authStorage, getModelRegistryModelsPath(home));
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

  /*
  FNXC:ProviderAuth 2026-07-05-00:00:
  Re-authenticating a provider must clear its in-memory logged-out suppression so the settings card flips back to connected.
  Anthropic subscription OAuth is aliased across the legacy `anthropic` row — where interactive login persists the credential — and the separated `anthropic-subscription` id, where the card's logged-out flag and status read are keyed. Because a re-login only writes `anthropic`, clearing just the written id left `anthropic-subscription` suppressed: a user who logged out of the subscription earlier in the same dashboard session saw every successful re-login reported as "Login did not complete. Please try again." until the process restarted (the credential was valid on disk the whole time). Clear BOTH aliases when either is re-authenticated. Only OAuth credentials alias this way; a raw `anthropic` API key stays scoped to its own card, so api_key writes never clear the subscription alias.
  */
  const clearReauthenticatedLogoutState = (
    provider: string,
    credentialType?: StoredCredential["type"],
  ) => {
    loggedOutProviders.delete(provider);
    oauthRefreshCooldownUntil.delete(provider);
    const isAnthropicAlias =
      provider === ANTHROPIC_PROVIDER_ID || provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID;
    const aliasesSubscriptionOAuth = credentialType === undefined || credentialType === "oauth";
    if (isAnthropicAlias && aliasesSubscriptionOAuth) {
      loggedOutProviders.delete(ANTHROPIC_PROVIDER_ID);
      loggedOutProviders.delete(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
    }
  };

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
    storageProvider: string,
    credential: StoredCredential,
  ): Promise<StoredCredential | undefined> => {
    if (!shouldRefreshOAuthCredential(credential)) {
      return credential;
    }

    const now = Date.now();
    const cooldownUntil = oauthRefreshCooldownUntil.get(storageProvider);
    if (cooldownUntil && cooldownUntil > now) {
      return undefined;
    }

    const existing = oauthRefreshInFlight.get(storageProvider);
    if (existing) {
      return existing;
    }

    const refreshPromise = refreshOAuthCredential(storageProvider, credential)
      .then((refreshed) => {
        if (refreshed) {
          oauthRefreshCooldownUntil.delete(storageProvider);
        } else {
          oauthRefreshCooldownUntil.set(storageProvider, Date.now() + OAUTH_REFRESH_FAILURE_COOLDOWN_MS);
        }
        return refreshed;
      })
      .catch(() => {
        oauthRefreshCooldownUntil.set(storageProvider, Date.now() + OAUTH_REFRESH_FAILURE_COOLDOWN_MS);
        return undefined;
      })
      .finally(() => {
        oauthRefreshInFlight.delete(storageProvider);
      });

    oauthRefreshInFlight.set(storageProvider, refreshPromise);
    return refreshPromise;
  };

  const selectStoredCredential = (provider: string) => choosePreferredStoredCredential(
    primary.get(provider) as StoredCredential | undefined,
    supplementalCredentials[provider],
  );

  const selectStoredCredentialByType = (
    provider: string,
    type: StoredCredential["type"],
  ) => choosePreferredStoredCredential(
    ((primary.get(provider) as StoredCredential | undefined)?.type === type
      ? primary.get(provider) as StoredCredential
      : undefined),
    supplementalCredentials[provider]?.type === type ? supplementalCredentials[provider] : undefined,
  );

  const isAnthropicSubscriptionLoggedOut = () => loggedOutProviders.has(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
  const isAnthropicRawProviderLoggedOut = () => loggedOutProviders.has(ANTHROPIC_PROVIDER_ID);

  const selectAnthropicSubscriptionCredential = (): { credential?: StoredCredential; sourceProvider?: string } => {
    if (isAnthropicSubscriptionLoggedOut()) {
      return {};
    }

    const separatedCredential = selectStoredCredential(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
    if (separatedCredential?.type === "oauth") {
      return { credential: separatedCredential, sourceProvider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID };
    }

    if (!isAnthropicRawProviderLoggedOut()) {
      const legacyCredential = selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "oauth");
      if (legacyCredential) {
        return { credential: legacyCredential, sourceProvider: ANTHROPIC_PROVIDER_ID };
      }
    }

    return {};
  };

  const hasVisibleAnthropicSubscriptionCredential = () => Boolean(selectAnthropicSubscriptionCredential().credential);

  const selectVisibleStoredCredential = (provider: string) => {
    if (loggedOutProviders.has(provider)) {
      return undefined;
    }
    if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
      return selectAnthropicSubscriptionCredential().credential;
    }
    if (provider === ANTHROPIC_PROVIDER_ID && isAnthropicSubscriptionLoggedOut()) {
      return selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "api_key");
    }
    return selectStoredCredential(provider);
  };

  const resolveTargetFallbackApiKey = (provider: string): string | undefined => {
    const fallbackResolver = (primary as unknown as {
      fallbackResolver?: (provider: string) => string | undefined;
    }).fallbackResolver;
    return fallbackResolver?.(provider);
  };

  const hasTargetFallbackAuth = (provider: string): boolean => Boolean(resolveTargetFallbackApiKey(provider));

  const hasVisibleAnthropicCredential = () => {
    const hasVisibleRawAnthropicApiKey = !isAnthropicRawProviderLoggedOut()
      && (Boolean(selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "api_key"))
        || modelsJsonApiKeys.has(ANTHROPIC_PROVIDER_ID));
    const hasVisibleLegacyAnthropicOAuth = !isAnthropicRawProviderLoggedOut()
      && Boolean(selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "oauth"));
    const hasVisibleSubscriptionCredential = hasVisibleAnthropicSubscriptionCredential();
    const hasVisibleAnthropicFallback = !isAnthropicRawProviderLoggedOut()
      && hasTargetFallbackAuth(ANTHROPIC_PROVIDER_ID);

    if (!isAnthropicSubscriptionLoggedOut()) {
      /*
      FNXC:ProviderAuth 2026-06-30-12:23:
      Logging out of the raw Anthropic API-key provider must suppress only the raw/legacy `anthropic` storage slot.
      Model-runtime reads for `anthropic` still need to see an independently logged-in `anthropic-subscription` credential from the separated subscription card.

      FNXC:ProviderAuth 2026-06-30-12:47:
      Anthropic's subscription alias is an extra runtime credential source, not a replacement for AuthStorage's existing fallback-resolver contract.
      Keep custom fallback auth visible after explicit raw/subscription credentials are checked so ModelRegistry provider request configs still work for `anthropic` like every other provider.
      */
      return hasVisibleRawAnthropicApiKey
        || hasVisibleLegacyAnthropicOAuth
        || hasVisibleSubscriptionCredential
        || hasVisibleAnthropicFallback;
    }

    /*
    FNXC:ProviderAuth 2026-06-30-12:05:
    Logging out of the Anthropic subscription must suppress legacy `anthropic` OAuth aliases from status/list reads as well as model-runtime resolution.
    Keep raw API-key credentials and models.json fallback visible so the separate API-key card is not hidden by subscription logout.
    */
    return hasVisibleRawAnthropicApiKey || hasVisibleAnthropicFallback;
  };

  const resolveRefreshableCredentialApiKey = async (
    storageProvider: string,
    credential: StoredCredential | undefined,
  ): Promise<string | undefined> => {
    if (!credential) {
      return undefined;
    }
    const refreshWasNeeded = shouldRefreshOAuthCredential(credential);
    const refreshedCredential = await refreshProviderOAuthCredential(storageProvider, credential);
    if (refreshedCredential?.type === "oauth" && refreshedCredential.access) {
      if (refreshWasNeeded) {
        /*
        FNXC:ClaudeOAuth 2026-06-13-22:46:
        A manual re-login or replacement credential must win over an older in-flight refresh response.
        Re-check the credential identity before persisting so a delayed refresh cannot restore stale OAuth material after the user already fixed auth.

        FNXC:ProviderAuth 2026-07-07-00:00:
        FN-7646: ~/.fusion/agent/auth.json is shared across independent Fusion processes on one
        machine (e.g. a CLI-served web app and the desktop app). The FileAuthStorageBackend already
        coordinates concurrent writers with a lock plus a per-provider read-modify-merge, so it never
        clobbers OTHER providers — but this process's own in-flight refresh must not overwrite a
        NEWER credential another process wrote for the SAME provider while this refresh was pending.
        Re-read from disk (primary.reload()) before comparing identity so `latestCredential` reflects
        what is actually on disk right now, not this process's possibly-stale in-memory snapshot from
        before the refresh started. Without this reload, a concurrent process's newer login/refresh for
        this exact provider could be silently overwritten by our older refreshed token.
        */
        primary.reload();
        const latestCredential = selectStoredCredential(storageProvider);
        if (!isSameOAuthCredentialIdentity(latestCredential, credential)) {
          return resolveStoredCredentialApiKey(storageProvider, latestCredential);
        }
      }
      primary.set(storageProvider, refreshedCredential as AuthCredential);
      loggedOutProviders.delete(storageProvider);
      return resolveStoredCredentialApiKey(storageProvider, refreshedCredential);
    }

    return resolveStoredCredentialApiKey(storageProvider, credential);
  };

  const resolveAnthropicRuntimeApiKey = async (): Promise<string | undefined> => {
    const rawProviderLoggedOut = isAnthropicRawProviderLoggedOut();

    /*
    FNXC:ProviderAuth 2026-07-01-14:55:
    Anthropic runtime auth (`getApiKey("anthropic")`) resolves in precedence order: (1) raw API key, (2) legacy `anthropic` OAuth, (3) separated `anthropic-subscription` OAuth, (4) models.json / ModelRegistry fallback raw key. Raw key wins so an explicit `ANTHROPIC_API_KEY` keeps using x-api-key; subscription/OAuth tokens must resolve here so the built-in provider runs them on `/v1` with Claude Code impersonation. Do NOT gate OAuth behind the CLI or reroute it to an `/v1` `anthropic-subscription` provider — that reintroduced the #1857 regression (FN-7391/FN-7396).
    */
    if (!rawProviderLoggedOut) {
      const anthropicApiKeyCredential = selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "api_key");
      if (anthropicApiKeyCredential) {
        return resolveStoredCredentialApiKey(ANTHROPIC_PROVIDER_ID, anthropicApiKeyCredential);
      }
    }

    const subscriptionLoggedOut = loggedOutProviders.has(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
    const legacyAnthropicOAuthCredential = rawProviderLoggedOut
      ? undefined
      : selectStoredCredentialByType(ANTHROPIC_PROVIDER_ID, "oauth");
    if (!subscriptionLoggedOut && legacyAnthropicOAuthCredential) {
      const legacyKey = await resolveRefreshableCredentialApiKey(ANTHROPIC_PROVIDER_ID, legacyAnthropicOAuthCredential);
      if (legacyKey) return legacyKey;
    }

    if (!subscriptionLoggedOut) {
      const subscriptionCredential = selectStoredCredential(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
      if (subscriptionCredential?.type === "oauth") {
        /*
        FNXC:ProviderAuth 2026-06-30-11:26:
        The separated subscription login stores OAuth material under `anthropic-subscription` so the API-key card stays raw-key-only, but Anthropic model execution still requests provider `anthropic`. Resolve and refresh the subscription credential (persisting rotated tokens back to `anthropic-subscription`) so a subscription user's `anthropic/<model>` selection runs on their OAuth token.
        */
        const subscriptionKey = await resolveRefreshableCredentialApiKey(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, subscriptionCredential);
        if (subscriptionKey) return subscriptionKey;
      }
    }

    if (!rawProviderLoggedOut) {
      /*
      FNXC:ProviderAuth 2026-06-30-13:28:
      Logging out of the raw Anthropic provider must suppress raw-key sources consistently across status and runtime resolution. Treat models.json Anthropic keys and ModelRegistry fallback resolver keys as raw-key fallback material; subscription OAuth stays governed by the separate `anthropic-subscription` logout state above.
      */
      const modelsJsonApiKey = modelsJsonApiKeys.get(ANTHROPIC_PROVIDER_ID);
      if (modelsJsonApiKey) return modelsJsonApiKey;
      return resolveTargetFallbackApiKey(ANTHROPIC_PROVIDER_ID);
    }

    return undefined;
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
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            const legacyAnthropicCredential = target.get(ANTHROPIC_PROVIDER_ID) as StoredCredential | undefined;
            if (legacyAnthropicCredential?.type === "oauth") {
              target.logout(ANTHROPIC_PROVIDER_ID);
            }
          }
        };
      }

      if (prop === "remove") {
        return (provider: string) => {
          target.remove(provider);
          loggedOutProviders.add(provider);
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            const legacyAnthropicCredential = target.get(ANTHROPIC_PROVIDER_ID) as StoredCredential | undefined;
            if (legacyAnthropicCredential?.type === "oauth") {
              target.remove(ANTHROPIC_PROVIDER_ID);
            }
          }
        };
      }

      if (prop === "setFallbackResolver") {
        return (resolver: (provider: string) => string | undefined) => {
          (target as unknown as { fallbackResolver?: (provider: string) => string | undefined }).fallbackResolver = resolver;
        };
      }

      if (prop === "login") {
        // Preserve the original invocation semantics (bind `this` to the proxy so
        // any internal credential writes still flow through the set/logout traps),
        // and only ADD the alias-aware logged-out clearing on top.
        const originalLogin = Reflect.get(target, prop, receiver) as (
          provider: string,
          callbacks: unknown,
        ) => Promise<void>;
        return async (provider: string, callbacks: unknown) => {
          const result = await originalLogin.call(receiver, provider, callbacks);
          /*
          FNXC:ProviderAuth 2026-07-05-00:00:
          A completed interactive login means the user re-authenticated this provider, so lift its logged-out suppression (and the Anthropic subscription alias) even though the credential is persisted under `anthropic`. Without this, subscription re-login after an in-session logout stays invisible to the status card. See clearReauthenticatedLogoutState.
          */
          clearReauthenticatedLogoutState(provider);
          return result;
        };
      }

      if (prop === "set") {
        return (provider: string, credential: AuthCredential) => {
          target.set(provider, credential);
          clearReauthenticatedLogoutState(provider, (credential as StoredCredential | undefined)?.type);
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
        return (provider: string) => selectVisibleStoredCredential(provider);
      }

      if (prop === "has") {
        return (provider: string) => {
          if (provider === ANTHROPIC_PROVIDER_ID) {
            return hasVisibleAnthropicCredential();
          }
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            return hasVisibleAnthropicSubscriptionCredential();
          }
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          return target.has(provider) || provider in supplementalCredentials || modelsJsonApiKeys.has(provider) || hasTargetFallbackAuth(provider);
        };
      }

      if (prop === "hasAuth") {
        return (provider: string) => {
          if (provider === ANTHROPIC_PROVIDER_ID) {
            return hasVisibleAnthropicCredential();
          }
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            return hasVisibleAnthropicSubscriptionCredential();
          }
          if (loggedOutProviders.has(provider)) {
            return false;
          }
          return target.hasAuth(provider) || Boolean(supplementalCredentials[provider]) || modelsJsonApiKeys.has(provider) || hasTargetFallbackAuth(provider);
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
          if (hasVisibleAnthropicSubscriptionCredential()) {
            providerIds.add(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
          }
          const merged: Record<string, StoredCredential> = {};
          for (const providerId of providerIds) {
            const credential = selectVisibleStoredCredential(providerId);
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
          if (hasVisibleAnthropicSubscriptionCredential()) {
            providers.add(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
            providers.add(ANTHROPIC_PROVIDER_ID);
          }
          return Array.from(providers).filter((p) => {
            if (p === ANTHROPIC_PROVIDER_ID) {
              return hasVisibleAnthropicCredential();
            }
            if (loggedOutProviders.has(p)) {
              return false;
            }
            return true;
          });
        };
      }

      if (prop === "getApiKey") {
        return async (provider: string) => {
          if (provider === ANTHROPIC_PROVIDER_ID) {
            return resolveAnthropicRuntimeApiKey();
          }

          if (loggedOutProviders.has(provider)) {
            return undefined;
          }

          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            const { credential: subscriptionCredential, sourceProvider } = selectAnthropicSubscriptionCredential();
            if (subscriptionCredential?.type !== "oauth") {
              return undefined;
            }
            if (sourceProvider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
              /*
              FNXC:ProviderAuth 2026-07-01-12:34:
              Legacy Anthropic OAuth rows are subscription credentials, not raw API keys. Hydrate them into `anthropic-subscription` before refresh so status, usage, and banner clearing share the same provider id without overwriting a raw `anthropic` API-key credential.
              */
              primary.set(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, subscriptionCredential as AuthCredential);
              loggedOutProviders.delete(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID);
            }
            return resolveRefreshableCredentialApiKey(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, subscriptionCredential);
          }

          // 1. Primary Fusion auth
          const primaryKey = await target.getApiKey(provider);
          if (primaryKey) return primaryKey;

          // 2. Supplemental auth.json credentials (.pi + .codex)
          const refreshCandidate = selectStoredCredential(provider);
          const refreshedKey = await resolveRefreshableCredentialApiKey(provider, refreshCandidate);
          if (refreshedKey) return refreshedKey;

          const supplementalKey = resolveStoredCredentialApiKey(provider, supplementalCredentials[provider]);
          if (supplementalKey) return supplementalKey;

          // 3. models.json provider API keys (e.g., kimi-coding, lmstudio)
          const modelsJsonApiKey = modelsJsonApiKeys.get(provider);
          if (modelsJsonApiKey) return modelsJsonApiKey;

          // 4. ModelRegistry fallback resolver (env-backed provider configs)
          return resolveTargetFallbackApiKey(provider);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}
