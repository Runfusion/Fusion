import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  choosePreferredStoredCredential,
  getClaudeCodeCredentialPaths,
  getCodexCliAuthPath,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
  type StoredAuthCredential,
} from "@fusion/core";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type StoredCredential = StoredAuthCredential;

export interface FusionAuthStorage {
  reload(): void;
  get(provider: string): StoredCredential | undefined;
  getAll(): Record<string, StoredCredential>;
  list(): string[];
  has(provider: string): boolean;
  hasAuth(provider: string): boolean;
  set(provider: string, credential: StoredCredential): Promise<void>;
  remove(provider: string): Promise<void>;
  logout(provider: string): Promise<void>;
  getApiKey(provider: string): Promise<string | undefined>;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  login(provider: string, callbacks: unknown): Promise<void>;
  modify(provider: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>): Promise<StoredCredential | undefined>;
  setModelRuntime(modelRuntime: ModelRuntime): void;
}

/*
FNXC:ProviderAuth 2026-07-17-08:30:
FN-8205 replaces the immediate-fail `lockSync` write path: proper-lockfile rejects
synchronous retries with ESYNC, so a held shared auth.json lock used to surface ELOCKED
straight through set/remove/logout. Writes now share this asynchronous retry policy with
modify() and queue per resolved auth path before taking the cross-process file lock. This
prevents same-engine sessions from self-contending while preserving fresh read-modify-merge
under the lock for independent Fusion processes. The vendored pi-coding-agent synchronous
lock defect from Runfusion/Fusion#2167 remains a separately tracked upstream follow-up.
*/
const AUTH_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 20,
    maxTimeout: 10_000,
    randomize: true,
  },
} as const;

const authWriteQueues = new Map<string, Promise<void>>();

function enqueueAuthWrite<T>(authPath: string, write: () => Promise<T>): Promise<T> {
  const queueKey = resolve(authPath);
  const previous = authWriteQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(write);
  const tail = operation.then(() => undefined, () => undefined);
  authWriteQueues.set(queueKey, tail);
  void tail.finally(() => {
    if (authWriteQueues.get(queueKey) === tail) authWriteQueues.delete(queueKey);
  });
  return operation;
}

class FusionFileAuthStorage implements FusionAuthStorage {
  private data: Record<string, StoredCredential> = {};
  private modelRuntime: ModelRuntime | undefined;

  constructor(private readonly authPath: string) {
    this.reload();
  }

  private ensureFile(): void {
    const parent = dirname(this.authPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", { encoding: "utf-8", mode: 0o600 });
      chmodSync(this.authPath, 0o600);
    }
  }

  private readCurrent(): Record<string, StoredCredential> {
    try {
      return JSON.parse(readFileSync(this.authPath, "utf-8")) as Record<string, StoredCredential>;
    } catch {
      return {};
    }
  }

  private async withLock<T>(fn: (current: Record<string, StoredCredential>) => Promise<T>): Promise<T> {
    return enqueueAuthWrite(this.authPath, async () => {
      this.ensureFile();
      const release = await lockfile.lock(this.authPath, AUTH_LOCK_OPTIONS);
      try {
        // Always merge the on-disk state observed after acquiring the lock, never this.data.
        const current = this.readCurrent();
        const result = await fn(current);
        writeFileSync(this.authPath, JSON.stringify(current, null, 2), { encoding: "utf-8", mode: 0o600 });
        chmodSync(this.authPath, 0o600);
        this.data = current;
        return result;
      } finally {
        await release();
      }
    });
  }

  reload(): void {
    this.ensureFile();
    this.data = this.readCurrent();
  }

