import {
  GLOBAL_SETTINGS_KEYS,
  QMD_INSTALL_COMMAND,
  MemoryBackendError,
  buildInsightExtractionPrompt,
  exportSettings,
  generateMemoryAudit,
  getMemoryBackendCapabilities,
  importSettings,
  installQmd,
  isGhAuthenticated,
  isGhAvailable,
  isQmdAvailable,
  listMemoryBackendTypes,
  listProjectMemoryFiles,
  processAndAuditInsightExtraction,
  readInsightsMemory,
  readMemory,
  readProjectMemoryFile,
  readProjectMemoryFileContent,
  refreshQmdProjectMemoryIndex,
  resolveMemoryBackend,
  scheduleQmdProjectMemoryRefresh,
  searchProjectMemory,
  syncBackupRoutine,
  type ModelPreset,
  type PiExtensionSettings,
  validateBackupDir,
  validateBackupRetention,
  validateBackupSchedule,
  validateImportData,
  writeInsightsMemory,
  writeMemory,
  writeProjectMemoryFile,
  updatePiExtensionDisabledIds,
} from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import { generateRemoteToken, issueRemoteAuthToken, maskRemoteToken } from "../remote-auth.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import type { ApiRoutesContext } from "./types.js";

interface SettingsMemoryRouteDeps {
  githubToken?: string;
  validateModelPresets: (input: unknown) => ModelPreset[] | undefined;
  sanitizeOverlapIgnorePaths: (input: unknown) => string[] | undefined;
  discoverDashboardPiExtensions: (cwd: string) => Promise<PiExtensionSettings>;
}

