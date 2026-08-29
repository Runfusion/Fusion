import {
  RESERVED_SYNC_PASSPHRASE_KEY,
  SecretsSyncError,
  type SecretsSyncRecord,
  getSyncPassphrase,
  unwrapSecretsBundle,
  wrapSecretsBundle,
} from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { fetchFromRemoteNode, MISSING_REMOTE_NODE_API_KEY_MESSAGE } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";

function emitSecretsAudit(
  req: unknown,
  ctx: Parameters<ApiRouteRegistrar>[0],
  type: "secret:sync-push" | "secret:sync-pull",
  target: string,
  metadata: Record<string, unknown>,
): void {
  const requestWithAuditor = req as { runAuditor?: { filesystem?: (input: { type: string; target: string; metadata?: Record<string, unknown> }) => void } };
  if (requestWithAuditor.runAuditor?.filesystem) {
    requestWithAuditor.runAuditor.filesystem({ type, target, metadata });
    return;
  }
  ctx.runtimeLogger.child("secrets-sync").info("Secrets sync audit event", { type, target, ...metadata });
}

async function listSyncRecords(store: Parameters<ApiRouteRegistrar>[0]["store"]): Promise<SecretsSyncRecord[]> {
  const secretsStore = await store.getSecretsStore();
  const records = [] as SecretsSyncRecord[];
  for (const record of await secretsStore.listSecrets()) {
    if (record.key === RESERVED_SYNC_PASSPHRASE_KEY) {
      continue;
    }
    const revealed = await secretsStore.revealSecret(record.id, record.scope, { agentId: null, userId: null });
    records.push({
      key: record.key,
      value: revealed.plaintextValue,
      scope: record.scope,
      description: record.description,
      accessPolicy: record.accessPolicy,
      envExportable: record.envExportable,
      envExportKey: record.envExportKey,
    });
  }
  return records;
}

export const registerSecretsSyncRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;

  router.post("/nodes/:id/secrets/push", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      // FNXC:GlobalDirGuard 2026-06-25-22:40: Secrets-sync node state is GLOBAL — use getGlobalSettingsDir(), never getFusionDir() (project .fusion/), which spawns a stray per-project central DB and resets global settings. See register-settings-sync-inbound-routes.ts for full rationale.
      const central = new CentralCore(store.getGlobalSettingsDir());
      await central.init();
      try {
        const node = await central.getNode(req.params.id);
        if (!node) {
          throw notFound("Node not found");
        }
        if (node.type === "local") {
          throw badRequest("Cannot push secrets to a local node");
        }
        if (!node.url || node.url.trim().length === 0) {
          throw badRequest("Node has no URL configured");
        }
        if (!node.apiKey || node.apiKey.trim().length === 0) {
          throw badRequest(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
        }

        const secretsStore = await store.getSecretsStore();
        const passphrase = await getSyncPassphrase(secretsStore);
        if (passphrase === null) {
          res.status(400).json({ error: "passphrase-not-configured" });
          return;
        }

        const records = await listSyncRecords(store);
        const envelope = await wrapSecretsBundle(records, passphrase);
        const localPeerInfo = await central.getLocalPeerInfo();

        await fetchFromRemoteNode(node, "/api/secrets/sync-receive", {
          method: "POST",
          body: {
            ...envelope,
            sourceNodeId: localPeerInfo.nodeId,
            exportedAt: new Date().toISOString(),
          },
        });

        emitSecretsAudit(req, ctx, "secret:sync-push", node.id, { nodeId: node.id, recordCount: records.length });

        res.json({
          success: true,
          pushedCount: records.length,
          pushedKeys: records.map((record) => ({ key: record.key, scope: record.scope })),
        });
      } finally {
        await central.close();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/nodes/:id/secrets/pull", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getGlobalSettingsDir());
      await central.init();
      try {
        const node = await central.getNode(req.params.id);
        if (!node) {
          throw notFound("Node not found");
        }
        if (node.type === "local") {
          throw badRequest("Cannot pull secrets from a local node");
        }
        if (!node.url || node.url.trim().length === 0) {
          throw badRequest("Node has no URL configured");
        }
        if (!node.apiKey || node.apiKey.trim().length === 0) {
          throw badRequest(MISSING_REMOTE_NODE_API_KEY_MESSAGE);
        }

        const secretsStore = await store.getSecretsStore();
        const passphrase = await getSyncPassphrase(secretsStore);
        if (passphrase === null) {
          res.status(400).json({ error: "passphrase-not-configured" });
          return;
        }

        const remoteEnvelope = await fetchFromRemoteNode(node, "/api/secrets/sync-export", { method: "GET" }) as import("@fusion/core").WrappedSecretsBundle;
        let records: SecretsSyncRecord[];
        try {
          records = await unwrapSecretsBundle(remoteEnvelope, passphrase);
        } catch (error) {
          if (error instanceof SecretsSyncError) {
            res.status(400).json({ error: error.code });
            return;
          }
          throw error;
        }

        let appliedCount = 0;
        let skippedCount = 0;
        const appliedKeys: Array<{ key: string; scope: "project" | "global" }> = [];
        for (const record of records) {
          if (record.key === RESERVED_SYNC_PASSPHRASE_KEY) {
            skippedCount += 1;
            continue;
          }

          const existing = (await secretsStore.listSecrets(record.scope)).find((secret) => secret.key === record.key);
          if (existing) {
            await secretsStore.updateSecret(existing.id, record.scope, {
              plaintextValue: record.value,
              description: record.description,
              accessPolicy: record.accessPolicy,
              envExportable: record.envExportable,
              envExportKey: record.envExportKey,
            });
          } else {
            await secretsStore.createSecret({
              scope: record.scope,
              key: record.key,
              plaintextValue: record.value,
              description: record.description,
              accessPolicy: record.accessPolicy,
              envExportable: record.envExportable,
              envExportKey: record.envExportKey,
            });
          }
          appliedCount += 1;
          appliedKeys.push({ key: record.key, scope: record.scope });
          emitSecretsAudit(req, ctx, "secret:sync-pull", node.id, { nodeId: node.id, key: record.key, scope: record.scope });
        }

        res.json({ success: true, appliedCount, skippedCount, appliedKeys });
      } finally {
        await central.close();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
};
