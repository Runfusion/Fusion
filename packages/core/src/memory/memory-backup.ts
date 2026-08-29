import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ProjectSettings } from "../types.js";
import { MEMORY_WORKSPACE_PATH } from "./memory-backend.js";
import { validateBackupSchedule } from "../backup/backup.js";

export const MEMORY_BACKUP_SCHEDULE_NAME = "Memory Backup";
const AGENT_MEMORY_ROOT = ".fusion/agent-memory";

type MemoryBackupScope = "project" | "agents" | "all";

export interface MemoryBackupInfo {
  filename: string;
  createdAt: string;
  size: number;
  path: string;
  scope: MemoryBackupScope;
  entryCount: number;
}

export interface MemoryBackupOptions {
  backupDir?: string;
  retention?: number;
  scope?: MemoryBackupScope;
}

export class MemoryBackupManager {
  private fusionDir: string;
  private backupDir: string;
  private retention: number;
  private scope: MemoryBackupScope;

  constructor(fusionDir: string, options?: MemoryBackupOptions) {
    this.fusionDir = fusionDir;
    this.backupDir = options?.backupDir ?? ".fusion/backups/memory";
    this.retention = options?.retention ?? 14;
    this.scope = options?.scope ?? "all";
  }

  private getProjectRoot(): string {
    return resolve(this.fusionDir, "..");
  }

  private getBackupDirPath(): string {
    return resolve(this.getProjectRoot(), this.backupDir);
  }

  private async collectSources() {
    const root = this.getProjectRoot();
    const projectPath = join(root, MEMORY_WORKSPACE_PATH);
    const agentsPath = join(root, AGENT_MEMORY_ROOT);
    const includeProject = this.scope !== "agents";
    const includeAgents = this.scope !== "project";
    const sources: Array<{ source: string; target: string }> = [];

    if (includeProject && existsSync(projectPath)) {
      sources.push({ source: projectPath, target: "project" });
    }
    if (includeAgents && existsSync(agentsPath)) {
      sources.push({ source: agentsPath, target: "agents" });
    }

    if (sources.length === 0) {
      throw new Error(`No memory sources found for scope '${this.scope}' (.fusion/memory or .fusion/agent-memory)`);
    }

    return sources;
  }

