import {
  RESERVED_SYNC_PASSPHRASE_KEY,
  SecretsSyncError,
  type SecretsSyncRecord,
  getSyncPassphrase,
  unwrapSecretsBundle,
  wrapSecretsBundle,
} from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

function emitSecretsAudit(
  req: unknown,
  ctx: Parameters<ApiRouteRegistrar>[0],
  type: "secret:sync-pull",
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

async function upsertRecords(
  store: Parameters<ApiRouteRegistrar>[0]["store"],
  records: SecretsSyncRecord[],
): Promise<{ appliedCount: number; skippedCount: number; appliedKeys: Array<{ key: string; scope: "project" | "global" }> }> {
  const secretsStore = await store.getSecretsStore();
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
  }

  return { appliedCount, skippedCount, appliedKeys };
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

export const registerSecretsSyncInboundRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;

  router.post("/secrets/sync-receive", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      // FNXC:GlobalDirGuard 2026-06-25-22:40: Inbound secrets sync writes GLOBAL central state — use getGlobalSettingsDir(), never getFusionDir() (project .fusion/), which spawns a stray per-project central DB and resets global settings. See register-settings-sync-inbound-routes.ts for full rationale.
      const central = new CentralCore(store.getGlobalSettingsDir());
      await central.init();
      try {
        // Validate auth
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          throw new ApiError(401, "Missing or invalid Authorization header");
        }

        const token = authHeader.slice(7);
        const nodes = await central.listNodes();
        const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
        if (!localNode) {
          throw new ApiError(401, "Local node not configured");
        }
        if (token.length === 0) {
          throw new ApiError(401, "Missing or invalid Authorization header");
        }
        if (!localNode.apiKey) {
          throw new ApiError(401, "Invalid apiKey");
        }
        if (localNode.apiKey !== token) {
          throw new ApiError(401, "Invalid apiKey");
        }

        const body = req.body;
        if (!body?.sourceNodeId) throw badRequest("Missing required field: sourceNodeId");
        if (!body?.exportedAt) throw badRequest("Missing required field: exportedAt");
        if (body?.version === undefined) throw badRequest("Missing required field: version");
        if (!body?.ciphertext) throw badRequest("Missing required field: ciphertext");
        if (!body?.salt) throw badRequest("Missing required field: salt");
        if (!body?.nonce) throw badRequest("Missing required field: nonce");
        if (!body?.kdf) throw badRequest("Missing required field: kdf");
        if (!body?.kdfParams) throw badRequest("Missing required field: kdfParams");

        if (body.version !== 1) {
          res.status(400).json({ error: "version-mismatch" });
          return;
        }

        const secretsStore = await store.getSecretsStore();
        const passphrase = await getSyncPassphrase(secretsStore);
        if (passphrase === null) {
          res.status(400).json({ error: "passphrase-not-configured" });
          return;
        }

        let records: SecretsSyncRecord[];
        try {
          records = await unwrapSecretsBundle(body, passphrase);
        } catch (error) {
          if (error instanceof SecretsSyncError) {
            res.status(400).json({ error: error.code });
            return;
          }
          throw error;
        }

        const { appliedCount, skippedCount, appliedKeys } = await upsertRecords(store, records);
        for (const keyInfo of appliedKeys) {
          emitSecretsAudit(req, ctx, "secret:sync-pull", body.sourceNodeId, {
            nodeId: body.sourceNodeId,
            key: keyInfo.key,
            scope: keyInfo.scope,
          });
        }

        res.json({ success: true, appliedCount, skippedCount });
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

  router.get("/secrets/sync-export", async (req, res) => {
    try {
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore(store.getGlobalSettingsDir());
      await central.init();
      try {
        // Validate auth
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          throw new ApiError(401, "Missing or invalid Authorization header");
        }

        const token = authHeader.slice(7);
        const nodes = await central.listNodes();
        const localNode = nodes.find((n: import("@fusion/core").NodeConfig) => n.type === "local");
        if (!localNode) {
          throw new ApiError(401, "Local node not configured");
        }
        if (token.length === 0) {
          throw new ApiError(401, "Missing or invalid Authorization header");
        }
        if (!localNode.apiKey) {
          throw new ApiError(401, "Invalid apiKey");
        }
        if (localNode.apiKey !== token) {
          throw new ApiError(401, "Invalid apiKey");
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
        res.json({ ...envelope, sourceNodeId: localPeerInfo.nodeId, exportedAt: new Date().toISOString() });
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