export function registerSettingsMemoryRoutes(ctx: ApiRoutesContext, deps: SettingsMemoryRouteDeps): void {
  const { router, options, store, runtimeLogger, getProjectContext, rethrowAsApiError } = ctx;
  const { githubToken, validateModelPresets, sanitizeOverlapIgnorePaths, discoverDashboardPiExtensions } = deps;

  function resolveRemoteBaseUrl(remoteAccess: NonNullable<Awaited<ReturnType<typeof store.getSettings>>["remoteAccess"]>): URL {
    if (!remoteAccess.activeProvider) {
      throw new ApiError(409, "No active remote provider configured", { code: "REMOTE_PROVIDER_NOT_CONFIGURED" });
    }

    if (remoteAccess.activeProvider === "cloudflare") {
      const ingressUrl = remoteAccess.providers.cloudflare.ingressUrl?.trim();
      if (!ingressUrl) {
        throw new ApiError(409, "Cloudflare ingress URL is not configured", { code: "REMOTE_URL_NOT_CONFIGURED" });
      }

      let parsed: URL;
      try {
        parsed = new URL(ingressUrl);
      } catch {
        throw new ApiError(409, "Cloudflare ingress URL is invalid", { code: "REMOTE_URL_INVALID" });
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ApiError(409, "Cloudflare ingress URL must use http or https", { code: "REMOTE_URL_INVALID" });
      }

      return parsed;
    }

    const hostname = remoteAccess.providers.tailscale.hostname?.trim();
    if (!hostname) {
      throw new ApiError(409, "Tailscale hostname is not configured", { code: "REMOTE_URL_NOT_CONFIGURED" });
    }

    const baseUrl = new URL(`http://${hostname}`);
    const targetPort = Number(remoteAccess.providers.tailscale.targetPort);
    if (Number.isFinite(targetPort) && targetPort > 0 && targetPort !== 80) {
      baseUrl.port = String(targetPort);
    }

    return baseUrl;
  }

  async function ensurePersistentRemoteToken(
    scopedStore: typeof store,
    remoteAccess: NonNullable<Awaited<ReturnType<typeof store.getSettings>>["remoteAccess"]>,
  ): Promise<string> {
    const existing = remoteAccess.tokenStrategy.persistent.token?.trim();
    if (existing) {
      return existing;
    }

    const token = generateRemoteToken();
    await scopedStore.updateSettings({
      remoteAccess: {
        ...remoteAccess,
        tokenStrategy: {
          ...remoteAccess.tokenStrategy,
          persistent: {
            ...remoteAccess.tokenStrategy.persistent,
            token,
          },
        },
      },
    });

    return token;
  }

  async function buildRemoteLoginUrlForTokenType(
    scopedStore: typeof store,
    mode: "persistent" | "short-lived",
  ): Promise<{ loginUrl: string; tokenType: "persistent" | "short-lived"; expiresAt: string | null }> {
    const settings = await scopedStore.getSettings();
    const remoteAccess = settings.remoteAccess;

    if (!remoteAccess?.enabled) {
      throw new ApiError(409, "Remote access is disabled", { code: "REMOTE_ACCESS_DISABLED" });
    }

    const baseUrl = resolveRemoteBaseUrl(remoteAccess);

    if (mode === "persistent") {
      if (!remoteAccess.tokenStrategy.persistent.enabled) {
        throw new ApiError(409, "Persistent remote token strategy is disabled", { code: "REMOTE_TOKEN_DISABLED" });
      }

      const token = await ensurePersistentRemoteToken(scopedStore, remoteAccess);
      const loginUrl = new URL("/remote-login", baseUrl);
      loginUrl.searchParams.set("rt", token);
      return {
        loginUrl: loginUrl.toString(),
        tokenType: "persistent",
        expiresAt: null,
      };
    }

    let issued;
    try {
      issued = issueRemoteAuthToken("short-lived", remoteAccess);
    } catch (err) {
      throw new ApiError(409, err instanceof Error ? err.message : "Short-lived token generation failed", {
        code: "REMOTE_TOKEN_DISABLED",
      });
    }

    const loginUrl = new URL("/remote-login", baseUrl);
    loginUrl.searchParams.set("rt", issued.token);
    return {
      loginUrl: loginUrl.toString(),
      tokenType: "short-lived",
      expiresAt: issued.expiresAt ?? null,
    };
  }

  // Settings CRUD
  router.get("/settings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      const prAuthAvailable = (isGhAvailable() && isGhAuthenticated()) || Boolean(githubToken);
      // Inject server-side configuration flags
      res.json({
        ...settings,
        prAuthAvailable,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      // Strip server-owned fields that should never be persisted to config.json.
      // These are computed server-side and injected only on GET /settings.
       
      const { githubTokenConfigured, prAuthAvailable, ...clientSettings } = req.body;

      // Reject global-only fields with a helpful error pointing to the correct endpoint
      const globalKeySet = new Set<string>(GLOBAL_SETTINGS_KEYS);
      const globalFieldsFound = Object.keys(clientSettings).filter((k) => globalKeySet.has(k));
      if (globalFieldsFound.length > 0) {
        throw badRequest(`Cannot update global settings via this endpoint. Use PUT /settings/global instead. Global fields found: ${globalFieldsFound.join(", ")}`);
      }

      if (Object.prototype.hasOwnProperty.call(clientSettings, "modelPresets")) {
        clientSettings.modelPresets = validateModelPresets(clientSettings.modelPresets);
      }
      if (Object.prototype.hasOwnProperty.call(clientSettings, "overlapIgnorePaths")) {
        clientSettings.overlapIgnorePaths = sanitizeOverlapIgnorePaths(clientSettings.overlapIgnorePaths);
      }

      // Validate backup settings if provided
      if (clientSettings.autoBackupSchedule !== undefined && !validateBackupSchedule(clientSettings.autoBackupSchedule)) {
        throw badRequest("Invalid cron expression for autoBackupSchedule");
      }
      if (clientSettings.autoBackupRetention !== undefined && !validateBackupRetention(clientSettings.autoBackupRetention)) {
        throw badRequest("autoBackupRetention must be between 1 and 100");
      }
      if (clientSettings.autoBackupDir !== undefined && !validateBackupDir(clientSettings.autoBackupDir)) {
        throw badRequest("autoBackupDir must be a relative path without '..' traversal");
      }
      if (clientSettings.autoArchiveDoneAfterMs !== undefined) {
        const ageMs = clientSettings.autoArchiveDoneAfterMs;
        if (!Number.isInteger(ageMs) || ageMs < 60_000 || ageMs > 10 * 365 * 24 * 60 * 60 * 1000) {
          throw badRequest("autoArchiveDoneAfterMs must be between 60000 and 315360000000");
        }
      }
      if (
        clientSettings.archiveAgentLogMode !== undefined &&
        !["none", "compact", "full"].includes(clientSettings.archiveAgentLogMode)
      ) {
        throw badRequest("archiveAgentLogMode must be one of: none, compact, full");
      }

      // Validate memoryBackendType if provided - must be string or null (for explicit clear)
      // Unknown backend IDs are accepted and persisted verbatim (for custom backend compatibility)
      // Fallback-to-file is runtime resolution behavior only
      if (clientSettings.memoryBackendType !== undefined) {
        if (clientSettings.memoryBackendType !== null && typeof clientSettings.memoryBackendType !== "string") {
          throw badRequest("memoryBackendType must be a string or null");
        }
      }

      const settings = await scopedStore.updateSettings(clientSettings);
      
      // Sync backup routine when backup settings change.
      const routineStoreForProject = engine?.getRoutineStore() ?? options?.routineStore;
      if (routineStoreForProject) {
        try {
          await syncBackupRoutine(routineStoreForProject, settings);
        } catch (err) {
          // Log but don't fail the settings update if routine sync fails
          runtimeLogger.error("Failed to sync backup routine", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      
      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = typeof (err instanceof Error ? err.message : String(err)) === "string" && (
        (err instanceof Error ? err.message : String(err)).includes("modelPresets") || (err instanceof Error ? err.message : String(err)).includes("must include both provider and modelId")
      ) ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Remote Access Routes ────────────────────────────────────────────

  function toRemoteSettingsPayload(remoteAccess: NonNullable<Awaited<ReturnType<typeof store.getSettings>>["remoteAccess"]>) {
    const persistentToken = remoteAccess.tokenStrategy.persistent.token?.trim() ?? "";
    return {
      remoteEnabled: Boolean(remoteAccess.enabled),
      remoteActiveProvider: remoteAccess.activeProvider ?? null,
      remoteTailscaleEnabled: Boolean(remoteAccess.providers.tailscale.enabled),
      remoteTailscaleHostname: remoteAccess.providers.tailscale.hostname,
      remoteTailscaleTargetPort: Number(remoteAccess.providers.tailscale.targetPort ?? 4040),
      remoteTailscaleAcceptRoutes: Boolean(remoteAccess.providers.tailscale.acceptRoutes),
      remoteCloudflareEnabled: Boolean(remoteAccess.providers.cloudflare.enabled),
      remoteCloudflareTunnelName: remoteAccess.providers.cloudflare.tunnelName,
      remoteCloudflareTunnelToken: remoteAccess.providers.cloudflare.tunnelToken,
      remoteCloudflareIngressUrl: remoteAccess.providers.cloudflare.ingressUrl,
      remoteShortLivedEnabled: Boolean(remoteAccess.tokenStrategy.shortLived.enabled),
      remoteShortLivedTtlMs: Number(remoteAccess.tokenStrategy.shortLived.ttlMs ?? 900_000),
      remoteShortLivedMaxTtlMs: Number(remoteAccess.tokenStrategy.shortLived.maxTtlMs ?? 86_400_000),
      remotePersistentToken: persistentToken ? maskRemoteToken(persistentToken) : null,
      remoteRememberLastRunning: Boolean(remoteAccess.lifecycle.rememberLastRunning),
      remoteWasRunningOnShutdown: Boolean(remoteAccess.lifecycle.wasRunningOnShutdown),
      remoteLastStartedProvider: remoteAccess.lifecycle.lastRunningProvider ?? null,
    };
  }

  router.get("/remote/settings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const remoteAccess = settings.remoteAccess;

      if (!remoteAccess) {
        throw new ApiError(409, "Remote access is not configured", { code: "REMOTE_ACCESS_DISABLED" });
      }

      res.json({ settings: toRemoteSettingsPayload(remoteAccess) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to load remote settings");
    }
  });

  router.put("/remote/settings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const remoteAccess = settings.remoteAccess;
      if (!remoteAccess) {
        throw new ApiError(409, "Remote access is not configured", { code: "REMOTE_ACCESS_DISABLED" });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const nextRemoteAccess = {
        ...remoteAccess,
        enabled: body.remoteEnabled === undefined ? remoteAccess.enabled : Boolean(body.remoteEnabled),
        activeProvider: body.remoteActiveProvider === undefined
          ? remoteAccess.activeProvider
          : (body.remoteActiveProvider as "tailscale" | "cloudflare" | null),
        providers: {
          tailscale: {
            ...remoteAccess.providers.tailscale,
            enabled: body.remoteTailscaleEnabled === undefined ? remoteAccess.providers.tailscale.enabled : Boolean(body.remoteTailscaleEnabled),
            hostname: body.remoteTailscaleHostname === undefined ? remoteAccess.providers.tailscale.hostname : String(body.remoteTailscaleHostname ?? ""),
            targetPort: body.remoteTailscaleTargetPort === undefined ? remoteAccess.providers.tailscale.targetPort : Number(body.remoteTailscaleTargetPort ?? 4040),
            acceptRoutes: body.remoteTailscaleAcceptRoutes === undefined ? remoteAccess.providers.tailscale.acceptRoutes : Boolean(body.remoteTailscaleAcceptRoutes),
          },
          cloudflare: {
            ...remoteAccess.providers.cloudflare,
            enabled: body.remoteCloudflareEnabled === undefined ? remoteAccess.providers.cloudflare.enabled : Boolean(body.remoteCloudflareEnabled),
            tunnelName: body.remoteCloudflareTunnelName === undefined ? remoteAccess.providers.cloudflare.tunnelName : String(body.remoteCloudflareTunnelName ?? ""),
            tunnelToken: body.remoteCloudflareTunnelToken === undefined
              ? remoteAccess.providers.cloudflare.tunnelToken
              : (body.remoteCloudflareTunnelToken ? String(body.remoteCloudflareTunnelToken) : null),
            ingressUrl: body.remoteCloudflareIngressUrl === undefined ? remoteAccess.providers.cloudflare.ingressUrl : String(body.remoteCloudflareIngressUrl ?? ""),
          },
        },
        tokenStrategy: {
          persistent: {
            ...remoteAccess.tokenStrategy.persistent,
            enabled: body.remotePersistentEnabled === undefined ? remoteAccess.tokenStrategy.persistent.enabled : Boolean(body.remotePersistentEnabled),
            token: body.remotePersistentToken === undefined
              ? remoteAccess.tokenStrategy.persistent.token
              : (body.remotePersistentToken ? String(body.remotePersistentToken) : null),
          },
          shortLived: {
            ...remoteAccess.tokenStrategy.shortLived,
            enabled: body.remoteShortLivedEnabled === undefined ? remoteAccess.tokenStrategy.shortLived.enabled : Boolean(body.remoteShortLivedEnabled),
            ttlMs: body.remoteShortLivedTtlMs === undefined ? remoteAccess.tokenStrategy.shortLived.ttlMs : Number(body.remoteShortLivedTtlMs ?? 900_000),
            maxTtlMs: body.remoteShortLivedMaxTtlMs === undefined ? remoteAccess.tokenStrategy.shortLived.maxTtlMs : Number(body.remoteShortLivedMaxTtlMs ?? 86_400_000),
          },
        },
        lifecycle: {
          ...remoteAccess.lifecycle,
          rememberLastRunning: body.remoteRememberLastRunning === undefined ? remoteAccess.lifecycle.rememberLastRunning : Boolean(body.remoteRememberLastRunning),
          wasRunningOnShutdown: body.remoteWasRunningOnShutdown === undefined ? remoteAccess.lifecycle.wasRunningOnShutdown : Boolean(body.remoteWasRunningOnShutdown),
          lastRunningProvider: body.remoteLastStartedProvider === undefined
            ? remoteAccess.lifecycle.lastRunningProvider
            : (body.remoteLastStartedProvider as "tailscale" | "cloudflare" | null),
        },
      };

      await scopedStore.updateSettings({ remoteAccess: nextRemoteAccess });
      res.json({ settings: toRemoteSettingsPayload(nextRemoteAccess) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to update remote settings");
    }
  });

  router.get("/remote/status", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const manager = engine?.getRemoteTunnelManager();
      const tunnelStatus = manager?.getStatus();
      const restore = engine?.getRemoteTunnelRestoreDiagnostics();

      res.json({
        provider: tunnelStatus?.provider ?? settings.remoteAccess?.activeProvider ?? null,
        state: tunnelStatus?.state ?? "stopped",
        url: tunnelStatus?.url ?? null,
        lastError: tunnelStatus?.lastError?.message ?? null,
        lastErrorCode: tunnelStatus?.lastError?.code ?? null,
        restore: restore ?? {
          outcome: "skipped",
          reason: "not_attempted",
          at: new Date().toISOString(),
          provider: null,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to load remote status");
    }
  });

  router.post("/remote/provider/activate", async (req, res) => {
    try {
      const provider = req.body?.provider;
      if (provider !== "tailscale" && provider !== "cloudflare") {
        throw new ApiError(400, "Invalid remote provider", { code: "INVALID_PROVIDER" });
      }
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const remoteAccess = settings.remoteAccess;
      if (!remoteAccess) {
        throw new ApiError(409, "Remote access is not configured", { code: "REMOTE_ACCESS_DISABLED" });
      }

      await scopedStore.updateSettings({
        remoteAccess: {
          ...remoteAccess,
          activeProvider: provider,
        },
      });
      res.json({ activeProvider: provider });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to activate remote provider");
    }
  });

  router.post("/remote/tunnel/start", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const provider = settings.remoteAccess?.activeProvider ?? null;
      if (!provider) {
        throw new ApiError(409, "No active provider configured", { code: "NO_ACTIVE_PROVIDER" });
      }

      if (!engine) {
        res.json({ state: "starting", provider });
        return;
      }

      const status = await engine.startRemoteTunnel();
      res.json({
        state: status.state,
        provider: status.provider,
        url: status.url,
        lastError: status.lastError?.message ?? null,
        lastErrorCode: status.lastError?.code ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("invalid_config:") || message.startsWith("runtime_prerequisite_missing:")) {
        throw new ApiError(409, message.split(":").slice(1).join(":") || "Remote tunnel prerequisites are not met", {
          code: "REMOTE_TUNNEL_PREREQUISITE_MISSING",
        });
      }
      rethrowAsApiError(err, "Failed to start remote tunnel");
    }
  });

  router.post("/remote/tunnel/stop", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const provider = settings.remoteAccess?.activeProvider ?? null;

      if (!engine) {
        res.json({ state: "stopped", provider });
        return;
      }

      const status = await engine.stopRemoteTunnel();
      res.json({
        state: status.state,
        provider: status.provider,
        url: status.url,
        lastError: status.lastError?.message ?? null,
        lastErrorCode: status.lastError?.code ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to stop remote tunnel");
    }
  });

  router.post("/remote/token/persistent/regenerate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const remoteAccess = settings.remoteAccess;
      if (!remoteAccess) {
        throw new ApiError(409, "Remote access is not configured", { code: "REMOTE_ACCESS_DISABLED" });
      }

      const token = generateRemoteToken();
      await scopedStore.updateSettings({
        remoteAccess: {
          ...remoteAccess,
          tokenStrategy: {
            ...remoteAccess.tokenStrategy,
            persistent: {
              ...remoteAccess.tokenStrategy.persistent,
              token,
            },
          },
        },
      });
      res.json({ token, maskedToken: maskRemoteToken(token) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to regenerate persistent token");
    }
  });

  router.post("/remote/token/short-lived/generate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const remoteAccess = settings.remoteAccess;
      if (!remoteAccess) {
        throw new ApiError(409, "Remote access is not configured", { code: "REMOTE_ACCESS_DISABLED" });
      }

      const ttlInput = req.body?.ttlMs;
      const modeSettings = (typeof ttlInput === "number" && Number.isFinite(ttlInput))
        ? {
            ...remoteAccess,
            tokenStrategy: {
              ...remoteAccess.tokenStrategy,
              shortLived: {
                ...remoteAccess.tokenStrategy.shortLived,
                ttlMs: Math.floor(ttlInput),
              },
            },
          }
        : remoteAccess;

      const issued = issueRemoteAuthToken("short-lived", modeSettings);
      const effectiveTtlMs = issued.expiresAt
        ? Math.max(0, Date.parse(issued.expiresAt) - Date.now())
        : modeSettings.tokenStrategy.shortLived.ttlMs;
      res.json({ token: issued.token, expiresAt: issued.expiresAt ?? null, ttlMs: effectiveTtlMs });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate short-lived token");
    }
  });

  router.post("/remote-access/auth/login-url", async (req, res) => {
    try {
      const mode = req.body?.mode;
      if (mode !== "persistent" && mode !== "short-lived") {
        throw new ApiError(400, "mode must be 'persistent' or 'short-lived'", { code: "INVALID_REMOTE_AUTH_MODE" });
      }

      const { store: scopedStore } = await getProjectContext(req);
      const payload = await buildRemoteLoginUrlForTokenType(scopedStore, mode);
      res.json({
        loginUrl: payload.loginUrl,
        tokenType: payload.tokenType,
        ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate remote login URL");
    }
  });

  router.get("/remote/url", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const tokenType = req.query.tokenType === "short-lived" ? "short-lived" : "persistent";
      const payload = await buildRemoteLoginUrlForTokenType(scopedStore, tokenType);
      res.json({ url: payload.loginUrl, tokenType: payload.tokenType, expiresAt: payload.expiresAt });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate remote URL");
    }
  });

  router.get("/remote/qr", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const tokenType = req.query.tokenType === "short-lived" ? "short-lived" : "persistent";
      const format = req.query.format === "image/svg" ? "image/svg" : "text";
      const payload = await buildRemoteLoginUrlForTokenType(scopedStore, tokenType);
      if (format === "image/svg") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect width="100%" height="100%" fill="white"/><text x="10" y="42" font-size="12" fill="black">${payload.loginUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`;
        res.json({ url: payload.loginUrl, tokenType: payload.tokenType, expiresAt: payload.expiresAt, format, data: svg });
        return;
      }
      res.json({ url: payload.loginUrl, tokenType: payload.tokenType, expiresAt: payload.expiresAt, format, data: payload.loginUrl });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate remote QR payload");
    }
  });

  // ── Project Memory Routes ─────────────────────────────────────

  /**
   * GET /api/memory
   * Returns the project memory file content using the configured backend.
   * If memory does not exist yet, returns an empty string.
   *
   * Uses backend-aware read via `readMemory()` which delegates to the
   * configured memory backend (file, readonly, qmd, etc.).
   */
  router.get("/memory", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Use backend-aware memory read
      const result = await readMemory(rootDir, settings);
      res.json({ content: result.content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // readMemory returns empty content for read failures (graceful degradation)
      // so we should not normally get here for read operations
      rethrowAsApiError(err, "Failed to read memory");
    }
  });

  /**
   * PUT /api/memory
   * Updates the project memory file content using the configured backend.
   * Body: { content: string }
   *
   * Uses backend-aware write via `writeMemory()` which delegates to the
   * configured memory backend. Write-disabled backends (readonly) will
   * return 409 Conflict.
   *
   * Error mapping:
   * - READ_ONLY → 409 Conflict
   * - BACKEND_UNAVAILABLE → 503 Service Unavailable
   * - QUOTA_EXCEEDED → 413 Payload Too Large
   * - UNSUPPORTED → 409 Conflict
   * - CONFLICT → 409 Conflict
   * - Other errors → 500 Internal Server Error
   */
  router.put("/memory", async (req, res) => {
    try {
      const { content } = req.body ?? {};
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Use backend-aware memory write with explicit error mapping
      await writeMemory(rootDir, content, settings);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map MemoryBackendError codes to appropriate HTTP status codes
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
          case "BACKEND_UNAVAILABLE":
            res.status(503).json({
              error: `Memory backend unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          case "QUOTA_EXCEEDED":
            res.status(413).json({
              error: `Memory quota exceeded: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          default:
            // READ_FAILED, WRITE_FAILED, NOT_FOUND, etc.
            throw new ApiError(500, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
        }
      }

      rethrowAsApiError(err, "Failed to save memory");
    }
  });

  /**
   * GET /api/memory/files
   * Lists editable project memory files across the layered memory workspace.
   */
  router.get("/memory/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const files = await listProjectMemoryFiles(rootDir);
      res.json({ files });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list memory files");
    }
  });

  /**
   * GET /api/memory/file?path=.fusion/memory/MEMORY.md
   * Reads one validated memory file. Paths outside memory are rejected by core.
   */
  router.get("/memory/file", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!path) {
        throw badRequest("path is required");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const result = await readProjectMemoryFile(rootDir, { path, lineCount: 400 });
      res.json({ path: result.path, content: result.content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to read memory file");
    }
  });

  /**
   * PUT /api/memory/file
   * Writes one validated memory file. Read-only backends reject writes.
   */
  router.put("/memory/file", async (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (typeof path !== "string" || !path) {
        throw badRequest("path must be a string");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const backend = resolveMemoryBackend(settings);
      if (!backend.capabilities.writable) {
        throw new MemoryBackendError("READ_ONLY", "This backend is read-only and cannot write memory", backend.type);
      }

      const rootDir = scopedStore.getRootDir();
      await writeProjectMemoryFile(rootDir, path, content);
      if (backend.type === "qmd") {
        scheduleQmdProjectMemoryRefresh(rootDir);
      }
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err.message}`, details);
          case "NOT_FOUND":
            throw new ApiError(404, `Memory operation failed: ${err.message}`, details);
          default:
            throw new ApiError(500, `Memory operation failed: ${err.message}`, details);
        }
      }
      rethrowAsApiError(err, "Failed to save memory file");
    }
  });

  // ── Memory Backend Routes ─────────────────────────────────────

  /**
   * GET /api/memory/backend
   * Returns the current memory backend status and capabilities.
   *
   * The `currentBackend` field reflects the **effective** backend after runtime
   * resolution. If a custom/unknown backend type is persisted in settings, it
   * is returned as-is in the response, but `currentBackend` reflects the
   * fallback backend (file) used at runtime.
   *
   * Response shape:
   * - `currentBackend`: The effective backend type after runtime resolution
   * - `capabilities`: The capabilities of the effective backend
   * - `availableBackends`: List of registered backend types
   */
  router.get("/memory/backend", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const capabilities = getMemoryBackendCapabilities(settings);
      const availableBackends = listMemoryBackendTypes();

      res.json({
        currentBackend: resolveMemoryBackend(settings).type,
        capabilities,
        availableBackends,
        qmdAvailable: await isQmdAvailable(),
        qmdInstallCommand: QMD_INSTALL_COMMAND,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get memory backend status");
    }
  });

  router.post("/memory/install-qmd", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const installed = await installQmd();
      const qmdAvailable = await isQmdAvailable();
      if (installed && qmdAvailable) {
        scheduleQmdProjectMemoryRefresh(scopedStore.getRootDir());
      }

      res.json({
        success: installed,
        qmdAvailable,
        qmdInstallCommand: QMD_INSTALL_COMMAND,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to install qmd");
    }
  });

  router.post("/memory/test", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();
      const query = typeof req.body?.query === "string" && req.body.query.trim()
        ? req.body.query.trim()
        : "project memory";
      const qmdAvailable = await isQmdAvailable();
      if (qmdAvailable) {
        await refreshQmdProjectMemoryIndex(rootDir, { force: true });
      }
      const results = await searchProjectMemory(
        rootDir,
        { query, limit: 5 },
        { ...settings, memoryBackendType: "qmd" },
      );

      res.json({
        query,
        qmdAvailable,
        usedFallback: !qmdAvailable,
        qmdInstallCommand: QMD_INSTALL_COMMAND,
        results,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to test memory retrieval");
    }
  });

  /**
   * POST /api/memory/compact
   * AI-powered memory compaction using the memory compaction service.
   * Reads one selected memory file, compacts it using AI, and writes back the result.
   *
   * Body: { path?: string } (defaults to .fusion/memory/MEMORY.md)
   *
   * Error mapping:
   * - Memory content too short (< 200 chars) → 400 Bad Request
   * - READ_ONLY → 409 Conflict
   * - BACKEND_UNAVAILABLE → 503 Service Unavailable
   * - AiServiceError → 503 Service Unavailable
   * - Other errors → 500 Internal Server Error
   */
  router.post("/memory/compact", async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === "string" && req.body.path.trim()
        ? req.body.path
        : ".fusion/memory/MEMORY.md";
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const backend = resolveMemoryBackend(settings);
      if (!backend.capabilities.writable) {
        throw new MemoryBackendError("READ_ONLY", "This backend is read-only and cannot write memory", backend.type);
      }
      const rootDir = scopedStore.getRootDir();

      // Read the selected file in full before compaction.
      const result = await readProjectMemoryFileContent(rootDir, requestedPath);
      const content = result.content;

      // Validate content length (must be at least 200 chars to compact)
      if (content.length < 200) {
        throw badRequest("Memory content too short to compact");
      }

      // Resolve model selection hierarchy for compaction:
      // 1. Project titleSummarizer override (titleSummarizerProvider + titleSummarizerModelId)
      // 2. Planning lane settings (planningProvider + planningModelId)
      // 3. Default pair (defaultProvider + defaultModelId)
      // 4. Automatic model resolution (no explicit model)
      const resolvedProvider =
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

      // Import and call the compaction service
      const { compactMemoryWithAi } = await import("@fusion/core");
      const compacted = await compactMemoryWithAi(content, rootDir, resolvedProvider, resolvedModelId);

      // Write compacted content back to the same selected memory file.
      await writeProjectMemoryFile(rootDir, result.path, compacted);
      if (backend.type === "qmd") {
        scheduleQmdProjectMemoryRefresh(rootDir);
      }

      res.json({ path: result.path, content: compacted });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map MemoryBackendError codes to appropriate HTTP status codes
      if (err instanceof MemoryBackendError) {
        const details = { code: err.code, backend: err.backend };
        switch (err.code) {
          case "READ_ONLY":
          case "UNSUPPORTED":
          case "CONFLICT":
            throw new ApiError(409, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
          case "BACKEND_UNAVAILABLE":
            res.status(503).json({
              error: `Memory backend unavailable: ${err instanceof Error ? err.message : String(err)}`,
              ...details,
            });
            return;
          default:
            // READ_FAILED, WRITE_FAILED, NOT_FOUND, etc.
            throw new ApiError(500, `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`, details);
        }
      }

      // Map AI service errors to 503
      if (err instanceof Error && err.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      }

      rethrowAsApiError(err, "Failed to compact memory");
    }
  });

  // ── Memory Insights Routes ───────────────────────────────────────────

  // Lazy-loaded createFnAgent for AI operations (same pattern as ai-refine.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createFnAgentForInsights: any;

  async function initCreateFnAgentForInsights(): Promise<void> {
    if (createFnAgentForInsights) return;
    try {
      // Use dynamic import with @vite-ignore to prevent static analysis issues
      const engine = await import(/* @vite-ignore */ "@fusion/engine");
      createFnAgentForInsights = engine.createFnAgent;
    } catch {
      createFnAgentForInsights = undefined;
    }
  }

  /**
   * GET /api/memory/insights
   * Returns the insights memory file content.
   * Returns { content: null, exists: false } if no insights file exists yet.
   */
  router.get("/memory/insights", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      const content = await readInsightsMemory(rootDir);
      res.json({ content, exists: content !== null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // If the file doesn't exist, return null with exists: false
      if (err instanceof Error && err.message.includes("no such file")) {
        res.json({ content: null, exists: false });
        return;
      }
      rethrowAsApiError(err, "Failed to read memory insights");
    }
  });

  /**
   * PUT /api/memory/insights
   * Updates the insights memory file content.
   * Body: { content: string }
   */
  router.put("/memory/insights", async (req, res) => {
    try {
      const { content } = req.body ?? {};
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      await writeInsightsMemory(rootDir, content);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to save memory insights");
    }
  });

  /**
   * POST /api/memory/extract
   * Triggers AI-powered insight extraction from working memory.
   * Reads working memory, generates insights via AI, merges/prunes existing insights,
   * and generates an audit report.
   *
   * Returns: { success: boolean, summary: string, insightCount: number, pruned: boolean }
   * Errors: 400 if working memory is empty, 503 if AI service unavailable
   */
  router.post("/memory/extract", async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let session: any = null;
    try {
      await initCreateFnAgentForInsights();

      if (!createFnAgentForInsights) {
        throw new ApiError(503, "AI engine not available");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Read working memory and existing insights
      // Use readMemory (from memory-backend.ts) to handle both legacy and multi-file paths
      const memoryResult = await readMemory(rootDir, settings);
      const workingMemory = memoryResult.content;
      const existingInsights = await readInsightsMemory(rootDir);

      // Validate working memory is not empty
      if (!workingMemory || workingMemory.trim().length === 0) {
        throw badRequest("No working memory to extract insights from");
      }

      // Build the extraction prompt
      const extractionPrompt = buildInsightExtractionPrompt(workingMemory, existingInsights ?? "");

      // Resolve model selection hierarchy for insight extraction
      const resolvedProvider =
        (settings.planningProvider && settings.planningModelId ? settings.planningProvider : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

      const resolvedModelId =
        (settings.planningProvider && settings.planningModelId ? settings.planningModelId : undefined) ||
        (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

      // Create AI agent session for extraction
      const agentResult = await createFnAgentForInsights({
        cwd: rootDir,
        tools: "readonly",
        defaultProvider: resolvedProvider,
        defaultModelId: resolvedModelId,
        systemPrompt: "You are a helpful AI assistant that extracts insights from working memory.",
      });

      if (!agentResult?.session) {
        throw new ApiError(503, "Failed to initialize AI agent for insight extraction");
      }

      session = agentResult.session;

      // Send extraction prompt to AI
      const responseText = await session.prompt(extractionPrompt);

      // Process the result: merge insights, prune duplicates, and generate audit
      const result = await processAndAuditInsightExtraction(rootDir, {
        rawResponse: responseText,
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        summary: result.extraction?.summary ?? `Extracted ${result.extraction?.insightCount ?? 0} insights`,
        insightCount: result.extraction?.insightCount ?? 0,
        pruned: result.pruning?.applied ?? false,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }

      // Map AI service errors to 503
      if (err instanceof Error && err.name === "AiServiceError") {
        throw new ApiError(503, err.message || "AI service temporarily unavailable");
      }

      // Map model not found errors to 400 with helpful message
      if (err instanceof Error && err.message.includes("not found in the pi model registry")) {
        throw badRequest(
          "AI model not configured. Please open Settings → AI and select a valid model for insight extraction.",
        );
      }

      // Map other extraction errors
      if (err instanceof Error && err.message.includes("No working memory")) {
        throw badRequest(err.message);
      }

      rethrowAsApiError(err, "Failed to extract insights");
    } finally {
      // Always dispose the session
      if (session) {
        try {
          session.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    }
  });

  /**
   * GET /api/memory/audit
   * Returns a comprehensive memory audit report.
   * The audit checks working memory and insights memory state, extraction history,
   * and generates health recommendations.
   */
  router.get("/memory/audit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();

      const report = await generateMemoryAudit(rootDir);
      res.json(report);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to generate memory audit");
    }
  });

  /**
   * GET /api/memory/stats
   * Returns lightweight quick stats about memory files (no AI, no full audit).
   * Useful for dashboard displays showing memory size and insight counts.
   *
   * Returns: { workingMemorySize: number, insightsSize: number, insightsExists: boolean }
   */
  router.get("/memory/stats", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();

      // Read both files concurrently
      // Use readMemory to handle both legacy and multi-file memory paths
      const [workingResult, insightsContent] = await Promise.all([
        readMemory(rootDir, settings),
        readInsightsMemory(rootDir).catch(() => null),
      ]);

      res.json({
        workingMemorySize: workingResult.content.length,
        insightsSize: insightsContent?.length ?? 0,
        insightsExists: insightsContent !== null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch memory stats");
    }
  });

  // ── Global Settings Routes ─────────────────────────────────────

  /**
   * GET /api/settings/global
   * Returns the global (user-level) settings from ~/.fusion/settings.json.
   * Does NOT include computed/server-only fields like prAuthAvailable.
   */
  router.get("/settings/global", async (_req, res) => {
    try {
      const globalStore = store.getGlobalSettingsStore();
      const settings = await globalStore.getSettings();
      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/settings/global
   * Update global (user-level) settings in ~/.fusion/settings.json.
   * These settings persist across all fn projects for the current user.
   */
  router.put("/settings/global", async (req, res) => {
    try {
      // Snapshot the prior value of useClaudeCli *before* writing so we can
      // detect a toggle transition and trigger the onUseClaudeCliToggled
      // hook (used to install the fusion Claude-skill into every registered
      // project without waiting for a server restart).
      let prevUseClaudeCli = false;
      try {
        const priorGlobal = await store.getGlobalSettingsStore().getSettings();
        prevUseClaudeCli = priorGlobal.useClaudeCli === true;
      } catch {
        // Best-effort: on read failure assume false so a flip-on still fires.
      }

      const settings = await store.updateGlobalSettings(req.body);
      // Invalidate global settings caches in all project-scoped stores so the
      // next GET /settings?projectId=xxx reads fresh values from disk rather
      // than returning a stale per-project cache.
      invalidateAllGlobalSettingsCaches();
      // Also invalidate caches in engine manager stores (separate GlobalSettingsStore
      // instances that are NOT part of the project-store-resolver cache).
      const engineManager = options?.engineManager;
      if (engineManager) {
        for (const engine of engineManager.getAllEngines().values()) {
          engine.getTaskStore().getGlobalSettingsStore().invalidateCache();
        }
      }

      // Fire the toggle hook only on an actual transition — avoids redundant
      // skill-install sweeps when the user saves unrelated settings.
      const nextUseClaudeCli = settings.useClaudeCli === true;
      if (options?.onUseClaudeCliToggled && prevUseClaudeCli !== nextUseClaudeCli) {
        try {
          options.onUseClaudeCliToggled(prevUseClaudeCli, nextUseClaudeCli);
        } catch (hookErr) {
          runtimeLogger.warn(
            `onUseClaudeCliToggled callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }

      res.json(settings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/scopes
   * Returns settings separated by scope: { global, project }.
   * Useful for the UI to show which scope each setting comes from.
   */
  router.get("/settings/scopes", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scopes = await scopedStore.getSettingsByScope();
      res.json(scopes);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/pi-extensions
   * List Pi/Fusion extension entry points and their Fusion-owned enabled state.
   */
  router.get("/settings/pi-extensions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      res.json(await discoverDashboardPiExtensions(scopedStore.getRootDir()));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PUT /api/settings/pi-extensions
   * Persist Fusion-owned disabled extension ids in ~/.fusion/agent/settings.json.
   */
  router.put("/settings/pi-extensions", async (req, res) => {
    try {
      const disabledIds = (req.body as { disabledIds?: unknown }).disabledIds;
      if (!Array.isArray(disabledIds) || disabledIds.some((entry) => typeof entry !== "string")) {
        throw badRequest("disabledIds must be an array of extension ids");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const currentSettings = await discoverDashboardPiExtensions(scopedStore.getRootDir());
      updatePiExtensionDisabledIds(
        scopedStore.getRootDir(),
        disabledIds,
        undefined,
        currentSettings.extensions.map((extension) => extension.id),
      );
      res.json(await discoverDashboardPiExtensions(scopedStore.getRootDir()));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Pi Settings Routes ────────────────────────────────────────────

  /**
   * GET /api/pi-settings
   * Returns the user's global pi extension settings from ~/.pi/agent/settings.json.
   * Includes packages, extension paths, skill paths, prompt template paths, and theme paths.
   */
  router.post("/settings/test-ntfy", async (req, res) => {
    const normalizeNtfyBaseUrl = (value: string, source: "request" | "settings"): string => {
      const trimmed = value.trim();
      if (!trimmed) {
        throw badRequest("ntfy server URL cannot be empty");
      }

      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw badRequest(`ntfy server URL from ${source} must be a valid URL`);
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw badRequest("ntfy server URL must use http:// or https://");
      }

      return trimmed.replace(/\/+$/, "");
    };

    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();

      // Validate ntfy is enabled
      if (!settings.ntfyEnabled) {
        throw badRequest("ntfy notifications are not enabled");
      }

      // Validate topic exists and matches required format
      const topic = settings.ntfyTopic;
      if (!topic || !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
        throw badRequest("ntfy topic is not configured or invalid");
      }

      const overrideValue = req.body?.ntfyBaseUrl;
      if (overrideValue !== undefined && overrideValue !== null && typeof overrideValue !== "string") {
        throw badRequest("ntfy server URL must be a string");
      }

      const requestOverride = typeof overrideValue === "string" && overrideValue.trim()
        ? normalizeNtfyBaseUrl(overrideValue, "request")
        : undefined;
      const storedServer = typeof settings.ntfyBaseUrl === "string" && settings.ntfyBaseUrl.trim()
        ? normalizeNtfyBaseUrl(settings.ntfyBaseUrl, "settings")
        : undefined;
      const ntfyBaseUrl = requestOverride ?? storedServer ?? "https://ntfy.sh";
      const url = `${ntfyBaseUrl}/${topic}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Title": "Fusion test notification",
          "Priority": "default",
          "Content-Type": "text/plain",
        },
        body: "Fusion test notification — your notifications are working!",
      });

      if (!response.ok) {
        throw new ApiError(502, `ntfy server returned ${response.status}: ${response.statusText}`);
      }

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to send test notification");
    }
  });

  // ── Settings Export/Import Routes ─────────────────────────────────

  /**
   * GET /api/settings/export
   * Export settings as JSON for backup or migration.
   * Query params: ?scope=global|project|both (default: both)
   * Returns: SettingsExportData structure
   */
  router.get("/settings/export", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scopeParam = req.query.scope as string | undefined;
      const scope = scopeParam === "global" || scopeParam === "project" || scopeParam === "both"
        ? scopeParam
        : "both";

      const exportData = await exportSettings(scopedStore, { scope });
      res.json(exportData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to export settings");
    }
  });

  /**
   * POST /api/settings/import
   * Import settings from JSON data.
   * Body: { data: SettingsExportData, scope?: 'global'|'project'|'both', merge?: boolean }
   * Returns: { success: true, globalCount: number, projectCount: number }
   */
  router.post("/settings/import", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { data, scope = "both", merge = true } = req.body;

      // Validate the import data
      const validationErrors = validateImportData(data);
      if (validationErrors.length > 0) {
        throw badRequest(`Validation failed: ${validationErrors.join("; ")}`);
      }

      // Perform the import
      const result = await importSettings(scopedStore, data, { scope, merge });

      if (!result.success) {
        throw new ApiError(500, result.error ?? "Import failed", {
          globalCount: result.globalCount,
          projectCount: result.projectCount,
        });
      }

      res.json({
        success: true,
        globalCount: result.globalCount,
        projectCount: result.projectCount,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to import settings");
    }
  });

  // ── Executor Stats Route ────────────────────────────────────────────

  /**
   * GET /api/executor/stats
   * Returns executor statistics for the status bar.
   * 
   * Counts (running, blocked, queued, in-review, stuck) are derived client-side
   * from the tasks array. This endpoint returns settings-based values and
   * lastActivityAt from the activity log.
   */
}
