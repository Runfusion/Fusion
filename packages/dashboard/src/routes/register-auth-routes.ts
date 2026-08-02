import { createLogger, DEFAULT_PROVIDER_INSTANCE_ID, isValidProviderInstanceId } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-register-auth-routes");
import type { Request } from "express";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { GIT_INSTALL_URL, isGhAvailable, isGhAuthenticated, probeGitCliStatus } from "@fusion/core";
import { probeClaudeCli } from "../claude-cli-probe.js";
import { probeDroidCli } from "../droid-cli-probe.js";
import { probeCursorCliProvider, probeGrokCliProvider, probeOmpCliProvider } from "../runtime-provider-probes.js";
import { probeLlamaCpp } from "../llama-cpp-probe.js";
import { ApiError, badRequest, conflict } from "../api-error.js";
import { clearUsageCache } from "../usage.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";
import {
  STATIC_API_KEY_PROVIDER_CATALOG,
  STATIC_OAUTH_PROVIDER_CATALOG,
  unionProviderCatalog,
} from "./auth-provider-catalog.js";

export type DeviceCodeInfo = {
  userCode: string;
  verificationUri: string;
};

export function parseGitHubCopilotDeviceCode(instructions: string): string | undefined {
  const match = instructions.match(/Enter code:\s*([A-Z0-9-]+)\b/i);
  return match?.[1];
}