  get(provider: string): StoredCredential | undefined { return this.data[provider]; }
  getAll(): Record<string, StoredCredential> { return { ...this.data }; }
  list(): string[] { return Object.keys(this.data); }
  has(provider: string): boolean { return Boolean(this.data[provider]); }
  hasAuth(provider: string): boolean { return this.has(provider); }
  async set(provider: string, credential: StoredCredential): Promise<void> {
    await this.withLock(async (current) => { current[provider] = credential; });
  }
  async remove(provider: string): Promise<void> {
    await this.withLock(async (current) => { delete current[provider]; });
  }
  async logout(provider: string): Promise<void> { await this.remove(provider); }
  async getApiKey(provider: string): Promise<string | undefined> {
    return resolveStoredCredentialApiKey(provider, this.get(provider));
  }
  getOAuthProviders(): Array<{ id: string; name: string }> {
    return [
      { id: "anthropic", name: "Anthropic" },
      { id: "openai-codex", name: "OpenAI Codex" },
      { id: "github-copilot", name: "GitHub Copilot" },
    ];
  }
  setModelRuntime(modelRuntime: ModelRuntime): void {
    this.modelRuntime = modelRuntime;
  }
  async login(provider: string, callbacks: unknown): Promise<void> {
    if (!this.modelRuntime) throw new Error("OAuth login requires a ModelRuntime-backed Fusion auth storage");
    const legacy = callbacks as {
      onAuth?: (info: { url: string; instructions?: string }) => void;
      onDeviceCode?: (info: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }) => void;
      onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (message: string) => void;
      signal?: AbortSignal;
    };
    const interaction: AuthInteraction = {
      signal: legacy.signal,
      prompt: async (prompt) => legacy.onPrompt?.({
        message: prompt.message,
        placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
      }) ?? "",
      notify: (event) => {
        if (event.type === "auth_url") legacy.onAuth?.({ url: event.url, instructions: event.instructions });
        else if (event.type === "device_code") legacy.onDeviceCode?.(event);
        else if (event.type === "progress") legacy.onProgress?.(event.message);
      },
    };
    await this.modelRuntime.login(provider, "oauth", interaction);
    this.reload();
  }
  async modify(provider: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>): Promise<StoredCredential | undefined> {
    return this.withLock(async (current) => {
      const next = await fn(current[provider]);
      if (next !== undefined) current[provider] = next;
      return current[provider];
    });
  }
}

