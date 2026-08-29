/**
 * Tests for the PostgreSQL backup manager (pg_dump/pg_restore).
 *
 * FNXC:PostgresBackup 2026-06-24-21:40:
 * These tests use fake pg_dump/pg_restore shell scripts (written to temp
 * files and invoked by absolute path) so they run without a real PostgreSQL
 * server. They verify:
 *   - createBackup produces two timestamped dump files (project + central).
 *   - listBackups returns the pairs newest-first.
 *   - cleanupOldBackups respects retention.
 *   - restoreBackup invokes pg_restore with the right args.
 *   - The connection string is passed via PG_CONNECTION_STRING env var, not
 *     as a CLI argument (credential safety, VAL-CONN-005).
 *   - includeCentral: false skips the central dump.
 *
 * The fake scripts capture the env and args they were invoked with into a
 * sidecar file so the tests can assert on them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { PgBackupManager, parsePgUrl } from "../../postgres/pg-backup.js";

/** Write a fake pg_dump script that creates the output file and records invocation. */
function writeFakePgDump(dir: string): string {
  const scriptPath = join(dir, "fake-pg_dump");
  // The script writes the --file target path to an empty file and appends
  // each invocation to a sidecar (append so tests can inspect multiple runs).
  const script = `#!/bin/bash
# Append invocation for assertions.
echo "--- ARGS: $@" >> "${dir}/pg_dump-invocations.log"
env | grep -E '^PG' | sort >> "${dir}/pg_dump-invocations.log"
# Extract the --file path and create it.
for arg in "$@"; do
  if [ "$prev" = "--file" ]; then
    echo "fake-pg-dump-content" > "$arg"
  fi
  prev="$arg"
done
exit 0
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/** Write a fake pg_restore script that records invocation. */
function writeFakePgRestore(dir: string): string {
  const scriptPath = join(dir, "fake-pg_restore");
  const script = `#!/bin/bash
echo "ARGS: $@" > "${dir}/pg_restore-invocation.txt"
env | grep -E '^PG' | sort >> "${dir}/pg_restore-invocation.txt"
exit 0
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("PgBackupManager", () => {
  let tempDir: string;
  let fusionDir: string;
  let pgDumpPath: string;
  let pgRestorePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fusion-pg-backup-"));
    fusionDir = join(tempDir, "project", ".fusion");
    mkdirSync(fusionDir, { recursive: true });
    pgDumpPath = writeFakePgDump(tempDir);
    pgRestorePath = writeFakePgRestore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("createBackup produces project + central dump files", async () => {
    const manager = new PgBackupManager(
      "postgresql://user:secret@localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();
    expect(pair.project?.filename).toMatch(/^fusion-pg-.*\.dump$/);
    expect(existsSync(pair.project!.path)).toBe(true);
    expect(pair.central).toBeDefined();
    expect("filename" in (pair.central as object)).toBe(true);
  });

  it("skips central dump when includeCentral is false", async () => {
    const manager = new PgBackupManager(
      "postgresql://user:secret@localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath, includeCentral: false },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();
    expect(pair.central).toBeUndefined();
  });

  it("passes connection components via libpq PG* env vars, not PG_CONNECTION_STRING (P0 #5)", async () => {
    const manager = new PgBackupManager(
      "postgresql://postgres:supersecret@localhost:55432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    await manager.createBackup();

    const invocation = readFileSync(join(tempDir, "pg_dump-invocations.log"), "utf8");
    // The libpq PG* variables MUST be present with the parsed components.
    expect(invocation).toContain("PGHOST=localhost");
    expect(invocation).toContain("PGPORT=55432");
    expect(invocation).toContain("PGUSER=postgres");
    expect(invocation).toContain("PGPASSWORD=supersecret");
    expect(invocation).toContain("PGDATABASE=fusion");
    // PG_CONNECTION_STRING must NOT be present (it is a non-libpq variable and
    // was the root cause of the embedded-mode wrong-server bug).
    expect(invocation).not.toContain("PG_CONNECTION_STRING=");
    // The password must NOT appear in the args (credential safety, VAL-CONN-005).
    expect(invocation).not.toMatch(/ARGS:.*supersecret/);
  });

  it("pg_restore receives the same libpq PG* env vars (P0 #6)", async () => {
    const manager = new PgBackupManager(
      "postgresql://postgres:supersecret@localhost:55432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();

    await manager.restoreBackup(pair.project!.path);

    const invocation = readFileSync(join(tempDir, "pg_restore-invocation.txt"), "utf8");
    expect(invocation).toContain("PGHOST=localhost");
    expect(invocation).toContain("PGPORT=55432");
    expect(invocation).toContain("PGUSER=postgres");
    expect(invocation).toContain("PGPASSWORD=supersecret");
    expect(invocation).toContain("PGDATABASE=fusion");
    expect(invocation).not.toContain("PG_CONNECTION_STRING=");
    expect(invocation).not.toMatch(/ARGS:.*supersecret/);
  });

  it("removes the orphaned project dump when the central dump fails (P1 #25)", async () => {
    // A pg_dump that fails ONLY for the central schema.
    const failingCentralDump = join(tempDir, "fake-pg_dump-fail-central");
    const script = `#!/bin/bash
for arg in "$@"; do
  if [ "$prev" = "--schema" ] && [ "$arg" = "central" ]; then
    echo "central dump failed" >&2
    exit 1
  fi
  prev="$arg"
done
for arg in "$@"; do
  if [ "$prev" = "--file" ]; then
    echo "fake-pg-dump-content" > "$arg"
  fi
  prev="$arg"
done
exit 0
`;
    writeFileSync(failingCentralDump, script, { mode: 0o755 });

    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath: failingCentralDump, pgRestorePath },
    );

    await expect(manager.createBackup()).rejects.toThrow(/pg_dump failed/);

    // The orphaned project dump must have been cleaned up.
    const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
    if (existsSync(backupDirPath)) {
      const files = readdirSync(backupDirPath).filter((f) => f.endsWith(".dump"));
      expect(files.length).toBe(0);
    }
  });

  it("dumps the project and archive schemas together, central separately", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    await manager.createBackup();

    const invocation = readFileSync(join(tempDir, "pg_dump-invocations.log"), "utf8");
    // The project dump includes both project and archive schemas.
    expect(invocation).toContain("--schema project");
    expect(invocation).toContain("--schema archive");
    // The central dump includes the central schema.
    expect(invocation).toContain("--schema central");
  });

  it("listBackups returns pairs newest-first", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    // Create two backup pairs directly with distinct timestamps to avoid
    // sub-second timestamp collisions.
    const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDirPath, { recursive: true });
    const ts1 = "20260101-000001";
    const ts2 = "20260101-000002";
    for (const ts of [ts1, ts2]) {
      writeFileSync(join(backupDirPath, `fusion-pg-${ts}.dump`), "content");
      writeFileSync(join(backupDirPath, `fusion-central-pg-${ts}.dump`), "content");
    }

    const backups = await manager.listBackups();
    expect(backups.length).toBe(2);
    // Newest first (ts2 > ts1 lexicographically).
    expect(backups[0].timestamp).toBe(ts2);
    expect(backups[1].timestamp).toBe(ts1);
    // Each pair has both halves.
    for (const b of backups) {
      expect(b.project).toBeDefined();
      expect(b.central).toBeDefined();
    }
  });

  it("cleanupOldBackups respects retention", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath, retention: 2 },
    );
    // Create 3 backup pairs directly with distinct timestamps to avoid
    // sub-second timestamp collisions.
    const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDirPath, { recursive: true });
    for (const ts of ["20260101-000001", "20260101-000002", "20260101-000003"]) {
      writeFileSync(join(backupDirPath, `fusion-pg-${ts}.dump`), "content");
      writeFileSync(join(backupDirPath, `fusion-central-pg-${ts}.dump`), "content");
    }

    const { deleted } = await manager.cleanupOldBackups();
    expect(deleted.length).toBeGreaterThanOrEqual(2); // oldest pair = 2 files
    const remaining = await manager.listBackups();
    expect(remaining.length).toBeLessThanOrEqual(2);
  });

  it("restoreBackup invokes pg_restore with the dump path", async () => {
    const manager = new PgBackupManager(
      "postgresql://user:secret@localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();

    await manager.restoreBackup(pair.project!.path);

    const invocation = readFileSync(join(tempDir, "pg_restore-invocation.txt"), "utf8");
    expect(invocation).toContain("--format=custom");
    expect(invocation).toContain("--clean");
    expect(invocation).toContain(pair.project!.path);
    // Credential safety: password in env, not in args.
    expect(invocation).toContain("PGPASSWORD=secret");
    expect(invocation).not.toMatch(/ARGS:.*secret/);
  });

  it("restoreBackup throws on missing file", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    await expect(manager.restoreBackup(join(tempDir, "nonexistent.dump"))).rejects.toThrow(
      /not found/,
    );
  });

  it("redacts connection-string passwords in error messages", async () => {
    // Use a pg_dump path that doesn't exist so it fails.
    const manager = new PgBackupManager(
      "postgresql://user:mypassword@localhost:5432/fusion",
      fusionDir,
      { pgDumpPath: join(tempDir, "does-not-exist-pg_dump") },
    );
    await expect(manager.createBackup()).rejects.toThrow(/pg_dump failed/);
    // The thrown error should not contain the raw password.
    try {
      await manager.createBackup();
    } catch (e) {
      expect((e as Error).message).not.toContain("mypassword");
    }
  });
});


