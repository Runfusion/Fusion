import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BackupManager, type BackupInfo } from "../../backup/backup.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const execFileAsync = promisify(execFile);

function findPostgresClient(name: "pg_dump" | "pg_restore"): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    `/opt/homebrew/bin/${name}`,
    `/opt/homebrew/opt/libpq/bin/${name}`,
    `/usr/local/opt/libpq/bin/${name}`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const pgDumpPath = findPostgresClient("pg_dump");
const pgRestorePath = findPostgresClient("pg_restore");
const pgIt = pgDumpPath && pgRestorePath ? it : it.skip;

type MigrationVersionRow = { version: string };

/*
FNXC:PostgresBackup 2026-09-04-04:40:
The destructive restore contract must be proven against a real PostgreSQL cluster:
a project/archive restore returns public.fusion_schema_migrations to the captured
set, while legacy and central-only paths deliberately leave that state untouched.
*/
pgDescribe("PostgreSQL backup migration bookkeeping", () => {
  const harness: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_backup_migrations" });
  let root = "";
  let originalMigrationVersions: string[] = [];

  const migrationVersions = async (): Promise<string[]> => {
    const rows = await harness.adminSql()<MigrationVersionRow[]>`
      SELECT version FROM public.fusion_schema_migrations ORDER BY version
    `;
    return rows.map((row) => row.version);
  };

  const restoreMigrationVersions = async (versions: readonly string[]): Promise<void> => {
    await harness.adminSql()`DELETE FROM public.fusion_schema_migrations`;
    for (const version of versions) {
      await harness.adminSql()`INSERT INTO public.fusion_schema_migrations (version) VALUES (${version})`;
    }
  };

  const createManager = (): BackupManager => new BackupManager(join(root, ".fusion"), {
    connectionString: harness.testUrl(),
    pgDumpPath,
    pgRestorePath,
  });

  const migrationBackupPath = (backup: BackupInfo): string => {
    if (!backup.migrationsBackup || !("path" in backup.migrationsBackup)) {
      throw new Error("Expected a migration bookkeeping backup artifact");
    }
    return backup.migrationsBackup.path;
  };

  const projectBackupPath = (backup: BackupInfo): string => backup.path;

  beforeAll(harness.beforeAll);
  beforeEach(async () => {
    await harness.beforeEach();
    root = await mkdtemp(join(tmpdir(), "fusion-backup-migrations-"));
    originalMigrationVersions = await migrationVersions();
  });
  afterEach(async () => {
    await restoreMigrationVersions(originalMigrationVersions);
    await rm(root, { recursive: true, force: true });
    await harness.afterEach();
  });
  afterAll(harness.afterAll);

  pgIt("captures bookkeeping separately from project schemas", async () => {
    const backup = await createManager().createBackup();
    const migrationsPath = migrationBackupPath(backup);

    expect(existsSync(migrationsPath)).toBe(true);
    const migrationsListing = await execFileAsync(pgRestorePath!, ["--list", migrationsPath]);
    const projectListing = await execFileAsync(pgRestorePath!, ["--list", projectBackupPath(backup)]);
    expect(migrationsListing.stdout).toContain("public fusion_schema_migrations");
    expect(projectListing.stdout).not.toContain("public fusion_schema_migrations");
  });

  pgIt("restores the exact migration version set captured with project data", async () => {
    const manager = createManager();
    const backup = await manager.createBackup();
    const capturedVersions = await migrationVersions();
    const deletedVersion = capturedVersions[0];
    expect(deletedVersion).toBeTruthy();

    await harness.adminSql()`INSERT INTO public.fusion_schema_migrations (version) VALUES ('fn-9255-drift-marker')`;
    await harness.adminSql()`DELETE FROM public.fusion_schema_migrations WHERE version = ${deletedVersion}`;
    expect(await migrationVersions()).not.toEqual(capturedVersions);

    const result = await manager.restoreBackup(backup.filename);

    expect(result.migrationBookkeeping).toBe("restored");
    expect(await migrationVersions()).toEqual(capturedVersions);
    expect(await migrationVersions()).not.toContain("fn-9255-drift-marker");
    expect(await migrationVersions()).toContain(deletedVersion);
  });

  pgIt("reports unavailable and leaves bookkeeping untouched for a legacy pair", async () => {
    const manager = createManager();
    const backup = await manager.createBackup();
    await unlink(migrationBackupPath(backup));
    await harness.adminSql()`INSERT INTO public.fusion_schema_migrations (version) VALUES ('fn-9255-drift-marker')`;
    const driftedVersions = await migrationVersions();

    const result = await manager.restoreBackup(backup.filename, { createPreRestoreBackup: false });

    expect(result.migrationBookkeeping).toBe("unavailable");
    expect(await migrationVersions()).toEqual(driftedVersions);
  });

  pgIt("leaves bookkeeping untouched for a central-only restore", async () => {
    const manager = createManager();
    const backup = await manager.createBackup();
    expect(backup.centralBackup && "filename" in backup.centralBackup).toBe(true);
    if (!backup.centralBackup || !("filename" in backup.centralBackup)) throw new Error("Expected central backup");
    await harness.adminSql()`INSERT INTO public.fusion_schema_migrations (version) VALUES ('fn-9255-drift-marker')`;
    const beforeRestore = await migrationVersions();

    const result = await manager.restoreBackup(backup.centralBackup.filename);

    expect(result.migrationBookkeeping).toBe("skipped-central-only");
    expect(await migrationVersions()).toEqual(beforeRestore);
  });

  pgIt("refuses bookkeeping restore without a pre-restore rollback stem before mutation", async () => {
    const manager = createManager();
    const task = await harness.createTestTask();
    const backup = await manager.createBackup();
    const beforeVersions = await migrationVersions();
    const beforeTaskRows = await harness.adminSql()<Array<{ id: string }>`
      SELECT id FROM project.tasks WHERE id = ${task.id}
    `;

    await expect(manager.restoreBackup(backup.filename, { createPreRestoreBackup: false }))
      .rejects.toThrow("createPreRestoreBackup: false is refused");

    const afterTaskRows = await harness.adminSql()<Array<{ id: string }>`
      SELECT id FROM project.tasks WHERE id = ${task.id}
    `;
    expect(await migrationVersions()).toEqual(beforeVersions);
    expect(afterTaskRows).toEqual(beforeTaskRows);
    const backupFiles = await readdir(dirname(backup.path));
    expect(backupFiles.some((filename) => filename.includes("-pre-restore-"))).toBe(false);
  });
});
