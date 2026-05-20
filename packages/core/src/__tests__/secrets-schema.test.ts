import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../db.js";
import { createCentralDatabase } from "../central-db.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("secrets schema migrations", () => {
  it("creates project secrets schema + index on fresh init", () => {
    const dir = createTempDir("kb-secrets-project-");
    const db = new Database(join(dir, ".fusion"));
    try {
      db.init();

      const columns = db.prepare("PRAGMA table_info(secrets)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "id",
          "key",
          "value_ciphertext",
          "nonce",
          "description",
          "access_policy",
          "env_exportable",
          "env_export_key",
          "created_at",
          "updated_at",
          "last_read_at",
          "last_read_by",
        ]),
      );

      const index = db
        .prepare("PRAGMA index_info('idxSecretsKey')")
        .all() as Array<{ name: string }>;
      expect(index.map((entry) => entry.name)).toEqual(["key"]);

      const version = db
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };
      expect(version.value).toBe("89");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates central secrets_global schema + index on fresh init", () => {
    const dir = createTempDir("kb-secrets-central-");
    const db = createCentralDatabase(dir);
    try {
      db.init();

      const columns = db.prepare("PRAGMA table_info(secrets_global)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "id",
          "key",
          "value_ciphertext",
          "nonce",
          "description",
          "access_policy",
          "env_exportable",
          "env_export_key",
          "created_at",
          "updated_at",
          "last_read_at",
          "last_read_by",
        ]),
      );

      const index = db
        .prepare("PRAGMA index_info('idxSecretsGlobalKey')")
        .all() as Array<{ name: string }>;
      expect(index.map((entry) => entry.name)).toEqual(["key"]);

      const version = db
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };
      expect(version.value).toBe("13");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates project DB from schema version 82", () => {
    const dir = createTempDir("kb-secrets-project-migrate-");
    const db = new Database(join(dir, ".fusion"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '82')");

      db.init();

      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secrets'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("secrets");

      const version = db
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };
      expect(version.value).toBe("89");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates central DB from schema version 11", () => {
    const dir = createTempDir("kb-secrets-central-migrate-");
    const db = createCentralDatabase(dir);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '11')");

      db.init();

      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secrets_global'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("secrets_global");

      const version = db
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };
      expect(version.value).toBe("13");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-running init is idempotent", () => {
    const projectDir = createTempDir("kb-secrets-idempotent-project-");
    const centralDir = createTempDir("kb-secrets-idempotent-central-");
    const projectDb = new Database(join(projectDir, ".fusion"));
    const centralDb = createCentralDatabase(centralDir);

    try {
      projectDb.init();
      centralDb.init();
      projectDb.init();
      centralDb.init();

      const projectVersion = projectDb
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };
      const centralVersion = centralDb
        .prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'")
        .get() as { value: string };

      expect(projectVersion.value).toBe("89");
      expect(centralVersion.value).toBe("13");
    } finally {
      projectDb.close();
      centralDb.close();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(centralDir, { recursive: true, force: true });
    }
  });

  it("enforces check constraints and unique key in secrets", () => {
    const dir = createTempDir("kb-secrets-constraints-project-");
    const db = new Database(join(dir, ".fusion"));
    try {
      db.init();

      db.prepare(
        `INSERT INTO secrets (
          id, key, value_ciphertext, nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "secret-1",
        "OPENAI_API_KEY",
        Buffer.from("cipher-1"),
        Buffer.from("nonce-1"),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      expect(() => {
        db.prepare(
          `INSERT INTO secrets (
            id, key, value_ciphertext, nonce, access_policy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          "secret-2",
          "INVALID_POLICY",
          Buffer.from("cipher-2"),
          Buffer.from("nonce-2"),
          "invalid",
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO secrets (
            id, key, value_ciphertext, nonce, env_exportable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          "secret-3",
          "INVALID_EXPORTABLE",
          Buffer.from("cipher-3"),
          Buffer.from("nonce-3"),
          2,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO secrets (
            id, key, value_ciphertext, nonce, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          "secret-4",
          "OPENAI_API_KEY",
          Buffer.from("cipher-4"),
          Buffer.from("nonce-4"),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces check constraints and unique key in secrets_global", () => {
    const dir = createTempDir("kb-secrets-constraints-central-");
    const db = createCentralDatabase(dir);
    try {
      db.init();

      db.prepare(
        `INSERT INTO secrets_global (
          id, key, value_ciphertext, nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "global-secret-1",
        "OPENAI_API_KEY",
        Buffer.from("cipher-1"),
        Buffer.from("nonce-1"),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      expect(() => {
        db.prepare(
          `INSERT INTO secrets_global (
            id, key, value_ciphertext, nonce, access_policy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          "global-secret-2",
          "INVALID_POLICY",
          Buffer.from("cipher-2"),
          Buffer.from("nonce-2"),
          "invalid",
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO secrets_global (
            id, key, value_ciphertext, nonce, env_exportable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          "global-secret-3",
          "INVALID_EXPORTABLE",
          Buffer.from("cipher-3"),
          Buffer.from("nonce-3"),
          2,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO secrets_global (
            id, key, value_ciphertext, nonce, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          "global-secret-4",
          "OPENAI_API_KEY",
          Buffer.from("cipher-4"),
          Buffer.from("nonce-4"),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
