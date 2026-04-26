import type { ProjectSettings } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { getFusionAuthPath } from "../auth-paths.js";
import { fetchFromRemoteNode, readStoredAuthProvidersFromDisk } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerSettingsSyncRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, emitAuthSyncAuditLog, rethrowAsApiError } = ctx;

  // ── Node Settings Sync Routes ────────────────────────────────────────────

  /**
   * GET /api/nodes/:id/settings
   * Fetch settings from a remote node by proxying to the remote's /api/settings/scopes endpoint.
   * Returns: { global: GlobalSettings, project: Partial<ProjectSettings> }
   */
  router.get("/nodes/:id/settings", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      await central.close();

      if (!node) {
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        throw badRequest("Cannot fetch settings from a local node");
      }

      const result = await fetchFromRemoteNode(node, "/api/settings/scopes");
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/settings/push
   * Push local settings to a remote node.
   * Body: {} (empty, uses local settings automatically)
   * Returns: { success: true, syncedFields: string[] }
   */
  router.post("/nodes/:id/settings/push", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot push settings to a local node");
      }

      // Get local project settings
      const projectSettings = await store.getSettingsByScope();

      // Get local global settings
      const globalSettingsStore = store.getGlobalSettingsStore();
      const globalSettings = await globalSettingsStore.getSettings();

      // Build sync payload
      const payload = {
        global: globalSettings,
        projects: { [store.getRootDir().split("/").pop()!]: projectSettings.project },
        exportedAt: new Date().toISOString(),
        version: 1 as const,
      };

      // Compute checksum
      const { createHash } = await import("node:crypto");
      const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

      // Send to remote node
      await fetchFromRemoteNode(node, "/api/settings/sync-receive", {
        method: "POST",
        body: { ...payload, checksum },
      });

      // Record sync
      await central.updateSettingsSyncState(node.id, {
        lastSyncedAt: new Date().toISOString(),
        localChecksum: checksum,
      });

      await central.close();

      // Collect synced field names
      const syncedFields = [
        ...Object.keys(globalSettings),
        ...Object.keys(projectSettings.project),
      ];

      res.json({ success: true, syncedFields });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/settings/pull
   * Pull settings from a remote node and apply locally.
   * Body: { conflictResolution?: "last-write-wins" | "manual" }
   * Returns (last-write-wins): { success: true, appliedFields: string[], skippedFields: string[] }
   * Returns (manual): { diff: { global: string[], project: string[] }, remoteSettings, localSettings }
   */
  router.post("/nodes/:id/settings/pull", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot pull settings from a local node");
      }

      const conflictResolution = req.body?.conflictResolution ?? "last-write-wins";
      if (conflictResolution !== "last-write-wins" && conflictResolution !== "manual") {
        await central.close();
        throw badRequest("conflictResolution must be 'last-write-wins' or 'manual'");
      }

      // Fetch remote settings
      const remoteSettings = await fetchFromRemoteNode(node, "/api/settings/scopes") as {
        global: Record<string, unknown>;
        project: Record<string, unknown>;
      };

      if (conflictResolution === "manual") {
        // Get local settings for diff comparison
        const localProjectSettings = await store.getSettingsByScope();
        const localGlobalSettings = await store.getGlobalSettingsStore().getSettings();

        // Compute diff: field names that differ between local and remote
        const diffGlobal = Object.keys(remoteSettings.global || {}).filter(
          (key) => JSON.stringify(remoteSettings.global?.[key]) !== JSON.stringify(localGlobalSettings[key as keyof typeof localGlobalSettings]),
        );
        const diffProject = Object.keys(remoteSettings.project || {}).filter(
          (key) => JSON.stringify(remoteSettings.project?.[key]) !== JSON.stringify(localProjectSettings.project?.[key as keyof typeof localProjectSettings.project]),
        );

        await central.close();

        res.json({
          diff: { global: diffGlobal, project: diffProject },
          remoteSettings,
          localSettings: { global: localGlobalSettings, project: localProjectSettings.project },
        });
        return;
      }

      // last-write-wins: apply remote settings
      // Build payload with checksum
      const { createHash } = await import("node:crypto");
      const exportedAt = new Date().toISOString();
      const payloadWithoutChecksum = {
        global: remoteSettings.global,
        projects: remoteSettings.project as Record<string, ProjectSettings>,
        exportedAt,
        version: 1 as const,
      };
      const checksum = createHash("sha256").update(JSON.stringify(payloadWithoutChecksum)).digest("hex");

      const result = await central.applyRemoteSettings({
        ...payloadWithoutChecksum,
        checksum,
      });

      // Record sync
      await central.updateSettingsSyncState(node.id, {
        lastSyncedAt: new Date().toISOString(),
        remoteChecksum: checksum,
      });

      await central.close();

      // Build applied/skipped field lists
      const appliedFields = [
        ...Object.keys(remoteSettings.global || {}),
        ...Object.keys(remoteSettings.project || {}),
      ];
      const skippedFields = result.error ? Object.keys(remoteSettings.global || {}) : [];

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
   * GET /api/nodes/:id/settings/sync-status
   * Returns last sync timestamp and diff summary between local and remote.
   * Returns: {
   *   lastSyncAt: string | null,
   *   lastSyncDirection: string | null,
   *   localUpdatedAt: string,
   *   remoteReachable: boolean,
   *   diff: { global: string[], project: string[] }
   * }
   */
  router.get("/nodes/:id/settings/sync-status", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot check sync status for a local node");
      }

      // Get sync state
      const syncState = await central.getSettingsSyncState(node.id);

      // Get local settings for comparison
      const localProjectSettings = await store.getSettingsByScope();
      const localGlobalSettings = await store.getGlobalSettingsStore().getSettings();

      // Try to fetch remote settings
      let remoteReachable = false;
      let remoteSettings: { global: Record<string, unknown>; project: Record<string, unknown> } | null = null;
      let diffGlobal: string[] = [];
      let diffProject: string[] = [];

      try {
        remoteSettings = await fetchFromRemoteNode(node, "/api/settings/scopes") as {
          global: Record<string, unknown>;
          project: Record<string, unknown>;
        };
        remoteReachable = true;

        // Compute diff
        const rs = remoteSettings;
        diffGlobal = Object.keys(rs.global || {}).filter(
          (key) => JSON.stringify(rs.global?.[key]) !== JSON.stringify(localGlobalSettings[key as keyof typeof localGlobalSettings]),
        );
        diffProject = Object.keys(rs.project || {}).filter(
          (key) => JSON.stringify(rs.project?.[key]) !== JSON.stringify(localProjectSettings.project?.[key as keyof typeof localProjectSettings.project]),
        );
      } catch {
        // Remote unreachable - diff will be empty arrays
      }

      await central.close();

      res.json({
        lastSyncAt: syncState?.lastSyncedAt ?? null,
        lastSyncDirection: syncState ? "sync" : null, // Direction not tracked in new schema
        localUpdatedAt: syncState?.updatedAt ?? new Date().toISOString(),
        remoteReachable,
        diff: { global: diffGlobal, project: diffProject },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/nodes/:id/auth/sync
   * Synchronize model auth credentials with a remote node.
   * Body: { direction?: "push" | "pull" }
   * Returns: { success: true, syncedProviders: string[] }
   */
  router.post("/nodes/:id/auth/sync", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();

      const node = await central.getNode(req.params.id);
      if (!node) {
        await central.close();
        throw notFound("Node not found");
      }

      if (node.type === "local") {
        await central.close();
        throw badRequest("Cannot sync auth with a local node");
      }

      if (!node.apiKey) {
        await central.close();
        throw badRequest("Remote node requires an apiKey for auth sync");
      }

      const direction = req.body?.direction ?? "push";
      if (direction !== "push" && direction !== "pull") {
        await central.close();
        throw badRequest("direction must be 'push' or 'pull'");
      }

      // Get local node ID
      const localPeerInfo = await central.getLocalPeerInfo();
      const timestamp = new Date().toISOString();

      // Import AuthStorage
      const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      if (direction === "push") {
        // Get OAuth provider IDs to exclude
        const oauthProviders = authStorage.getOAuthProviders();
        const oauthIds = new Set(oauthProviders.map((p) => p.id));

        const allProviders = await readStoredAuthProvidersFromDisk();

        // Filter to only API-key-based providers (skip OAuth)
        const apiKeyProviders: Record<string, { type: string; key: string }> = {};
        for (const [providerId, cred] of Object.entries(allProviders)) {
          if (oauthIds.has(providerId)) continue;
          if (cred.type === "api_key" && cred.key) {
            apiKeyProviders[providerId] = { type: "api_key", key: cred.key };
          }
        }

        // Send to remote
        await fetchFromRemoteNode(node, "/api/settings/auth-receive", {
          method: "POST",
          body: {
            providers: apiKeyProviders,
            sourceNodeId: localPeerInfo.nodeId,
            timestamp,
          },
        });

        // Record sync
        await central.updateSettingsSyncState(node.id, {
          lastSyncedAt: timestamp,
        });

        await central.close();

        const providerNames = Object.keys(apiKeyProviders);
        emitAuthSyncAuditLog({
          operation: "sync",
          direction: "push",
          route: "/nodes/:id/auth/sync",
          sourceNodeId: localPeerInfo.nodeId,
          targetNodeId: node.id,
          providerNames,
        });

        res.json({ success: true, syncedProviders: providerNames });
      } else {
        // Pull: fetch remote auth and apply locally
        const remoteAuth = await fetchFromRemoteNode(node, "/api/settings/auth-export") as {
          providers: Record<string, { type: string; key: string }>;
          sourceNodeId: string;
          timestamp: string;
        };

        // Write received credentials to local AuthStorage
        const syncedProviders: string[] = [];
        for (const [providerId, credential] of Object.entries(remoteAuth.providers || {})) {
          if (credential.type === "api_key" && credential.key) {
            authStorage.set(providerId, { type: "api_key", key: credential.key });
            syncedProviders.push(providerId);
          }
        }

        // Record sync
        await central.updateSettingsSyncState(node.id, {
          lastSyncedAt: timestamp,
        });

        await central.close();

        emitAuthSyncAuditLog({
          operation: "sync",
          direction: "pull",
          route: "/nodes/:id/auth/sync",
          sourceNodeId: remoteAuth.sourceNodeId,
          targetNodeId: localPeerInfo.nodeId,
          providerNames: syncedProviders,
        });

        res.json({ success: true, syncedProviders });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
