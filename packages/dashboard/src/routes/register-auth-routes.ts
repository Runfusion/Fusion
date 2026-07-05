import type { Request } from "express";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { GIT_INSTALL_URL, isGhAvailable, isGhAuthenticated, probeGitCliStatus } from "@fusion/core";
import { probeClaudeCli } from "../claude-cli-probe.js";
import { probeDroidCli } from "../droid-cli-probe.js";
import { probeCursorCliProvider } from "../runtime-provider-probes.js";
import { probeLlamaCpp } from "../llama-cpp-probe.js";
import { ApiError, badRequest, conflict } from "../api-error.js";
import { clearUsageCache } from "../usage.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

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

  /**
   * Mask an API key for safe display.
   * - If key length <= 8: return 8 bullets (never reveal short keys)
   * - Otherwise: first 3 chars + 5 bullets + last 4 chars
   */
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

  function isExpiredOauthCredential(providerId: string, storage: AuthStorageLike): boolean {
    const credential = getOauthStatusCredential(providerId, storage);
    if (!credential || typeof credential.expires !== "number") {
      return false;
    }

    return Date.now() >= credential.expires;
  }

  type ManualCodeConfig = {
    prompt: string;
    placeholder?: string;
    helpText?: string;
  };

  type PendingLogin = {
    abortController: AbortController;
    inputPromise: Promise<string>;
    resolveInput: (input: string) => void;
    rejectInput: (error: Error) => void;
    inputSubmitted: boolean;
    manualCode?: ManualCodeConfig;
  };

  /**
   * Track in-progress login flows to prevent concurrent logins for the same provider.
   * Maps provider ID → pending interactive login state.
   */
  const loginInProgress = new Map<string, PendingLogin>();

  const OAUTH_SESSION_TTL_MS = 5 * 60 * 1000;
  const oauthSessions = new Map<string, { port: number; path: string; originalRedirectUri: string; expiresAt: number }>();

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

  function cleanupExpiredOauthSessions(): void {
    const now = Date.now();
    for (const [state, session] of oauthSessions.entries()) {
      if (session.expiresAt <= now) {
        oauthSessions.delete(state);
      }
    }
  }

  function setOauthSession(state: string, details: { port: number; path: string; originalRedirectUri: string }): void {
    cleanupExpiredOauthSessions();
    oauthSessions.set(state, { ...details, expiresAt: Date.now() + OAUTH_SESSION_TTL_MS });
    const timeout = setTimeout(() => {
      const current = oauthSessions.get(state);
      if (current && current.expiresAt <= Date.now()) {
        oauthSessions.delete(state);
      }
    }, OAUTH_SESSION_TTL_MS + 1_000);
    timeout.unref();
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

  function normalizeManualOAuthInputForProvider(providerId: string, input: string): string {
    if (providerId !== "anthropic" && providerId !== "openai-codex") {
      return input.trim();
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return trimmed;
    }

    try {
      const url = new URL(trimmed);
      const searchCode = url.searchParams.get("code");
      if (searchCode) {
        if (url.protocol === "http:" || url.protocol === "https:") {
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
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers: {
        id: string;
        name: string;
        authenticated: boolean;
        type: "oauth" | "api_key" | "cli";
        expired?: boolean;
        keyHint?: string;
        loginInProgress?: boolean;
        requiresManualCode?: boolean;
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
        return {
          id: statusProvider.id,
          name: statusProvider.name,
          authenticated: hasAuth && !expired,
          type: "oauth" as const,
          expired,
          loginInProgress: loginInProgress.has(statusProvider.id),
          requiresManualCode: getManualCodeConfig(toOauthLoginProviderId(statusProvider.id), origin) !== undefined || undefined,
        };
      }));

      // Include API-key-backed providers if supported
      if (storage.getApiKeyProviders) {
        const apiKeyProviders = storage.getApiKeyProviders();
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

      res.json({ providers, ghCli, gitCli });
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
          console.warn(
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
          console.warn(
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
          console.warn(
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
      const { provider, origin } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (origin !== undefined && typeof origin !== "string") {
        throw badRequest("origin must be a string when provided");
      }

      const storageProvider = toOauthLoginProviderId(provider);

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        throw conflict(`Login already in progress for ${provider}`);
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider || p.id === storageProvider);
      if (!found) {
        throw badRequest(`Unknown provider: ${provider}`);
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
          console.warn(`[auth/login] manual OAuth input promise rejected for ${provider}: ${message}`);
        }
      });
      const pendingLogin: PendingLogin = {
         abortController,
         inputPromise,
         resolveInput,
         rejectInput,
         inputSubmitted: false,
         manualCode: getManualCodeConfig(storageProvider, origin),
       };
       loginInProgress.set(provider, pendingLogin);

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
      const loginPromise = storage.login(loginProvider, {
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
      });

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
          rejectAuthInfo(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          clearTimeout(timeout);
          loginInProgress.delete(provider);
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
      if (provider) loginInProgress.delete(provider);
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
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const activeLogin = loginInProgress.get(provider);
      if (!activeLogin) {
        res.json({ success: true, cancelled: false });
        return;
      }

      loginInProgress.delete(provider);
      activeLogin.inputSubmitted = true;
      activeLogin.rejectInput(new Error("cancelled"));
      activeLogin.abortController.abort();
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
  router.post("/auth/manual-code", (req, res) => {
    try {
      const { provider, code } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }
      if (!code || typeof code !== "string" || !code.trim()) {
        throw badRequest("code is required");
      }

      const activeLogin = loginInProgress.get(provider);
      if (!activeLogin) {
        throw conflict(`No login in progress for ${provider}`);
      }

      if (activeLogin.inputSubmitted) {
        res.json({ success: true, submitted: false });
        return;
      }

      activeLogin.inputSubmitted = true;
      activeLogin.resolveInput(normalizeManualOAuthInputForProvider(toOauthLoginProviderId(provider), code));
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
        return res.status(400).type("text/html").send(simpleErrorHtml("OAuth failed", error));
      }

      if (!code || !state) {
        return res.status(400).type("text/html").send(simpleErrorHtml("Missing OAuth parameters"));
      }

      cleanupExpiredOauthSessions();
      const session = oauthSessions.get(state);
      if (!session || session.expiresAt <= Date.now()) {
        oauthSessions.delete(state);
        return res.status(400).type("text/html").send(simpleErrorHtml("OAuth session expired or not found"));
      }

      const callbackUrl = new URL(`http://localhost:${session.port}${session.path}`);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      const callbackResponse = await fetch(callbackUrl, { method: "GET" });
      const responseBody = await callbackResponse.text();
      const contentType = callbackResponse.headers.get("content-type") ?? "text/html";

      oauthSessions.delete(state);

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
  router.post("/auth/logout", (req, res) => {
    try {
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
      }

      const storage = getAuthStorage();
      storage.logout(toOauthCredentialProviderId(provider));
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
      const { provider, apiKey } = req.body;
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

      storage.setApiKey(provider, apiKey.trim());

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
  router.delete("/auth/api-key", (req, res) => {
    try {
      const { provider } = req.body;
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

      storage.clearApiKey(provider);
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
};
