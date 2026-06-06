import type { ProjectSettings } from "@fusion/core";
import { isMovedSettingsKey } from "@fusion/core";
import { basename } from "node:path";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { getFusionAuthPath } from "../auth-paths.js";
import {
  classifySyncStatusDenialReason,
  fetchFromRemoteNode,
  MISSING_REMOTE_NODE_API_KEY_MESSAGE,
  readStoredAuthProvidersFromDisk,
  toProviderAuthEntries,
  type SyncStatusDenialReason,
} from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";

function computeSettingsDiff(
  remoteSettings: { global?: Record<string, unknown>; project?: Record<string, unknown> },
  localGlobalSettings: Record<string, unknown>,
  localProjectSettings: Record<string, unknown>,
): { global: string[]; project: string[] } {
  // Moved (tombstoned) keys are excluded from the diff entirely (KTD-8): workflow
  // settings are not synced across nodes yet, so they must never appear in a
  // diff/push/pull field list — even if a mid-migration peer still carries them.
  const globalKeys = Array.from(new Set([
    ...Object.keys(remoteSettings.global ?? {}),
    ...Object.keys(localGlobalSettings ?? {}),
  ])).filter((key) => !isMovedSettingsKey(key));
  const projectKeys = Array.from(new Set([
    ...Object.keys(remoteSettings.project ?? {}),
    ...Object.keys(localProjectSettings ?? {}),
  ])).filter((key) => !isMovedSettingsKey(key));

  return {
    global: globalKeys.filter((key) => JSON.stringify(remoteSettings.global?.[key]) !== JSON.stringify(localGlobalSettings[key])),
    project: projectKeys.filter((key) => JSON.stringify(remoteSettings.project?.[key]) !== JSON.stringify(localProjectSettings[key])),
  };
}

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
      const payloadWithoutChecksum = {
        global: globalSettings,
        projects: { [basename(store.getRootDir())]: projectSettings.project },
        exportedAt: new Date().toISOString(),
        version: 1 as const,
      };

      // Compute checksum over the canonical settings payload shape only.
      // Do not include sourceNodeId in this hash; applyRemoteSettings() validates
      // checksums against { global, projects, exportedAt, version }.
      const { createHash } = await import("node:crypto");
      const checksum = createHash("sha256").update(JSON.stringify(payloadWithoutChecksum)).digest("hex");
      const localPeerInfo = await central.getLocalPeerInfo();

      // Send to remote node
      await fetchFromRemoteNode(node, "/api/settings/sync-receive", {
        method: "POST",
        body: {
          ...payloadWithoutChecksum,
          checksum,
          sourceNodeId: localPeerInfo.nodeId,
        },
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
        // Manual conflict resolution is a read-only inspection probe — do NOT call
        // central.updateSettingsSyncState(...) here. SettingsSyncState.lastSyncedAt
        // represents the last successful settings sync; mutating it on a diff probe
        // would corrupt the contract and lie to sync-status. Parallel to
        // GET /nodes/:id/settings/sync-status, which is also read-only.
        // Get local settings for diff comparison
        const localProjectSettings = await store.getSettingsByScope();
        const localGlobalSettings = await store.getGlobalSettingsStore().getSettings();

        // Compute diff: field names that differ between local and remote
        const { global: diffGlobal, project: diffProject } = computeSettingsDiff(
          remoteSettings,
          localGlobalSettings as Record<string, unknown>,
          localProjectSettings.project as Record<string, unknown>,
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
      let denialReason: SyncStatusDenialReason | null = null; // FN-4847: stable, non-leaking denial classification for degraded probes.

      try {
        remoteSettings = await fetchFromRemoteNode(node, "/api/settings/scopes") as {
          global: Record<string, unknown>;
          project: Record<string, unknown>;
        };
        remoteReachable = true;

        // Compute diff
        const rs = remoteSettings;
        const diff = computeSettingsDiff(
          rs,
          localGlobalSettings as Record<string, unknown>,
          localProjectSettings.project as Record<string, unknown>,
        );
        diffGlobal = diff.global;
        diffProject = diff.project;
      } catch (err) {
        // FN-4847: Remote probe failures are classified into actionable, enum-only denial reasons.
        denialReason = classifySyncStatusDenialReason(err);
      }

      await central.close();

      res.json({
        lastSyncAt: syncState?.lastSyncedAt ?? null,
        lastSyncDirection: syncState ? "sync" : null, // Direction not tracked in new schema
        localUpdatedAt: syncState?.updatedAt ?? new Date().toISOString(),
        remoteReachable,
        actionableDenialReason: denialReason, // FN-4847: explicit null on success, enum value on degraded failures.
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
        throw badRequest(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
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
      const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
      const authStorage = AuthStorage.create(getFusionAuthPath());

      if (direction === "push") {
        const allProviders = await readStoredAuthProvidersFromDisk();
        const authMaterial = central.getAuthMaterialSnapshot(toProviderAuthEntries(allProviders));

        // Send to remote
        await fetchFromRemoteNode(node, "/api/settings/auth-receive", {
          method: "POST",
          body: {
            authMaterial,
            sourceNodeId: localPeerInfo.nodeId,
            timestamp,
          },
        });

        // Record sync
        await central.updateSettingsSyncState(node.id, {
          lastSyncedAt: timestamp,
        });

        await central.close();

        const providerNames = Object.keys(authMaterial.payload.providerAuth ?? {});
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
          authMaterial: import("@fusion/core").AuthMaterialSnapshot;
          sourceNodeId: string;
          timestamp: string;
        };

        const applied = central.applyAuthMaterialSnapshot(remoteAuth.authMaterial);

        // Write received credentials to local AuthStorage
        const syncedProviders: string[] = [];
        for (const [providerId, credential] of Object.entries(applied.providerAuth)) {
          if (credential.type === "api_key" && credential.key) {
            authStorage.set(providerId, { type: "api_key", key: credential.key });
            syncedProviders.push(providerId);
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
