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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { PgBackupManager, parsePgUrl } from "../../postgres/pg-backup.js";

function pgUrl(password: string, user = "user", host = "localhost", port = 5432, database = "fusion"): string {
  return ["postgresql://", user, ":", password, "@", host, ":", String(port), "/", database].join("");
}

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
      pgUrl("secret"),
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
      pgUrl("secret"),
      fusionDir,
      { pgDumpPath, pgRestorePath, includeCentral: false },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();
    expect(pair.central).toBeUndefined();
  });

  it("passes connection components via libpq PG* env vars, not PG_CONNECTION_STRING (P0 #5)", async () => {
    const manager = new PgBackupManager(
      pgUrl("supersecret", "postgres", "localhost", 55432),
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
      pgUrl("supersecret", "postgres", "localhost", 55432),
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
      const files = readdirSync(backupDirPath);
      expect(files.filter((filename) => filename.endsWith(".dump"))).toHaveLength(0);
      expect(files.some((filename) => filename.endsWith(".part") || filename.endsWith(".reserved"))).toBe(false);
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

  it("listBackups returns an empty inventory when the backup directory is absent", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );

    await expect(manager.listBackups()).resolves.toEqual([]);
  });

  it("listBackups reports project and central orphans and ignores malformed files", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDirPath, { recursive: true });
    writeFileSync(join(backupDirPath, "fusion-pg-20260101-000001.dump"), "project");
    writeFileSync(join(backupDirPath, "fusion-central-pg-20260101-000002.dump"), "central");
    for (const filename of [
      "fusion-2026-01-01-000001.db",
      "fusion-pg-not-a-timestamp.dump",
      "fusion-project-pg-20260101-000003.dump",
      "unrelated.dump",
    ]) {
      writeFileSync(join(backupDirPath, filename), "ignored");
    }

    const backups = await manager.listBackups();

    expect(backups).toHaveLength(2);
    expect(backups.find((pair) => pair.timestamp === "20260101-000001")?.project?.filename)
      .toBe("fusion-pg-20260101-000001.dump");
    expect(backups.find((pair) => pair.timestamp === "20260101-000001")?.central)
      .toBeUndefined();
    expect(backups.find((pair) => pair.timestamp === "20260101-000002")?.project)
      .toBeUndefined();
    expect(backups.find((pair) => pair.timestamp === "20260101-000002")?.central)
      .toMatchObject({ filename: "fusion-central-pg-20260101-000002.dump" });
  });

  it("createBackup assigns a shared collision-free stem to both halves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    try {
      const manager = new PgBackupManager(
        "postgresql://localhost:5432/fusion",
        fusionDir,
        { pgDumpPath, pgRestorePath },
      );

      const first = await manager.createBackup();
      const second = await manager.createBackup();

      expect(first.timestamp).toMatch(/^\d{8}-\d{6}$/);
      expect(second.timestamp).toBe(`${first.timestamp}-1`);
      expect(second.project?.filename).toBe(`fusion-pg-${first.timestamp}-1.dump`);
      expect(second.central).toMatchObject({
        filename: `fusion-central-pg-${first.timestamp}-1.dump`,
      });
      expect(await manager.listBackups()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("listBackups recognizes complete pre-restore dump pairs", async () => {
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDirPath, { recursive: true });
    writeFileSync(join(backupDirPath, "fusion-pre-restore-pg-20260101-000001.dump"), "project");
    writeFileSync(join(backupDirPath, "fusion-central-pre-restore-pg-20260101-000001.dump"), "central");

    const backups = await manager.listBackups();

    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({
      timestamp: "pre-restore-20260101-000001",
      project: { filename: "fusion-pre-restore-pg-20260101-000001.dump" },
      central: { filename: "fusion-central-pre-restore-pg-20260101-000001.dump" },
    });
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

  it("validateBackup lists a custom archive without destructive restore flags", async () => {
    const manager = new PgBackupManager(
      pgUrl("secret"),
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const pair = await manager.createBackup();

    await manager.validateBackup(pair.project!.path);

    const invocation = readFileSync(join(tempDir, "pg_restore-invocation.txt"), "utf8");
    expect(invocation).toContain(`ARGS: --list ${pair.project!.path}`);
    expect(invocation).not.toContain("--clean");
    expect(invocation).not.toContain("--single-transaction");
  });

  it("a corrupt archive fails validation before any destructive restore", async () => {
    const rejectingRestore = join(tempDir, "fake-pg_restore-invalid-list");
    writeFileSync(rejectingRestore, `#!/bin/bash
if [ "$1" = "--list" ]; then echo "truncated archive" >&2; exit 1; fi
echo "$@" >> "${tempDir}/destructive-restore.log"
`, { mode: 0o755 });
    const manager = new PgBackupManager(
      "postgresql://localhost:5432/fusion",
      fusionDir,
      { pgDumpPath, pgRestorePath: rejectingRestore },
    );
    const dumpPath = join(tempDir, "corrupt.dump");
    writeFileSync(dumpPath, "truncated");

    await expect(manager.validateBackup(dumpPath)).rejects.toThrow(/pg_restore failed/);
    expect(existsSync(join(tempDir, "destructive-restore.log"))).toBe(false);
  });

  it("createPreRestoreBackup keeps sources and uses a collision-safe paired stem", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    try {
      const manager = new PgBackupManager(
        "postgresql://localhost:5432/fusion",
        fusionDir,
        { pgDumpPath, pgRestorePath, retention: 1 },
      );
      const backupDirPath = join(fusionDir, "..", ".fusion", "backups");
      mkdirSync(backupDirPath, { recursive: true });
      const sourcePath = join(backupDirPath, "fusion-pg-20251231-235959.dump");
      writeFileSync(sourcePath, "selected-source");

      const first = await manager.createPreRestoreBackup();
      const second = await manager.createPreRestoreBackup();

      expect(second.timestamp).toBe(`${first.timestamp}-1`);
      expect(second.project?.filename).toBe(
        first.project?.filename.replace(/\.dump$/, "-1.dump"),
      );
      expect(second.central && "filename" in second.central ? second.central.filename : undefined)
        .toBe(
          first.central && "filename" in first.central
            ? first.central.filename.replace(/\.dump$/, "-1.dump")
            : undefined,
        );
      expect(readFileSync(sourcePath, "utf8")).toBe("selected-source");
      expect(existsSync(first.project!.path)).toBe(true);
      expect(existsSync(second.project!.path)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restoreBackup invokes pg_restore with the dump path", async () => {
    const manager = new PgBackupManager(
      pgUrl("secret"),
      fusionDir,
      { pgDumpPath, pgRestorePath },
    );
    const pair = await manager.createBackup();
    expect(pair.project).toBeDefined();

    await manager.restoreBackup(pair.project!.path);

    const invocation = readFileSync(join(tempDir, "pg_restore-invocation.txt"), "utf8");
    expect(invocation).toContain("--format=custom");
    expect(invocation).toContain("--clean");
    expect(invocation).toContain("--if-exists");
    expect(invocation).toContain("--single-transaction");
    expect(invocation).toContain("--no-owner");
    expect(invocation).toContain("--no-privileges");
    expect(invocation).toContain(pair.project!.path);
    // Credential safety: password in env, not in args.
    expect(invocation).toContain("PGPASSWORD=secret");
    expect(invocation).not.toMatch(/ARGS:.*secret/);
  });

  it("native client timeouts remain bounded and credential-safe without wall-clock fixtures", async () => {
    const dumpPath = join(tempDir, "valid.dump");
    writeFileSync(dumpPath, "dump");
    const clientExec = vi.fn(async (_file: string, _args: readonly string[], options: { timeout: number }) => {
      expect(options.timeout).toBe(20);
      throw new Error(`timed out while connecting with ${pgUrl("timeout-secret")}`);
    });
    const manager = new PgBackupManager(pgUrl("timeout-secret"), fusionDir, {
      pgDumpPath,
      pgRestorePath,
      clientTimeoutMs: 20,
      clientExec,
    });

    await expect(manager.validateBackup(dumpPath)).rejects.toThrow(/pg_restore failed/);
    await expect(manager.validateBackup(dumpPath)).rejects.not.toThrow(/timeout-secret/);
    await expect(manager.createBackup()).rejects.toThrow(/pg_dump failed/);
    expect(clientExec).toHaveBeenCalledWith(pgRestorePath, expect.any(Array), expect.objectContaining({ timeout: 20 }));
    expect(clientExec).toHaveBeenCalledWith(pgDumpPath, expect.any(Array), expect.objectContaining({ timeout: 20 }));
  });

  it("native restore spawn failures redact passwords from child errors", async () => {
    const leakingRestore = join(tempDir, "fake-pg_restore-secret-error");
    writeFileSync(
      leakingRestore,
      `#!/bin/bash\necho '${["postgresql://", "user", ":", "spawn-secret", "@", "localhost/fusion PGPASSWORD=spawn-secret"].join("")}' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const dumpPath = join(tempDir, "valid.dump");
    writeFileSync(dumpPath, "dump");
    const manager = new PgBackupManager(
      pgUrl("spawn-secret"),
      fusionDir,
      { pgDumpPath, pgRestorePath: leakingRestore },
    );

    await expect(manager.validateBackup(dumpPath)).rejects.not.toThrow(/spawn-secret/);
    await expect(manager.validateBackup(dumpPath)).rejects.toThrow(/\*\*\*/);
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
    const manager = new PgBackupManager(pgUrl("mypassword"), fusionDir, {
      pgDumpPath: join(tempDir, "does-not-exist-pg_dump"),
    });
    await expect(manager.createBackup()).rejects.toThrow(/pg_dump failed/);
    try {
      await manager.createBackup();
    } catch (e) {
      expect((e as Error).message).not.toContain("mypassword");
    }
  });

  it("claims concurrent stems exclusively, publishes by rename, and leaves no residue", async () => {
    const manager = new PgBackupManager(pgUrl("secret"), fusionDir, { pgDumpPath, pgRestorePath });
    const [first, second] = await Promise.all([manager.createBackup(), manager.createBackup()]);
    const paths = [first.project?.path, first.central && "path" in first.central ? first.central.path : undefined,
      second.project?.path, second.central && "path" in second.central ? second.central.path : undefined];
    expect(new Set(paths).size).toBe(4);
    const files = readdirSync(join(fusionDir, "..", ".fusion", "backups"));
    expect(files.some((filename) => filename.endsWith(".part") || filename.endsWith(".reserved"))).toBe(false);
  });

  it("runs project-only retention while leaving pre-restore dumps intact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    try {
      const manager = new PgBackupManager(pgUrl("secret"), fusionDir, {
        pgDumpPath, pgRestorePath, includeCentral: false, retention: 2,
      });
      const first = await manager.createBackup();
      const second = await manager.createBackup();
      const third = await manager.createBackup();
      expect(existsSync(first.project!.path)).toBe(false);
      expect(existsSync(second.project!.path)).toBe(true);
      expect(existsSync(third.project!.path)).toBe(true);
      expect(readdirSync(join(fusionDir, "..", ".fusion", "backups")))
        .toEqual(expect.arrayContaining([second.project!.filename, third.project!.filename]));
      const preRestore = await manager.createPreRestoreBackup();
      await manager.cleanupOldBackups();
      expect(existsSync(preRestore.project!.path)).toBe(true);
      expect(preRestore.central && "path" in preRestore.central && existsSync(preRestore.central.path)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores live in-progress artifacts for listing, restore selection, and retention", async () => {
    const manager = new PgBackupManager(pgUrl("secret"), fusionDir, { pgDumpPath, pgRestorePath, retention: 1 });
    const backupDir = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDir, { recursive: true });
    const stem = "20260101-000001";
    const project = `fusion-pg-${stem}.dump`;
    writeFileSync(join(backupDir, `${project}.part`), "partial");
    writeFileSync(join(backupDir, `${project}.reserved`), "live-owner");
    await expect(manager.listBackups()).resolves.toEqual([]);
    expect(() => manager.resolveBackupSelection(`${project}.part`)).toThrow(/Invalid PostgreSQL backup filename/);
    await expect(manager.cleanupOldBackups()).resolves.toEqual({ deleted: [] });
  });

  it("sweeps only abandoned reservations and their partial dumps", async () => {
    const manager = new PgBackupManager(pgUrl("secret"), fusionDir, { pgDumpPath, pgRestorePath, clientTimeoutMs: 20 });
    const backupDir = join(fusionDir, "..", ".fusion", "backups");
    mkdirSync(backupDir, { recursive: true });
    const stale = "fusion-pg-20260101-000001.dump";
    const fresh = "fusion-pg-20260101-000002.dump";
    for (const filename of [`${stale}.reserved`, `${stale}.part`, `${fresh}.reserved`, `${fresh}.part`]) {
      writeFileSync(join(backupDir, filename), "artifact");
    }
    const old = new Date(Date.now() - 61_000);
    utimesSync(join(backupDir, `${stale}.reserved`), old, old);
    await manager.cleanupOldBackups();
    expect(existsSync(join(backupDir, `${stale}.reserved`))).toBe(false);
    expect(existsSync(join(backupDir, `${stale}.part`))).toBe(false);
    expect(existsSync(join(backupDir, `${fresh}.reserved`))).toBe(true);
    expect(existsSync(join(backupDir, `${fresh}.part`))).toBe(true);
  });
});


describe("parsePgUrl", () => {
  it("parses a URL-form connection string into PG* components", () => {
    const parsed = parsePgUrl(pgUrl("supersecret", "postgres", "localhost", 55432));
    expect(parsed.host).toBe("localhost");
    expect(parsed.port).toBe(55432);
    expect(parsed.user).toBe("postgres");
    expect(parsed.password).toBe("supersecret");
    expect(parsed.dbname).toBe("fusion");
  });

  it("decodes URL-encoded user/password/database", () => {
    const parsed = parsePgUrl(["postgresql://", "us%40er", ":", "p%40ss", "@", "host:5432/db%20name"].join(""));
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
