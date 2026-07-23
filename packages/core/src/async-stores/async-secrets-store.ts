/**
 * Async Drizzle SecretsStore helpers (U6 satellite-central-archive-db).
 *
 * FNXC:SecretsStore 2026-06-24-20:00:
 * Async equivalents of the sync SQLite SecretsStore call sites in
 * secrets-store.ts. SecretsStore is dual-scope: it writes project-scoped
 * secrets to `project.secrets` and global-scoped secrets to
 * `central.secrets_global`. Under the shared PostgreSQL backend both scopes
 * are served by the single `AsyncDataLayer` (the connection serves all
 * schemas), so the dual-database injection (projectDb + centralDb) collapses
 * to one layer and the scope selects the table.
 *
 * This is the "SecretsStore async injection against central PostgreSQL" the
 * feature requires. The sync store keeps its sync path until the coordinated
 * `getDatabase()` flip (the gate depends on it); these helpers are the async
 * target the PostgreSQL integration tests consume and the surface the
 * dashboard/engine will program against once the connection model flips.
 *
 * SQLite → PostgreSQL notes (see library/satellite-store-migration-pattern.md
 * and library/satellite-fusiondir-stores-notes.md):
 *   - The BLOB `value_ciphertext` / `nonce` columns are `bytea` in PostgreSQL
 *     (VAL-SCHEMA-004 / VAL-CROSS-011). The secrets-roundtrip test proves the
 *     bytes survive byte-identical; the cipher is driver-agnostic.
 *   - The boolean `env_exportable` integer 0/1 column is kept as integer in
 *     PostgreSQL ("kept as integer to preserve exact behavior"), so
 *     `row.envExportable === 1` checks still work.
 *   - SQLite `UNIQUE constraint failed` → PostgreSQL unique_violation
 *     (error code 23505). The code may be on the error directly (raw
 *     postgres.js) or on the `cause` (Drizzle wraps postgres errors).
 *   - `db.bumpLastModified()` (an in-memory change-notification timestamp) has
 *     no PostgreSQL equivalent at this layer; change notification moves to
 *     LISTEN/NOTIFY at the consumer layer. It is a no-op on the async path.
 *
 * Transition context:
 *   The sync SecretsStore constructor takes `projectDb` + `centralDb` (both the
 *   sync `Database`/`CentralDatabase`). The async target takes the single
 *   `AsyncDataLayer` plus a `MasterKeyProvider`. The helpers below are the
 *   async data path; a thin async wrapper class (`AsyncSecretsStore`) wires
 *   them together with the cipher and the audit emitter so consumers can drop
 *   it in place of the sync store at the flip.
 */
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { isPostgresUniqueError } from "../db/postgres-errors.js";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import {
  createSecretCipher,
  SecretCryptoError,
  type MasterKeyProvider,
} from "../secrets/secrets-crypto.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

export type SecretScope = "project" | "global";
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

/**
 * A secrets row from either project.secrets or central.secrets_global.
 * FNXC:SecretsStore 2026-06-24-20:05:
 * Both tables share the same column shape. `envExportable` is integer 0/1.
 */
interface SecretRow {
  id: string;
  key: string;
  description: string | null;
  accessPolicy: SecretAccessPolicy;
  envExportable: number;
  envExportKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  lastReadBy: string | null;
}

interface SecretCipherRow extends SecretRow {
  valueCiphertext: Buffer;
  nonce: Buffer;
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

/**
 * FNXC:SecretsStore 2026-06-24-20:12:
 * The columns both secrets tables share. project.secrets and
 * central.secrets_global have identical column shapes but are distinct Drizzle
 * table objects (different schema/name literal). The helpers operate on the
 * project.secrets table type and the global table is cast at the dispatch
 * boundary since the two are structurally identical column-for-column.
 */
type ProjectSecretsTable = typeof schema.project.secrets;

/**
 * Resolve the Drizzle table ref for a scope. Both tables share the same column
 * shape, so the call sites are identical once the table ref is selected.
 * FNXC:SecretsStore 2026-06-24-20:10:
 * Under the shared PostgreSQL backend a single connection serves both schemas,
 * so the dual-database injection collapses to a scope-to-table dispatch. The
 * central.secrets_global table is structurally identical to project.secrets
 * (same columns, same types), so it is cast to the project table type at the
 * dispatch boundary; the helper bodies then compile against one table type.
 */
function tableForScope(scope: SecretScope): ProjectSecretsTable {
  return scope === "project"
    ? schema.project.secrets
    : (schema.central.secretsGlobal as unknown as ProjectSecretsTable);
}

function isAccessPolicy(value: string): value is SecretAccessPolicy {
  return value === "auto" || value === "prompt" || value === "deny";
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value as Uint8Array);
}

