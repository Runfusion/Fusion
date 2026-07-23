/**
 * PostgreSQL secrets round-trip integration test (U6 / VAL-CROSS-011).
 *
 * FNXC:SecretsStore 2026-06-24-12:00:
 * Secrets must encrypt and decrypt correctly against the central PostgreSQL
 * database. This test proves the at-rest encryption path (AES-256-GCM via
 * createSecretCipher) round-trips through the PostgreSQL `secrets` (project
 * schema) and `secrets_global` (central schema) `bytea` columns — the columns
 * that the async satellite-store migration targets.
 *
 * Why this test exists:
 *   The SQLite BLOB columns for `value_ciphertext` / `nonce` map to PostgreSQL
 *   `bytea` (see schema/_shared.ts). A naive conversion could corrupt the
 *   ciphertext/auth-tag bytes (e.g. via Buffer-vs-Uint8Array drift, hex
 *   encoding, or truncation), which would only surface at decrypt time. This
 *   test exercises the full encrypt → INSERT → SELECT → decrypt cycle against
 *   both schemas so any byte-level corruption fails loudly.
 *
 * Coverage:
 *   VAL-CROSS-011 — Secrets encryption round-trips against the central
 *     PostgreSQL database (project + global scope).
 *   VAL-DATA-016 prerequisite — the bytea-backed secret storage the plugin
 *     store contract depends on is correct under PostgreSQL.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { createSecretCipher } from "../../secrets/secrets-crypto.js";
import * as schema from "../../postgres/schema/index.js";

const PG_ADMIN_URL =
  process.env.FUSION_PG_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

/**
 * FNXC:SecretsStore 2026-06-24-12:00:
 * Create a uniquely-named fresh database for each test so tests are hermetic
 * and never touch existing data. Mirrors the data-layer / schema-applier test
 * harness (CREATE/DROP DATABASE cannot run inside a transaction, so psql via
 * execSync is the acceptable short-DDL use per AGENTS.md).
 */
