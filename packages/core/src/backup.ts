import { cp, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { DatabaseSync } from "./sqlite-adapter.js";
import { getDefaultCentralDbPath } from "./central-db.js";
import type { ProjectSettings } from "./types.js";

export interface BackupFileInfo {
  filename: string;
  createdAt: string;
  size: number;
  path: string;
}

export interface BackupInfo extends BackupFileInfo {
  centralBackup?:
    | BackupFileInfo
    | {
        skipped: "missing" | "disabled";
      }
    | {
        failed: string;
      };
}

export interface BackupPairInfo {
  timestamp: string;
  project?: BackupFileInfo;
  central?: BackupFileInfo;
}

export interface BackupOptions {
  backupDir?: string;
  retention?: number;
  centralDbPath?: string;
  includeCentralDb?: boolean;
}

export class BackupManager {
  private fusionDir: string;
  private backupDir: string;
  private retention: number;
  private centralDbPath: string;
  private includeCentralDb: boolean;

  constructor(fusionDir: string, options?: BackupOptions) {
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
    this.centralDbPath = options?.centralDbPath ?? join(this.fusionDir, "..", ".fusion", "fusion-central.db");
    this.includeCentralDb = options?.includeCentralDb ?? true;
  }

  private getBackupDirPath(): string {
    return join(this.fusionDir, "..", this.backupDir);
  }

  async createBackup(): Promise<BackupInfo> {
    const sourcePath = join(this.fusionDir, "fusion.db");
    const backupDirPath = this.getBackupDirPath();
    await mkdir(backupDirPath, { recursive: true });

    const timestamp = currentBackupTimestamp();
    let counter = 0;

    while (true) {
      const projectFilename = generateBackupFilename(timestamp, counter);
      const projectTargetPath = join(backupDirPath, projectFilename);
      const projectExists = existsSync(projectTargetPath);

      if (!this.includeCentralDb) {
        if (!projectExists) break;
        counter += 1;
        continue;
      }

      const centralFilename = generateCentralBackupFilename(timestamp, counter);
      const centralTargetPath = join(backupDirPath, centralFilename);
      const centralExists = existsSync(centralTargetPath);

      if (!projectExists && !centralExists) {
        break;
      }
      counter += 1;
    }

    const filename = generateBackupFilename(timestamp, counter);
    const targetPath = join(backupDirPath, filename);

    checkpointWalBestEffort(sourcePath);
    await cp(sourcePath, targetPath, { preserveTimestamps: true });

    const stats = await stat(targetPath);
    const backup: BackupInfo = {
      filename,
      createdAt: new Date().toISOString(),
      size: stats.size,
      path: targetPath,
    };

    if (!this.includeCentralDb) {
      backup.centralBackup = { skipped: "disabled" };
      return backup;
    }

    if (!existsSync(this.centralDbPath)) {
      backup.centralBackup = { skipped: "missing" };
      return backup;
    }

    const centralFilename = generateCentralBackupFilename(timestamp, counter);
    const centralTargetPath = join(backupDirPath, centralFilename);

    try {
      checkpointWalBestEffort(this.centralDbPath);
      await cp(this.centralDbPath, centralTargetPath, { preserveTimestamps: true });

      const centralStats = await stat(centralTargetPath);
      backup.centralBackup = {
        filename: centralFilename,
        createdAt: new Date().toISOString(),
        size: centralStats.size,
        path: centralTargetPath,
      };
    } catch (err) {
      backup.centralBackup = {
        failed: (err as Error).message,
      };
    }

    return backup;
  }

  async listBackups(): Promise<BackupFileInfo[]> {
    const backupDirPath = this.getBackupDirPath();

    try {
      const files = await readdir(backupDirPath);
      const backups: BackupFileInfo[] = [];

      for (const filename of files) {
        if (!filename.match(/^(?:fusion|kb)(-pre-restore)?-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/)) {
          continue;
        }

        const filePath = join(backupDirPath, filename);
        const stats = await stat(filePath);
        backups.push({
          filename,
          createdAt: parseBackupTimestamp(filename, stats.mtime.toISOString()),
          size: stats.size,
          path: filePath,
        });
      }

      return sortBackupsNewestFirst(backups);
    } catch {
      return [];
    }
  }

  async listCentralBackups(): Promise<BackupFileInfo[]> {
    const backupDirPath = this.getBackupDirPath();

    try {
      const files = await readdir(backupDirPath);
      const backups: BackupFileInfo[] = [];

      for (const filename of files) {
        if (!filename.match(/^fusion-central(-pre-restore)?-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/)) {
          continue;
        }

        const filePath = join(backupDirPath, filename);
        const stats = await stat(filePath);
        backups.push({
          filename,
          createdAt: parseCentralBackupTimestamp(filename, stats.mtime.toISOString()),
          size: stats.size,
          path: filePath,
        });
      }

      return sortBackupsNewestFirst(backups);
    } catch {
      return [];
    }
  }

  async listBackupPairs(): Promise<BackupPairInfo[]> {
    const projects = await this.listBackups();
    const centrals = await this.listCentralBackups();
    const pairs = new Map<string, BackupPairInfo>();

    for (const project of projects) {
      const key = getBackupPairKey(project.filename, false);
      if (!key) continue;
      const existing = pairs.get(key) ?? { timestamp: key };
      existing.project = project;
      pairs.set(key, existing);
    }

    for (const central of centrals) {
      const key = getBackupPairKey(central.filename, true);
      if (!key) continue;
      const existing = pairs.get(key) ?? { timestamp: key };
      existing.central = central;
      pairs.set(key, existing);
    }

    return [...pairs.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async cleanupOldBackups(): Promise<number> {
    const backups = await this.listBackups();
    const regularBackups = backups.filter((b) => !b.filename.includes("pre-restore"));

    if (regularBackups.length <= this.retention) {
      return 0;
    }

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

      const siblingCentralFilename = toCentralSiblingFilename(backup.filename);
      if (!siblingCentralFilename) continue;
      const siblingCentralPath = join(this.getBackupDirPath(), siblingCentralFilename);
      if (existsSync(siblingCentralPath)) {
        try {
          await unlink(siblingCentralPath);
        } catch {
          // Ignore sibling cleanup errors
        }
      }
    }

    return deletedCount;
  }

  async restoreBackup(
    filename: string,
    options?: { createPreRestoreBackup?: boolean; skipCentral?: boolean; centralOnly?: boolean }
  ): Promise<void> {
    const backupDirPath = this.getBackupDirPath();
    const sourcePath = join(backupDirPath, filename);

    try {
      await stat(sourcePath);
    } catch {
      throw new Error(`Backup file not found: ${filename}`);
    }

    const createPreRestoreBackup = options?.createPreRestoreBackup ?? true;
    const timestamp = formatTimestamp(new Date());

    const restoreCentral = async (centralFilename: string, centralSourcePath = join(backupDirPath, centralFilename)) => {
      try {
        await stat(centralSourcePath);
      } catch {
        return false;
      }

      if (options?.centralOnly && !existsSync(this.centralDbPath)) {
        throw new Error(`Central database path not found: ${this.centralDbPath}`);
      }

      if (createPreRestoreBackup && existsSync(this.centralDbPath)) {
        await mkdir(backupDirPath, { recursive: true });
        const preRestoreFilename = `fusion-central-pre-restore-${timestamp}.db`;
        await cp(this.centralDbPath, join(backupDirPath, preRestoreFilename), { preserveTimestamps: true });
      }

      await cp(centralSourcePath, this.centralDbPath, { preserveTimestamps: true });
      return true;
    };

    if (filename.startsWith("fusion-central-")) {
      await restoreCentral(filename, sourcePath);
      return;
    }

    const targetPath = join(this.fusionDir, "fusion.db");
    if (createPreRestoreBackup) {
      const preRestoreFilename = `fusion-pre-restore-${timestamp}.db`;
      const preRestorePath = join(backupDirPath, preRestoreFilename);
      await mkdir(backupDirPath, { recursive: true });
      await cp(targetPath, preRestorePath, { preserveTimestamps: true });
    }

    await cp(sourcePath, targetPath, { preserveTimestamps: true });

    if (!options?.skipCentral) {
      const centralSiblingFilename = toCentralSiblingFilename(filename);
      if (centralSiblingFilename) {
        await restoreCentral(centralSiblingFilename);
      }
    }
  }
}

export function currentBackupTimestamp(): string {
  return formatTimestamp(new Date());
}

export function generateBackupFilename(timestamp = currentBackupTimestamp(), counter = 0): string {
  return counter > 0 ? `fusion-${timestamp}-${counter}.db` : `fusion-${timestamp}.db`;
}

export function generateCentralBackupFilename(timestamp = currentBackupTimestamp(), counter = 0): string {
  return counter > 0 ? `fusion-central-${timestamp}-${counter}.db` : `fusion-central-${timestamp}.db`;
}

function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function checkpointWalBestEffort(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    // Best effort only; plain file copy fallback remains valid.
  }
}

function sortBackupsNewestFirst(backups: BackupFileInfo[]): BackupFileInfo[] {
  return backups.sort((a, b) => {
    const timeCompare = b.createdAt.localeCompare(a.createdAt);
    if (timeCompare !== 0) return timeCompare;
    return b.filename.localeCompare(a.filename);
  });
}

function parseBackupTimestamp(filename: string, fallback: string): string {
  const match = filename.match(/^(?:fusion|kb)(?:-pre-restore)?-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.db$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : fallback;
}

function parseCentralBackupTimestamp(filename: string, fallback: string): string {
  const match = filename.match(/^fusion-central(?:-pre-restore)?-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.db$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : fallback;
}

function toCentralSiblingFilename(projectFilename: string): string | null {
  const match = projectFilename.match(/^(?:fusion|kb)-(\d{4}-\d{2}-\d{2}-\d{6})(-\d+)?\.db$/);
  if (!match) return null;
  return `fusion-central-${match[1]}${match[2] ?? ""}.db`;
}

function getBackupPairKey(filename: string, isCentral: boolean): string | null {
  const pattern = isCentral
    ? /^fusion-central(?:-pre-restore)?-(\d{4}-\d{2}-\d{2}-\d{6})(-\d+)?\.db$/
    : /^(?:fusion|kb)(?:-pre-restore)?-(\d{4}-\d{2}-\d{2}-\d{6})(-\d+)?\.db$/;
  const match = filename.match(pattern);
  if (!match) return null;
  return `${match[1]}${match[2] ?? ""}`;
}

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

export function validateBackupRetention(retention: number): boolean {
  return Number.isInteger(retention) && retention >= 1 && retention <= 100;
}

export function validateBackupDir(dir: string): boolean {
  if (dir.startsWith("/") || dir.startsWith("\\")) {
    return false;
  }
  if (dir.includes("..")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(dir)) {
    return false;
  }
  return true;
}

export function createBackupManager(
  fusionDir: string,
  settings?: Partial<ProjectSettings>
): BackupManager {
  let centralDbPath: string;
  try {
    centralDbPath = getDefaultCentralDbPath();
  } catch {
    centralDbPath = join(fusionDir, "..", ".fusion", "fusion-central.db");
  }

  return new BackupManager(fusionDir, {
    backupDir: canonicalizeBackupDir(settings?.autoBackupDir),
    retention: settings?.autoBackupRetention,
    centralDbPath,
    includeCentralDb: true,
  });
}

function canonicalizeBackupDir(dir: string | undefined): string | undefined {
  if (dir === ".kb/backups") return ".fusion/backups";
  return dir;
}

export async function runBackupCommand(
  fusionDir: string,
  settings: ProjectSettings
): Promise<{ success: boolean; output: string; backupPath?: string; deletedCount?: number }> {
  if (settings.autoBackupSchedule && !validateBackupSchedule(settings.autoBackupSchedule)) {
    return {
      success: false,
      output: `Invalid backup schedule: ${settings.autoBackupSchedule}`,
    };
  }

  const manager = createBackupManager(fusionDir, settings);

  try {
    const backup = await manager.createBackup();
    const deletedCount = await manager.cleanupOldBackups();
    const removedClause = deletedCount > 0 ? ` Removed ${deletedCount} old backup(s).` : "";

    const output = (() => {
      if (backup.centralBackup && "filename" in backup.centralBackup) {
        const total = backup.size + backup.centralBackup.size;
        return `Backup created: ${backup.filename} + ${backup.centralBackup.filename} (${formatBytes(total)}).${removedClause}`.trim();
      }

      if (backup.centralBackup && "skipped" in backup.centralBackup) {
        return `Backup created: ${backup.filename} (${formatBytes(backup.size)}). Central DB skipped: ${backup.centralBackup.skipped}.${removedClause}`.trim();
      }

      if (backup.centralBackup && "failed" in backup.centralBackup) {
        return `Backup created: ${backup.filename} (${formatBytes(backup.size)}). Central DB backup failed: ${backup.centralBackup.failed}.${removedClause}`.trim();
      }

      return `Backup created: ${backup.filename} (${formatBytes(backup.size)}).${removedClause}`.trim();
    })();

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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export const BACKUP_SCHEDULE_NAME = "Database Backup";

export async function syncBackupAutomation(
  automationStore: import("./automation-store.js").AutomationStore,
  settings: ProjectSettings
): Promise<import("./automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");

  const schedules = await automationStore.listSchedules();
  const existingSchedule = schedules.find(s => s.name === BACKUP_SCHEDULE_NAME);

  if (!settings.autoBackupEnabled) {
    if (existingSchedule) {
      await automationStore.deleteSchedule(existingSchedule.id);
    }
    return undefined;
  }

  const schedule = settings.autoBackupSchedule || "0 2 * * *";
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }

  const command = "fn backup --create";

  if (existingSchedule) {
    return await automationStore.updateSchedule(existingSchedule.id, {
      scheduleType: "custom",
      cronExpression: schedule,
      command,
      enabled: true,
    });
  } else {
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

  const command = "fn backup --create";
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
