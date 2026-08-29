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

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createSecretCipher } from "../../secrets/secrets-crypto.js";
import * as schema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (the bytea encrypt → INSERT → SELECT → decrypt cycle is), and every
assertion is unchanged. `db` is the harness's raw admin Drizzle connection, matching the
direct-connection semantics the original per-test databases used.
*/
interface SecretTestCtx {
  db: PostgresJsDatabase;
}

/** A fixed 32-byte master key provider for deterministic test crypto. */
function fixedMasterKeyProvider(key: Buffer = randomBytes(32)): () => Promise<Buffer> {
  return async () => Buffer.from(key);
}

pgDescribe("PostgreSQL secrets round-trip (VAL-CROSS-011)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_secret_test",
  });
  let ctx: SecretTestCtx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { db: h.adminDb() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("round-trips a project-scoped secret through project.secrets bytea columns", async () => {
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