  async createBackup(): Promise<MemoryBackupInfo> {
    const backupDirPath = this.getBackupDirPath();
    await mkdir(backupDirPath, { recursive: true });

    const sources = await this.collectSources();
    const baseName = `memory-${formatTimestamp(new Date())}`;

    let filename = baseName;
    let finalPath = join(backupDirPath, filename);
    let tmpPath = `${finalPath}.tmp`;
    let counter = 1;

    while (existsSync(finalPath) || existsSync(tmpPath)) {
      filename = `${baseName}-${counter}`;
      finalPath = join(backupDirPath, filename);
      tmpPath = `${finalPath}.tmp`;
      counter++;
    }

    try {
      await mkdir(tmpPath, { recursive: true });
      for (const { source, target } of sources) {
        const targetPath = join(tmpPath, target);
        await cp(source, targetPath, { recursive: true, preserveTimestamps: true });
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      await rm(tmpPath, { recursive: true, force: true });
      throw error;
    }

    return this.buildInfo(filename, finalPath);
  }

  async listBackups(): Promise<MemoryBackupInfo[]> {
    const backupDirPath = this.getBackupDirPath();
    try {
      const entries = await readdir(backupDirPath);
      const backups: MemoryBackupInfo[] = [];
      for (const entry of entries) {
        if (!entry.match(/^memory-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?$/)) continue;
        const fullPath = join(backupDirPath, entry);
        const st = await stat(fullPath);
        if (!st.isDirectory()) continue;
        backups.push(await this.buildInfo(entry, fullPath));
      }
      return backups.sort((a, b) => {
        const timeCompare = b.createdAt.localeCompare(a.createdAt);
        if (timeCompare !== 0) return timeCompare;
        return b.filename.localeCompare(a.filename);
      });
    } catch {
      return [];
    }
  }

  async cleanupOldBackups(): Promise<number> {
    const backups = await this.listBackups();
    if (backups.length <= this.retention) return 0;
    const sorted = [...backups].sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      if (timeCompare !== 0) return timeCompare;
      return a.filename.localeCompare(b.filename);
    });
    const toDelete = sorted.slice(0, sorted.length - this.retention);
    let deleted = 0;
    for (const backup of toDelete) {
      try {
        await rm(backup.path, { recursive: true, force: true });
        deleted++;
      } catch {
        // ignore
      }
    }
    return deleted;
  }

  async restoreBackup(filename: string, opts?: { overwrite?: boolean }): Promise<void> {
    const backupRoot = join(this.getBackupDirPath(), filename);
    const sourceProject = join(backupRoot, "project");
    const sourceAgents = join(backupRoot, "agents");

    const hasProject = existsSync(sourceProject);
    const hasAgents = existsSync(sourceAgents);
    if (!hasProject && !hasAgents) {
      throw new Error(`Memory backup not found or empty: ${filename}`);
    }

    if (hasProject) {
      await this.restoreTree(sourceProject, join(this.getProjectRoot(), MEMORY_WORKSPACE_PATH), opts?.overwrite === true);
    }
    if (hasAgents) {
      await this.restoreTree(sourceAgents, join(this.getProjectRoot(), AGENT_MEMORY_ROOT), opts?.overwrite === true);
    }
  }

  private async restoreTree(sourceDir: string, destinationDir: string, overwrite: boolean): Promise<void> {
    const files = await listFilesRecursive(sourceDir);
    for (const file of files) {
      const rel = relative(sourceDir, file);
      const destFile = join(destinationDir, rel);
      await mkdir(dirname(destFile), { recursive: true });

      if (existsSync(destFile) && !overwrite) {
        const [srcBuf, dstBuf] = await Promise.all([readFile(file), readFile(destFile)]);
        if (!srcBuf.equals(dstBuf)) {
          throw new Error(`Restore would overwrite modified memory file: ${destFile}`);
        }
        continue;
      }

      const tmp = `${destFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const content = await readFile(file);
      await writeFile(tmp, content);
      await rename(tmp, destFile);
    }
  }

  private async buildInfo(filename: string, fullPath: string): Promise<MemoryBackupInfo> {
    const stats = await stat(fullPath);
    const sizeAndCount = await getDirectoryStats(fullPath);
    const match = filename.match(/^memory-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/);
    const createdAt = match
      ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
      : stats.mtime.toISOString();
    const hasProject = existsSync(join(fullPath, "project"));
    const hasAgents = existsSync(join(fullPath, "agents"));
    const scope: MemoryBackupScope = hasProject && hasAgents ? "all" : hasProject ? "project" : "agents";

    return {
      filename,
      createdAt,
      size: sizeAndCount.size,
      path: fullPath,
      scope,
      entryCount: sizeAndCount.entryCount,
    };
  }
}

export function createMemoryBackupManager(
  fusionDir: string,
  settings?: Partial<ProjectSettings>,
): MemoryBackupManager {
  return new MemoryBackupManager(fusionDir, {
    backupDir: sanitizeMemoryBackupDir(fusionDir, canonicalizeMemoryBackupDir(settings?.memoryBackupDir)),
    retention: settings?.memoryBackupRetention,
    scope: settings?.memoryBackupScope,
  });
}

export async function runMemoryBackupCommand(
  fusionDir: string,
  settings: ProjectSettings,
): Promise<{ success: boolean; output: string; backupPath?: string; deletedCount?: number }> {
  if (settings.memoryBackupSchedule && !validateMemoryBackupSchedule(settings.memoryBackupSchedule)) {
    return { success: false, output: `Invalid memory backup schedule: ${settings.memoryBackupSchedule}` };
  }

  const manager = createMemoryBackupManager(fusionDir, settings);
  try {
    const backup = await manager.createBackup();
    const deletedCount = await manager.cleanupOldBackups();
    const output = deletedCount > 0
      ? `Memory backup created: ${backup.filename} (${formatBytes(backup.size)}). Removed ${deletedCount} old backup(s).`
      : `Memory backup created: ${backup.filename} (${formatBytes(backup.size)})`;
    return { success: true, output, backupPath: backup.path, deletedCount };
  } catch (error) {
    return { success: false, output: `Memory backup failed: ${(error as Error).message}` };
  }
}

export const validateMemoryBackupSchedule = validateBackupSchedule;

export async function syncMemoryBackupAutomation(
  automationStore: import("../automation/automation-store.js").AutomationStore,
  settings: ProjectSettings,
): Promise<import("../automation/automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("../automation/automation-store.js");
  const schedules = await automationStore.listSchedules();
  const existing = schedules.find((s) => s.name === MEMORY_BACKUP_SCHEDULE_NAME);

  if (!settings.memoryBackupEnabled) {
    if (existing) await automationStore.deleteSchedule(existing.id);
    return undefined;
  }

  const schedule = settings.memoryBackupSchedule || "0 3 * * *";
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }

  const command = "fn memory-backup --create";
  if (existing) {
    return await automationStore.updateSchedule(existing.id, {
      scheduleType: "custom",
      cronExpression: schedule,
      command,
      enabled: true,
    });
  }

  return await automationStore.createSchedule({
    name: MEMORY_BACKUP_SCHEDULE_NAME,
    description: "Automatic memory backup based on project settings",
    scheduleType: "custom",
    cronExpression: schedule,
    command,
    enabled: true,
  });
}

export async function syncMemoryBackupRoutine(
  routineStore: import("../automation/routine-store.js").RoutineStore,
  settings: ProjectSettings,
): Promise<import("../automation/routine.js").Routine | undefined> {
  const { RoutineStore } = await import("../automation/routine-store.js");
  const routines = await routineStore.listRoutines();
  const existing = routines.find((routine) => routine.name === MEMORY_BACKUP_SCHEDULE_NAME);

  if (!settings.memoryBackupEnabled) {
    if (existing) {
      await routineStore.deleteRoutine(existing.id);
    }
    return undefined;
  }

  const schedule = settings.memoryBackupSchedule || "0 3 * * *";
  if (!RoutineStore.isValidCron(schedule)) {
    throw new Error(`Invalid backup schedule: ${schedule}`);
  }

  const command = "fn memory-backup --create";
  if (existing) {
    return await routineStore.updateRoutine(existing.id, {
      trigger: { type: "cron" as const, cronExpression: schedule },
      command,
      enabled: true,
    });
  }

  return await routineStore.createRoutine({
    name: MEMORY_BACKUP_SCHEDULE_NAME,
    description: "Automatic memory backup based on project settings",
    agentId: "",
    trigger: { type: "cron" as const, cronExpression: schedule },
    command,
    enabled: true,
    scope: "project" as const,
  });
}

function canonicalizeMemoryBackupDir(dir: string | undefined): string | undefined {
  if (dir === ".kb/backups/memory") return ".fusion/backups/memory";
  return dir;
}

function sanitizeMemoryBackupDir(fusionDir: string, dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (dir.startsWith("/") || dir.startsWith("\\") || /^[a-zA-Z]:/.test(dir) || dir.includes("..")) {
    throw new Error(`Invalid memory backup directory: ${dir}`);
  }
  const projectRoot = resolve(fusionDir, "..");
  const resolved = resolve(projectRoot, dir);
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error(`Invalid memory backup directory: ${dir}`);
  }
  return rel || ".";
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function getDirectoryStats(dir: string): Promise<{ size: number; entryCount: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  let size = 0;
  let entryCount = 0;
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await getDirectoryStats(fullPath);
      size += nested.size;
      entryCount += nested.entryCount;
      continue;
    }
    if (entry.isFile()) {
      const st = await stat(fullPath);
      size += st.size;
      entryCount++;
    }
  }
  return { size, entryCount };
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}
