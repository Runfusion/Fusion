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
} from "./backup.js";
import type { ProjectSettings } from "./types.js";

describe("BackupManager", () => {
  let tempDir: string;
  let kbDir: string;
  let backupManager: BackupManager;

  beforeEach(async () => {
    // Use fake timers for deterministic timestamp control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    kbDir = join(tempDir, ".fusion");
    await mkdir(kbDir, { recursive: true });
    // Create a dummy database file
    writeFileSync(join(kbDir, "kb.db"), "dummy database content");
    backupManager = new BackupManager(kbDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createBackup", () => {
    it("should create a backup file with correct name pattern", async () => {
      const backup = await backupManager.createBackup();

      expect(backup.filename).toMatch(/^kb-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
      expect(existsSync(backup.path)).toBe(true);
    });

    it("should copy database content correctly", async () => {
      const backup = await backupManager.createBackup();

      const originalContent = readFileSync(join(kbDir, "kb.db"), "utf-8");
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
      const manager = new BackupManager(kbDir, { backupDir: customBackupDir });

      const customBackupPath = join(tempDir, customBackupDir);
      expect(existsSync(customBackupPath)).toBe(false);

      await manager.createBackup();

      expect(existsSync(customBackupPath)).toBe(true);
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
      expect(backups[0].filename).toMatch(/^kb-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    });

    it("should return correct file sizes", async () => {
      const backup = await backupManager.createBackup();
      const backups = await backupManager.listBackups();

      expect(backups[0].size).toBe(backup.size);
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
      const manager = new BackupManager(kbDir, { retention: 2 });

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
      const manager = new BackupManager(kbDir, { retention: 2 });

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
  });

  describe("restoreBackup", () => {
    it("should restore backup to main database location", async () => {
      const backup = await backupManager.createBackup();

      // Modify the original database
      await writeFile(join(kbDir, "kb.db"), "modified content");

      // Restore the backup
      await backupManager.restoreBackup(backup.filename, { createPreRestoreBackup: false });

      // Verify the restore
      const restoredContent = readFileSync(join(kbDir, "kb.db"), "utf-8");
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
    });
  });
});

describe("generateBackupFilename", () => {
  it("should generate filename with correct pattern", () => {
    const filename = generateBackupFilename();
    expect(filename).toMatch(/^kb-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
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
    const kbDir = join(tempDir, ".fusion");
    await mkdir(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "kb.db"), "test");

    const settings: Partial<ProjectSettings> = {
      autoBackupDir: "custom/backups",
      autoBackupRetention: 2,
    };

    const manager = createBackupManager(kbDir, settings);

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
});

describe("runBackupCommand", () => {
  let tempDir: string;
  let kbDir: string;

  beforeEach(async () => {
    // Use fake timers for deterministic timestamp control
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    
    tempDir = mkdtempSync(join(tmpdir(), "kb-backup-test-"));
    kbDir = join(tempDir, ".fusion");
    await mkdir(kbDir, { recursive: true });
    writeFileSync(join(kbDir, "kb.db"), "dummy database content");
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

    const result = await runBackupCommand(kbDir, settings);

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

    const result = await runBackupCommand(kbDir, settings);

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

    const result = await runBackupCommand(kbDir, settings);

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
    const manager = createBackupManager(kbDir, settings);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}.000Z`));
      await manager.createBackup();
    }

    // Now run backup command
    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    const result = await runBackupCommand(kbDir, settings);

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  });

  it("should return failure when database file is missing", async () => {
    // Remove the database
    await rm(join(kbDir, "kb.db"));

    const settings: ProjectSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: true,
      autoBackupEnabled: true,
    };

    const result = await runBackupCommand(kbDir, settings);

    expect(result.success).toBe(false);
    expect(result.output).toContain("failed");
  });
});
