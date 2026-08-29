import type { Request } from "express";
import {
  RESERVED_SYNC_PASSPHRASE_KEY,
  clearSyncPassphrase,
  hasSyncPassphraseConfigured,
  isSecretAccessPolicy,
  isSecretScope,
  SecretsStoreError,
  setSyncPassphrase,
  type SecretScope,
} from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

function parseScope(scope: unknown): SecretScope {
  if (isSecretScope(scope)) return scope;
  throw badRequest("scope must be 'project' or 'global'");
}

function mapSecretsError(error: SecretsStoreError): never {
  switch (error.code) {
    case "duplicate-key":
      throw new ApiError(409, error.message, { code: error.code });
    case "not-found":
      throw new ApiError(404, error.message, { code: error.code });
    case "invalid-policy":
    case "invalid-key":
      throw new ApiError(400, error.message, { code: error.code });
    case "decrypt-failed":
      throw new ApiError(500, error.message, { code: error.code });
    default:
      throw new ApiError(500, error.message, { code: error.code });
  }
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("body must be an object");
  }
}

/**
 * FNXC:Secrets 2026-08-05-21:37:
 * Secret routes must reject absent explicit request identity before getProjectContext can resolve the daemon launch engine/store fallback. A selected project is required even for global scope, which remains stored in shared central.secrets_global.
 */
function getExplicitProjectId(req: Request, ctx: Parameters<ApiRouteRegistrar>[0]): string {
  const projectId = ctx.getProjectIdFromRequest(req);
  if (!projectId) throw badRequest("projectId is required");
  return projectId;
}

async function getExplicitSecretsStore(req: Request, ctx: Parameters<ApiRouteRegistrar>[0]) {
  const requestedProjectId = getExplicitProjectId(req, ctx);
  const { store, projectId } = await ctx.getProjectContext(req);
  /*
  FNXC:Secrets 2026-08-05-22:08:
  The explicit id check must happen before context resolution because a launch engine can otherwise substitute its own partition. Reject a resolver mismatch too, so a malformed context cannot redirect a scoped secret request after that precondition.
  */
  if (projectId !== requestedProjectId) throw badRequest("project context does not match projectId");
  return store.getSecretsStore();
}

function emitSecretsAudit(
  req: unknown,
  ctx: Parameters<ApiRouteRegistrar>[0],
  type: "secret:create" | "secret:update" | "secret:delete",
  metadata: Record<string, unknown>,
): void {
  const requestWithAuditor = req as {
    runAuditor?: { filesystem?: (input: { type: string; target: string; metadata?: Record<string, unknown> }) => void };
  };
  if (requestWithAuditor.runAuditor?.filesystem) {
    requestWithAuditor.runAuditor.filesystem({ type, target: "secrets", metadata });
    return;
  }
  ctx.runtimeLogger.child("secrets").info("Secrets audit event", { type, ...metadata });
}

