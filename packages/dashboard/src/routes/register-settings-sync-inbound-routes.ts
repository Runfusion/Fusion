import { ApiError, badRequest } from "../api-error.js";
import { getFusionAuthPath } from "../auth-paths.js";
import { readStoredAuthProvidersFromDisk } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerSettingsSyncInboundRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, emitAuthSyncAuditLog, rethrowAsApiError } = ctx;

  // ── Inbound Settings Sync Endpoints ────────────────────────────────
  // These endpoints are called by remote nodes to deliver settings or request auth data.
  // They validate apiKey auth before accepting data.

  /**
   * POST /api/settings/sync-receive
   * Receive pushed settings from a remote node.
   * Body: SettingsSyncPayload with global, projects, exportedAt, checksum, version
   * Returns: { success: true, appliedFields: string[], skippedFields: string[] }
   */
  router.post("/settings/sync-receive", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth - find local node and check apiKey
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      const payload = req.body;

      // Validate required fields
      if (!payload?.sourceNodeId) {
        await central.close();
        throw badRequest("Missing required field: sourceNodeId");
      }
      if (!payload?.exportedAt) {
        await central.close();
        throw badRequest("Missing required field: exportedAt");
      }

      // Apply remote settings
      const result = await central.applyRemoteSettings(payload);

      // Build applied/skipped field lists
      const appliedFields = [
        ...Object.keys(payload.global || {}),
        ...Object.keys(payload.projects || {}),
      ];
      const skippedFields = result.error ? appliedFields : [];

      await central.close();

      res.json({
        success: result.success,
        appliedFields,
        skippedFields,
        error: result.error,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/settings/auth-receive
   * Receive auth credentials from a remote node.
   * Body: { providers: Record<string, { type: string; key: string }>, sourceNodeId: string, timestamp: string }
   * Returns: { success: true, receivedProviders: string[] }
   */
  router.post("/settings/auth-receive", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      const { providers, sourceNodeId, timestamp } = req.body || {};

      // Validate required fields
      if (!providers || typeof providers !== "object") {
        await central.close();
        throw badRequest("Missing required field: providers");
      }
      if (!sourceNodeId) {
        await central.close();
        throw badRequest("Missing required field: sourceNodeId");
      }
      if (!timestamp) {
        await central.close();
        throw badRequest("Missing required field: timestamp");
      }

      // Import AuthStorage and write credentials
      const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      const receivedProviders: string[] = [];
      for (const [providerId, credential] of Object.entries(providers)) {
        if (typeof credential === "object" && credential !== null) {
          const cred = credential as { type: string; key?: string; access?: string; refresh?: string; expires?: number; accountId?: string };
          if (cred.type === "api_key" && cred.key) {
            authStorage.set(providerId, { type: "api_key", key: cred.key });
            receivedProviders.push(providerId);
          }
        }
      }

      emitAuthSyncAuditLog({
        operation: "receive",
        direction: "receive",
        route: "/settings/auth-receive",
        sourceNodeId,
        providerNames: receivedProviders,
      });

      await central.close();

      res.json({ success: true, receivedProviders });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/settings/auth-export
   * Export local auth credentials for a requesting remote node.
   * Returns: { providers: Record<string, { type: string; key: string }>, sourceNodeId: string, timestamp: string }
   */
  router.get("/settings/auth-export", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getFusionDir());
      await central.init();

      // Validate auth
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const nodes = await central.listNodes();
      const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
      if (!localNode) {
        await central.close();
        throw new ApiError(401, "Local node not configured");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      // Get local node ID
      const localPeerInfo = await central.getLocalPeerInfo();

      const allProviders = await readStoredAuthProvidersFromDisk();

      // Filter to only API-key-based providers (skip OAuth)
      const apiKeyProviders: Record<string, { type: string; key: string }> = {};
      for (const [providerId, cred] of Object.entries(allProviders)) {
        if (cred.type === "api_key" && cred.key) {
          apiKeyProviders[providerId] = { type: "api_key", key: cred.key };
        }
      }

      await central.close();

      res.json({
        providers: apiKeyProviders,
        sourceNodeId: localPeerInfo.nodeId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
