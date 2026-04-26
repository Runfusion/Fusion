import { isGhAvailable, isGhAuthenticated } from "@fusion/core";
import { probeClaudeCli } from "../claude-cli-probe.js";
import { ApiError, badRequest, conflict } from "../api-error.js";
import { clearUsageCache } from "../usage.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import type { AuthStorageLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerAuthRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, store, rethrowAsApiError } = ctx;
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

  /**
   * Track in-progress login flows to prevent concurrent logins for the same provider.
   * Maps provider ID → AbortController for the active login.
   */
  const loginInProgress = new Map<string, AbortController>();

  /**
   * GET /api/auth/status
   * Returns list of all providers with their authentication status and type.
   * Includes both OAuth-backed and API-key-backed providers.
   * Response: {
   *   providers: [{ id, name, authenticated, type, keyHint? }],
   *   ghCli: { available: boolean, authenticated: boolean }
   * }
   */
  router.get("/auth/status", async (_req, res) => {
    try {
      const storage = getAuthStorage();
      storage.reload();
      const oauthProviders = storage.getOAuthProviders();
      const providers: { id: string; name: string; authenticated: boolean; type: "oauth" | "api_key" | "cli"; keyHint?: string }[] = oauthProviders.map((p) => ({
        id: p.id,
        name: p.name,
        authenticated: storage.hasAuth(p.id),
        type: "oauth" as const,
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
      const { provider } = req.body;
      if (!provider || typeof provider !== "string") {
        throw badRequest("provider is required");
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
      loginInProgress.set(provider, abortController);

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
          authResolve({ url: info.url, instructions: info.instructions });
        },
        onPrompt: async (prompt) => {
          // Web UI cannot interactively prompt — return empty string if allowed
          if (prompt.allowEmpty) return "";
          return prompt.placeholder || "";
        },
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
      res.json({ url: authInfo.url, instructions: authInfo.instructions });
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