export const registerSecretsRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError } = ctx;

  router.get("/secrets", async (req, res) => {
    try {
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const secrets = await secretsStore.listSecrets();
      const visibleSecrets = secrets.filter(
        (secret) => !(secret.scope === "global" && secret.key === RESERVED_SYNC_PASSPHRASE_KEY),
      );
      res.json({ secrets: visibleSecrets });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to list secrets");
    }
  });

  router.get("/secrets/sync-passphrase", async (req, res) => {
    try {
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const configured = await hasSyncPassphraseConfigured(secretsStore);
      res.json({ configured });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to read sync passphrase status");
    }
  });

  router.put("/secrets/sync-passphrase", async (req, res) => {
    try {
      getExplicitProjectId(req, ctx);
      assertObject(req.body);
      const passphrase = req.body.passphrase;
      if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
        res.status(400).json({ error: "invalid-passphrase" });
        return;
      }
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const hadConfiguredPassphrase = await hasSyncPassphraseConfigured(secretsStore);
      await setSyncPassphrase(secretsStore, passphrase);
      emitSecretsAudit(req, ctx, hadConfiguredPassphrase ? "secret:update" : "secret:create", {
        key: RESERVED_SYNC_PASSPHRASE_KEY,
        scope: "global",
      });
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to set sync passphrase");
    }
  });

  router.delete("/secrets/sync-passphrase", async (req, res) => {
    try {
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      await clearSyncPassphrase(secretsStore);
      emitSecretsAudit(req, ctx, "secret:delete", { key: RESERVED_SYNC_PASSPHRASE_KEY, scope: "global" });
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to clear sync passphrase");
    }
  });

  router.post("/secrets", async (req, res) => {
    try {
      getExplicitProjectId(req, ctx);
      assertObject(req.body);
      const { scope, key, value, description, accessPolicy, envExportable, envExportKey } = req.body;
      const parsedScope = parseScope(scope);
      if (typeof key !== "string" || key.trim().length === 0) {
        throw badRequest("key must be a non-empty string");
      }
      if (typeof value !== "string") {
        throw badRequest("value must be a string");
      }
      let parsedAccessPolicy: "auto" | "prompt" | "deny" | undefined;
      if (accessPolicy !== undefined) {
        if (!isSecretAccessPolicy(accessPolicy)) {
          throw badRequest("accessPolicy must be one of: auto, prompt, deny");
        }
        parsedAccessPolicy = accessPolicy;
      }

      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const secret = await secretsStore.createSecret({
        scope: parsedScope,
        key,
        plaintextValue: value,
        description: typeof description === "string" ? description : null,
        accessPolicy: parsedAccessPolicy,
        envExportable: envExportable === undefined ? undefined : Boolean(envExportable),
        envExportKey: typeof envExportKey === "string" ? envExportKey : null,
      });
      res.status(201).json(secret);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to create secret");
    }
  });

  router.patch("/secrets/:scope/:id", async (req, res) => {
    try {
      getExplicitProjectId(req, ctx);
      const scope = parseScope(req.params.scope);
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");
      assertObject(req.body);

      const patch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(req.body, "key")) {
        if (req.body.key !== null && typeof req.body.key !== "string") {
          throw badRequest("key must be a string when provided");
        }
        patch.key = req.body.key;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
        if (req.body.description !== null && typeof req.body.description !== "string") {
          throw badRequest("description must be a string or null");
        }
        patch.description = req.body.description;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "accessPolicy")) {
        if (req.body.accessPolicy !== null && !isSecretAccessPolicy(req.body.accessPolicy)) {
          throw badRequest("accessPolicy must be one of: auto, prompt, deny");
        }
        patch.accessPolicy = req.body.accessPolicy;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "envExportable")) {
        if (req.body.envExportable !== null && typeof req.body.envExportable !== "boolean") {
          throw badRequest("envExportable must be a boolean or null");
        }
        patch.envExportable = req.body.envExportable;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "envExportKey")) {
        if (req.body.envExportKey !== null && typeof req.body.envExportKey !== "string") {
          throw badRequest("envExportKey must be a string or null");
        }
        patch.envExportKey = req.body.envExportKey;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "value")) {
        if (req.body.value !== null && typeof req.body.value !== "string") {
          throw badRequest("value must be a string when provided");
        }
        if (typeof req.body.value === "string") {
          patch.plaintextValue = req.body.value;
        }
      }

      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const secret = await secretsStore.updateSecret(id, scope, patch);
      res.json(secret);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to update secret");
    }
  });

  router.delete("/secrets/:scope/:id", async (req, res) => {
    try {
      getExplicitProjectId(req, ctx);
      const scope = parseScope(req.params.scope);
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      await secretsStore.deleteSecret(id, scope);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to delete secret");
    }
  });

  router.post("/secrets/:scope/:id/reveal", async (req, res) => {
    try {
      getExplicitProjectId(req, ctx);
      const scope = parseScope(req.params.scope);
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");
      const secretsStore = await getExplicitSecretsStore(req, ctx);
      const secret = await secretsStore.revealSecret(id, scope, {
        userId: null,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json({ key: secret.key, value: secret.plaintextValue });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to reveal secret");
    }
  });
};
