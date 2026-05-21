import {
  BackupManager,
  createBackupManager,
  runBackupCommand,
  TaskStore,
} from "@fusion/core";
import { resolveProject } from "../project-context.js";

async function resolveBackupStore(projectName?: string): Promise<TaskStore> {
  try {
    return (await resolveProject(projectName)).store;
  } catch {
    const store = new TaskStore(process.cwd());
    await store.init();
    return store;
  }
}

/**
 * Find the project root and create a backup manager.
 */
async function getBackupManager(projectName?: string): Promise<{
  manager: BackupManager;
  store: TaskStore;
  fusionDir: string;
}> {
  const store = await resolveBackupStore(projectName);
  // Access the private fusionDir property via type assertion
  const fusionDir = (store as unknown as { fusionDir: string }).fusionDir;
  const settings = await store.getSettings();
  const manager = createBackupManager(fusionDir, settings);
  return { manager, store, fusionDir };
}

/**
 * Create a database backup immediately.
 * Usage: fn backup --create
 */
export async function runBackupCreate(projectName?: string): Promise<void> {
  const { fusionDir, store } = await getBackupManager(projectName);
  const settings = await store.getSettings();
  
  console.log("Creating database backup...");
  
  const result = await runBackupCommand(fusionDir, settings);
  
  if (result.success) {
    console.log(result.output);
    process.exit(0);
  } else {
    console.error(result.output);
    process.exit(1);
  }
}

/**
 * List all database backups.
 * Usage: fn backup --list
 */
export async function runBackupList(projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  const pairs = await manager.listBackupPairs();

  if (pairs.length === 0) {
    console.log("No backups found.");
    return;
  }

  const totalSize = pairs.reduce((sum, pair) => sum + (pair.project?.size ?? 0) + (pair.central?.size ?? 0), 0);
  const formattedTotal = formatBytes(totalSize);

  console.log("Date                      Size      Filename");
  console.log("-".repeat(60));

  for (const pair of pairs) {
    if (pair.project) {
      const date = formatListDate(pair.project.createdAt);
      const pairSize = formatBytes((pair.project?.size ?? 0) + (pair.central?.size ?? 0)).padEnd(10);
      const noSibling = pair.central ? "" : "   (no central sibling)";
      console.log(`${date}  ${pairSize}  ${pair.project.filename}${noSibling}`);
      if (pair.central) {
        console.log(`${" ".repeat(28)}${formatBytes(pair.central.size).padEnd(10)}  └─ ${pair.central.filename}`);
      }
      continue;
    }

    if (pair.central) {
      const date = formatListDate(pair.central.createdAt);
      const size = formatBytes(pair.central.size).padEnd(10);
      console.log(`${date}  ${size}  ${pair.central.filename}   (orphan central backup)`);
    }
  }

  console.log("-".repeat(60));
  console.log(`Total: ${formattedTotal}`);
}

/**
 * Restore database from a backup file.
 * Usage: fn backup --restore <filename>
 */
export async function runBackupRestore(filename: string, projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  console.log(`Restoring backup: ${filename}`);
  console.log("A pre-restore backup will be created first.\n");
  
  try {
    await manager.restoreBackup(filename, { createPreRestoreBackup: true });
    if (filename.startsWith("fusion-central-")) {
      console.log(`Successfully restored central database from ${filename}`);
      console.log("Created pre-restore snapshot: fusion-central-pre-restore-<timestamp>.db");
    } else {
      console.log(`Successfully restored project database from ${filename}`);
      console.log("Created pre-restore snapshots: fusion-pre-restore-<timestamp>.db and (if paired) fusion-central-pre-restore-<timestamp>.db");
    }
  } catch (err) {
    console.error(`Restore failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Remove old backups exceeding retention limit.
 * Usage: fn backup --cleanup
 */
export async function runBackupCleanup(projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  console.log("Cleaning up old backups...");
  
  const deletedCount = await manager.cleanupOldBackups();
  
  if (deletedCount > 0) {
    console.log(`Removed ${deletedCount} old backup(s) and any paired central backup files.`);
  } else {
    console.log("No backups to clean up (within retention limit).");
  }
}

/**
 * Format bytes as human-readable string.
 */
function formatListDate(iso: string): string {
  const d = new Date(iso);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
