import type { Database as ProjectDatabase } from "../db/db.js";
import type { CentralDatabase } from "../central/central-db.js";
import { createSecretCipher, type MasterKeyProvider } from "./secrets-crypto.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as asyncSecretsStore from "../async-stores/async-secrets-store.js";
import { createLogger } from "../process/logger.js";
const severityAuditLog = createLogger("core-secrets-store");

export type SecretScope = "project" | "global";
export function isSecretScope(value: unknown): value is SecretScope {
  return value === "project" || value === "global";
}

export type SecretAccessPolicy = "auto" | "prompt" | "deny";

export interface SecretRecord {
  id: string;
  key: string;
  scope: SecretScope;
  description: string | null;
  accessPolicy: SecretAccessPolicy;
  envExportable: boolean;
  envExportKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  lastReadBy: string | null;
}

export interface EnvExportableSecret {
  id: string;
  key: string;
  exportKey: string;
  scope: SecretScope;
  plaintextValue: string;
}

interface SecretRow {
  id: string;
  key: string;
  description: string | null;
  access_policy: SecretAccessPolicy;
  env_exportable: number;
  env_export_key: string | null;
  created_at: string;
  updated_at: string;
  last_read_at: string | null;
  last_read_by: string | null;
}


type SecretsDb = Pick<ProjectDatabase, "prepare" | "bumpLastModified"> | Pick<CentralDatabase, "prepare" | "bumpLastModified">;

type SecretsStoreAuditEvent = {
  mutationType: "secret:create" | "secret:update" | "secret:delete" | "secret:read";
  scope: SecretScope;
  secretId: string;
  key: string;
  actor?: { agentId?: string | null; userId?: string | null };
};

export interface SecretsStoreOptions {
  /** Optional non-blocking audit emitter. Errors are swallowed/warned so CRUD paths continue. */
  auditEmitter?: (event: SecretsStoreAuditEvent) => void;
  /**
   * FNXC:SecretsStore 2026-06-24-21:00:
   * When provided, the store enters backend (PostgreSQL) mode and delegates all
   * data access to the async helpers in async-secrets-store.ts. The sync SQLite
   * databases (projectDb/centralDb) are ignored in this mode. This is the
   * dual-path pattern: the same class serves both SQLite (CLI/desktop) and
   * PostgreSQL (backend) deployments.
   */
  asyncLayer?: AsyncDataLayer | null;
}

export class SecretsStoreError extends Error {
  readonly code: "duplicate-key" | "not-found" | "invalid-policy" | "invalid-key" | "decrypt-failed";

  constructor(params: {
    code: "duplicate-key" | "not-found" | "invalid-policy" | "invalid-key" | "decrypt-failed";
    message: string;
  }) {
    super(params.message);
    this.name = "SecretsStoreError";
    this.code = params.code;
  }
}



function isAccessPolicy(value: string): value is SecretAccessPolicy {
  return value === "auto" || value === "prompt" || value === "deny";
}

export class SecretsStore {
  private readonly cipher: ReturnType<typeof createSecretCipher>;
  /**
   * FNXC:SecretsStore 2026-06-24-21:05:
   * When non-null, the store is in backend (PostgreSQL) mode and all data
   * access delegates to the async helpers. The sync projectDb/centralDb are
   * not used in this mode.
   */
  private readonly asyncLayer: AsyncDataLayer | null;