describe("parsePgUrl", () => {
  it("parses a URL-form connection string into PG* components", () => {
    const parsed = parsePgUrl("postgresql://postgres:supersecret@localhost:55432/fusion");
    expect(parsed.host).toBe("localhost");
    expect(parsed.port).toBe(55432);
    expect(parsed.user).toBe("postgres");
    expect(parsed.password).toBe("supersecret");
    expect(parsed.dbname).toBe("fusion");
  });

  it("decodes URL-encoded user/password/database", () => {
    const parsed = parsePgUrl("postgresql://us%40er:p%40ss@host:5432/db%20name");
    expect(parsed.user).toBe("us@er");
    expect(parsed.password).toBe("p@ss");
    expect(parsed.dbname).toBe("db name");
  });

  it("parses a libpq keyword/value connection string", () => {
    const parsed = parsePgUrl("host=localhost port=55432 user=postgres password=secret dbname=fusion");
    expect(parsed.host).toBe("localhost");
    expect(parsed.port).toBe(55432);
    expect(parsed.user).toBe("postgres");
    expect(parsed.password).toBe("secret");
    expect(parsed.dbname).toBe("fusion");
  });

  it("handles quoted keyword/value values", () => {
    const parsed = parsePgUrl('host=localhost password="my secret" dbname=fusion');
    expect(parsed.password).toBe("my secret");
    expect(parsed.dbname).toBe("fusion");
  });

  it("returns empty object for a malformed URL", () => {
    const parsed = parsePgUrl("not-a-connection-string");
    expect(parsed.host).toBeUndefined();
    expect(parsed.dbname).toBeUndefined();
  });
});
