import { cp, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { ProjectSettings } from "./types.js";

/**
 * Metadata for a database backup file.
 */
export interface BackupInfo {
  /** Filename of the backup (e.g., "fusion-2026-03-31-020000.db") */
  filename: string;
  /** ISO-8601 timestamp when the backup was created */
  createdAt: string;
  /** Size in bytes */
  size: number;
  /** Full absolute path to the backup file */
  path: string;
}

/**
 * Options for configuring the backup manager.
 */
export interface BackupOptions {
  /** Directory for backup files, relative to the project root. Default: ".fusion/backups" */
  backupDir?: string;
  /** Number of backups to retain. Default: 7 */
  retention?: number;
}

/**
 * Manages database backup operations including creation, listing,
 * cleanup of old backups, and restoration.
 */
export class BackupManager {
  private fusionDir: string;
  private backupDir: string;
  private retention: number;

  /**
   * Creates a new BackupManager instance.
   * @param fusionDir - Absolute path to the .fusion directory
   * @param options - Backup configuration options
   */
  constructor(fusionDir: string, options?: BackupOptions) {
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
  }

  /**
   * Gets the absolute path to the backup directory.
   */
  private getBackupDirPath(): string {
    // The backupDir is relative to project root, which is parent of fusionDir
    return join(this.fusionDir, "..", this.backupDir);
  }

  /**
   * Creates a timestamped backup of the database.
   * @returns BackupInfo for the newly created backup
   */
  async createBackup(): Promise<BackupInfo> {
    const sourcePath = join(this.fusionDir, "fusion.db");
    const backupDirPath = this.getBackupDirPath();
    
    // Ensure backup directory exists
    await mkdir(backupDirPath, { recursive: true });
    
    // Generate unique filename (handle collisions with counter suffix)
    let filename = generateBackupFilename();
    let targetPath = join(backupDirPath, filename);
    let counter = 1;
    
    while (existsSync(targetPath)) {
      const baseName = filename.replace(/\.db$/, "");
      filename = `${baseName}-${counter}.db`;
      targetPath = join(backupDirPath, filename);
      counter++;
    }

    // Copy the database file
    await cp(sourcePath, targetPath, { preserveTimestamps: true });

    // Get file stats
    const stats = await stat(targetPath);

    return {
      filename,
      createdAt: new Date().toISOString(),
      size: stats.size,
      path: targetPath,
    };
  }

  /**
   * Lists all backup files sorted by creation time (newest first).
   * @returns Array of BackupInfo objects
   */
  async listBackups(): Promise<BackupInfo[]> {
    const backupDirPath = this.getBackupDirPath();

    try {
      const files = await readdir(backupDirPath);
      const backups: BackupInfo[] = [];

      for (const filename of files) {
        // Match fusion-* and legacy kb-* backup patterns:
        //   fusion-YYYY-MM-DD-HHmmss.db, fusion-YYYY-MM-DD-HHmmss-N.db,
        //   fusion-pre-restore-YYYY-MM-DD-HHmmss.db
        //   kb-* variants kept for the ongoing kb → fn rename (see memory).
        if (!filename.match(/^(?:fusion|kb)(-pre-restore)?-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/)) {
          continue;
        }

        const filePath = join(backupDirPath, filename);
        const stats = await stat(filePath);

        // Parse timestamp from filename. Also handles counter suffix: fusion-YYYY-MM-DD-HHmmss-N.db
        const match = filename.match(/^(?:fusion|kb)(?:-pre-restore)?-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.db$/);
        const createdAt = match
          ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
          : stats.mtime.toISOString();

        backups.push({
          filename,
          createdAt,
          size: stats.size,
          path: filePath,
        });
      }

      // Sort by createdAt descending (newest first), then by filename for deterministic ordering
      return backups.sort((a, b) => {
        const timeCompare = b.createdAt.localeCompare(a.createdAt);
        if (timeCompare !== 0) return timeCompare;
        return b.filename.localeCompare(a.filename);
      });
    } catch {
      // Directory doesn't exist or can't be read - return empty array
      return [];
    }
  }

  /**
   * Removes old backups to maintain the retention limit.
   * Only removes regular backups, not pre-restore backups.
   * @returns Number of backups deleted
   */
  async cleanupOldBackups(): Promise<number> {
    const backups = await this.listBackups();
    
    // Filter to only regular backups (not pre-restore)
    const regularBackups = backups.filter(b => !b.filename.includes("pre-restore"));

    if (regularBackups.length <= this.retention) {
      return 0;
    }

    // Sort ascending (oldest first) for deletion, using filename as secondary sort for determinism
    const sorted = [...regularBackups].sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      if (timeCompare !== 0) return timeCompare;
      return a.filename.localeCompare(b.filename);
    });
    const toDelete = sorted.slice(0, sorted.length - this.retention);

    let deletedCount = 0;
    for (const backup of toDelete) {
      try {
        await unlink(backup.path);
        deletedCount++;
      } catch {
        // Ignore deletion errors
      }
    }

    return deletedCount;
  }

  /**
   * Restores a backup to become the main database.
   * Optionally creates a pre-restore backup of the current database.
   * @param filename - Name of the backup file to restore
   * @param options - Restore options
   */
  async restoreBackup(
    filename: string,
    options?: { createPreRestoreBackup?: boolean }
  ): Promise<void> {
    const backupDirPath = this.getBackupDirPath();
    const sourcePath = join(backupDirPath, filename);
    const targetPath = join(this.fusionDir, "fusion.db");

    // Verify source exists
    try {
      await stat(sourcePath);
    } catch {
      throw new Error(`Backup file not found: ${filename}`);
    }

    // Optionally create pre-restore backup
    if (options?.createPreRestoreBackup ?? true) {
      const preRestoreFilename = `fusion-pre-restore-${formatTimestamp(new Date())}.db`;
      const preRestorePath = join(backupDirPath, preRestoreFilename);
      await mkdir(backupDirPath, { recursive: true });
      await cp(targetPath, preRestorePath, { preserveTimestamps: true });
    }

    // Restore the backup
    await cp(sourcePath, targetPath, { preserveTimestamps: true });
  }
}

