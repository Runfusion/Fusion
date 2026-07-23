import { join } from "node:path";
import { resolveGlobalDir } from "../config/global-settings.js";
import { CronExpressionParser } from "cron-parser";
import { getDefaultCentralDbPath } from "../central/central-db.js";
import { PgBackupManager, type PgBackupPair, type PgDumpResult } from "../postgres/pg-backup.js";
import { resolveBackend } from "../postgres/backend-resolver.js";
import { getActiveEmbeddedRuntimeUrl } from "../postgres/active-backend-registry.js";
import type { Settings } from "../types.js";

/**
 * FNXC:SettingsBackups 2026-07-16-14:50:
 * Database dumps represent the shared PostgreSQL cluster. Resolve their root once from
 * the global settings directory, falling back to the canonical global directory so no
 * caller can accidentally create per-project retention sets when that directory is unset.
 */
export function resolveGlobalBackupRoot(store: { getGlobalSettingsDir(): string | undefined }): string {
  return store.getGlobalSettingsDir() ?? resolveGlobalDir();
}

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
  /**
   * FNXC:SqliteFinalRemoval 2026-06-26-00:15:
   * PostgreSQL connection string. BackupManager always delegates to
   * PgBackupManager (pg_dump/pg_restore). The legacy SQLite file-copy path
   * was removed as part of the SQLite-to-PostgreSQL cutover.
   */
  connectionString?: string;
}

/**
 * FNXC:SqliteFinalRemoval 2026-06-26:
 * BackupManager now exclusively delegates to PgBackupManager (pg_dump/pg_restore).
 * The legacy SQLite file-copy path (copyLiveDatabase, verifyDatabaseIntegrity via
 * PRAGMA quick_check, quarantineCorruptBackup, WAL snapshot copy) was removed as
 * part of the SQLite-to-PostgreSQL cutover (VAL-REMOVAL-003/005). All production
 * callers receive a connection string via createBackupManager's auto-resolution
 * from the runtime backend.
 */
export class BackupManager {
  private fusionDir: string;
  private backupDir: string;
  private retention: number;
  private centralDbPath: string;
  private includeCentralDb: boolean;
  private readonly pgManager: PgBackupManager;

  constructor(fusionDir: string, options?: BackupOptions) {
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
    this.centralDbPath = options?.centralDbPath ?? join(this.fusionDir, "..", ".fusion", "fusion-central.db");
    this.includeCentralDb = options?.includeCentralDb ?? true;
    const connectionString = options?.connectionString ?? resolveBackendConnectionString();
    if (!connectionString) {
      throw new Error(
        "BackupManager requires a PostgreSQL connection string. The legacy SQLite file-copy path was removed. " +
          "Pass connectionString explicitly or ensure DATABASE_URL / embedded backend is configured.",
      );
    }
    this.pgManager = new PgBackupManager(connectionString, fusionDir, {
      backupDir: this.backupDir,
      retention: this.retention,
      includeCentral: this.includeCentralDb,
    });
  }

  private getBackupDirPath(): string {
    return join(this.fusionDir, "..", this.backupDir);
  }

  async createBackup(): Promise<BackupInfo> {
    const pair = await this.pgManager.createBackup();
    return pgBackupPairToBackupInfo(pair);
  }

  async listBackups(): Promise<BackupFileInfo[]> {
    const pairs = await this.pgManager.listBackups();
    const results: BackupFileInfo[] = [];
    for (const pair of pairs) {
      if (pair.project) {
        results.push(pgDumpResultToBackupFileInfo(pair.project));
      }
      if (pair.central && "filename" in pair.central) {
        results.push(pgDumpResultToBackupFileInfo(pair.central));
      }
    }
    return results;
  }

  /**
   * FNXC:SqliteFinalRemoval 2026-06-26:
   * List central backups from the backup directory. PgBackupManager stores
   * central dumps alongside project dumps; this filters for central files.
   */
  async listCentralBackups(): Promise<BackupFileInfo[]> {
    const all = await this.listBackups();
    return all.filter((b) => b.filename.includes("-central-") || b.filename.startsWith("fusion-central"));
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
    const result = await this.pgManager.cleanupOldBackups();
    return result.deleted.length;
  }