export const registerAuthRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, store, getScopedStore, rethrowAsApiError } = ctx;
  const authStorage = options?.authStorage;

  /*
  FNXC:ProviderAuth 2026-07-14-14:22:
  CLI-backed providers own their credentials and have dedicated status rows below. Runtime model registration can also expose those ids through getApiKeyProviders(); exclude them from the generic API-key union so Grok cannot render twice as both "missing API key" and ready via its authenticated CLI.
  */
  const syntheticCliProviderIds = new Set([
    "claude-cli",
    "pi-claude-cli",
    "droid-cli",
    "cursor-cli",
    "grok-cli",
    "omp-cli",
    "llama-cpp",
  ]);

  // Use injected AuthStorage or fail gracefully if not provided.
  // When running via the CLI/engine, AuthStorage is passed in via ServerOptions.
  function getAuthStorage(): AuthStorageLike {
    if (!authStorage) {
      throw new Error("Authentication is not configured");
    }
    return authStorage;
  }

  function normalizeCursorCliBinaryPath(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }

  async function readCursorCliBinaryPath(): Promise<string | undefined> {
    /*
    FNXC:CursorCli 2026-07-02-00:00:
    Auth provider list, status, enable, and path-save validation must all probe the same trimmed global Cursor CLI binary override before falling back to PATH candidates.
    */
    if (!store) return undefined;
    const globalSettings = await store.getGlobalSettingsStore().getSettings();
    return normalizeCursorCliBinaryPath(globalSettings.cursorCliBinaryPath);
  }

  async function probeCursorCliWithStoredBinary() {
    return probeCursorCliProvider({ binaryPath: await readCursorCliBinaryPath() });
  }

  /*
  FNXC:GrokCli 2026-07-08-00:00:
  Mirrors normalizeCursorCliBinaryPath/readCursorCliBinaryPath/probeCursorCliWithStoredBinary above (FN-7705). Auth provider list, status, enable, and path-save validation must all probe the same trimmed global Grok CLI binary override before falling back to PATH candidates.
  */
  function normalizeGrokCliBinaryPath(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }

  async function readGrokCliBinaryPath(): Promise<string | undefined> {
    if (!store) return undefined;
    const globalSettings = await store.getGlobalSettingsStore().getSettings();
    return normalizeGrokCliBinaryPath((globalSettings as Record<string, unknown>).grokCliBinaryPath);
  }

  async function probeGrokCliWithStoredBinary() {
    return probeGrokCliProvider({ binaryPath: await readGrokCliBinaryPath() });
  }

  /*
  FNXC:OmpAcp 2026-07-13-22:50:
  Mirrors Grok/Cursor binary path helpers so auth provider list, status, enable, and path-save validation probe the same trimmed global OMP CLI override.
  */
  function normalizeOmpCliBinaryPath(value: unknown): string | undefined {
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }

  async function readOmpCliBinaryPath(): Promise<string | undefined> {
    if (!store) return undefined;
    const globalSettings = await store.getGlobalSettingsStore().getSettings();
    return normalizeOmpCliBinaryPath((globalSettings as Record<string, unknown>).ompCliBinaryPath);
  }

  async function probeOmpCliWithStoredBinary() {
    return probeOmpCliProvider({ binaryPath: await readOmpCliBinaryPath() });
  }

  /**
   * Mask an API key for safe display.
   * - If key length <= 8: return 8 bullets (never reveal short keys)
   * - Otherwise: first 3 chars + 5 bullets + last 4 chars
   */
  /*
  FNXC:ProviderAuth 2026-08-01-06:11:
  Instance ids are scoped to a provider. Credential-establishing writes may create a supplied id,
  but all management mutations require an existing row; labels are optional opaque display text.
  */
  function resolveInstanceId(value: unknown): string {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return DEFAULT_PROVIDER_INSTANCE_ID;
    if (!isValidProviderInstanceId(value)) throw badRequest("instance must be a valid provider instance id");
    return value;
  }

  // Empty strings are wire-compatible with omission, including for CLI-provider validation.
  function hasExplicitInstance(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  function validateLabel(value: unknown, required = false): string | undefined {
    if (value === undefined || value === null || value === "") {
      if (required) throw badRequest("label is required");
      return undefined;
    }
    if (typeof value !== "string") throw badRequest("label must be a string");
    const label = value.trim();
    if (label.length > 60) throw badRequest("label must be at most 60 characters");
    if (required && !label) throw badRequest("label is required");
    return label || undefined;
  }

  function maskApiKey(key: string): string {
    if (key.length <= 8) {
      return "••••••••";
    }
    return key.slice(0, 3) + "•••••" + key.slice(-4);
  }

  function getOauthStatusCredential(providerId: string, storage: AuthStorageLike) {
    const credential = storage.get?.(providerId);
    if (credential?.type === "oauth") {
      return credential;
    }
    if (providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
      /*
      FNXC:ProviderAuth 2026-07-01-12:46:
      The OAuth re-login banner is keyed by the dashboard status id `anthropic-subscription`, but pre-split installs may still hold Claude subscription OAuth in the legacy `anthropic` row. Read that legacy OAuth only for subscription status; raw API-key status remains on the separate `anthropic-api-key` card.
      */
      const legacyCredential = storage.get?.(ANTHROPIC_OAUTH_PROVIDER_ID);
      return legacyCredential?.type === "oauth" ? legacyCredential : undefined;
    }
    return undefined;
  }

  /*
  FNXC:ProviderAuth 2026-07-05-00:00:
  FN-7574: an expired-and-unrefreshable subscription OAuth credential was reported as
  `authenticated:true` on the settings card and never surfaced the re-login banner,
  even though OAuthExpiryMonitor (engine side) had already fired the oauth-token-expired
  notification for the same credential. Root cause enumerated in task notes: a stored
  OAuth-typed credential with a missing/non-numeric `expires` field was previously
  treated as "not expired" here, while `resolveOAuthApiKey`/`getApiKey` in
  packages/engine/src/auth-storage.ts already treat a missing numeric `expires` as
  unusable (never yields a runtime key). Make the status predicate fail-safe: a stored
  OAuth credential without a usable numeric expiry now reports `expired:true` (shows as
  not-connected) rather than silently claiming a live session it cannot actually use.
  OAuthExpiryMonitor intentionally keeps its separate skip-and-don't-notify behavior for
  unknown-expiry credentials (see oauth-expiry-monitor.ts) — the notification channel
  should stay conservative about spamming, while this "are you logged in" status surface
  should stay conservative about claiming a live session.
  */
  function isExpiredOauthCredential(providerId: string, storage: AuthStorageLike): boolean {
    const credential = getOauthStatusCredential(providerId, storage);
    if (!credential) {
      return false;
    }
    if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
      // A stored OAuth credential with no usable expiry can never mint a runtime API
      // key (see resolveOAuthApiKey in auth-storage.ts), so treat it as expired rather
      // than authenticated.
      return true;
    }

    return Date.now() >= credential.expires;
  }

  /*
  FNXC:ClaudeOAuth 2026-07-05-19:10:
  An Anthropic subscription OAuth token can be present AND unexpired yet still be unable to run models — e.g. a profile-only grant, or a token that a buggy refresh narrowed to `user:profile` (root cause fixed in packages/engine/src/auth-storage.ts). Such a token proves identity but 403s on every model call ("OAuth token does not meet scope requirement any_of(user:inference, ...)"), which is exactly how the status card came to claim "logged in" while all inference failed. So /auth/status must treat an inference-incapable token as not-connected, not authenticated.
  Mirror the API's any_of inference set. Only penalize when scopes ARE recorded and none is inference-capable: a fresh pi-ai login persists NO `scopes` field, so absent/empty scopes are treated as unknown-but-usable to avoid falsely reporting a good login as disconnected.
  */
  const ANTHROPIC_INFERENCE_SCOPES = new Set([
    "user:inference",
    "user:developer",
    "user:ccr_inference",
    "user:voice",
    "org:service_key_inference",
    "workspace:developer",
    "workspace:inference",
  ]);

  function isAnthropicOauthProviderId(providerId: string): boolean {
    return providerId === ANTHROPIC_OAUTH_PROVIDER_ID || providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID;
  }

  function isInferenceIncapableAnthropicOauth(providerId: string, storage: AuthStorageLike): boolean {
    // Scope semantics are Anthropic-specific — never apply this to github-copilot,
    // openai-codex, or other OAuth providers whose scope sets are unrelated.
    if (!isAnthropicOauthProviderId(providerId)) {
      return false;
    }
    const credential = getOauthStatusCredential(providerId, storage);
    if (!credential) {
      return false;
    }
    const rawScopes = (credential as { scopes?: unknown }).scopes;
    if (!Array.isArray(rawScopes)) {
      return false;
    }
    const scopes = rawScopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
    if (scopes.length === 0) {
      // Unknown scopes (e.g. fresh login that records none) — assume usable.
      return false;
    }
    return !scopes.some((scope) => ANTHROPIC_INFERENCE_SCOPES.has(scope));
  }

  type ManualCodeConfig = {
    prompt: string;
    placeholder?: string;
    helpText?: string;
  };

  type PendingLogin = {
    provider: string;
    abortController: AbortController;
    inputPromise: Promise<string>;
    resolveInput: (input: string) => void;
    rejectInput: (error: Error) => void;
    inputSubmitted: boolean;
    manualCode?: ManualCodeConfig;
    instanceId: string;
    label?: string;
  };

  /*
  FNXC:ProviderAuth 2026-08-01-06:25:
  OAuth is a multi-request flow, so its server-side entry is keyed by provider plus instance.
  The bound id and opaque label must survive login, manual-code, cancel, and callback handling;
  an absent or mismatched flow must fail rather than re-targeting the default credential.
  */
  const loginInProgress = new Map<string, PendingLogin>();
  const loginKey = (providerId: string, instanceId: string) => `${providerId}::${instanceId}`;

  /*
  FNXC:ProviderAuth 2026-07-05-00:00:
  Interactive OAuth login (e.g. Anthropic subscription paste-callback flow) resolves the auth URL to the client immediately, then the real login continues in the background. When the background `storage.login` rejects — bad/expired code, token-exchange rejection, redirect_uri mismatch — that error was previously dropped on the floor: `rejectAuthInfo` is a no-op once the auth URL has been sent, and nothing logged or surfaced it. The UI (which only polls `/auth/status`) then showed a generic "login failed" with no cause, making the failure undiagnosable for both users and maintainers.
  Retain the last background login error per provider so `/auth/status` can report why it failed, and always log it server-side. Cleared when a fresh login for the same provider starts.
  */
  const lastLoginError = new Map<string, string>();

  const OAUTH_SESSION_TTL_MS = 5 * 60 * 1000;
  type OauthSession = { port: number; path: string; originalRedirectUri: string; expiresAt: number; flowKey: string; provider: string; instanceId: string; timeout: ReturnType<typeof setTimeout> };
  const oauthSessions = new Map<string, OauthSession>();

  function isLocalhostOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  }

  function simpleErrorHtml(title: string, detail?: string): string {
    const safeTitle = String(title);
    const safeDetail = detail ? String(detail) : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${safeTitle}</title></head><body><h2>${safeTitle}</h2>${safeDetail ? `<p>${safeDetail}</p>` : ""}<p>You can close this tab.</p></body></html>`;
  }

  function deleteOauthSession(state: string): void {
    const session = oauthSessions.get(state);
    if (session) clearTimeout(session.timeout);
    oauthSessions.delete(state);
  }

  function deleteOauthSessionsForFlow(flowKey: string): void {
    for (const [state, session] of oauthSessions.entries()) {
      if (session.flowKey === flowKey) deleteOauthSession(state);
    }
  }

  function cancelOauthFlow(flowKey: string, reason: Error): void {
    const activeLogin = loginInProgress.get(flowKey);
    if (!activeLogin) return;
    loginInProgress.delete(flowKey);
    deleteOauthSessionsForFlow(flowKey);
    activeLogin.inputSubmitted = true;
    activeLogin.rejectInput(reason);
    activeLogin.abortController.abort();
  }

  function expireOauthSession(state: string, session: OauthSession): void {
    deleteOauthSession(state);
    // A proxy state is the only callback route for this dashboard-origin flow. Once it expires,
    // terminate its bound login so a later callback cannot persist a cancelled account.
    cancelOauthFlow(session.flowKey, new Error("OAuth session expired"));
  }

  function cleanupExpiredOauthSessions(): void {
    const now = Date.now();
    for (const [state, session] of oauthSessions.entries()) {
      if (session.expiresAt <= now) expireOauthSession(state, session);
    }
  }

  /*
  FNXC:ProviderAuth 2026-08-01-07:20:
  Redirect callbacks carry only OAuth state. Bind that state to the active provider-instance flow
  and delete it on every terminal path, so a cancelled or forged callback can never resume or
  overwrite a default credential.
  */
  function setOauthSession(state: string, details: { port: number; path: string; originalRedirectUri: string; flowKey: string; provider: string; instanceId: string }): void {
    cleanupExpiredOauthSessions();
    const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
    const timeout = setTimeout(() => {
      const current = oauthSessions.get(state);
      if (current?.expiresAt === expiresAt) expireOauthSession(state, current);
    }, OAUTH_SESSION_TTL_MS + 1_000);
    timeout.unref();
    oauthSessions.set(state, { ...details, expiresAt, timeout });
  }

  function rewriteAuthUrl(authUrl: string, origin: string): { url: string; state: string; originalRedirectUri: string; port: number; path: string } {
    const authUrlObj = new URL(authUrl);
    const state = authUrlObj.searchParams.get("state");
    const redirectUri = authUrlObj.searchParams.get("redirect_uri");

    if (!state) {
      throw badRequest("OAuth provider did not return state in auth URL");
    }
    if (!redirectUri) {
      throw badRequest("OAuth provider did not return redirect_uri in auth URL");
    }

    const redirectUriUrl = new URL(redirectUri);
    const port = Number.parseInt(redirectUriUrl.port, 10);
    if (!Number.isFinite(port) || port <= 0) {
      throw badRequest("OAuth provider returned invalid callback redirect_uri");
    }

    const newRedirectUri = new URL("/api/auth/oauth-callback", origin).toString();
    authUrlObj.searchParams.set("redirect_uri", newRedirectUri);

    return {
      url: authUrlObj.toString(),
      state,
      originalRedirectUri: redirectUriUrl.toString(),
      port,
      path: `${redirectUriUrl.pathname}${redirectUriUrl.search}`,
    };
  }

  const ANTHROPIC_OAUTH_PROVIDER_ID = "anthropic";
  const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";

  function toOauthLoginProviderId(providerId: string): string {
    return providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID ? ANTHROPIC_OAUTH_PROVIDER_ID : providerId;
  }

  function toOauthCredentialProviderId(providerId: string): string {
    return providerId === ANTHROPIC_OAUTH_PROVIDER_ID ? ANTHROPIC_SUBSCRIPTION_PROVIDER_ID : providerId;
  }

  function toAuthStatusProvider(provider: { id: string; name: string }): { id: string; name: string } {
    if (provider.id !== ANTHROPIC_OAUTH_PROVIDER_ID) {
      return provider;
    }
    /*
    FNXC:ProviderAuth 2026-06-29-22:12:
    Anthropic subscription OAuth and raw `ANTHROPIC_API_KEY` credentials share the upstream auth id `anthropic`, but dashboard users need separate cards so saving or clearing an API key never appears to replace Claude subscription login.
    Expose OAuth through a synthetic UI id and map it back only at route boundaries.
    */
    return { id: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, name: "Anthropic Subscription" };
  }

  function shouldRewriteOauthRedirect(providerId: string, origin: string | undefined): boolean {
    const storageProviderId = toOauthLoginProviderId(providerId);

    if (!origin || isLocalhostOrigin(origin)) {
      return false;
    }

    // These providers do not use a redirect_uri-based callback:
    //   - openai-codex, anthropic: pasted-code UX with their own localhost callbacks
    //   - github-copilot: OAuth device-code flow (verification_uri has no state/redirect_uri)
    if (storageProviderId === "openai-codex" || storageProviderId === "anthropic" || storageProviderId === "github-copilot") {
      return false;
    }

    return true;
  }

  function getManualCodeConfig(providerId: string, origin: string | undefined): ManualCodeConfig | undefined {
    const remoteDashboard = origin !== undefined && !isLocalhostOrigin(origin);

    if (providerId === "openai-codex") {
      return {
        prompt: "Paste the final redirect URL or authorization code",
        placeholder: "http://localhost:1455/auth/callback?code=...&state=... or just the code",
        helpText: remoteDashboard
          ? "After sign-in, OpenAI may redirect to a localhost callback that cannot open from this dashboard host. Copy the full browser URL from the address bar and paste it here."
          : "If the browser cannot finish the localhost callback automatically, copy the full browser URL from the address bar and paste it here.",
      };
    }

    if (providerId === "anthropic") {
      return {
        prompt: "Paste the final redirect URL or authorization code",
        placeholder: "http://localhost:*/callback?code=...&state=... or just the code",
        helpText: remoteDashboard
          ? "After Claude sign-in, copy the full browser URL (or just the code) and paste it here to finish login from this dashboard host."
          : "If Claude cannot finish the localhost callback automatically, copy the full browser URL from the address bar and paste it here.",
      };
    }

    return undefined;
  }

  function providerWantsAutoPrompt(providerId: string): boolean {
    return providerId === "github-copilot";
  }

  function parseManualOAuthCallbackUrl(input: string): URL | undefined {
    const trimmed = input.trim();
    const candidates = [trimmed];
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(trimmed)) {
      candidates.unshift(`http://${trimmed}`);
    }

    for (const candidate of candidates) {
      try {
        return new URL(candidate);
      } catch {
        // Try the next representation.
      }
    }
    return undefined;
  }

  function normalizeManualOAuthInputForProvider(providerId: string, input: string): string {
    if (providerId !== "anthropic" && providerId !== "openai-codex") {
      return input.trim();
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return trimmed;
    }

    try {
      const url = parseManualOAuthCallbackUrl(trimmed);
      if (!url) {
        throw new Error("not a URL");
      }
      const searchCode = url.searchParams.get("code");
      if (searchCode) {
        if (providerId === "openai-codex" && (url.protocol === "http:" || url.protocol === "https:")) {
          return trimmed;
        }
        const normalized = new URLSearchParams();
        normalized.set("code", searchCode);
        const searchState = url.searchParams.get("state");
        if (searchState) {
          normalized.set("state", searchState);
        }
        return normalized.toString();
      }

      const hash = url.hash.replace(/^#/, "").replace(/^\?/, "");
      if (!hash) {
        return trimmed;
      }
      const hashParams = new URLSearchParams(hash);
      const hashCode = hashParams.get("code");
      if (!hashCode) {
        return trimmed;
      }

      /*
      FNXC:ProviderAuth 2026-07-04-00:00:
      Anthropic subscription and Codex pasted-login flows must accept the exact browser address bar after redirect, including providers/browsers that place OAuth `code` and `state` in the URL fragment or omit the URL scheme.
      The upstream CLI parser treats a syntactically valid URL as search-only and schemeless localhost text as raw parameters, so normalize callback inputs to query-param text before resolving the pending manual-code prompt.
      Also keep the raw callback URL parseable for server-side callback delivery when the browser cannot reach the local OAuth listener itself.
      */
      const normalized = new URLSearchParams();
      normalized.set("code", hashCode);
      const hashState = hashParams.get("state");
      if (hashState) {
        normalized.set("state", hashState);
      }
      return normalized.toString();
    } catch {
      const queryStart = trimmed.indexOf("?");
      if (queryStart >= 0) {
        const queryEnd = trimmed.indexOf("#", queryStart);
        const query = trimmed.slice(queryStart + 1, queryEnd >= 0 ? queryEnd : undefined);
        const params = new URLSearchParams(query);
        const code = params.get("code");
        if (code) {
          const normalized = new URLSearchParams();
          normalized.set("code", code);
          const state = params.get("state");
          if (state) {
            normalized.set("state", state);
          }
          return normalized.toString();
        }
      }
      return trimmed;
    }
  }

  async function deliverManualOAuthCallbackToLocalListener(providerId: string, input: string): Promise<void> {
    if (providerId !== "anthropic") {
      return;
    }

    const url = parseManualOAuthCallbackUrl(input);
    if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !url.port) {
      return;
    }

    const callbackUrl = new URL(`http://127.0.0.1:${url.port}${url.pathname}`);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);

    try {
      await fetch(callbackUrl, { method: "GET", signal: AbortSignal.timeout(3_000) });
    } catch {
      // Fall back to resolving the pending manual-code prompt below.
    }
  }

  function selectOauthOption(
    providerId: string,
    prompt: { options: Array<{ id: string; label?: string }> },
  ): string | undefined {
    if (prompt.options.length === 1) {
      return prompt.options[0]?.id;
    }

    const defaultLabeledOption = prompt.options.find((option) => /\(default\)/i.test(option.label ?? ""));

    // FN-5917: returning undefined here caused pi-ai's openai-codex login
    // flow to throw "Login cancelled" before it could open browser auth.
    if (providerId === "openai-codex") {
      return prompt.options.find((option) => option.id === "browser")?.id ?? defaultLabeledOption?.id ?? prompt.options[0]?.id;
    }

    return defaultLabeledOption?.id ?? prompt.options[0]?.id;
  }

  async function probeDroidCliWithEffectiveBinary(req?: Request) {
    let pluginSettings: Record<string, unknown> | undefined;
    if (req) {
      try {
        const scopedStore = await getScopedStore(req);
        const plugin = await scopedStore.getPluginStore().getPlugin("fusion-plugin-droid-runtime");
        if (plugin && typeof plugin.settings === "object" && plugin.settings !== null) {
          pluginSettings = plugin.settings as Record<string, unknown>;
        }
      } catch {
        // Missing/unreadable plugin settings: fall back to default droid binary resolution.
      }
    }

    return probeDroidCli({ settings: pluginSettings });
  }

  function appendManualCodeHint(
    instructions: string | undefined,
    providerId: string,
    origin: string | undefined,
  ): string | undefined {
    const manualCode = getManualCodeConfig(providerId, origin);
    if (!manualCode) {
      return instructions;
    }

    const hint = manualCode.helpText;
    if (!hint) {
      return instructions;
    }

    if (!instructions?.trim()) {
      return hint;
    }

    return `${instructions.trim()} ${hint}`;
  }

  /**
   * GET /api/auth/status
   * Returns list of all providers with their authentication status and type.
   * Includes both OAuth-backed and API-key-backed providers.
   * Response: {
   *   providers: [{ id, name, authenticated, type, keyHint? }],
   *   ghCli: { available: boolean, authenticated: boolean },
   *   gitCli: { available: boolean, version?: string, installUrl: string }
   * }
   */
  router.get("/auth/status", async (req, res) => {
    try {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const storage = getAuthStorage();
      /*
      FNXC:ProviderAuth 2026-08-01-19:10:
      FN-8713: Express normally supplies `req.query`, but direct route consumers can omit it. Treat an absent query as empty while retaining instance validation; a well-formed dangling instance stays unauthenticated below and must never fall back to the provider default.
      */
      const query = req.query ?? {};
      const requestedProvider = typeof query.provider === "string" ? query.provider : undefined;
      const rawRequestedInstance = typeof query.instance === "string" ? query.instance : undefined;
      if (rawRequestedInstance?.trim() && !requestedProvider) throw badRequest("instance requires provider");
      if (rawRequestedInstance?.trim() && !isValidProviderInstanceId(rawRequestedInstance.trim())) throw badRequest("instance must be a valid provider instance id");
      if (rawRequestedInstance?.trim() && requestedProvider && syntheticCliProviderIds.has(requestedProvider)) throw badRequest("CLI providers do not support credential instances");
      const requestedInstance = rawRequestedInstance?.trim() || undefined;
      storage.reload();
      /*
      FNXC:ProviderAuth 2026-07-07-00:00:
      FN-7625: enumerate OAuth + API-key providers from the static catalog
      UNIONED with whatever storage currently reports, so a connected
      runtime plugin narrowing storage.getOAuthProviders()/getApiKeyProviders()
      never removes a provider from the list — only per-provider status below
      may vary with runtime/auth state. See auth-provider-catalog.ts.
      */
      const oauthProviders = unionProviderCatalog(STATIC_OAUTH_PROVIDER_CATALOG, storage.getOAuthProviders());
      const providers: {
        id: string;
        name: string;
        authenticated: boolean;
        type: "oauth" | "api_key" | "cli";
        expired?: boolean;
        keyHint?: string;
        loginInProgress?: boolean;
        requiresManualCode?: boolean;
        loginError?: string;
      }[] = await Promise.all(oauthProviders.map(async (p) => {
        const statusProvider = toAuthStatusProvider(p);
        const storageProviderId = toOauthCredentialProviderId(statusProvider.id);
        let hasAuth = storage.hasAuth(storageProviderId);
        let expired = hasAuth && isExpiredOauthCredential(storageProviderId, storage);
        if (expired && storage.getApiKey) {
          /*
          FNXC:ClaudeOAuth 2026-06-13-22:46:
          The auth status poll should clear a Claude re-login banner after Fusion refreshes a stored OAuth token, without waiting for a separate model request to touch auth storage.
          Keep this best-effort so providers without refresh support still report expired and ask the user to re-authenticate.
          */
          try {
            await storage.getApiKey(storageProviderId);
          } catch {
            // Best-effort refresh only; preserve the expired status below.
          }
          hasAuth = storage.hasAuth(storageProviderId);
          expired = hasAuth && isExpiredOauthCredential(storageProviderId, storage);
        }
        /*
        FNXC:ClaudeOAuth 2026-07-05-19:10:
        A present, unexpired Anthropic OAuth token that lacks an inference scope cannot run models, so it must report as not-connected with the same remediation as an expired session (re-login). Fold it into `expired` so the existing OAuthReloginBanner (which keys on `expired===true`) prompts re-authentication, and set a specific `loginError` so SettingsModal explains the cause rather than showing a bare "expired". Evaluated only when the token is otherwise live (has auth and not already expired) to avoid redundant messaging.
        */
        const missingInferenceScope = hasAuth
          && !expired
          && isInferenceIncapableAnthropicOauth(storageProviderId, storage);
        const scopeLoginError = missingInferenceScope
          ? "This Anthropic login is missing the model-access (inference) scope, so model calls will fail. Re-login to grant full access."
          : undefined;
        /*
        FNXC:ProviderAuth 2026-07-14-15:54:
        Expired OAuth must carry an actionable card message, not only authenticated:false. Refresh failures such as invalid_grant cannot repair themselves; tell the operator to re-login while preserving a more specific background-login or inference-scope error when available.
        */
        const expiryLoginError = expired
          ? "This OAuth session expired and could not be refreshed. Re-login to restore model access."
          : undefined;
        return {
          id: statusProvider.id,
          name: statusProvider.name,
          authenticated: hasAuth && !expired && !missingInferenceScope,
          type: "oauth" as const,
          expired: expired || missingInferenceScope,
          loginInProgress: [...loginInProgress.keys()].some((key) => key.startsWith(`${statusProvider.id}::`)),
          requiresManualCode: getManualCodeConfig(toOauthLoginProviderId(statusProvider.id), origin) !== undefined || undefined,
          loginError: lastLoginError.get(statusProvider.id) ?? scopeLoginError ?? expiryLoginError,
        };
      }));

      // Include API-key-backed providers. Presence is the static catalog
      // unioned with anything storage additionally reports (FN-7625) —
      // storage.getApiKeyProviders may be absent/narrowed, but the catalog
      // entries must still surface as present-but-unauthenticated.
      {
        const runtimeApiKeyProviders = storage.getApiKeyProviders
          ? storage.getApiKeyProviders().filter((provider) => !syntheticCliProviderIds.has(provider.id))
          : [];
        const apiKeyProviders = unionProviderCatalog(STATIC_API_KEY_PROVIDER_CATALOG, runtimeApiKeyProviders);
        for (const p of apiKeyProviders) {
          let keyHint: string | undefined;
          if (storage.get) {
            const cred = storage.get(p.id);
            if (cred?.type === "api_key" && cred?.key) {
              keyHint = maskApiKey(cred.key);
            }
          }
          providers.push({
            id: p.id,
            name: p.name,
            authenticated: storage.hasApiKey ? storage.hasApiKey(p.id) : false,
            type: "api_key" as const,
            keyHint,
          });
        }
      }

      // Inject the synthetic "Anthropic — via Claude CLI" provider. Its
      // "authenticated" state is a product of three facts: the `claude`
      // binary must be on PATH, the user must have enabled useClaudeCli,
      // and the vendored extension must have loaded cleanly. We compute
      // them here once per /auth/status call so the provider list rendered
      // by onboarding + settings stays consistent with what a direct call
      // to /providers/claude-cli/status would return.
      if (store) {
        let enabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useClaudeCli === true;
        } catch {
          // Unreadable settings — fall through with enabled=false
        }
        const extension = options?.getClaudeCliExtensionStatus?.() ?? null;
        const binary = await probeClaudeCli();
        const extensionOk = extension === null || extension.status === "ok";
        providers.push({
          id: "claude-cli",
          name: "Anthropic — via Claude CLI",
          authenticated: enabled && binary.available && extensionOk,
          type: "cli" as const,
        });
      }

      // Inject the synthetic "Factory AI — via Droid CLI" provider.
      if (store) {
        let droidEnabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          droidEnabled = globalSettings.useDroidCli === true;
        } catch {
          // Unreadable settings — fall through with enabled=false
        }
        const droidExtension = options?.getDroidCliExtensionStatus?.() ?? null;
        const droidBinary = await probeDroidCliWithEffectiveBinary(req);
        const droidExtensionOk = droidExtension === null || droidExtension.status === "ok";
        providers.push({
          id: "droid-cli",
          name: "Factory AI — via Droid CLI",
          authenticated: droidEnabled && droidBinary.available && droidExtensionOk,
          type: "cli" as const,
        });
      }

      if (store) {
        let cursorEnabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          cursorEnabled = (globalSettings as Record<string, unknown>).useCursorCli === true;
        } catch {
          // best effort
        }
        const cursorBinary = await probeCursorCliWithStoredBinary();
        providers.push({
          id: "cursor-cli",
          name: "Cursor — via Cursor CLI",
          authenticated: cursorEnabled && cursorBinary.available,
          type: "cli" as const,
        });
      }

      /*
      FNXC:GrokCli 2026-07-09-00:00:
      FN-7716: inject the synthetic "Grok — via Grok CLI" provider, mirroring
      the cursor-cli injection above EXACTLY — `authenticated` derives from
      toggle+binary availability only. The `grok` CLI resolves its own
      credentials from more sources than Fusion can see (env var, project
      `.env`, `GROK_BASE_URL`, `grok -k`, sandbox secrets), so requiring a
      Fusion-visible API key produced false "not authenticated" states for
      operators with a fully working CLI. Key presence is exposed only via
      `grokBinary.apiKeyDetected` as a non-blocking informational field on the
      status route (see GET /providers/grok-cli/status below) — it never
      gates this `authenticated` flag.
      */
      if (store) {
        let grokEnabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          grokEnabled = (globalSettings as Record<string, unknown>).useGrokCli === true;
        } catch {
          // best effort
        }
        const grokBinary = await probeGrokCliWithStoredBinary();
        providers.push({
          id: "grok-cli",
          name: "Grok — via Grok CLI",
          authenticated: grokEnabled && grokBinary.available,
          type: "cli" as const,
        });
      }

      /*
      FNXC:OmpAcp 2026-07-13-22:50:
      Inject synthetic "Oh My Pi — via omp ACP" provider. authenticated = toggle + binary available; omp owns credentials under ~/.omp.
      */
      if (store) {
        let ompEnabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          ompEnabled = (globalSettings as Record<string, unknown>).useOmpCli === true;
        } catch {
          // best effort
        }
        const ompBinary = await probeOmpCliWithStoredBinary();
        providers.push({
          id: "omp-cli",
          name: "Oh My Pi — via omp ACP",
          authenticated: ompEnabled && ompBinary.available,
          type: "cli" as const,
        });
      }

      // Inject synthetic llama.cpp provider.
      if (store) {
        let llamaEnabled = false;
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          llamaEnabled = globalSettings.useLlamaCpp === true;
        } catch {
          // Best-effort
        }
        const llamaExtension = options?.getLlamaCppExtensionStatus?.() ?? null;
        const extensionOk = llamaExtension === null || llamaExtension.status === "ok";
        const probe = await probeLlamaCpp();
        providers.push({
          id: "llama-cpp",
          name: "llama.cpp — via HTTP server",
          authenticated: llamaEnabled && probe.reachable && extensionOk,
          type: "cli" as const,
        });
      }

      const ghCli = {
        available: isGhAvailable(),
        authenticated: isGhAuthenticated(),
      };
      let gitCli: Awaited<ReturnType<typeof probeGitCliStatus>>;
      try {
        gitCli = await probeGitCliStatus();
      } catch {
        gitCli = { available: false, installUrl: GIT_INSTALL_URL };
      }

      /*
      FNXC:ProviderAuth 2026-08-01-06:11:
      Status remains the full provider envelope: a targeted instance only re-points its named
      provider. A missing well-formed target is safely unauthenticated, never default fallback.
      */
      const instanceProviders = providers.map((provider) => {
        if (syntheticCliProviderIds.has(provider.id)) return provider;
        const target = requestedProvider === provider.id ? requestedInstance : undefined;
        const defaultRef = storage.getDefaultInstance?.(provider.id);
        const instanceId = target ?? defaultRef?.instanceId ?? DEFAULT_PROVIDER_INSTANCE_ID;
        const ref = { providerId: provider.id, instanceId };
        const credential = target ? storage.getInstance?.(ref) : undefined;
        if (target && !credential && storage.getInstance) {
          return { ...provider, instanceId, authenticated: false, expired: false, keyHint: undefined, instances: [] };
        }
        const refs = storage.listInstances?.(provider.id) ?? [];
        const targetedCredential = target ? credential : undefined;
        const targetedKey = targetedCredential?.type === "api_key" && typeof targetedCredential.key === "string"
          ? targetedCredential.key : undefined;
        const targetExpired = targetedCredential?.type === "oauth"
          && (typeof targetedCredential.expires !== "number" || Date.now() >= targetedCredential.expires);
        return {
          ...provider,
          /*
          FNXC:ProviderAuth 2026-08-01-06:57:
          A targeted poll is also the UI's per-row flow signal, so it must not report a sibling
          account's in-flight login as this account's activity.
          */
          ...(target ? { loginInProgress: loginInProgress.has(loginKey(provider.id, instanceId)) } : {}),
          ...(targetedCredential ? {
            authenticated: targetedCredential.type === "api_key" ? Boolean(targetedKey) : !targetExpired,
            expired: Boolean(targetExpired),
            ...(targetedKey ? { keyHint: maskApiKey(targetedKey) } : { keyHint: undefined }),
          } : {}),
          instanceId,
          instances: (target ? refs.filter((item) => item.instanceId === instanceId) : refs)
            .map((item) => {
              const instanceCredential = storage.getInstance?.({ providerId: provider.id, instanceId: item.instanceId });
              const instanceKey = instanceCredential?.type === "api_key" && typeof instanceCredential.key === "string"
                ? instanceCredential.key : undefined;
              const expired = instanceCredential?.type === "oauth"
                && (typeof instanceCredential.expires !== "number" || Date.now() >= instanceCredential.expires);
              return {
                instanceId: item.instanceId,
                ...(typeof instanceCredential?.label === "string" ? { label: instanceCredential.label } : {}),
                isDefault: item.instanceId === defaultRef?.instanceId,
                authenticated: instanceCredential?.type === "api_key" ? Boolean(instanceKey) : Boolean(instanceCredential) && !expired,
                expired: Boolean(expired),
                ...(instanceCredential?.type ? { type: instanceCredential.type } : {}),
                ...(instanceKey ? { keyHint: maskApiKey(instanceKey) } : {}),
              };
            }),
        };
      });
      res.json({ providers: instanceProviders, ghCli, gitCli });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/providers/claude-cli/status
   * Dedicated diagnostic endpoint for the "Anthropic — via Claude CLI"
   * provider card. Runs three checks:
   *   1. `claude --version` binary probe (with short timeout)
   *   2. GlobalSettings.useClaudeCli toggle state
   *   3. Cached @fusion/pi-claude-cli extension resolution from the host
   *
   * Response fields are structured so the frontend can render a clear
   * "what's working, what isn't" breakdown without itself having to know
   * about pi internals.
   */
  /**
   * POST /api/auth/claude-cli
   * Enable or disable the "Anthropic — via Claude CLI" synthetic provider.
   * Body: { enabled: boolean }
   *
   * Rather than add yet another settings API, this delegates to the
   * existing PUT /api/settings/global path — same cache invalidation,
   * same onUseClaudeCliToggled hook firing, same downstream skill
   * backfill behavior. The thin wrapper exists so the frontend provider
   * card has a shape-appropriate endpoint ("turn this provider on/off")
   * without calling a generic settings route.
   *
   * When `enabled=true` is requested we probe the claude binary first
   * and refuse if it's missing — saving the user from a confusing state
   * where the toggle is "on" but nothing actually works.
   */
  router.post("/auth/claude-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }

      if (enabled) {
        const binary = await probeClaudeCli();
        if (!binary.available) {
          throw new ApiError(
            400,
            `Cannot enable Claude CLI routing: ${binary.reason ?? "claude binary not available"}`,
          );
        }
      }

      // Snapshot prior value so we only fire the toggle hook on an actual
      // transition — mirrors the logic in PUT /api/settings/global.
      let prev = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prev = priorGlobal.useClaudeCli === true;
      } catch {
        // Unreadable prior — treat as false so a first enable still fires.
      }

      const settings = await store.updateGlobalSettings({ useClaudeCli: enabled });
      invalidateAllGlobalSettingsCaches();
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      const next = settings.useClaudeCli === true;
      if (options?.onUseClaudeCliToggled && prev !== next) {
        try {
          options.onUseClaudeCliToggled(prev, next);
        } catch (hookErr) {
          severityAuditLog.warn(
            `[auth/claude-cli] onUseClaudeCliToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json({
        enabled: next,
        // The pi-claude-cli extension is now always loaded; toggling
        // this setting only flips the /api/models filter, which takes
        // effect on the next picker fetch. No restart needed.
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/auth/droid-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }

      if (enabled) {
        const binary = await probeDroidCliWithEffectiveBinary(req);
        if (!binary.available) {
          throw new ApiError(
            400,
            `Cannot enable Droid CLI routing: ${binary.reason ?? "droid binary not available"}`,
          );
        }
      }

      // Snapshot prior value so we only fire the toggle hook on an actual
      // transition — mirrors the logic in PUT /api/settings/global.
      let prev = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prev = priorGlobal.useDroidCli === true;
      } catch {
        // Unreadable prior — treat as false so a first enable still fires.
      }

      const settings = await store.updateGlobalSettings({ useDroidCli: enabled });
      invalidateAllGlobalSettingsCaches();
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      const next = settings.useDroidCli === true;
      if (options?.onUseDroidCliToggled && prev !== next) {
        try {
          options.onUseDroidCliToggled(prev, next);
        } catch (hookErr) {
          severityAuditLog.warn(
            `[auth/droid-cli] onUseDroidCliToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json({
        enabled: next,
        // The droid-cli provider toggle flips provider routing state and takes
        // effect immediately for new model selections. No restart needed.
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/claude-cli/status", async (_req, res) => {
    try {
      const binary = await probeClaudeCli();
      let enabled = false;
      let acpEnabled = true; // experimentalFeatures.claudeCliAcp defaults ON
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useClaudeCli === true;
          acpEnabled =
            (globalSettings as { experimentalFeatures?: Record<string, boolean> })
              .experimentalFeatures?.claudeCliAcp !== false;
        } catch {
          // Best-effort: unreadable settings still allow the binary probe
          // to surface, just with enabled=false.
        }
      }
      const extension = options?.getClaudeCliExtensionStatus?.() ?? null;
      // ACP transport (Route A): active only when Claude CLI is on, the
      // experimental flag is on, AND the acp-runtime plugin published a bridge
      // path (FUSION_CLAUDE_ACP_BRIDGE). Otherwise the provider uses `claude -p`.
      const acpBridgeAvailable =
        typeof process.env.FUSION_CLAUDE_ACP_BRIDGE === "string" &&
        process.env.FUSION_CLAUDE_ACP_BRIDGE.length > 0;
      // FNXC:ClaudeAcp 2026-06-15-11:40:
      // `active` must reflect the ACTUAL dispatch determinant — FUSION_CLAUDE_ACP
      // (set by applyClaudeAcpEnable from the flag OR the operator force-override),
      // not the flag alone — so the status isn't misleading when an operator forces
      // it on/off.
      const acpEnvOn = process.env.FUSION_CLAUDE_ACP === "1";
      // R17: the driver writes this signal when a turn comes back "Not logged in"
      // (the bridged `claude` can't authenticate). Surface it so the UI can offer
      // fall-back-to-`-p` or fix-auth. Path matches ACP_BRIDGE_AUTH_SIGNAL_PATH.
      let acpAuthFailed = false;
      let acpAuthReason: string | undefined;
      try {
        const signalPath = join(tmpdir(), "fusion-acp-bridge-auth.json");
        if (existsSync(signalPath)) {
          const sig = JSON.parse(readFileSync(signalPath, "utf8")) as { authFailed?: boolean; reason?: string };
          if (sig?.authFailed) {
            acpAuthFailed = true;
            acpAuthReason = typeof sig.reason === "string" ? sig.reason : undefined;
          }
        }
      } catch {
        // best-effort; absence of the signal means no known auth failure
      }

      res.json({
        binary,
        enabled,
        extension,
        acp: {
          enabled: acpEnabled,
          bridgeAvailable: acpBridgeAvailable,
          active: enabled && acpBridgeAvailable && acpEnvOn,
          authFailed: acpAuthFailed,
          authReason: acpAuthReason,
        },
        // Convenience field: the provider card considers everything "ready"
        // when the binary is available, the user has enabled the toggle,
        // AND the host loaded the extension without error. Surfacing this
        // keeps the UI render logic simple.
        ready:
          binary.available &&
          enabled &&
          (extension === null || extension.status === "ok"),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/droid-cli/status", async (req, res) => {
    try {
      const binary = await probeDroidCliWithEffectiveBinary(req);
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useDroidCli === true;
        } catch {
          // Best-effort
        }
      }
      const extension = options?.getDroidCliExtensionStatus?.() ?? null;
      res.json({
        binary,
        enabled,
        extension,
        ready: binary.available && enabled && (extension === null || extension.status === "ok"),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/auth/cursor-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const requestedEnabled = req.body?.enabled;
      const hasEnabledPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "enabled");
      const requestedBinaryPath = req.body?.binaryPath;
      const hasBinaryPathPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "binaryPath");
      if (!hasEnabledPatch && !hasBinaryPathPatch) {
        throw badRequest("enabled or binaryPath is required");
      }
      if (hasEnabledPatch && typeof requestedEnabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (hasBinaryPathPatch && requestedBinaryPath !== null && typeof requestedBinaryPath !== "string") {
        throw badRequest("binaryPath must be a string or null");
      }

      const currentSettings = await store.getGlobalSettingsStore().getSettings();
      const enabled = hasEnabledPatch ? requestedEnabled : (currentSettings as Record<string, unknown>).useCursorCli === true;
      const currentBinaryPath = normalizeCursorCliBinaryPath(currentSettings.cursorCliBinaryPath);
      const nextBinaryPath = hasBinaryPathPatch
        ? normalizeCursorCliBinaryPath(requestedBinaryPath)
        : currentBinaryPath;

      if (hasBinaryPathPatch && nextBinaryPath) {
        const binary = await probeCursorCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available || !binary.usingConfiguredBinaryPath) {
          throw new ApiError(400, `Cannot save Cursor CLI binary path: ${binary.reason ?? "configured binary not available"}`);
        }
      }

      if (enabled) {
        const binary = await probeCursorCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available) {
          throw new ApiError(400, `Cannot enable Cursor CLI routing: ${binary.reason ?? "cursor binary not available"}`);
        }
      }

      const patch: Record<string, unknown> = {};
      if (hasEnabledPatch) {
        patch.useCursorCli = enabled;
      }
      if (hasBinaryPathPatch) {
        patch.cursorCliBinaryPath = nextBinaryPath ?? null;
      }
      const settings = await store.updateGlobalSettings(patch);
      invalidateAllGlobalSettingsCaches();
      res.json({
        enabled: (settings as Record<string, unknown>).useCursorCli === true,
        binaryPath: normalizeCursorCliBinaryPath((settings as Record<string, unknown>).cursorCliBinaryPath),
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/cursor-cli/status", async (_req, res) => {
    try {
      const binaryPath = await readCursorCliBinaryPath();
      const binary = await probeCursorCliProvider({ binaryPath });
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = (globalSettings as Record<string, unknown>).useCursorCli === true;
        } catch {
          // best effort
        }
      }
      res.json({ binary, enabled, binaryPath, extension: null, ready: enabled && binary.available });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:GrokCli 2026-07-08-00:00:
  FN-7705: POST /auth/grok-cli mirrors POST /auth/cursor-cli's enable/disable +
  binaryPath contract exactly. "Cannot enable" only requires the binary to be
  available (mirroring Cursor) — API-key presence is surfaced via the probe's
  `authenticated`/`reason` fields on the status route rather than blocking
  enable, since an operator may enable routing before setting GROK_API_KEY.
  */
  router.post("/auth/grok-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const requestedEnabled = req.body?.enabled;
      const hasEnabledPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "enabled");
      const requestedBinaryPath = req.body?.binaryPath;
      const hasBinaryPathPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "binaryPath");
      if (!hasEnabledPatch && !hasBinaryPathPatch) {
        throw badRequest("enabled or binaryPath is required");
      }
      if (hasEnabledPatch && typeof requestedEnabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (hasBinaryPathPatch && requestedBinaryPath !== null && typeof requestedBinaryPath !== "string") {
        throw badRequest("binaryPath must be a string or null");
      }

      const currentSettings = await store.getGlobalSettingsStore().getSettings();
      const enabled = hasEnabledPatch ? requestedEnabled : (currentSettings as Record<string, unknown>).useGrokCli === true;
      const currentBinaryPath = normalizeGrokCliBinaryPath((currentSettings as Record<string, unknown>).grokCliBinaryPath);
      const nextBinaryPath = hasBinaryPathPatch
        ? normalizeGrokCliBinaryPath(requestedBinaryPath)
        : currentBinaryPath;

      if (hasBinaryPathPatch && nextBinaryPath) {
        const binary = await probeGrokCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available || !binary.usingConfiguredBinaryPath) {
          throw new ApiError(400, `Cannot save Grok CLI binary path: ${binary.reason ?? "configured binary not available"}`);
        }
      }

      if (enabled) {
        const binary = await probeGrokCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available) {
          throw new ApiError(400, `Cannot enable Grok CLI routing: ${binary.reason ?? "grok binary not available"}`);
        }
      }

      const patch: Record<string, unknown> = {};
      if (hasEnabledPatch) {
        patch.useGrokCli = enabled;
      }
      if (hasBinaryPathPatch) {
        patch.grokCliBinaryPath = nextBinaryPath ?? null;
      }
      const settings = await store.updateGlobalSettings(patch);
      invalidateAllGlobalSettingsCaches();
      res.json({
        enabled: (settings as Record<string, unknown>).useGrokCli === true,
        binaryPath: normalizeGrokCliBinaryPath((settings as Record<string, unknown>).grokCliBinaryPath),
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/grok-cli/status", async (_req, res) => {
    try {
      const binaryPath = await readGrokCliBinaryPath();
      const binary = await probeGrokCliProvider({ binaryPath });
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = (globalSettings as Record<string, unknown>).useGrokCli === true;
        } catch {
          // best effort
        }
      }
      res.json({ binary, enabled, binaryPath, extension: null, ready: enabled && binary.available });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:OmpAcp 2026-07-13-22:50:
  POST /auth/omp-cli mirrors Grok/Cursor enable/disable + binaryPath contract. Enable requires binary available; omp auth stays under ~/.omp.
  */
  router.post("/auth/omp-cli", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const requestedEnabled = req.body?.enabled;
      const hasEnabledPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "enabled");
      const requestedBinaryPath = req.body?.binaryPath;
      const hasBinaryPathPatch = Object.prototype.hasOwnProperty.call(req.body ?? {}, "binaryPath");
      if (!hasEnabledPatch && !hasBinaryPathPatch) {
        throw badRequest("enabled or binaryPath is required");
      }
      if (hasEnabledPatch && typeof requestedEnabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      if (hasBinaryPathPatch && requestedBinaryPath !== null && typeof requestedBinaryPath !== "string") {
        throw badRequest("binaryPath must be a string or null");
      }

      const currentSettings = await store.getGlobalSettingsStore().getSettings();
      const enabled = hasEnabledPatch ? requestedEnabled : (currentSettings as Record<string, unknown>).useOmpCli === true;
      const currentBinaryPath = normalizeOmpCliBinaryPath((currentSettings as Record<string, unknown>).ompCliBinaryPath);
      const nextBinaryPath = hasBinaryPathPatch
        ? normalizeOmpCliBinaryPath(requestedBinaryPath)
        : currentBinaryPath;

      if (hasBinaryPathPatch && nextBinaryPath) {
        const binary = await probeOmpCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available || !binary.usingConfiguredBinaryPath) {
          throw new ApiError(400, `Cannot save OMP CLI binary path: ${binary.reason ?? "configured binary not available"}`);
        }
      }

      if (enabled) {
        const binary = await probeOmpCliProvider({ binaryPath: nextBinaryPath });
        if (!binary.available) {
          throw new ApiError(400, `Cannot enable OMP CLI routing: ${binary.reason ?? "omp binary not available"}`);
        }
      }

      const patch: Record<string, unknown> = {};
      if (hasEnabledPatch) {
        patch.useOmpCli = enabled;
      }
      if (hasBinaryPathPatch) {
        patch.ompCliBinaryPath = nextBinaryPath ?? null;
      }
      const settings = await store.updateGlobalSettings(patch);
      invalidateAllGlobalSettingsCaches();
      res.json({
        enabled: (settings as Record<string, unknown>).useOmpCli === true,
        binaryPath: normalizeOmpCliBinaryPath((settings as Record<string, unknown>).ompCliBinaryPath),
        restartRequired: false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/omp-cli/status", async (_req, res) => {
    try {
      const binaryPath = await readOmpCliBinaryPath();
      const binary = await probeOmpCliProvider({ binaryPath });
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = (globalSettings as Record<string, unknown>).useOmpCli === true;
        } catch {
          // best effort
        }
      }
      res.json({ binary, enabled, binaryPath, extension: null, ready: enabled && binary.available });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/auth/llama-cpp", async (req, res) => {
    try {
      if (!store) {
        throw new ApiError(500, "Settings store unavailable");
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }

      if (enabled) {
        const probe = await probeLlamaCpp();
        if (!probe.reachable) {
          throw new ApiError(400, `Cannot enable llama.cpp routing: ${probe.reason ?? "server unreachable"}`);
        }
      }

      let prev = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prev = priorGlobal.useLlamaCpp === true;
      } catch {
        // best effort
      }

      const settings = await store.updateGlobalSettings({ useLlamaCpp: enabled });
      invalidateAllGlobalSettingsCaches();
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      const next = settings.useLlamaCpp === true;
      if (options?.onUseLlamaCppToggled && prev !== next) {
        try {
          options.onUseLlamaCppToggled(prev, next);
        } catch (hookErr) {
          severityAuditLog.warn(
            `[auth/llama-cpp] onUseLlamaCppToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json({ enabled: next, restartRequired: false });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/providers/llama-cpp/status", async (_req, res) => {
    try {
      const probe = await probeLlamaCpp();
      let enabled = false;
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useLlamaCpp === true;
        } catch {
          // best-effort
        }
      }
      const extension = options?.getLlamaCppExtensionStatus?.() ?? null;
      const ready = enabled && probe.reachable && (extension === null || extension.status === "ok");
      res.json({
        enabled,
        extension,
        ready,
        server: {
          available: probe.reachable,
          url: probe.url,
          hasApiKey: probe.hasApiKey,
          reason: probe.reason,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/login
   * Initiates OAuth login for a provider.
   * Body: { provider: string }
   * Response: { url: string, instructions?: string }
   *
   * The endpoint starts the OAuth flow and returns the auth URL from the
   * onAuth callback. The client should open this URL in a new tab and
   * poll GET /api/auth/status to detect completion.
   */
  router.post("/auth/login", async (req, res) => {
    try {
      const { provider, origin, instance, label } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (origin !== undefined && typeof origin !== "string") {
        throw badRequest("origin must be a string when provided");
      }
      // Validate before invoking OAuth; storage fallback retains legacy default behavior.
      const instanceId = resolveInstanceId(instance);
      const hasNamedInstance = hasExplicitInstance(instance);
      const instanceLabel = validateLabel(label);
      if (hasNamedInstance && syntheticCliProviderIds.has(provider)) throw badRequest("CLI providers do not support credential instances");
      const storageProvider = toOauthLoginProviderId(provider);
      const flowKey = loginKey(provider, instanceId);

      // Different accounts may authenticate together; only a duplicate account flow conflicts.
      if (loginInProgress.has(flowKey)) {
        throw conflict(`Login already in progress for ${provider}`);
      }

      // Fresh login attempt clears any prior background failure for this provider.
      lastLoginError.delete(provider);

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider || p.id === storageProvider);
      if (!found) {
        /*
         * FNXC:ProviderAuth 2026-07-07-00:00:
         * FN-7624: `github` is NOT a dashboard-managed OAuth provider — pi's OAuth registry only
         * ships `anthropic`, `github-copilot`, and `openai-codex` (see @earendil-works/pi-ai/oauth via
         * packages/engine/src/auth-storage.ts). Fusion's real GitHub integration is gh CLI / token
         * based (`githubAuthMode: "gh-cli" | "token"`), so the onboarding/settings UI must never offer
         * a dashboard OAuth login for `github`. If this branch is ever reached for `github` anyway
         * (e.g. a stale client build), return a clear, actionable message naming the provider and that
         * no OAuth flow exists for it — never a generic/misleading error like "model not found".
         */
        throw badRequest(
          `Unknown provider: "${provider}" has no registered OAuth login flow. Registered dashboard OAuth providers are: ${oauthProviders.map((p) => p.id).join(", ") || "none"}. GitHub integration uses the GitHub CLI (run \`gh auth login\`) or a token, not dashboard OAuth.`,
        );
      }
      const loginProvider = found.id === provider ? provider : storageProvider;

      const abortController = new AbortController();
      let resolveInput: (value: string) => void = () => {};
      let rejectInput: (error: Error) => void = () => {};
      const inputPromise = new Promise<string>((resolve, reject) => {
        resolveInput = resolve;
        rejectInput = reject;
      });
      // Cancellation can reject this promise before the upstream provider has
      // actually awaited it. Keep the rejection observed so dashboard cancel
      // does not create unhandled rejection noise.
      void inputPromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "cancelled") {
          severityAuditLog.warn(`[auth/login] manual OAuth input promise rejected for ${provider}: ${message}`);
        }
      });
      const pendingLogin: PendingLogin = {
         provider,
         abortController,
         inputPromise,
         resolveInput,
         rejectInput,
         inputSubmitted: false,
         manualCode: getManualCodeConfig(storageProvider, origin),
         instanceId,
         label: instanceLabel,
       };
       loginInProgress.set(flowKey, pendingLogin);

      let autoPromptConsumed = false;

      // We need to get auth kickoff info from callbacks before responding.
      // The login() call continues in the background until the user completes OAuth.
      let authResolve: (info: { url: string; instructions?: string; deviceCode?: DeviceCodeInfo }) => void;
      let authReject: (err: Error) => void;
      let authSettled = false;
      const authUrlPromise = new Promise<{ url: string; instructions?: string; deviceCode?: DeviceCodeInfo }>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
      });
      const resolveAuthInfo = (info: { url: string; instructions?: string; deviceCode?: DeviceCodeInfo }) => {
        if (authSettled) return;
        authSettled = true;
        authResolve(info);
      };
      const rejectAuthInfo = (err: Error) => {
        if (authSettled) return;
        authSettled = true;
        authReject(err);
      };

      let resolvedDeviceCode: DeviceCodeInfo | undefined;

      // Start login flow in background — don't await the full login
      const loginCallbacks: Parameters<AuthStorageLike["login"]>[1] = {
        onAuth: (info) => {
          if (!resolvedDeviceCode) {
            const parsedUserCode =
              storageProvider === "github-copilot" && info.instructions
                ? parseGitHubCopilotDeviceCode(info.instructions)
                : undefined;
            if (parsedUserCode) {
              resolvedDeviceCode = {
                userCode: parsedUserCode,
                verificationUri: info.url,
              };
            }
          }

          resolveAuthInfo({
            url: info.url,
            instructions: appendManualCodeHint(info.instructions, storageProvider, origin),
            deviceCode: resolvedDeviceCode,
          });
        },
        onDeviceCode: (info) => {
          resolvedDeviceCode = {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
          };

          resolveAuthInfo({
            url: info.verificationUri,
            instructions: appendManualCodeHint(undefined, storageProvider, origin),
            deviceCode: resolvedDeviceCode,
          });
        },
        onPrompt: async (_prompt) => {
          if (providerWantsAutoPrompt(storageProvider) && !autoPromptConsumed) {
            autoPromptConsumed = true;
            return "";
          }
          return await pendingLogin.inputPromise;
        },
        // AuthStorage.login() forwards callbacks to provider-specific OAuth
        // implementations verbatim. openai-codex supports this optional hook
        // to race pasted codes against the localhost callback server.
        onManualCodeInput: async () => await pendingLogin.inputPromise,
        onProgress: () => {}, // no-op for web UI
        onSelect: async (prompt) => selectOauthOption(storageProvider, prompt),
        signal: abortController.signal,
      };
      const loginPromise = hasNamedInstance && storage.loginInstance
        ? storage.loginInstance({ providerId: loginProvider, instanceId }, loginCallbacks, instanceLabel)
        : storage.login(loginProvider, loginCallbacks);

      // Race: either we get the auth URL or the login completes/fails first
      const timeout = setTimeout(() => {
        rejectAuthInfo(new Error("Login initiation timed out"));
      }, 30_000);

      loginPromise
        .then(() => {
          // Login completed (user finished OAuth in browser)
        })
        .catch((err: unknown) => {
          // Login failed — also reject auth URL if not yet received
          const error = err instanceof Error ? err : new Error(String(err));
          // Surface the real cause: reject the auth-URL promise if it hasn't
          // resolved yet, and always retain + log the error. Once the auth URL
          // is already sent, rejectAuthInfo is a no-op, so this retained error
          // is the only channel by which the client learns why login failed.
          rejectAuthInfo(error);
          if (error.message !== "cancelled") {
            lastLoginError.set(provider, error.message);
            severityAuditLog.error(`[auth/login] background login failed for ${provider}: ${error.message}`);
          }
        })
        .finally(() => {
          clearTimeout(timeout);
          loginInProgress.delete(flowKey);
          deleteOauthSessionsForFlow(flowKey);
        });

      const authInfo = await authUrlPromise;
      clearTimeout(timeout);

      let responseUrl = authInfo.url;
      if (shouldRewriteOauthRedirect(provider, origin)) {
        const rewritten = rewriteAuthUrl(authInfo.url, origin);
        setOauthSession(rewritten.state, {
          port: rewritten.port,
          path: rewritten.path,
          originalRedirectUri: rewritten.originalRedirectUri,
          flowKey,
          provider,
          instanceId,
        });
        responseUrl = rewritten.url;
      }

      res.json({
        url: responseUrl,
        instructions: authInfo.instructions,
        manualCode: pendingLogin.manualCode,
        deviceCode: authInfo.deviceCode,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Clean up on error
      const provider = req.body?.provider;
      if (provider) {
        const flowKey = loginKey(provider, resolveInstanceId(req.body?.instance));
        loginInProgress.delete(flowKey);
        deleteOauthSessionsForFlow(flowKey);
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/cancel
   * Cancel an in-progress OAuth login for a provider.
   * Body: { provider: string }
   * Response: { success: true, cancelled: boolean }
   */
  router.post("/auth/cancel", (req, res) => {
    try {
      const { provider, instance } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const activeLogin = loginInProgress.get(loginKey(provider, resolveInstanceId(instance)));
      if (!activeLogin) {
        res.json({ success: true, cancelled: false });
        return;
      }

      const activeFlowKey = loginKey(provider, activeLogin.instanceId);
      cancelOauthFlow(activeFlowKey, new Error("cancelled"));
      res.json({ success: true, cancelled: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/manual-code
   * Submit a pasted OAuth callback URL or authorization code for an active login.
   * Body: { provider: string, code: string }
   * Response: { success: true, submitted: boolean }
   */
  router.post("/auth/manual-code", async (req, res) => {
    try {
      const { provider, code, instance } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (!code || typeof code !== "string" || !code.trim()) {
        throw badRequest("code is required");
      }

      const instanceId = resolveInstanceId(instance);
      const activeLogin = loginInProgress.get(loginKey(provider, instanceId));
      const providerFlow = [...loginInProgress.values()].find((flow) => flow.provider === provider);
      if (!activeLogin) {
        if (hasExplicitInstance(instance) && providerFlow && providerFlow.instanceId !== instanceId) {
          throw badRequest("instance does not match the active login flow");
        }
        throw conflict(`No login in progress for ${provider}`);
      }

      if (hasExplicitInstance(instance) && instanceId !== activeLogin.instanceId) throw badRequest("instance does not match the active login flow");
      if (activeLogin.inputSubmitted) {
        res.json({ success: true, submitted: false });
        return;
      }

      const storageProvider = toOauthLoginProviderId(provider);
      activeLogin.inputSubmitted = true;
      await deliverManualOAuthCallbackToLocalListener(storageProvider, code);
      activeLogin.resolveInput(normalizeManualOAuthInputForProvider(storageProvider, code));
      res.json({ success: true, submitted: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/auth/oauth-callback", async (req, res) => {
    try {
      const error = typeof req.query.error === "string" ? req.query.error : undefined;
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (error) {
        if (state) {
          const failedSession = oauthSessions.get(state);
          if (failedSession) {
            deleteOauthSession(state);
            const failedLogin = loginInProgress.get(failedSession.flowKey);
            if (failedLogin) {
              cancelOauthFlow(failedSession.flowKey, new Error("cancelled"));
            }
          }
        }
        return res.status(400).type("text/html").send(simpleErrorHtml("OAuth failed", error));
      }

      if (!code || !state) {
        return res.status(400).type("text/html").send(simpleErrorHtml("Missing OAuth parameters"));
      }

      cleanupExpiredOauthSessions();
      const session = oauthSessions.get(state);
      const activeLogin = session ? loginInProgress.get(session.flowKey) : undefined;
      if (!session || session.expiresAt <= Date.now() || !activeLogin || activeLogin.provider !== session.provider || activeLogin.instanceId !== session.instanceId) {
        if (session) deleteOauthSession(state);
        return res.status(400).type("text/html").send(simpleErrorHtml("OAuth session expired or not found"));
      }

      const callbackUrl = new URL(`http://localhost:${session.port}${session.path}`);
      // Consume before proxying so a network error cannot leave a replayable state session.
      deleteOauthSession(state);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      let callbackResponse: Response;
      try {
        callbackResponse = await fetch(callbackUrl, { method: "GET" });
      } catch (error) {
        // The state was consumed before forwarding; stop its bound flow on transport failure too.
        cancelOauthFlow(session.flowKey, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      const responseBody = await callbackResponse.text();
      const contentType = callbackResponse.headers.get("content-type") ?? "text/html";

      return res.status(callbackResponse.status).type(contentType).send(responseBody);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/logout
   * Removes credentials for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.post("/auth/logout", async (req, res) => {
    try {
      const { provider, instance } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      const instanceId = resolveInstanceId(instance);
      if (hasExplicitInstance(instance) && syntheticCliProviderIds.has(provider)) throw badRequest("CLI providers do not support credential instances");
      if (hasExplicitInstance(instance) && storage.logoutInstance) {
        const ref = { providerId: toOauthCredentialProviderId(provider), instanceId };
        if (!storage.getInstance?.(ref)) throw new ApiError(404, "Credential instance not found");
        await storage.logoutInstance(ref);
      } else {
        await storage.logout(toOauthCredentialProviderId(provider));
      }
      clearUsageCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/auth/api-key
   * Save an API key for an API-key-backed provider.
   * Body: { provider: string, apiKey: string }
   * Response: { success: true }
   *
   * Validates the provider exists, is API-key-backed, and the key is non-empty.
   * Never returns the key in any response.
   */
  router.post("/auth/api-key", async (req, res) => {
    try {
      const { provider, apiKey, instance, label } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        throw badRequest("apiKey is required and must be a non-empty string");
      }

      const storage = getAuthStorage();

      // Check that the storage supports API key management
      if (!storage.setApiKey) {
        throw badRequest("API key management is not supported");
      }

      // Validate the provider is an API-key-backed provider
      const apiKeyProviders = storage.getApiKeyProviders?.() ?? [];
      const found = apiKeyProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown API key provider: ${provider}`);
      }

      const instanceId = resolveInstanceId(instance);
      const instanceLabel = validateLabel(label);
      if (hasExplicitInstance(instance) && storage.setInstanceApiKey) {
        await storage.setInstanceApiKey({ providerId: provider, instanceId }, apiKey.trim(), instanceLabel);
      } else {
        await storage.setApiKey(provider, apiKey.trim());
      }

      let modelsRefreshed: number | undefined;
      let refreshReason: "no-models-from-cli" | "cli-failed" | "disabled-by-settings" | undefined;
      let refreshError: string | undefined;
      try {
        const refreshResult = await options?.onApiKeySaved?.(provider);
        if (refreshResult) {
          modelsRefreshed = refreshResult.registeredCount;
          refreshReason = refreshResult.reason;
          refreshError = refreshResult.error;
        }
      } catch (error) {
        refreshError = error instanceof Error ? error.message : String(error);
      }

      options?.modelRegistry?.refresh?.();
      clearUsageCache();
      res.json({
        success: true,
        ...(modelsRefreshed !== undefined ? { modelsRefreshed } : {}),
        ...(refreshReason ? { refreshReason } : {}),
        ...(refreshError ? { refreshError } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/auth/api-key
   * Remove an API key for a provider.
   * Body: { provider: string }
   * Response: { success: true }
   */
  router.delete("/auth/api-key", async (req, res) => {
    try {
      const { provider, instance } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      if (!storage.clearApiKey) {
        throw badRequest("API key management is not supported");
      }

      /*
      FNXC:ProviderAuth 2026-06-29-23:55:
      API-key save and clear must share the same provider-id allowlist so separated OAuth cards such as `anthropic-subscription` cannot accidentally clear raw API-key storage.
      */
      const apiKeyProviders = storage.getApiKeyProviders?.() ?? [];
      const found = apiKeyProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown API key provider: ${provider}`);
      }

      const instanceId = resolveInstanceId(instance);
      if (hasExplicitInstance(instance) && storage.clearInstanceApiKey) {
        const ref = { providerId: provider, instanceId };
        if (!storage.getInstance?.(ref)) throw new ApiError(404, "Credential instance not found");
        await storage.clearInstanceApiKey(ref);
      } else {
        await storage.clearApiKey(provider);
      }
      // No model refresh needed on delete: removing the key leaves nothing to sync.
      clearUsageCache();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/auth/providers/:provider/instances", (req, res) => {
    try {
      const provider = req.params.provider;
      const storage = getAuthStorage();
      const refs = storage.listInstances?.(provider) ?? (storage.hasAuth(provider) || storage.hasApiKey?.(provider)
        ? [{ providerId: provider, instanceId: DEFAULT_PROVIDER_INSTANCE_ID }]
        : []);
      const defaultRef = storage.getDefaultInstance?.(provider);
      res.json({ instances: refs.map((ref) => {
        const credential = storage.getInstance?.(ref);
        const key = credential?.type === "api_key" && typeof credential.key === "string" ? credential.key : undefined;
        // Instance listings must apply the same fail-safe OAuth expiry semantics as /auth/status.
        const expired = credential?.type === "oauth" && (typeof credential.expires !== "number" || !Number.isFinite(credential.expires) || Date.now() >= credential.expires);
        return {
          instanceId: ref.instanceId,
          ...(typeof credential?.label === "string" ? { label: credential.label } : {}),
          isDefault: (defaultRef?.instanceId ?? DEFAULT_PROVIDER_INSTANCE_ID) === ref.instanceId,
          authenticated: Boolean(credential ?? storage.hasAuth(provider)) && !expired,
          ...(expired ? { expired: true } : {}),
          ...(credential?.type ? { type: credential.type } : {}),
          ...(key ? { keyHint: maskApiKey(key) } : {}),
        };
      }) });
    } catch (err: unknown) { if (err instanceof ApiError) throw err; rethrowAsApiError(err); }
  });

  router.post("/auth/providers/:provider/instances/:instance/rename", async (req, res) => {
    try {
      const ref = { providerId: req.params.provider, instanceId: resolveInstanceId(req.params.instance) };
      const storage = getAuthStorage();
      if (!storage.getInstance?.(ref) || !storage.renameInstance) throw new ApiError(404, "Credential instance not found");
      await storage.renameInstance(ref, validateLabel(req.body?.label, true));
      res.json({ success: true });
    } catch (err: unknown) { if (err instanceof ApiError) throw err; rethrowAsApiError(err); }
  });

  router.post("/auth/providers/:provider/default-instance", async (req, res) => {
    try {
      const ref = { providerId: req.params.provider, instanceId: resolveInstanceId(req.body?.instance) };
      const storage = getAuthStorage();
      if (!storage.getInstance?.(ref) || !storage.setDefaultInstance) throw new ApiError(404, "Credential instance not found");
      await storage.setDefaultInstance(ref);
      res.json({ success: true });
    } catch (err: unknown) { if (err instanceof ApiError) throw err; rethrowAsApiError(err); }
  });

  router.delete("/auth/providers/:provider/instances/:instance", async (req, res) => {
    try {
      const ref = { providerId: req.params.provider, instanceId: resolveInstanceId(req.params.instance) };
      const storage = getAuthStorage();
      if (!storage.getInstance?.(ref) || !storage.removeInstance) throw new ApiError(404, "Credential instance not found");
      await storage.removeInstance(ref);
      clearUsageCache();
      res.json({ success: true });
    } catch (err: unknown) { if (err instanceof ApiError) throw err; rethrowAsApiError(err); }
  });
};
