import { randomUUID } from "node:crypto";
import type { Database as ProjectDatabase } from "../db/db.js";
import type { CentralDatabase } from "../central/central-db.js";
import { createSecretCipher, SecretCryptoError, type MasterKeyProvider } from "./secrets-crypto.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as asyncSecretsStore from "../async-stores/async-secrets-store.js";

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

interface SecretCipherRow extends SecretRow {
  value_ciphertext: Buffer;
  nonce: Buffer;
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

function tableForScope(scope: SecretScope): "secrets" | "secrets_global" {
  return scope === "project" ? "secrets" : "secrets_global";
}

function isSqliteUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
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
      console.warn("[secrets-store] audit emitter failed", error);
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
    if (this.backendMode) {
      return asyncSecretsStore.listSecrets(this.asyncLayer!.db, scope);
    }
    if (scope) {
      const db = this.dbForScope(scope);
      const table = tableForScope(scope);
      const rows = db.prepare(`SELECT id, key, description, access_policy, env_exportable, env_export_key, created_at, updated_at, last_read_at, last_read_by FROM ${table} ORDER BY key COLLATE NOCASE ASC`).all() as SecretRow[];
      return rows.map((row) => this.rowToRecord(row, scope));
    }

    const [project, global] = await Promise.all([
      this.listSecrets("project"),
      this.listSecrets("global"),
    ]);
    return [...project, ...global];
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
        console.warn(`[secrets-store] failed to reveal env exportable secret ${row.scope}:${row.key}: ${message}`);
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
    if (this.backendMode) {
      return asyncSecretsStore.getSecretMetadata(this.asyncLayer!.db, id, scope);
    }
    const db = this.dbForScope(scope);
    const table = tableForScope(scope);
    const row = db.prepare(`SELECT id, key, description, access_policy, env_exportable, env_export_key, created_at, updated_at, last_read_at, last_read_by FROM ${table} WHERE id = ?`).get(id) as SecretRow | undefined;
    return row ? this.rowToRecord(row, scope) : null;
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

    if (this.backendMode) {
      const created = await asyncSecretsStore.createSecret(this.asyncLayer!.db, this.cipher, input);
      this.emitAudit({ mutationType: "secret:create", scope: input.scope, secretId: created.id, key: created.key });
      return created;
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const encrypted = await this.cipher.encrypt(input.plaintextValue);
    const scope = input.scope;
    const db = this.dbForScope(scope);
    const table = tableForScope(scope);

    try {
      db.prepare(`INSERT INTO ${table} (id, key, value_ciphertext, nonce, description, access_policy, env_exportable, env_export_key, created_at, updated_at, last_read_at, last_read_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(
          id,
          key,
          encrypted.ciphertext,
          encrypted.nonce,
          input.description ?? null,
          input.accessPolicy ?? "auto",
          input.envExportable ? 1 : 0,
          input.envExportKey ?? null,
          now,
          now,
        );
      db.bumpLastModified();
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        throw new SecretsStoreError({ code: "duplicate-key", message: "Secret key already exists" });
      }
      throw error;
    }

    const created = (await this.getSecretMetadata(id, scope))!;
    this.emitAudit({ mutationType: "secret:create", scope, secretId: created.id, key: created.key });
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
    if (this.backendMode) {
      const updated = await asyncSecretsStore.updateSecret(this.asyncLayer!.db, this.cipher, id, scope, patch);
      this.emitAudit({ mutationType: "secret:update", scope, secretId: updated.id, key: updated.key });
      return updated;
    }

    const existing = await this.getSecretMetadata(id, scope);
    if (!existing) {
      throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
    }

    const updates: string[] = ["updated_at = ?"];
    const params: Array<string | number | Buffer | null> = [new Date().toISOString()];

    if (patch.key !== undefined) {
      const key = patch.key.trim();
      if (!key) {
        throw new SecretsStoreError({ code: "invalid-key", message: "Secret key is required" });
      }
      updates.push("key = ?");
      params.push(key);
    }

    if (patch.description !== undefined) {
      updates.push("description = ?");
      params.push(patch.description ?? null);
    }

    if (patch.accessPolicy !== undefined) {
      if (!isAccessPolicy(patch.accessPolicy)) {
        throw new SecretsStoreError({ code: "invalid-policy", message: "Invalid access policy" });
      }
      updates.push("access_policy = ?");
      params.push(patch.accessPolicy);
    }

    if (patch.envExportable !== undefined) {
      updates.push("env_exportable = ?");
      params.push(patch.envExportable ? 1 : 0);
    }

    if (patch.envExportKey !== undefined) {
      updates.push("env_export_key = ?");
      params.push(patch.envExportKey ?? null);
    }

    if (patch.plaintextValue !== undefined) {
      const encrypted = await this.cipher.encrypt(patch.plaintextValue);
      updates.push("value_ciphertext = ?", "nonce = ?");
      params.push(encrypted.ciphertext, encrypted.nonce);
    }

    const db = this.dbForScope(scope);
    const table = tableForScope(scope);

    try {
      params.push(id);
      db.prepare(`UPDATE ${table} SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      db.bumpLastModified();
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        throw new SecretsStoreError({ code: "duplicate-key", message: "Secret key already exists" });
      }
      throw error;
    }

    const updated = (await this.getSecretMetadata(id, scope))!;
    this.emitAudit({ mutationType: "secret:update", scope, secretId: updated.id, key: updated.key });
    return updated;
  }

