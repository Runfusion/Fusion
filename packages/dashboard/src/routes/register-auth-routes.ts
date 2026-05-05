import type { Request } from "express";
import { isGhAvailable, isGhAuthenticated } from "@fusion/core";
import { probeClaudeCli } from "../claude-cli-probe.js";
import { probeDroidCli } from "../droid-cli-probe.js";
import { probeLlamaCpp } from "../llama-cpp-probe.js";
import { ApiError, badRequest, conflict } from "../api-error.js";
import { clearUsageCache } from "../usage.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

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

  function isExpiredOauthCredential(providerId: string, storage: AuthStorageLike): boolean {
    const credential = storage.get?.(providerId);
    if (!credential || credential.type !== "oauth" || typeof credential.expires !== "number") {
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

  function shouldRewriteOauthRedirect(providerId: string, origin: string | undefined): boolean {
    if (!origin || isLocalhostOrigin(origin)) {
      return false;
    }

    // The upstream OpenAI Codex OAuth provider is hardcoded to request and
    // later redeem the localhost callback URI `http://localhost:1455/auth/callback`.
    // Rewriting that authorize-time redirect_uri to the dashboard proxy causes
    // OpenAI auth to fail with an upstream unknown_error. Keep the original
    // localhost callback for this provider.
    if (providerId === "openai-codex") {
      return false;
    }

    return true;
  }

  function getManualCodeConfig(providerId: string, origin: string | undefined): ManualCodeConfig | undefined {
    if (providerId !== "openai-codex") {
      return undefined;
    }

    const remoteDashboard = origin !== undefined && !isLocalhostOrigin(origin);
    return {
      prompt: "Paste the final redirect URL or authorization code",
      placeholder: "http://localhost:1455/auth/callback?code=...&state=... or just the code",
      helpText: remoteDashboard
        ? "After sign-in, OpenAI may redirect to a localhost callback that cannot open from this dashboard host. Copy the full browser URL from the address bar and paste it here."
        : "If the browser cannot finish the localhost callback automatically, copy the full browser URL from the address bar and paste it here.",
    };
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
   *   ghCli: { available: boolean, authenticated: boolean }
   * }
   */
  router.get("/auth/status", async (req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers: {
        id: string;
        name: string;
        authenticated: boolean;
        type: "oauth" | "api_key" | "cli";
        keyHint?: string;
        loginInProgress?: boolean;
      }[] = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id) && !isExpiredOauthCredential(p.id, storage),
        type: "oauth" as const,
        loginInProgress: loginInProgress.has(p.id),
      }));

      // Include API-key-backed providers if supported
      if (storage.getApiKeyProviders) {
        const apiKeyProviders = storage.getApiKeyProviders();
        for (const p of apiKeyProviders) {
          // Skip if already listed as an OAuth provider (avoid duplicates)
          if (providers.some((existing) => existing.id === p.id)) continue;
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

      res.json({ providers, ghCli });
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
      if (store) {
        try {
          const globalSettings = await store.getGlobalSettingsStore().getSettings();
          enabled = globalSettings.useClaudeCli === true;
        } catch {
          // Best-effort: unreadable settings still allow the binary probe
          // to surface, just with enabled=false.
        }
      }
      const extension = options?.getClaudeCliExtensionStatus?.() ?? null;

      res.json({
        binary,
        enabled,
        extension,
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

      // Prevent concurrent logins for the same provider
      if (loginInProgress.has(provider)) {
        throw conflict(`Login already in progress for ${provider}`);
      }

      const storage = getAuthStorage();
      const oauthProviders = storage.getOAuthProviders();
      const found = oauthProviders.find((p) => p.id === provider);
      if (!found) {
        throw badRequest(`Unknown provider: ${provider}`);
      }

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
        manualCode: getManualCodeConfig(provider, origin),
      };
      loginInProgress.set(provider, pendingLogin);

      // We need to get the URL from the onAuth callback before responding.
      // The login() call continues in the background until the user completes OAuth.
      let authResolve: (info: { url: string; instructions?: string }) => void;
      let authReject: (err: Error) => void;
      const authUrlPromise = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;
      });

      // Start login flow in background — don't await the full login
      const loginPromise = storage.login(provider, {
        onAuth: (info) => {
          authResolve({
            url: info.url,
            instructions: appendManualCodeHint(info.instructions, provider, origin),
          });
        },
        onPrompt: async () => await pendingLogin.inputPromise,
        // AuthStorage.login() forwards callbacks to provider-specific OAuth
        // implementations verbatim. openai-codex supports this optional hook
        // to race pasted codes against the localhost callback server.
        onManualCodeInput: async () => await pendingLogin.inputPromise,
        onProgress: () => {}, // no-op for web UI
        signal: abortController.signal,
      });

      // Race: either we get the auth URL or the login completes/fails first
      const timeout = setTimeout(() => {
        authReject(new Error("Login initiation timed out"));
      }, 30_000);

      loginPromise
        .then(() => {
          // Login completed (user finished OAuth in browser)
        })
        .catch((err) => {
          // Login failed — also reject auth URL if not yet received
          authReject(err);
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
      activeLogin.resolveInput(code.trim());
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
      storage.logout(provider);
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
  router.post("/auth/api-key", (req, res) => {
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

      storage.clearApiKey(provider);
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
