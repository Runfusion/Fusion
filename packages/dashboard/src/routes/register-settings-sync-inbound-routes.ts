import { isMovedSettingsKey } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import { getFusionAuthPath } from "../auth-paths.js";
import { readStoredAuthProvidersFromDisk, toProviderAuthEntries } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";

type WorkflowSettingsSyncSection = Record<string, Record<string, unknown>>;
type WorkflowSettingsSyncStore = {
  getWorkflowSettingsProjectId(): string;
  updateWorkflowSettingValues(workflowId: string, projectId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
};

function extractRejectedSettingIds(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const rejections = (err as { rejections?: unknown }).rejections;
  if (!Array.isArray(rejections)) return [];
  const ids: string[] = [];
  for (const rejection of rejections) {
    if (rejection && typeof rejection === "object" && typeof (rejection as { settingId?: unknown }).settingId === "string") {
      ids.push((rejection as { settingId: string }).settingId);
    }
  }
  return ids;
}

async function applyWorkflowSettingsSection(
  store: WorkflowSettingsSyncStore,
  section: WorkflowSettingsSyncSection,
): Promise<{ count: number; keys: string[] }> {
  const projectId = store.getWorkflowSettingsProjectId();
  let count = 0;
  const keys: string[] = [];

  for (const [workflowId, rawValues] of Object.entries(section)) {
    if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) continue;
    const patch: Record<string, unknown> = { ...rawValues };

    while (Object.keys(patch).length > 0) {
      try {
        await store.updateWorkflowSettingValues(workflowId, projectId, patch);
        const appliedKeys = Object.entries(patch)
          .filter(([, value]) => value !== null)
          .map(([key]) => key);
        count += appliedKeys.length;
        keys.push(...appliedKeys);
        break;
      } catch (err) {
        const rejectedIds = extractRejectedSettingIds(err);
        if (rejectedIds.length === 0) break;
        for (const settingId of rejectedIds) {
          delete patch[settingId];
        }
      }
    }
  }

  return { count, keys };
}

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
      if (token.length === 0) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }
      if (!localNode.apiKey) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
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

      // Apply inbound global settings through TaskStore so process-local caches
      // and settings listeners receive consistent updates.
      if (result.success && payload.global && typeof payload.global === "object") {
        const localGlobal = await store.getGlobalSettingsStore().getSettings() as Record<string, unknown>;
        const globalPatch = Object.fromEntries(
          Object.entries(payload.global as Record<string, unknown>)
            // Drop moved (tombstoned) keys here too — defense beyond the store
            // guard so an inbound push can never resurrect a moved key (KTD-8).
            .filter(([key, value]) => value !== undefined && localGlobal[key] === undefined && !isMovedSettingsKey(key)),
        );
        if (Object.keys(globalPatch).length > 0) {
          await store.updateGlobalSettings(globalPatch);
          invalidateAllGlobalSettingsCaches();
        }
      }

      let workflowSettingsCount = 0;
      let appliedWorkflowSettingKeys: string[] = [];
      if (result.success && payload.workflowSettings && typeof payload.workflowSettings === "object" && !Array.isArray(payload.workflowSettings)) {
        const workflowApplyResult = await applyWorkflowSettingsSection(store, payload.workflowSettings as WorkflowSettingsSyncSection);
        workflowSettingsCount = workflowApplyResult.count;
        appliedWorkflowSettingKeys = workflowApplyResult.keys;
      }

      // Build applied/skipped field lists. Moved keys are excluded so the reported
      // applied set matches what actually persisted (the store + applyRemoteSettings
      // both drop them). Workflow setting values sync in their own section.
      const appliedFields = [
        ...[
          ...Object.keys(payload.global || {}),
          ...Object.keys(payload.projects || {}),
        ].filter((key) => !isMovedSettingsKey(key)),
        ...appliedWorkflowSettingKeys,
      ];
      const skippedFields = result.error ? appliedFields : [];

      await central.close();

      res.json({
        success: result.success,
        appliedFields,
        skippedFields,
        workflowSettingsCount,
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
      if (token.length === 0) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }
      if (!localNode.apiKey) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      const { authMaterial, sourceNodeId, timestamp } = req.body || {};

      // Validate required fields
      if (!authMaterial || typeof authMaterial !== "object") {
        await central.close();
        throw badRequest("Missing required field: authMaterial");
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
      const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      const applyResult = central.applyAuthMaterialSnapshot(authMaterial);
      const receivedProviders: string[] = [];
      for (const [providerId, credential] of Object.entries(applyResult.providerAuth)) {
        if (credential.type === "api_key" && credential.key) {
          authStorage.set(providerId, { type: "api_key", key: credential.key });
          receivedProviders.push(providerId);
          continue;
        }
        if (credential.type === "oauth" && credential.accessToken && credential.refreshToken && typeof credential.expires === "number") {
          authStorage.set(providerId, {
            type: "oauth",
            access: credential.accessToken,
            refresh: credential.refreshToken,
            expires: credential.expires,
            ...(credential.accountId ? { accountId: credential.accountId } : {}),
          });
          receivedProviders.push(providerId);
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
      if (token.length === 0) {
        await central.close();
        throw new ApiError(401, "Missing or invalid Authorization header");
      }
      if (!localNode.apiKey) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }
      if (localNode.apiKey !== token) {
        await central.close();
        throw new ApiError(401, "Invalid apiKey");
      }

      // Get local node ID
      const localPeerInfo = await central.getLocalPeerInfo();

      const allProviders = await readStoredAuthProvidersFromDisk();
      const authMaterial = central.getAuthMaterialSnapshot(toProviderAuthEntries(allProviders));

      await central.close();

      res.json({
        authMaterial,
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