function rowToRecord(row: SecretRow, scope: SecretScope): SecretRecord {
  return {
    id: row.id,
    key: row.key,
    scope,
    description: row.description,
    accessPolicy: row.accessPolicy,
    envExportable: row.envExportable === 1,
    envExportKey: row.envExportKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastReadAt: row.lastReadAt,
    lastReadBy: row.lastReadBy,
  };
}

const metadataColumns = (table: ProjectSecretsTable) => ({
  id: table.id,
  key: table.key,
  description: table.description,
  accessPolicy: table.accessPolicy,
  envExportable: table.envExportable,
  envExportKey: table.envExportKey,
  createdAt: table.createdAt,
  updatedAt: table.updatedAt,
  lastReadAt: table.lastReadAt,
  lastReadBy: table.lastReadBy,
});

/**
 * FNXC:SecretsStore 2026-06-24-20:15:
 * Read the non-secret metadata for one secret by id. Mirrors sync
 * `SecretsStore.getSecretMetadata()`. Returns null when absent.
 */
export async function getSecretMetadata(
  handle: QueryHandle,
  id: string,
  scope: SecretScope,
): Promise<SecretRecord | null> {
  const table = tableForScope(scope);
  const rows = await handle
    .select(metadataColumns(table))
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  const row = rows[0] as SecretRow | undefined;
  return row ? rowToRecord(row, scope) : null;
}

/**
 * FNXC:SecretsStore 2026-06-24-20:20:
 * List secret metadata for a scope (or both scopes when undefined), ordered by
 * key case-insensitively. Mirrors sync `SecretsStore.listSecrets()`.
 */
export async function listSecrets(
  handle: QueryHandle,
  scope?: SecretScope,
): Promise<SecretRecord[]> {
  if (scope) {
    const table = tableForScope(scope);
    const rows = await handle
      .select(metadataColumns(table))
      .from(table)
      .orderBy(asc(sql`lower(${table.key})`));
    return (rows as SecretRow[]).map((row) => rowToRecord(row, scope));
  }
  const project = await listSecrets(handle, "project");
  const global = await listSecrets(handle, "global");
  return [...project, ...global];
}

/**
 * FNXC:SecretsStore 2026-06-24-20:25:
 * Create a new secret. Encrypts the plaintext (AES-256-GCM via the master key
 * provider) and inserts into the scope's table. Throws duplicate-key on a
 * unique violation. Mirrors sync `SecretsStore.createSecret()`.
 */