  /**
   * FNXC:SqliteFinalRemoval 2026-06-26:
   * Restore is delegated to PgBackupManager (pg_restore). The legacy SQLite
   * file-copy restore (cp fusion.db, pre-restore snapshots) was removed.
   */
  async restoreBackup(
    filename: string,
    _options?: { createPreRestoreBackup?: boolean; skipCentral?: boolean; centralOnly?: boolean }
  ): Promise<void> {
    await this.pgManager.restoreBackup(filename);
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
  settings?: Partial<Settings>,
  connectionString?: string,
): BackupManager {
  let centralDbPath: string;
  try {
    centralDbPath = getDefaultCentralDbPath();
  } catch {
    centralDbPath = join(fusionDir, "..", ".fusion", "fusion-central.db");
  }

  /*
   * FNXC:SqliteFinalRemoval 2026-06-26:
   * Auto-resolve the connection string from the runtime backend so production
   * deployments always delegate to PgBackupManager (VAL-REMOVAL-003). The
   * SQLite file-copy fallback was removed; an explicit connectionString
   * argument always wins.
   */
  const resolvedConnectionString =
    connectionString ?? resolveBackendConnectionString();

  return new BackupManager(fusionDir, {
    backupDir: canonicalizeBackupDir(settings?.autoBackupDir),
    retention: settings?.autoBackupRetention,
    centralDbPath,
    includeCentralDb: true,
    connectionString: resolvedConnectionString,
  });
}

/**
 * FNXC:PostgresBackup 2026-07-16-12:40:
 * External deployments resolve directly from DATABASE_URL. Embedded PostgreSQL
 * learns its URL only during asynchronous startup, so use the active lifecycle
 * registry as the synchronous fallback. It is intentionally undefined before
 * boot or after owner shutdown, preserving BackupManager's actionable error.
 */
export function resolveBackendConnectionString(): string | undefined {
  const backend = resolveBackend();
  if (backend.mode === "external" && backend.runtimeUrl) {
    return backend.runtimeUrl;
  }
  return getActiveEmbeddedRuntimeUrl();
}

/*
 * FNXC:SqliteFinalRemoval 2026-06-26-00:30:
 * Converters between PgBackupManager result shapes and BackupManager shapes.
 */
function pgDumpResultToBackupFileInfo(result: PgDumpResult): BackupFileInfo {
  return {
    filename: result.filename,
    createdAt: result.createdAt,
    size: result.sizeBytes,
    path: result.path,
  };
}

function pgBackupPairToBackupInfo(pair: PgBackupPair): BackupInfo {
  const info: BackupInfo = pair.project
    ? pgDumpResultToBackupFileInfo(pair.project)
    : { filename: "", createdAt: pair.timestamp, size: 0, path: "" };

  if (pair.central) {
    if ("filename" in pair.central) {
      info.centralBackup = pgDumpResultToBackupFileInfo(pair.central);
    } else {
      info.centralBackup = pair.central; // { skipped: "disabled" | "missing" }
    }
  }
  return info;
}

function canonicalizeBackupDir(dir: string | undefined): string | undefined {
  if (dir === ".kb/backups") return ".fusion/backups";
  return dir;
}

export async function runBackupCommand(
  fusionDir: string,
  settings: Settings
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
  automationStore: import("../automation/automation-store.js").AutomationStore,
  settings: Settings
): Promise<import("../automation/automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("../automation/automation-store.js");

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
  routineStore: import("../automation/routine-store.js").RoutineStore,
  settings: Settings,
): Promise<import("../automation/routine.js").Routine | undefined> {
  const { RoutineStore } = await import("../automation/routine-store.js");
  const schedule = settings.autoBackupSchedule || "0 2 * * *";
  if (!RoutineStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }

  /* FNXC:SettingsBackups 2026-07-16-16:20: backend-mode routines are central so
     independently opened projects cannot each schedule a dump of the shared cluster. */
  if (routineStore.asyncLayer) {
    const { GlobalRoutineStore } = await import("../automation/global-routine-store.js");
    const globalRoutines = new GlobalRoutineStore(routineStore.asyncLayer);
    if (!settings.autoBackupEnabled) {
      await globalRoutines.deleteByName(BACKUP_SCHEDULE_NAME);
      return undefined;
    }
    return globalRoutines.syncBackup({
      name: BACKUP_SCHEDULE_NAME,
      description: "Automatic backup of the shared global PostgreSQL cluster",
      agentId: "",
      trigger: { type: "cron", cronExpression: schedule },
      command: "fn backup --create",
      enabled: true,
    });
  }

  const routines = await routineStore.listRoutines();
  const existingRoutine = routines.find((routine) => routine.name === BACKUP_SCHEDULE_NAME);
  if (!settings.autoBackupEnabled) {
    if (existingRoutine) await routineStore.deleteRoutine(existingRoutine.id);
    return undefined;
  }
  const input = {
    name: BACKUP_SCHEDULE_NAME,
    description: "Automatic backup of the shared global PostgreSQL cluster",
    agentId: "", trigger: { type: "cron" as const, cronExpression: schedule },
    command: "fn backup --create", enabled: true, scope: "project" as const,
  };
  if (existingRoutine) return routineStore.updateRoutine(existingRoutine.id, { trigger: input.trigger, command: input.command, enabled: true });
  return routineStore.createRoutine(input);
}