export function createFusionCredentialStore(authStorage: FusionAuthStorage): CredentialStore {
  return {
    /*
    FNXC:ProviderAuth 2026-07-17-06:30:
    pi >=0.80.8 moved session request auth from `ModelRegistry.getApiKeyAndHeaders` (which called fusion's `getApiKey(provider)`) to `ModelRuntime.getAuth` -> pi-ai `resolveProviderAuth`, which reads the credential store directly (`credentials.read(provider.id)`) and, for an OAuth credential, refreshes it ITSELF via `credentials.modify(provider.id, ...)`. That refresh path is broken for Anthropic: fusion persists the subscription login under `anthropic-subscription` (there is NO raw `anthropic` row), so `modify("anthropic")` reads `current === undefined`, the refresh callback bails, and `resolveStoredOAuth` returns undefined -> the task fails with `Provider is not configured: anthropic` (then falls back). The status card still shows "connected" because status uses a different path (hasVisibleAnthropicCredential). Fix: resolve Anthropic auth through fusion's `getApiKey("anthropic")`, the battle-tested path that already handles token refresh + the raw-key/legacy-oauth/subscription/fallback precedence (see resolveAnthropicRuntimeApiKey), and hand pi-ai a ready-to-use api_key credential. pi-ai's anthropic-messages layer routes by token prefix — `sk-ant-oat*` -> OAuth Bearer + Claude Code identity headers, otherwise x-api-key — so a subscription OAuth token still runs as OAuth, and returning it as `api_key` deliberately bypasses pi-ai's own (broken-for-us) OAuth refresh-via-modify. Other OAuth providers (openai-codex, github-copilot) are stored under their own provider id, so read/modify share an id and pi-ai's refresh works — only Anthropic needs this indirection.
    */
    read: async (providerId) => {
      if (providerId === ANTHROPIC_PROVIDER_ID) {
        const token = await authStorage.getApiKey(ANTHROPIC_PROVIDER_ID);
        return token ? ({ type: "api_key", key: token } as Credential) : undefined;
      }
      return authStorage.get(providerId) as Credential | undefined;
    },
    list: async () => authStorage.list().flatMap((providerId): CredentialInfo[] => {
      const credential = authStorage.get(providerId);
      return credential?.type === "api_key" || credential?.type === "oauth"
        ? [{ providerId, type: credential.type }]
        : [];
    }),
    modify: async (providerId, fn) => authStorage.modify(providerId, async (current) => fn(current as Credential | undefined) as Promise<StoredCredential | undefined>) as Promise<Credential | undefined>,
    delete: async (providerId) => { await authStorage.remove(providerId); },
  };
}

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

  // pi 0.80.8 moved provider OAuth conversion behind ModelRuntime. The legacy
  // dashboard adapter only needs the stored bearer access token; ModelRuntime handles
  // provider-specific `toAuth` conversion for actual model requests.
  return credential.access;
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
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Do not include scope: RFC 6749 refreshes preserve the granted scope only when omitted.
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        refresh_token: credential.refresh,
      }),
    });
    if (!response.ok) return undefined;
    const payload = JSON.parse(await response.text()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") return undefined;
    return {
      ...credential,
      access: payload.access_token,
      refresh: payload.refresh_token,
      expires: Date.now() + payload.expires_in * 1000 - OAUTH_REFRESH_BUFFER_MS,
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
 * CLI's the pre-0.80.8 registry factory. Without a ModelRegistry the
 * /api/models endpoint returns an empty list, so the onboarding model picker shows "no models" even
 * when a provider (e.g. Anthropic) is connected.
 */
export type FusionModelRegistry = ModelRegistry & { readonly modelRuntime: ModelRuntime };

/**
 * FNXC:ModelRegistry 2026-07-16-17:20:
 * pi 0.80.8 made model initialization asynchronous and moved auth ownership to
 * ModelRuntime. Keep Fusion's file-backed, locked credential adapter as the runtime
 * CredentialStore so FN-7646's per-provider read-modify-merge guarantee survives.
 */
export async function createFusionModelRegistry(authStorage: FusionAuthStorage, home?: string): Promise<FusionModelRegistry> {
  const modelRuntime = await ModelRuntime.create({
    credentials: createFusionCredentialStore(authStorage),
    modelsPath: getModelRegistryModelsPath(home),
  });
  authStorage.setModelRuntime(modelRuntime);
  return Object.assign(new ModelRegistry(modelRuntime), { modelRuntime });
}

export function createFusionAuthStorage(): FusionAuthStorage {
  const primary = new FusionFileAuthStorage(getFusionAuthPath());
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
  let supplementalHydration = Promise.resolve();

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

  /*
  FNXC:ProviderAuth 2026-07-17-08:45:
  Supplemental hydration persists through the same per-path queue as direct writes. Construction
  and lock-free reload intentionally start it without blocking reads; callers that require a
  hydrated credential use getApiKey(), which awaits its own persistence. Other reads observe
  hydrated state after this queue drains rather than racing an un-awaited file write.
  */
  const syncSupplementalOauthCredentials = async (): Promise<void> => {
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
        await primary.set(provider, credential as StoredCredential);
        continue;
      }
      if (credential.type === "api_key") {
        await primary.set(provider, credential as StoredCredential);
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
      await primary.set(storageProvider, refreshedCredential as StoredCredential);
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

  supplementalHydration = syncSupplementalOauthCredentials();

  return new Proxy(primary, {
    // Forward property writes to the target so that methods like
    // `setFallbackResolver` (called by ModelRegistry) correctly update the
    // underlying AuthStorage. Without this trap, writes land on the Proxy
    // object itself and the target's fallbackResolver stays undefined.
    set(target: FusionAuthStorage, prop: string | symbol, value: unknown) {
      (target as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },

    get(target, prop, receiver) {
      if (prop === "logout") {
        return async (provider: string): Promise<void> => {
          await target.logout(provider);
          loggedOutProviders.add(provider);
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            const legacyAnthropicCredential = target.get(ANTHROPIC_PROVIDER_ID) as StoredCredential | undefined;
            if (legacyAnthropicCredential?.type === "oauth") {
              await target.logout(ANTHROPIC_PROVIDER_ID);
            }
          }
        };
      }

      if (prop === "remove") {
        return async (provider: string): Promise<void> => {
          await target.remove(provider);
          loggedOutProviders.add(provider);
          if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            const legacyAnthropicCredential = target.get(ANTHROPIC_PROVIDER_ID) as StoredCredential | undefined;
            if (legacyAnthropicCredential?.type === "oauth") {
              await target.remove(ANTHROPIC_PROVIDER_ID);
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
        return async (provider: string, credential: StoredCredential): Promise<void> => {
          await target.set(provider, credential);
          clearReauthenticatedLogoutState(provider, (credential as StoredCredential | undefined)?.type);
        };
      }

      if (prop === "reload") {
        return () => {
          target.reload();
          supplementalCredentials = readSupplementalCredentials();
          supplementalHydration = syncSupplementalOauthCredentials();
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
          await supplementalHydration;
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
              await primary.set(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, subscriptionCredential as StoredCredential);
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
  }) as FusionAuthStorage;
}
