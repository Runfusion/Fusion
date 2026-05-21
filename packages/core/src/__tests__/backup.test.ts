import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir, writeFile, readdir } from "node:fs/promises";
import {
  BackupManager,
  createBackupManager,
  generateBackupFilename,
  validateBackupSchedule,
  validateBackupRetention,
  validateBackupDir,
  runBackupCommand,
  syncBackupRoutine,
} from "../backup.js";
import { Database } from "../db.js";
import { RoutineStore } from "../routine-store.js";
import type { ProjectSettings } from "../types.js";

describe("BackupManager", () => {
  let tempDir: string;
  let fusionDir: string;
  let backupManager: BackupManager;

  beforeEach(async () => {
    // Use fake timers for deterministic timestamp control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    fusionDir = join(tempDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    // Create dummy project + central database files
    writeFileSync(join(fusionDir, "fusion.db"), "dummy database content");
    writeFileSync(join(fusionDir, "fusion-central.db"), "dummy central database content");
    backupManager = new BackupManager(fusionDir, {
      centralDbPath: join(fusionDir, "fusion-central.db"),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createBackup", () => {
    it("should create a backup file with correct name pattern", async () => {
      const backup = await backupManager.createBackup();

      expect(backup.filename).toMatch(/^fusion-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
      expect(existsSync(backup.path)).toBe(true);
    });

    it("should copy database content correctly", async () => {
      const backup = await backupManager.createBackup();

      const originalContent = readFileSync(join(fusionDir, "fusion.db"), "utf-8");
      const backupContent = readFileSync(backup.path, "utf-8");

      expect(backupContent).toBe(originalContent);
    });

    it("should return correct backup info", async () => {
      const backup = await backupManager.createBackup();

      expect(backup.filename).toBeDefined();
      expect(backup.createdAt).toBeDefined();
      expect(backup.size).toBeGreaterThan(0);
      expect(backup.path).toContain(backup.filename);
    });

    it("should create backup directory if it does not exist", async () => {
      const customBackupDir = "custom-backups";
      const manager = new BackupManager(fusionDir, {
        backupDir: customBackupDir,
        centralDbPath: join(fusionDir, "fusion-central.db"),
      });

      const customBackupPath = join(tempDir, customBackupDir);
      expect(existsSync(customBackupPath)).toBe(false);

      await manager.createBackup();

      expect(existsSync(customBackupPath)).toBe(true);
    });

    it("creates paired project and central backups with shared timestamp", async () => {
      const backup = await backupManager.createBackup();
      expect(backup.centralBackup && "filename" in backup.centralBackup).toBe(true);
      if (backup.centralBackup && "filename" in backup.centralBackup) {
        expect(backup.centralBackup.filename).toBe(backup.filename.replace(/^fusion-/, "fusion-central-"));
      }
    });

    it("skips central backup when central DB is missing", async () => {
      const manager = new BackupManager(fusionDir, {
        centralDbPath: join(fusionDir, "does-not-exist.db"),
      });
      const backup = await manager.createBackup();
      expect(backup.centralBackup).toEqual({ skipped: "missing" });
    });

    it("skips central backup when includeCentralDb is false", async () => {
      const manager = new BackupManager(fusionDir, {
        centralDbPath: join(fusionDir, "fusion-central.db"),
        includeCentralDb: false,
      });
      const backup = await manager.createBackup();
      expect(backup.centralBackup).toEqual({ skipped: "disabled" });
    });

    it("applies collision counter symmetrically for project and central backups", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "fusion-2026-01-01-000000.db"), "exists");
      const backup = await backupManager.createBackup();
      expect(backup.filename).toBe("fusion-2026-01-01-000000-1.db");
      expect(existsSync(join(backupDir, "fusion-central-2026-01-01-000000-1.db"))).toBe(true);
    });

    it("avoids central orphan collision by bumping shared counter", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "fusion-central-2026-01-01-000000.db"), "orphan");
      const backup = await backupManager.createBackup();
      expect(backup.filename).toBe("fusion-2026-01-01-000000-1.db");
      expect(readFileSync(join(backupDir, "fusion-central-2026-01-01-000000.db"), "utf-8")).toBe("orphan");
      expect(existsSync(join(backupDir, "fusion-central-2026-01-01-000000-1.db"))).toBe(true);
    });

    it("continues central copy when checkpoint open fails", async () => {
      const notSqlitePath = join(fusionDir, "not-sqlite.db");
      writeFileSync(notSqlitePath, "definitely not sqlite");
      const manager = new BackupManager(fusionDir, { centralDbPath: notSqlitePath });
      const backup = await manager.createBackup();
      expect(backup.centralBackup && "filename" in backup.centralBackup).toBe(true);
      if (backup.centralBackup && "filename" in backup.centralBackup) {
        expect(readFileSync(backup.centralBackup.path, "utf-8")).toBe("definitely not sqlite");
      }
    });

    it("keeps project backup when central copy fails", async () => {
      const manager = new BackupManager(fusionDir, { centralDbPath: fusionDir });
      const backup = await manager.createBackup();
      expect(existsSync(backup.path)).toBe(true);
      expect(backup.centralBackup && "failed" in backup.centralBackup).toBe(true);
    });
  });

  describe("listBackups", () => {
    it("should return empty array when no backups exist", async () => {
      const backups = await backupManager.listBackups();
      expect(backups).toEqual([]);
    });

    it("should return sorted array newest-first", async () => {
      // Create multiple backups by advancing system time deterministically
      const backup1 = await backupManager.createBackup();
      
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      const backup2 = await backupManager.createBackup();
      
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      const backup3 = await backupManager.createBackup();

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(3);
      // Verify sorted by createdAt descending (newest first)
      expect(backups[0].createdAt >= backups[1].createdAt).toBe(true);
      expect(backups[1].createdAt >= backups[2].createdAt).toBe(true);
      // Verify correct ordering by filename
      expect(backups[0].filename).toBe(backup3.filename);
      expect(backups[1].filename).toBe(backup2.filename);
      expect(backups[2].filename).toBe(backup1.filename);
    });

    it("should only list files matching backup pattern", async () => {
      await backupManager.createBackup();

      // Create some non-backup files
      const backupDir = join(tempDir, ".fusion/backups");
      await writeFile(join(backupDir, "not-a-backup.txt"), "content");
      await writeFile(join(backupDir, "random.db"), "content");

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(1);
      expect(backups[0].filename).toMatch(/^fusion-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    });

    it("should return correct file sizes", async () => {
      const backup = await backupManager.createBackup();
      const backups = await backupManager.listBackups();

      expect(backups[0].size).toBe(backup.size);
    });

    it("should list legacy kb-* backups alongside new fusion-* backups", async () => {
      // Create a new-style backup
      await backupManager.createBackup();

      // Create a legacy-style backup file manually
      const backupDir = join(tempDir, ".fusion/backups");
      await writeFile(join(backupDir, "kb-2025-12-31-120000.db"), "legacy backup content");

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(2);
      const filenames = backups.map((b) => b.filename);
      expect(filenames).toContain("kb-2025-12-31-120000.db");
      expect(filenames.some((f) => f.startsWith("fusion-"))).toBe(true);
    });

    it("should parse timestamps from legacy kb-* filenames", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "kb-2025-06-15-083000.db"), "legacy");

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(1);
      expect(backups[0].createdAt).toBe("2025-06-15T08:30:00Z");
    });

    it("should parse timestamps from legacy kb-pre-restore filenames", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "kb-pre-restore-2025-06-15-083000.db"), "legacy pre-restore");

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(1);
      expect(backups[0].filename).toBe("kb-pre-restore-2025-06-15-083000.db");
      expect(backups[0].createdAt).toBe("2025-06-15T08:30:00Z");
    });

    it("should list only legacy kb-* backups when no fusion-* exist", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "kb-2025-01-01-000000.db"), "legacy1");
      await writeFile(join(backupDir, "kb-2025-01-02-000000.db"), "legacy2");

      const backups = await backupManager.listBackups();

      expect(backups).toHaveLength(2);
      expect(backups.every((b) => b.filename.startsWith("kb-"))).toBe(true);
    });
  });

  describe("listBackupPairs", () => {
    it("shows paired and singleton backups", async () => {
      const backupDir = join(tempDir, ".fusion/backups");
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "fusion-2026-01-01-000000.db"), "project");
      await writeFile(join(backupDir, "fusion-central-2026-01-01-000000.db"), "central");
      await writeFile(join(backupDir, "fusion-2025-12-31-000000.db"), "legacy-only");

      const pairs = await backupManager.listBackupPairs();
      expect(pairs[0]).toMatchObject({ project: expect.anything(), central: expect.anything() });
      expect(pairs.some((pair) => pair.project && !pair.central)).toBe(true);
    });
  });

  describe("cleanupOldBackups", () => {
    it("should not delete when backup count is within retention", async () => {
      // Create 3 backups with retention of 7 by advancing time
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
        await backupManager.createBackup();
      }

      const deleted = await backupManager.cleanupOldBackups();

      expect(deleted).toBe(0);
      const backups = await backupManager.listBackups();
      expect(backups).toHaveLength(3);
    });

    it("should delete oldest backups exceeding retention", async () => {
      const manager = new BackupManager(fusionDir, { retention: 2, centralDbPath: join(fusionDir, "fusion-central.db") });

      // Create 4 backups by advancing time deterministically
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
        await manager.createBackup();
      }

      const deleted = await manager.cleanupOldBackups();

      expect(deleted).toBe(2); // 4 - 2 = 2 deleted
      const backups = await manager.listBackups();
      expect(backups).toHaveLength(2);
    });

    it("should keep the newest backups after cleanup", async () => {
      const manager = new BackupManager(fusionDir, { retention: 2, centralDbPath: join(fusionDir, "fusion-central.db") });

      // Create 4 backups and record their names by advancing time
      const backupNames: string[] = [];
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
        const backup = await manager.createBackup();
        backupNames.push(backup.filename);
      }

      await manager.cleanupOldBackups();

      const backups = await manager.listBackups();
      const remainingNames = backups.map((b) => b.filename);

      // Should keep the 2 newest (last 2 in the array)
      expect(remainingNames).toContain(backupNames[2]);
      expect(remainingNames).toContain(backupNames[3]);
      expect(remainingNames).not.toContain(backupNames[0]);
      expect(remainingNames).not.toContain(backupNames[1]);
    });

    it("deletes sibling central backup when deleting project backup", async () => {
      const manager = new BackupManager(fusionDir, { retention: 1, centralDbPath: join(fusionDir, "fusion-central.db") });
      await manager.createBackup();
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      await manager.createBackup();
      const backupDir = join(tempDir, ".fusion/backups");
      const oldestCentral = join(backupDir, "fusion-central-2026-01-01-000000.db");
      expect(existsSync(oldestCentral)).toBe(true);
      await manager.cleanupOldBackups();
      expect(existsSync(oldestCentral)).toBe(false);
    });
  });

  describe("restoreBackup", () => {
    it("should restore backup to main database location", async () => {
      const backup = await backupManager.createBackup();

      // Modify the original database
      await writeFile(join(fusionDir, "fusion.db"), "modified content");

      // Restore the backup
      await backupManager.restoreBackup(backup.filename, { createPreRestoreBackup: false });

      // Verify the restore
      const restoredContent = readFileSync(join(fusionDir, "fusion.db"), "utf-8");
      expect(restoredContent).toBe("dummy database content");
    });

    it("should throw when backup file does not exist", async () => {
      await expect(
        backupManager.restoreBackup("nonexistent-backup.db", { createPreRestoreBackup: false })
      ).rejects.toThrow("Backup file not found");
    });

    it("should create pre-restore backup by default", async () => {
      const backup = await backupManager.createBackup();

      // Advance time to ensure different timestamp for pre-restore backup
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));

      // Restore with default options (should create pre-restore backup)
      await backupManager.restoreBackup(backup.filename);

      // Check for pre-restore backup
      const backups = await backupManager.listBackups();
      const preRestoreBackup = backups.find((b) => b.filename.includes("pre-restore"));

      expect(preRestoreBackup).toBeDefined();
      expect(preRestoreBackup!.filename).toMatch(/^fusion-pre-restore-/);
    });

    it("restores paired central backup when restoring project backup", async () => {
      const backup = await backupManager.createBackup();
      await writeFile(join(fusionDir, "fusion.db"), "project modified");
      await writeFile(join(fusionDir, "fusion-central.db"), "central modified");

      await backupManager.restoreBackup(backup.filename, { createPreRestoreBackup: true });

      expect(readFileSync(join(fusionDir, "fusion.db"), "utf-8")).toBe("dummy database content");
      expect(readFileSync(join(fusionDir, "fusion-central.db"), "utf-8")).toBe("dummy central database content");
      const backups = await readdir(join(tempDir, ".fusion/backups"));
      expect(backups.some((name) => name.startsWith("fusion-pre-restore-"))).toBe(true);
      expect(backups.some((name) => name.startsWith("fusion-central-pre-restore-"))).toBe(true);
    });

    it("restores central-only backup when filename is fusion-central-*", async () => {
      const backup = await backupManager.createBackup();
      if (!backup.centralBackup || !("filename" in backup.centralBackup)) {
        throw new Error("expected central backup file");
      }
      await writeFile(join(fusionDir, "fusion-central.db"), "central modified");
      await backupManager.restoreBackup(backup.centralBackup.filename, { centralOnly: true, createPreRestoreBackup: true });
      expect(readFileSync(join(fusionDir, "fusion-central.db"), "utf-8")).toBe("dummy central database content");
      const backups = await readdir(join(tempDir, ".fusion/backups"));
      expect(backups.some((name) => name.startsWith("fusion-central-pre-restore-"))).toBe(true);
    });
  });
});

