import { SecretsStoreError, type SecretScope } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const VALID_SCOPES: SecretScope[] = ["project", "global"];
const VALID_POLICIES = ["auto", "prompt", "deny"] as const;

function parseScope(scope: unknown): SecretScope {
  if (scope === "project" || scope === "global") return scope;
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

export const registerSecretsRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  router.get("/secrets", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const secretsStore = await scopedStore.getSecretsStore();
      const secrets = await secretsStore.listSecrets();
      res.json({ secrets });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof SecretsStoreError) mapSecretsError(err);
      rethrowAsApiError(err, "Failed to list secrets");
    }
  });

  router.post("/secrets", async (req, res) => {
    try {
      assertObject(req.body);
      const { scope, key, value, description, accessPolicy, envExportable, envExportKey } = req.body;
      if (!VALID_SCOPES.includes(scope as SecretScope)) {
        throw badRequest("scope must be 'project' or 'global'");
      }
      if (typeof key !== "string" || key.trim().length === 0) {
        throw badRequest("key must be a non-empty string");
      }
      if (typeof value !== "string") {
        throw badRequest("value must be a string");
      }
      if (accessPolicy !== undefined && !VALID_POLICIES.includes(accessPolicy as (typeof VALID_POLICIES)[number])) {
        throw badRequest("accessPolicy must be one of: auto, prompt, deny");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const secretsStore = await scopedStore.getSecretsStore();
      const secret = await secretsStore.createSecret({
        scope,
        key,
        plaintextValue: value,
        description: typeof description === "string" ? description : null,
        accessPolicy,
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
        if (req.body.accessPolicy !== null && !VALID_POLICIES.includes(req.body.accessPolicy as (typeof VALID_POLICIES)[number])) {
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

      const { store: scopedStore } = await getProjectContext(req);
      const secretsStore = await scopedStore.getSecretsStore();
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
      const scope = parseScope(req.params.scope);
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");
      const { store: scopedStore } = await getProjectContext(req);
      const secretsStore = await scopedStore.getSecretsStore();
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
      const scope = parseScope(req.params.scope);
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");
      const { store: scopedStore } = await getProjectContext(req);
      const secretsStore = await scopedStore.getSecretsStore();
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