  constructor(
    private readonly projectDb: Pick<ProjectDatabase, "prepare" | "bumpLastModified">,
    private readonly centralDb: Pick<CentralDatabase, "prepare" | "bumpLastModified">,
    masterKeyProvider: MasterKeyProvider,
    private readonly options: SecretsStoreOptions = {},
  ) {
    this.cipher = createSecretCipher(masterKeyProvider);
    this.asyncLayer = options.asyncLayer ?? null;
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  private get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  private emitAudit(event: SecretsStoreAuditEvent): void {
    if (!this.options.auditEmitter) return;
    try {
      this.options.auditEmitter(event);
    } catch (error) {
      severityAuditLog.warn("[secrets-store] audit emitter failed", error);
    }
  }

  private dbForScope(scope: SecretScope): SecretsDb {
    return scope === "project" ? this.projectDb : this.centralDb;
  }

  private rowToRecord(row: SecretRow, scope: SecretScope): SecretRecord {
    return {
      id: row.id,
      key: row.key,
      scope,
      description: row.description,
      accessPolicy: row.access_policy,
      envExportable: row.env_exportable === 1,
      envExportKey: row.env_export_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastReadAt: row.last_read_at,
      lastReadBy: row.last_read_by,
    };
  }

  async listSecrets(scope?: SecretScope): Promise<SecretRecord[]> {
        return asyncSecretsStore.listSecrets(this.asyncLayer!.db, scope, this.asyncLayer!.projectId);
}

  async listEnvExportable(opts?: { keyPrefix?: string }): Promise<EnvExportableSecret[]> {
    const keyPrefix = opts?.keyPrefix;
    const projectRows = await this.listSecrets("project");
    const globalRows = await this.listSecrets("global");
    const exported = new Map<string, EnvExportableSecret>();

    const collect = async (row: SecretRecord): Promise<void> => {
      if (!row.envExportable) return;
      if (keyPrefix && !row.key.startsWith(keyPrefix)) return;
      const exportKey = row.envExportKey?.trim() || row.key;
      if (exported.has(exportKey)) {
        if (row.scope === "global") {
          console.debug(`[secrets-store] dropping global env export key due to project override: ${exportKey}`);
        }
        return;
      }
      try {
        const revealed = await this.revealSecret(row.id, row.scope, {
          agentId: null,
          userId: "fusion:secrets-env-writer",
        });
        exported.set(exportKey, {
          id: row.id,
          key: row.key,
          exportKey,
          scope: row.scope,
          plaintextValue: revealed.plaintextValue,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        severityAuditLog.warn(`[secrets-store] failed to reveal env exportable secret ${row.scope}:${row.key}: ${message}`);
      }
    };

    for (const row of projectRows) {
      await collect(row);
    }
    for (const row of globalRows) {
      await collect(row);
    }

    return [...exported.values()];
  }

  async getSecretMetadata(id: string, scope: SecretScope): Promise<SecretRecord | null> {
        return asyncSecretsStore.getSecretMetadata(this.asyncLayer!.db, id, scope, this.asyncLayer!.projectId);
}

  async createSecret(input: {
    scope: SecretScope;
    key: string;
    plaintextValue: string;
    description?: string | null;
    accessPolicy?: SecretAccessPolicy;
    envExportable?: boolean;
    envExportKey?: string | null;
  }): Promise<SecretRecord> {
    const key = input.key.trim();
    if (!key) {
      throw new SecretsStoreError({ code: "invalid-key", message: "Secret key is required" });
    }
    if (input.accessPolicy && !isAccessPolicy(input.accessPolicy)) {
      throw new SecretsStoreError({ code: "invalid-policy", message: "Invalid access policy" });
    }

        const created = await asyncSecretsStore.createSecret(this.asyncLayer!.db, this.cipher, input, this.asyncLayer!.projectId);
    this.emitAudit({ mutationType: "secret:create", scope: input.scope, secretId: created.id, key: created.key });
    return created;
}

  async updateSecret(id: string, scope: SecretScope, patch: {
    key?: string;
    plaintextValue?: string;
    description?: string | null;
    accessPolicy?: SecretAccessPolicy;
    envExportable?: boolean;
    envExportKey?: string | null;
  }): Promise<SecretRecord> {
        const updated = await asyncSecretsStore.updateSecret(this.asyncLayer!.db, this.cipher, id, scope, patch, this.asyncLayer!.projectId);
    this.emitAudit({ mutationType: "secret:update", scope, secretId: updated.id, key: updated.key });
    return updated;
}

  async deleteSecret(id: string, scope: SecretScope): Promise<void> {
        const existing = await this.getSecretMetadata(id, scope);
    if (!existing) {
      throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
    }
    await asyncSecretsStore.deleteSecret(this.asyncLayer!.db, id, scope, this.asyncLayer!.projectId);
    this.emitAudit({ mutationType: "secret:delete", scope, secretId: id, key: existing.key });
    return;
}

  async revealSecret(
    id: string,
    scope: SecretScope,
    reader: { agentId?: string | null; userId?: string | null },
  ): Promise<{ key: string; plaintextValue: string }> {
        const revealed = await asyncSecretsStore.revealSecret(this.asyncLayer!.db, this.cipher, id, scope, reader, this.asyncLayer!.projectId);
    this.emitAudit({ mutationType: "secret:read", scope, secretId: id, key: revealed.key, actor: reader });
    return revealed;
}
}