/**
 * Generates a backup filename with timestamp.
 * Format: fusion-YYYY-MM-DD-HHmmss.db
 */
export function generateBackupFilename(): string {
  return `fusion-${formatTimestamp(new Date())}.db`;
}

/**
 * Formats a date as YYYY-MM-DD-HHmmss in UTC.
 */
function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

/**
 * Validates a cron expression for backup scheduling.
 * @param schedule - Cron expression to validate
 * @returns True if valid, false otherwise
 */
export function validateBackupSchedule(schedule: string): boolean {
  if (!schedule || schedule.trim() === "") {
    return false;
  }
  try {
    CronExpressionParser.parse(schedule);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the backup retention count.
 * @param retention - Number of backups to retain
 * @returns True if valid (1-100), false otherwise
 */
export function validateBackupRetention(retention: number): boolean {
  return Number.isInteger(retention) && retention >= 1 && retention <= 100;
}

/**
 * Validates the backup directory path.
 * Must be relative and not contain parent directory traversal.
 * @param dir - Directory path to validate
 * @returns True if valid, false otherwise
 */
export function validateBackupDir(dir: string): boolean {
  // Must be relative (not start with / or \)
  if (dir.startsWith("/") || dir.startsWith("\\")) {
    return false;
  }
  // Must not contain parent directory traversal
  if (dir.includes("..")) {
    return false;
  }
  // Must not be absolute path with drive letter (Windows)
  if (/^[a-zA-Z]:/.test(dir)) {
    return false;
  }
  return true;
}

/**
 * Factory function to create a BackupManager with project settings.
 * @param fusionDir - Absolute path to the .fusion directory
 * @param settings - Project settings containing backup configuration
 * @returns Configured BackupManager instance
 */
export function createBackupManager(
  fusionDir: string,
  settings?: Partial<ProjectSettings>
): BackupManager {
  return new BackupManager(fusionDir, {
    backupDir: canonicalizeBackupDir(settings?.autoBackupDir),
    retention: settings?.autoBackupRetention,
  });
}

/**
 * Canonicalize a legacy `.kb/backups` value to `.fusion/backups`.
 * The kb → fn rename left some persisted settings pointing at the old path;
 * we rewrite it on read so existing projects keep working.
 */
function canonicalizeBackupDir(dir: string | undefined): string | undefined {
  if (dir === ".kb/backups") return ".fusion/backups";
  return dir;
}

/**
 * Runs the backup command with settings from the project.
 * This is the main entry point for scheduled backup automation.
 * 
 * NOTE: This function does NOT check autoBackupEnabled - that check should happen
 * at the automation/scheduler level. This allows manual backups via CLI even when
 * auto-backup is disabled.
 * 
 * @param fusionDir - Absolute path to the .fusion directory
 * @param settings - Project settings
 * @returns Result of the backup operation
 */
export async function runBackupCommand(
  fusionDir: string,
  settings: ProjectSettings
): Promise<{ success: boolean; output: string; backupPath?: string; deletedCount?: number }> {
  // Validate schedule if provided (for logging purposes)
  if (settings.autoBackupSchedule && !validateBackupSchedule(settings.autoBackupSchedule)) {
    return {
      success: false,
      output: `Invalid backup schedule: ${settings.autoBackupSchedule}`,
    };
  }

  // Create backup manager with settings
  const manager = createBackupManager(fusionDir, settings);

  try {
    // Create the backup
    const backup = await manager.createBackup();

    // Cleanup old backups
    const deletedCount = await manager.cleanupOldBackups();

    const output = deletedCount > 0
      ? `Backup created: ${backup.filename} (${formatBytes(backup.size)}). Removed ${deletedCount} old backup(s).`
      : `Backup created: ${backup.filename} (${formatBytes(backup.size)})`;

    return {
      success: true,
      output,
      backupPath: backup.path,
      deletedCount,
    };
  } catch (err) {
    return {
      success: false,
      output: `Backup failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Formats bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Constant name for the backup automation schedule.
 * Used to identify and manage the backup schedule in the automation store.
 */
export const BACKUP_SCHEDULE_NAME = "Database Backup";

/**
 * Synchronizes the backup automation schedule with project settings.
 * Creates, updates, or deletes the backup schedule based on settings.
 * 
 * @param automationStore - The AutomationStore instance
 * @param settings - Current project settings
 * @returns The created/updated schedule, or undefined if deleted/disabled
 */
export async function syncBackupAutomation(
  automationStore: import("./automation-store.js").AutomationStore,
  settings: ProjectSettings
): Promise<import("./automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");
  
  // Find existing backup schedule by name
  const schedules = await automationStore.listSchedules();
  const existingSchedule = schedules.find(s => s.name === BACKUP_SCHEDULE_NAME);
  
  // If backups are disabled, delete existing schedule if present
  if (!settings.autoBackupEnabled) {
    if (existingSchedule) {
      await automationStore.deleteSchedule(existingSchedule.id);
    }
    return undefined;
  }
  
  // Validate the cron schedule
  const schedule = settings.autoBackupSchedule || "0 2 * * *";
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }
  
  // Build the backup command.
  // Uses `npx runfusion.ai` so backups work even when only the zero-install
  // path (`npx runfusion.ai`) has been used and `fn` is not on PATH.
  const command = "npx runfusion.ai backup --create";

  if (existingSchedule) {
    // Update existing schedule
    return await automationStore.updateSchedule(existingSchedule.id, {
      scheduleType: "custom",
      cronExpression: schedule,
      command,
      enabled: true,
    });
  } else {
    // Create new schedule
    return await automationStore.createSchedule({
      name: BACKUP_SCHEDULE_NAME,
      description: "Automatic database backup based on project settings",
      scheduleType: "custom",
      cronExpression: schedule,
      command,
      enabled: true,
    });
  }
}

/**
 * Synchronizes the database backup routine with project settings.
 *
 * This is the combined routine/schedule model: cron scheduling comes from the
 * routine trigger, while the backup action is stored as a command on the same
 * record.
 */
export async function syncBackupRoutine(
  routineStore: import("./routine-store.js").RoutineStore,
  settings: ProjectSettings,
): Promise<import("./routine.js").Routine | undefined> {
  const { RoutineStore } = await import("./routine-store.js");

  const routines = await routineStore.listRoutines();
  const existingRoutine = routines.find((routine) => routine.name === BACKUP_SCHEDULE_NAME);

  if (!settings.autoBackupEnabled) {
    if (existingRoutine) {
      await routineStore.deleteRoutine(existingRoutine.id);
    }
    return undefined;
  }

  const schedule = settings.autoBackupSchedule || "0 2 * * *";
  if (!RoutineStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }

  const command = "npx runfusion.ai backup --create";
  const input = {
    name: BACKUP_SCHEDULE_NAME,
    description: "Automatic database backup based on project settings",
    agentId: "",
    trigger: { type: "cron" as const, cronExpression: schedule },
    command,
    enabled: true,
    scope: "project" as const,
  };

  if (existingRoutine) {
    return await routineStore.updateRoutine(existingRoutine.id, {
      trigger: input.trigger,
      command,
      enabled: true,
    });
  }

  return await routineStore.createRoutine(input);
}