function uniqueDbName(): string {
  return `fusion_secret_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface SecretTestCtx {
  dbName: string;
  testUrl: string;
  adminSql: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
}

async function setupCtx(): Promise<SecretTestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  // Apply the baseline schema so secrets + secrets_global exist.
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({
    databaseUrl: testUrl,
    databaseMigrationUrl: testUrl,
  });
  const connections = await createConnectionSetFromUrl(backend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  await applySchemaBaseline(connections.migration);
  await connections.close();

  const adminSql = postgres(testUrl, { max: 3, prepare: false, onnotice: () => {} });
  const db = drizzle(adminSql);
  return { dbName, testUrl, adminSql, db };
}

async function teardownCtx(ctx: SecretTestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.adminSql.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
}

/** A fixed 32-byte master key provider for deterministic test crypto. */
function fixedMasterKeyProvider(key: Buffer = randomBytes(32)): () => Promise<Buffer> {
  return async () => Buffer.from(key);
}

pgDescribe("PostgreSQL secrets round-trip (VAL-CROSS-011)", () => {
  let ctx: SecretTestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("round-trips a project-scoped secret through project.secrets bytea columns", async () => {
    ctx = await setupCtx();
    const cipher = createSecretCipher(fixedMasterKeyProvider());
    const plaintext = "super-secret-api-key-12345";
    const encrypted = await cipher.encrypt(plaintext);

    // Insert into project.secrets via Drizzle.
    await ctx.db.insert(schema.project.secrets).values({
      id: "sec-test-1",
      key: "API_KEY",
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: "test secret",
      accessPolicy: "auto",
      envExportable: 0,
      envExportKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReadAt: null,
      lastReadBy: null,
    });

    // Read it back.
    const rows = await ctx.db
      .select()
      .from(schema.project.secrets)
      .where(eq(schema.project.secrets.id, "sec-test-1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // The bytea columns must survive the round-trip byte-identical.
    const ciphertextBack = Buffer.isBuffer(row.valueCiphertext)
      ? row.valueCiphertext
      : Buffer.from(row.valueCiphertext as Uint8Array);
    const nonceBack = Buffer.isBuffer(row.nonce)
      ? row.nonce
      : Buffer.from(row.nonce as Uint8Array);
    expect(ciphertextBack.equals(encrypted.ciphertext)).toBe(true);
    expect(nonceBack.equals(encrypted.nonce)).toBe(true);

    // Decrypt and verify the plaintext matches.
    const decrypted = await cipher.decrypt({
      ciphertext: ciphertextBack,
      nonce: nonceBack,
    });
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips a global-scoped secret through central.secrets_global bytea columns", async () => {
    ctx = await setupCtx();
    const cipher = createSecretCipher(fixedMasterKeyProvider());
    const plaintext = "global-secret-token-XYZ";
    const encrypted = await cipher.encrypt(plaintext);

    await ctx.db.insert(schema.central.secretsGlobal).values({
      id: "sec-global-1",
      key: "GLOBAL_TOKEN",
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: null,
      accessPolicy: "prompt",
      envExportable: 1,
      envExportKey: "GLOBAL_TOKEN",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReadAt: null,
      lastReadBy: null,
    });

    const rows = await ctx.db
      .select()
      .from(schema.central.secretsGlobal)
      .where(eq(schema.central.secretsGlobal.id, "sec-global-1"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    const ciphertextBack = Buffer.isBuffer(row.valueCiphertext)
      ? row.valueCiphertext
      : Buffer.from(row.valueCiphertext as Uint8Array);
    const nonceBack = Buffer.isBuffer(row.nonce)
      ? row.nonce
      : Buffer.from(row.nonce as Uint8Array);

    const decrypted = await cipher.decrypt({
      ciphertext: ciphertextBack,
      nonce: nonceBack,
    });
    expect(decrypted).toBe(plaintext);
  });

  it("preserves ciphertext integrity across a re-read (tamper detection via GCM auth tag)", async () => {
    ctx = await setupCtx();
    const cipher = createSecretCipher(fixedMasterKeyProvider());
    const plaintext = "integrity-check-value";
    const encrypted = await cipher.encrypt(plaintext);

    await ctx.db.insert(schema.project.secrets).values({
      id: "sec-tamper-1",
      key: "INTEGRITY",
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: null,
      accessPolicy: "auto",
      envExportable: 0,
      envExportKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReadAt: null,
      lastReadBy: null,
    });

    // Tamper with the ciphertext directly in the database.
    await ctx.db.execute(
      sql`UPDATE project.secrets SET value_ciphertext = set_byte(value_ciphertext, 0, get_byte(value_ciphertext, 0) # 1) WHERE id = ${"sec-tamper-1"}`,
    );

    const rows = await ctx.db
      .select()
      .from(schema.project.secrets)
      .where(eq(schema.project.secrets.id, "sec-tamper-1"));
    const row = rows[0]!;
    const tamperedCiphertext = Buffer.isBuffer(row.valueCiphertext)
      ? row.valueCiphertext
      : Buffer.from(row.valueCiphertext as Uint8Array);
    const nonceBack = Buffer.isBuffer(row.nonce)
      ? row.nonce
      : Buffer.from(row.nonce as Uint8Array);

    // AES-GCM auth tag must reject the tampered ciphertext.
    await expect(
      cipher.decrypt({ ciphertext: tamperedCiphertext, nonce: nonceBack }),
    ).rejects.toThrow(/secret decryption failed/u);
  });

  it("enforces the access_policy CHECK constraint on project.secrets", async () => {
    ctx = await setupCtx();
    const cipher = createSecretCipher(fixedMasterKeyProvider());
    const encrypted = await cipher.encrypt("v");

    // Valid policy inserts fine.
    await ctx.db.insert(schema.project.secrets).values({
      id: "sec-policy-ok",
      key: "POLICY_OK",
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: null,
      accessPolicy: "deny",
      envExportable: 0,
      envExportKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReadAt: null,
      lastReadBy: null,
    });

    // Invalid policy is rejected by the CHECK constraint.
    await expect(
      ctx.db.insert(schema.project.secrets).values({
        id: "sec-policy-bad",
        key: "POLICY_BAD",
        valueCiphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        description: null,
        accessPolicy: "bogus",
        envExportable: 0,
        envExportKey: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastReadAt: null,
        lastReadBy: null,
      }),
    ).rejects.toThrow();
  });

  it("enforces key uniqueness on project.secrets", async () => {
    ctx = await setupCtx();
    const cipher = createSecretCipher(fixedMasterKeyProvider());
    const encrypted = await cipher.encrypt("v");

    await ctx.db.insert(schema.project.secrets).values({
      id: "sec-uniq-1",
      key: "UNIQUE_KEY",
      valueCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      description: null,
      accessPolicy: "auto",
      envExportable: 0,
      envExportKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReadAt: null,
      lastReadBy: null,
    });

    // Duplicate key must be rejected.
    await expect(
      ctx.db.insert(schema.project.secrets).values({
        id: "sec-uniq-2",
        key: "UNIQUE_KEY",
        valueCiphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        description: null,
        accessPolicy: "auto",
        envExportable: 0,
        envExportKey: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastReadAt: null,
        lastReadBy: null,
      }),
    ).rejects.toThrow();
  });
});