export async function createSecret(
  handle: QueryHandle,
  cipher: ReturnType<typeof createSecretCipher>,
  input: {
    scope: SecretScope;
    key: string;
    plaintextValue: string;
    description?: string | null;
    accessPolicy?: SecretAccessPolicy;
    envExportable?: boolean;
    envExportKey?: string | null;
  },
): Promise<SecretRecord> {
  const key = input.key.trim();
  if (!key) {
    throw new SecretsStoreError({ code: "invalid-key", message: "Secret key is required" });
  }
  if (input.accessPolicy && !isAccessPolicy(input.accessPolicy)) {
    throw new SecretsStoreError({ code: "invalid-policy", message: "Invalid access policy" });
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const encrypted = await cipher.encrypt(input.plaintextValue);
  const table = tableForScope(input.scope);

  try {
    await handle.insert(table).values({
      id,
      key,
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: input.description ?? null,
      accessPolicy: input.accessPolicy ?? "auto",
      envExportable: input.envExportable ? 1 : 0,
      envExportKey: input.envExportKey ?? null,
      createdAt: now,
      updatedAt: now,
      lastReadAt: null,
      lastReadBy: null,
    });
  } catch (error) {
    if (isPostgresUniqueError(error)) {
      throw new SecretsStoreError({ code: "duplicate-key", message: "Secret key already exists" });
    }
    throw error;
  }

  const created = await getSecretMetadata(handle, id, input.scope);
  if (!created) {
    throw new SecretsStoreError({ code: "not-found", message: "Secret insert succeeded but row could not be read back" });
  }
  return created;
}

/**
 * FNXC:SecretsStore 2026-06-24-20:30:
 * Patch an existing secret. Only the supplied fields are updated; when
 * `plaintextValue` is supplied the value is re-encrypted. Throws not-found
 * when absent, duplicate-key on a key collision. Mirrors sync
 * `SecretsStore.updateSecret()`.
 */
export async function updateSecret(
  handle: QueryHandle,
  cipher: ReturnType<typeof createSecretCipher>,
  id: string,
  scope: SecretScope,
  patch: {
    key?: string;
    plaintextValue?: string;
    description?: string | null;
    accessPolicy?: SecretAccessPolicy;
    envExportable?: boolean;
    envExportKey?: string | null;
  },
): Promise<SecretRecord> {
  const existing = await getSecretMetadata(handle, id, scope);
  if (!existing) {
    throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
  }

  const table = tableForScope(scope);
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  if (patch.key !== undefined) {
    const key = patch.key.trim();
    if (!key) {
      throw new SecretsStoreError({ code: "invalid-key", message: "Secret key is required" });
    }
    updates.key = key;
  }
  if (patch.description !== undefined) {
    updates.description = patch.description ?? null;
  }
  if (patch.accessPolicy !== undefined) {
    if (!isAccessPolicy(patch.accessPolicy)) {
      throw new SecretsStoreError({ code: "invalid-policy", message: "Invalid access policy" });
    }
    updates.accessPolicy = patch.accessPolicy;
  }
  if (patch.envExportable !== undefined) {
    updates.envExportable = patch.envExportable ? 1 : 0;
  }
  if (patch.envExportKey !== undefined) {
    updates.envExportKey = patch.envExportKey ?? null;
  }
  if (patch.plaintextValue !== undefined) {
    const encrypted = await cipher.encrypt(patch.plaintextValue);
    updates.valueCiphertext = encrypted.ciphertext;
    updates.nonce = encrypted.nonce;
  }

  try {
    await handle.update(table).set(updates).where(eq(table.id, id));
  } catch (error) {
    if (isPostgresUniqueError(error)) {
      throw new SecretsStoreError({ code: "duplicate-key", message: "Secret key already exists" });
    }
    throw error;
  }

  const updated = await getSecretMetadata(handle, id, scope);
  if (!updated) {
    throw new SecretsStoreError({ code: "not-found", message: "Secret update succeeded but row could not be read back" });
  }
  return updated;
}

/**
 * FNXC:SecretsStore 2026-06-24-20:35:
 * Delete a secret by id. Throws not-found when absent. Mirrors sync
 * `SecretsStore.deleteSecret()`.
 */
export async function deleteSecret(
  handle: QueryHandle,
  id: string,
  scope: SecretScope,
): Promise<void> {
  const existing = await getSecretMetadata(handle, id, scope);
  if (!existing) {
    throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
  }
  const table = tableForScope(scope);
  await handle.delete(table).where(eq(table.id, id));
}

/**
 * FNXC:SecretsStore 2026-06-24-20:40:
 * Reveal (decrypt) a secret by id, recording the read event (lastReadAt/by).
 * Mirrors sync `SecretsStore.revealSecret()`. Throws not-found when absent,
 * decrypt-failed when the GCM auth tag rejects the ciphertext.
 */
export async function revealSecret(
  handle: QueryHandle,
  cipher: ReturnType<typeof createSecretCipher>,
  id: string,
  scope: SecretScope,
  reader: { agentId?: string | null; userId?: string | null },
): Promise<{ key: string; plaintextValue: string }> {
  const table = tableForScope(scope);
  const rows = await handle
    .select({
      ...metadataColumns(table),
      valueCiphertext: table.valueCiphertext,
      nonce: table.nonce,
    })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  const row = rows[0] as SecretCipherRow | undefined;
  if (!row) {
    throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
  }

  let plaintextValue: string;
  try {
    plaintextValue = await cipher.decrypt({
      ciphertext: toBuffer(row.valueCiphertext),
      nonce: toBuffer(row.nonce),
    });
  } catch (error) {
    if (error instanceof SecretCryptoError && error.code === "decryption-failed") {
      throw new SecretsStoreError({ code: "decrypt-failed", message: "Secret decryption failed" });
    }
    throw new SecretsStoreError({ code: "decrypt-failed", message: "Secret decryption failed" });
  }

  const now = new Date().toISOString();
  const lastReadBy = reader.userId ?? reader.agentId ?? null;
  await handle
    .update(table)
    .set({ lastReadAt: now, lastReadBy, updatedAt: now })
    .where(eq(table.id, id));

  return { key: row.key, plaintextValue };
}

export type SecretsStoreAuditEvent = {
  mutationType: "secret:create" | "secret:update" | "secret:delete" | "secret:read";
  scope: SecretScope;
  secretId: string;
  key: string;
  actor?: { agentId?: string | null; userId?: string | null };
};

export interface AsyncSecretsStoreOptions {
  /** Optional non-blocking audit emitter. Errors are swallowed/warned so CRUD paths continue. */
  auditEmitter?: (event: SecretsStoreAuditEvent) => void;
}

/**
 * FNXC:SecretsStore 2026-06-24-20:45:
 * Async SecretsStore wrapper. This is the async-injection target for the
 * dashboard/engine: it takes the single `AsyncDataLayer` (which serves both
 * the project and central schemas) plus a `MasterKeyProvider`, and exposes
 * the same surface the sync `SecretsStore` did. The sync store keeps its
 * constructor shape until the coordinated `getDatabase()` flip; this wrapper
 * is what consumers drop in once the connection model flips.
 *
 * The helper functions above operate on a `QueryHandle`; this wrapper always
 * passes `layer.db` (non-transactional). A transaction-scoped variant can pass
 * a `tx` instead if a caller needs the secret mutation to commit/rollback with
 * surrounding work.
 */
export class AsyncSecretsStore {
  private readonly cipher: ReturnType<typeof createSecretCipher>;

  constructor(
    private readonly layer: AsyncDataLayer,
    masterKeyProvider: MasterKeyProvider,
    private readonly options: AsyncSecretsStoreOptions = {},
  ) {
    this.cipher = createSecretCipher(masterKeyProvider);
  }

  private emitAudit(event: SecretsStoreAuditEvent): void {
    if (!this.options.auditEmitter) return;
    try {
      this.options.auditEmitter(event);
    } catch (error) {
      console.warn("[async-secrets-store] audit emitter failed", error);
    }
  }

  listSecrets(scope?: SecretScope): Promise<SecretRecord[]> {
    return listSecrets(this.layer.db, scope);
  }

  async getSecretMetadata(id: string, scope: SecretScope): Promise<SecretRecord | null> {
    return getSecretMetadata(this.layer.db, id, scope);
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
    const created = await createSecret(this.layer.db, this.cipher, input);
    this.emitAudit({ mutationType: "secret:create", scope: input.scope, secretId: created.id, key: created.key });
    return created;
  }

  async updateSecret(
    id: string,
    scope: SecretScope,
    patch: {
      key?: string;
      plaintextValue?: string;
      description?: string | null;
      accessPolicy?: SecretAccessPolicy;
      envExportable?: boolean;
      envExportKey?: string | null;
    },
  ): Promise<SecretRecord> {
    const updated = await updateSecret(this.layer.db, this.cipher, id, scope, patch);
    this.emitAudit({ mutationType: "secret:update", scope, secretId: updated.id, key: updated.key });
    return updated;
  }

  async deleteSecret(id: string, scope: SecretScope): Promise<void> {
    const existing = await getSecretMetadata(this.layer.db, id, scope);
    if (!existing) {
      throw new SecretsStoreError({ code: "not-found", message: "Secret not found" });
    }
    await deleteSecret(this.layer.db, id, scope);
    this.emitAudit({ mutationType: "secret:delete", scope, secretId: id, key: existing.key });
  }

  async revealSecret(
    id: string,
    scope: SecretScope,
    reader: { agentId?: string | null; userId?: string | null },
  ): Promise<{ key: string; plaintextValue: string }> {
    const revealed = await revealSecret(this.layer.db, this.cipher, id, scope, reader);
    this.emitAudit({ mutationType: "secret:read", scope, secretId: id, key: revealed.key, actor: reader });
    return revealed;
  }

  /**
   * FNXC:SecretsStore 2026-06-24-20:50:
   * Collect env-exportable secrets (project scope overrides global on key
   * collision), decrypting each. Mirrors sync
   * `SecretsStore.listEnvExportable()`.
   */
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
          console.debug(`[async-secrets-store] dropping global env export key due to project override: ${exportKey}`);
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
        console.warn(`[async-secrets-store] failed to reveal env exportable secret ${row.scope}:${row.key}: ${message}`);
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
}