  async deleteSecret(id: string, scope: SecretScope): Promise<void> {
    if (this.backendMode) {
      const existing = await this.getSecretMetadata(id, scope);
      if (!existing) {
        throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
      }
      await asyncSecretsStore.deleteSecret(this.asyncLayer!.db, id, scope);
      this.emitAudit({ mutationType: "secret:delete", scope, secretId: id, key: existing.key });
      return;
    }

    const existing = await this.getSecretMetadata(id, scope);
    if (!existing) {
      throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
    }

    const db = this.dbForScope(scope);
    const table = tableForScope(scope);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    db.bumpLastModified();
    this.emitAudit({ mutationType: "secret:delete", scope, secretId: id, key: existing.key });
  }

  async revealSecret(
    id: string,
    scope: SecretScope,
    reader: { agentId?: string | null; userId?: string | null },
  ): Promise<{ key: string; plaintextValue: string }> {
    if (this.backendMode) {
      const revealed = await asyncSecretsStore.revealSecret(this.asyncLayer!.db, this.cipher, id, scope, reader);
      this.emitAudit({ mutationType: "secret:read", scope, secretId: id, key: revealed.key, actor: reader });
      return revealed;
    }

    const db = this.dbForScope(scope);
    const table = tableForScope(scope);
    const row = db.prepare(`SELECT id, key, value_ciphertext, nonce, description, access_policy, env_exportable, env_export_key, created_at, updated_at, last_read_at, last_read_by FROM ${table} WHERE id = ?`).get(id) as SecretCipherRow | undefined;

    if (!row) {
      throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
    }

    let plaintextValue: string;
    try {
      plaintextValue = await this.cipher.decrypt({ ciphertext: row.value_ciphertext, nonce: row.nonce });
    } catch (error) {
      if (error instanceof SecretCryptoError && error.code === "decryption-failed") {
        throw new SecretsStoreError({ code: "decrypt-failed", message: "Secret decryption failed" });
      }
      throw new SecretsStoreError({ code: "decrypt-failed", message: "Secret decryption failed" });
    }

    const now = new Date().toISOString();
    const lastReadBy = reader.userId ?? reader.agentId ?? null;
    db.prepare(`UPDATE ${table} SET last_read_at = ?, last_read_by = ?, updated_at = ? WHERE id = ?`).run(now, lastReadBy, now, id);
    db.bumpLastModified();

    this.emitAudit({ mutationType: "secret:read", scope, secretId: id, key: row.key, actor: reader });
    return { key: row.key, plaintextValue };
  }
}