describe("generateBackupFilename", () => {
  it("should generate filename with correct pattern", () => {
    const filename = generateBackupFilename();
    expect(filename).toMatch(/^fusion-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
  });

  it("should generate unique filenames for different timestamps", () => {
    // Use fake timers for deterministic time control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    const filename1 = generateBackupFilename();
    
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const filename2 = generateBackupFilename();

    expect(filename1).not.toBe(filename2);
    
    vi.useRealTimers();
  });
});

describe("validateBackupSchedule", () => {
  it("should return true for valid cron expressions", () => {
    expect(validateBackupSchedule("0 2 * * *")).toBe(true); // Daily at 2 AM
    expect(validateBackupSchedule("0 * * * *")).toBe(true); // Hourly
    expect(validateBackupSchedule("*/15 * * * *")).toBe(true); // Every 15 minutes
    expect(validateBackupSchedule("0 0 * * 0")).toBe(true); // Weekly on Sunday
  });

  it("should return false for invalid cron expressions", () => {
    expect(validateBackupSchedule("invalid")).toBe(false);
    expect(validateBackupSchedule("")).toBe(false);
    expect(validateBackupSchedule("   ")).toBe(false);
    expect(validateBackupSchedule("* *")).toBe(false); // Too few fields
    expect(validateBackupSchedule("99 99 99 99 99")).toBe(false); // Out of range
  });
});

describe("validateBackupRetention", () => {
  it("should return true for valid retention values", () => {
    expect(validateBackupRetention(1)).toBe(true);
    expect(validateBackupRetention(7)).toBe(true);
    expect(validateBackupRetention(100)).toBe(true);
  });

  it("should return false for invalid retention values", () => {
    expect(validateBackupRetention(0)).toBe(false);
    expect(validateBackupRetention(-1)).toBe(false);
    expect(validateBackupRetention(101)).toBe(false);
    expect(validateBackupRetention(1.5)).toBe(false); // Not an integer
    expect(validateBackupRetention(NaN)).toBe(false);
  });
});

describe("validateBackupDir", () => {
  it("should return true for valid relative paths", () => {
    expect(validateBackupDir(".fusion/backups")).toBe(true);
    expect(validateBackupDir("backups")).toBe(true);
    expect(validateBackupDir("data/backups/kb")).toBe(true);
  });

  it("should return false for absolute paths", () => {
    expect(validateBackupDir("/absolute/path")).toBe(false);
    expect(validateBackupDir("/home/user/backups")).toBe(false);
  });

  it("should return false for paths with parent traversal", () => {
    expect(validateBackupDir("../backups")).toBe(false);
    expect(validateBackupDir(".fusion/../backups")).toBe(false);
    expect(validateBackupDir("data/../../backups")).toBe(false);
  });

  it("should return false for Windows absolute paths", () => {
    expect(validateBackupDir("C:\\backups")).toBe(false);
    expect(validateBackupDir("D:\\data\\backups")).toBe(false);
  });
});

describe("createBackupManager", () => {
  it("should create manager with default options when no settings provided", () => {
    const manager = createBackupManager("/tmp/.fusion");
    expect(manager).toBeInstanceOf(BackupManager);
  });

  it("should use settings when provided", async () => {
    // Use fake timers for deterministic time control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    const tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    const fusionDir = join(tempDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    writeFileSync(join(fusionDir, "fusion.db"), "test");

    const settings: Partial<ProjectSettings> = {
      autoBackupDir: "custom/backups",
      autoBackupRetention: 2,
    };

    const manager = createBackupManager(fusionDir, settings);

    // Create 4 backups by advancing time
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
      await manager.createBackup();
    }

    // Cleanup should leave only 2
    const deleted = await manager.cleanupOldBackups();
    expect(deleted).toBe(2);

    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should canonicalize legacy .kb/backups to .fusion/backups in settings", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    const fusionDir = join(tempDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    writeFileSync(join(fusionDir, "fusion.db"), "test");

    const settings: Partial<ProjectSettings> = {
      autoBackupDir: ".kb/backups", // Legacy value
    };

    const manager = createBackupManager(fusionDir, settings);

    // Use fake timers and create a backup
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const backup = await manager.createBackup();

    // Verify the backup was created in the canonical .fusion/backups directory
    expect(backup.path).toContain(".fusion/backups");
    expect(backup.path).not.toContain(".kb/backups");

    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should preserve non-legacy custom .kb/* directories", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    const fusionDir = join(tempDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    writeFileSync(join(fusionDir, "fusion.db"), "test");

    const settings: Partial<ProjectSettings> = {
      autoBackupDir: ".kb/my-custom-backups", // Custom path, not the legacy default
    };

    const manager = createBackupManager(fusionDir, settings);

    // Use fake timers and create a backup
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const backup = await manager.createBackup();

    // Verify the backup was created in the custom .kb/my-custom-backups directory
    expect(backup.path).toContain(".kb/my-custom-backups");

    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("syncBackupRoutine", () => {
  let tempDir: string;
  let routineStore: RoutineStore;

  const baseSettings: ProjectSettings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
  };

  beforeEach(async () => {
    vi.useRealTimers();
    tempDir = mkdtempSync(join(tmpdir(), "kb-backup-routine-test-"));
    routineStore = new RoutineStore(tempDir, { inMemoryDb: true });
    await routineStore.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a command-backed routine for automatic database backups", async () => {
    const routine = await syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "0 3 * * *",
    });

    expect(routine).toBeDefined();
    expect(routine?.name).toBe("Database Backup");
    expect(routine?.trigger).toEqual({ type: "cron", cronExpression: "0 3 * * *" });
    expect(routine?.command).toBe("fn backup --create");
    expect(routine?.agentId).toBe("");
    expect(routine?.scope).toBe("project");
  });

  it("updates the existing backup routine when settings change", async () => {
    await syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "0 2 * * *",
    });

    const updated = await syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "30 4 * * *",
    });
    const routines = await routineStore.listRoutines();

    expect(routines).toHaveLength(1);
    expect(updated?.trigger).toEqual({ type: "cron", cronExpression: "30 4 * * *" });
    expect(updated?.command).toBe("fn backup --create");
    expect(updated?.enabled).toBe(true);
  });

  it("deletes the backup routine when automatic backups are disabled", async () => {
    await syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "0 2 * * *",
    });

    await syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: false,
    });

    expect(await routineStore.listRoutines()).toEqual([]);
  });

  it("rejects invalid backup schedules before creating a routine", async () => {
    await expect(syncBackupRoutine(routineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "bad-cron",
    })).rejects.toThrow("Invalid backup schedule");

    expect(await routineStore.listRoutines()).toEqual([]);
  });

  it("creates backup routine after upgrading legacy routines schema missing agentId", async () => {
    const diskDir = mkdtempSync(join(tmpdir(), "kb-backup-routine-legacy-"));
    const db = new Database(join(diskDir, ".fusion"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        triggerType TEXT NOT NULL,
        triggerConfig TEXT NOT NULL,
        command TEXT,
        enabled INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '55')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.close();

    const diskRoutineStore = new RoutineStore(diskDir);
    await diskRoutineStore.init();

    await expect(syncBackupRoutine(diskRoutineStore, {
      ...baseSettings,
      autoBackupEnabled: true,
      autoBackupSchedule: "0 1 * * *",
    })).resolves.toBeDefined();

    const routines = await diskRoutineStore.listRoutines();
    expect(routines).toHaveLength(1);
    expect(routines[0]?.name).toBe("Database Backup");
    expect(routines[0]?.agentId).toBe("");

    await rm(diskDir, { recursive: true, force: true });
  });
});

describe("runBackupCommand", () => {
  let tempDir: string;
  let fusionDir: string;

  beforeEach(async () => {
    // Use fake timers for deterministic timestamp control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    fusionDir = join(tempDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    writeFileSync(join(fusionDir, "fusion.db"), "dummy database content");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create backup regardless of autoBackupEnabled setting", async () => {
    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: false, // Disabled, but should still work when called manually
    };

    const result = await runBackupCommand(fusionDir, settings);

    // Should succeed even when autoBackupEnabled is false
    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();
  });

  it("should create backup when enabled", async () => {
    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
      autoBackupRetention: 7,
    };

    const result = await runBackupCommand(fusionDir, settings);

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(result.output).toContain("Backup created");
  });

  it("should return failure for invalid schedule", async () => {
    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
      autoBackupSchedule: "invalid-cron",
    };

    const result = await runBackupCommand(fusionDir, settings);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid backup schedule");
  });

  it("should cleanup old backups after creation", async () => {
    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
      autoBackupRetention: 2,
    };

    // Create 3 backups first (manually to test cleanup) by advancing time
    const manager = createBackupManager(fusionDir, settings);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
      await manager.createBackup();
    }

    // Now run backup command
    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    const result = await runBackupCommand(fusionDir, settings);

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  });

  it("should report central copy failure while keeping success true", async () => {
    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
    };

    await rm(join(fusionDir, "fusion-central.db"), { force: true });
    await mkdir(join(fusionDir, "fusion-central.db"), { recursive: true });

    const result = await runBackupCommand(fusionDir, settings);

    expect(result.success).toBe(true);
    expect(result.output).toContain("Central DB backup failed");
  });

  it("should return failure when database file is missing", async () => {
    // Remove the database
    await rm(join(fusionDir, "fusion.db"));

    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
    };

    const result = await runBackupCommand(fusionDir, settings);

    expect(result.success).toBe(false);
    expect(result.output).toContain("failed");
  });
});
