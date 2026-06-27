import { cp, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
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
  /**
   * Verify each backup copy with `PRAGMA quick_check` and refuse to keep or
   * rotate-in a corrupt copy. Defaults to true. Set false only where the
   * source is intentionally not a real SQLite file (e.g. unit tests).
   */
  verifyIntegrity?: boolean;
}

export class BackupManager {
  private fusionDir: string;
  private backupDir: string;
  private retention: number;
  private centralDbPath: string;
  private includeCentralDb: boolean;
  private verifyIntegrity: boolean;

  constructor(fusionDir: string, options?: BackupOptions) {
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups";
    this.retention = options?.retention ?? 7;
    this.centralDbPath = options?.centralDbPath ?? join(this.fusionDir, "..", ".fusion", "fusion-central.db");
    this.includeCentralDb = options?.includeCentralDb ?? true;
    this.verifyIntegrity = options?.verifyIntegrity ?? true;
  }

  private getBackupDirPath(): string {
    return join(this.fusionDir, "..", this.backupDir);
  }

  async createBackup(): Promise<BackupInfo> {
    const sourcePath = join(this.fusionDir, "fusion.db");
    const backupDirPath = this.getBackupDirPath();
    try {
      await mkdir(backupDirPath, { recursive: true });
    } catch (err) {
      throw new Error(formatBackupError({
        dbLabel: "project DB",
        action: "prepare backup directory",
        backupDirPath,
        cause: err,
      }));
    }

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

    try {
      await copyLiveDatabase(sourcePath, targetPath);

      // Verify the freshly-written copy. A copy of a live WAL db can capture a
      // torn/corrupt main file; refusing to keep a corrupt backup guarantees
      // that every retained `fusion-*.db` is restorable and that a corrupt copy
      // is never counted as the "last known-good" by cleanupOldBackups().
      if (this.verifyIntegrity) {
        const integrity = verifyDatabaseIntegrity(targetPath);
        if (!integrity.ok) {
          await quarantineCorruptBackup(targetPath);
          throw new Error(
            `verification failed: ${integrity.error ?? "database disk image is malformed"}. ` +
              "The source database may be corrupt; the unusable copy was quarantined as *.corrupt.",
          );
        }
      }
    } catch (err) {
      throw new Error(formatBackupError({
        dbLabel: "project DB",
        action: "create backup",
        sourcePath,
        targetPath,
        cause: err,
      }));
    }

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
      await copyLiveDatabase(this.centralDbPath, centralTargetPath);

      if (this.verifyIntegrity) {
        const centralIntegrity = verifyDatabaseIntegrity(centralTargetPath);
        if (!centralIntegrity.ok) {
          await quarantineCorruptBackup(centralTargetPath);
          throw new Error(
            `verification failed: ${centralIntegrity.error ?? "database disk image is malformed"}. ` +
              "The source database may be corrupt; the unusable copy was quarantined as *.corrupt.",
          );
        }
      }

      const centralStats = await stat(centralTargetPath);
      backup.centralBackup = {
        filename: centralFilename,
        createdAt: new Date().toISOString(),
        size: centralStats.size,
        path: centralTargetPath,
      };
    } catch (err) {
      backup.centralBackup = {
        failed: formatBackupError({
          dbLabel: "central DB",
          action: "create backup",
          sourcePath: this.centralDbPath,
          targetPath: centralTargetPath,
          cause: err,
        }),
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

    // Never rotate out the last known-good backup. The retained set is the
    // newest `retention` files, but if every one of them fails verification
    // (e.g. a run of corrupt copies from a flaky source db) we must protect the
    // newest verifiably-good backup from deletion even though it falls outside
    // the retention window. Verification is lazy: in the common case the newest
    // kept backup is good and we run exactly one check.
    if (this.verifyIntegrity) {
      const kept = sorted.slice(sorted.length - this.retention);
      const keptHasGood = kept
        .slice()
        .reverse()
        .some((b) => verifyDatabaseIntegrity(b.path).ok);
      if (!keptHasGood) {
        for (let i = toDelete.length - 1; i >= 0; i--) {
          if (verifyDatabaseIntegrity(toDelete[i].path).ok) {
            toDelete.splice(i, 1);
            break;
          }
        }
      }
    }

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

// Copy a live WAL-mode SQLite DB by snapshotting the main file plus any
// sibling -wal/-shm. SQLite replays the WAL on open, so the backup captures
// uncheckpointed pages without us opening a second connection. Previously this
// ran PRAGMA wal_checkpoint(TRUNCATE) through a fresh node:sqlite connection
// against the live DB, which actively rewrites the main file's pages — a
// node:sqlite SIGSEGV mid-checkpoint (see db.ts pager_write note) could leave
// the main file extended-but-zeroed. Plain cp avoids that blast radius.
async function copyLiveDatabase(sourcePath: string, targetPath: string): Promise<void> {
  await cp(sourcePath, targetPath, { preserveTimestamps: true });

  const walSource = `${sourcePath}-wal`;
  if (existsSync(walSource)) {
    await cp(walSource, `${targetPath}-wal`, { preserveTimestamps: true });
  }

  const shmSource = `${sourcePath}-shm`;
  if (existsSync(shmSource)) {
    await cp(shmSource, `${targetPath}-shm`, { preserveTimestamps: true });
  }
}

/**
 * Result of an on-disk SQLite integrity verification.
 *
 * `verified` distinguishes "we ran the check" from "we couldn't run it". When
 * the `sqlite3` CLI is unavailable (e.g. a packaged environment with no system
 * binary on PATH) we return `{ ok: true, verified: false }` so verification
 * degrades to a no-op rather than blocking backups or rotation.
 */
export interface DatabaseIntegrityResult {
  ok: boolean;
  verified: boolean;
  error?: string;
}

/**
 * Verify a SQLite database file with `PRAGMA quick_check`.
 *
 * Uses the `sqlite3` CLI (the same dependency the recovery path relies on) so
 * we never open the file through the live `node:sqlite` connection — opening a
 * WAL-mode copy through node:sqlite would replay/checkpoint pages and mutate
 * the very backup we are trying to validate. `quick_check` is far cheaper than
 * a full `integrity_check` but still detects the B-tree malformations
 * ("rowid out of order", "2nd reference to page") that node:sqlite SIGSEGVs
 * leave behind.
 */
export function verifyDatabaseIntegrity(dbPath: string): DatabaseIntegrityResult {
  if (!existsSync(dbPath)) {
    return { ok: false, verified: true, error: "file does not exist" };
  }

  const result = spawnSync("sqlite3", [dbPath, "PRAGMA quick_check;"], {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });

  // ENOENT (or any spawn error) means the sqlite3 binary is unavailable — we
  // cannot verify, so treat as a non-blocking pass.
  if (result.error) {
    return { ok: true, verified: false, error: result.error.message };
  }

  const stdout = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    return {
      ok: false,
      verified: true,
      error: stdout || (result.stderr ?? "").trim() || `sqlite3 exited ${result.status}`,
    };
  }

  if (stdout.toLowerCase() === "ok") {
    return { ok: true, verified: true };
  }

  return { ok: false, verified: true, error: stdout.split("\n").slice(0, 3).join(" | ") };
}

/** Move a verifiably-corrupt backup copy aside so it never masquerades as good. */
async function quarantineCorruptBackup(targetPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${targetPath}${suffix}`;
    if (!existsSync(path)) continue;
    try {
      await rename(path, `${path}.corrupt`);
    } catch {
      // Best effort — fall back to deleting so a corrupt copy is never listed.
      try {
        await unlink(path);
      } catch {
        // Ignore.
      }
    }
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
  const projectDbPath = join(fusionDir, "fusion.db");
  if (settings.autoBackupSchedule && !validateBackupSchedule(settings.autoBackupSchedule)) {
    return {
      success: false,
      output: formatBackupError({
        dbLabel: "project DB",
        action: "validate backup schedule",
        sourcePath: projectDbPath,
        cause: `invalid cron expression: ${settings.autoBackupSchedule}`,
      }),
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
      output: formatBackupError({
        dbLabel: "project DB",
        action: "run backup command",
        sourcePath: projectDbPath,
        cause: err,
      }),
    };
  }
}

/*
FNXC:DatabaseBackup 2026-06-26-12:00:
Database Backup automations are operator-facing data-safety signals. Every failure must name the affected DB, relevant path, and cause so CLI, dashboard, routine, and cron surfaces never persist a detail-less "Backup failed" result.
*/
function formatBackupError(input: {
  dbLabel: "project DB" | "central DB";
  action: string;
  sourcePath?: string;
  targetPath?: string;
  backupDirPath?: string;
  cause: unknown;
}): string {
  const parts = [`${input.dbLabel} ${input.action} failed`];
  if (input.sourcePath) parts.push(`source: ${input.sourcePath}`);
  if (input.targetPath) parts.push(`target: ${input.targetPath}`);
  if (input.backupDirPath) parts.push(`backup directory: ${input.backupDirPath}`);
  parts.push(`cause: ${describeError(input.cause)}`);
  return parts.join("; ");
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.trim() || err.name || "unknown error";
  }
  if (typeof err === "string") {
    return err.trim() || "unknown error";
  }
  if (err === null || err === undefined) {
    return "unknown error";
  }
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Fall through to String().
  }
  return String(err).trim() || "unknown error";
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
