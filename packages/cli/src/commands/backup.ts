import {
  BackupManager,
  createBackupManager,
  runBackupCommand,
  TaskStore,
} from "@fusion/core";
import { resolveProject } from "../project-context.js";

/**
 * Find the project root and create a backup manager.
 */
async function getBackupManager(projectName?: string): Promise<{
  manager: BackupManager;
  store: TaskStore;
  kbDir: string;
}> {
  const store = projectName 
    ? (await resolveProject(projectName)).store
    : new TaskStore(process.cwd());
  if (!projectName) {
    await store.init();
  }
  // Access the private kbDir property via type assertion
  const kbDir = (store as unknown as { kbDir: string }).kbDir;
  const settings = await store.getSettings();
  const manager = createBackupManager(kbDir, settings);
  return { manager, store, kbDir };
}

/**
 * Create a database backup immediately.
 * Usage: kb backup --create
 */
export async function runBackupCreate(projectName?: string): Promise<void> {
  const { manager, kbDir, store } = await getBackupManager(projectName);
  const settings = await store.getSettings();
  
  console.log("Creating database backup...");
  
  const result = await runBackupCommand(kbDir, settings);
  
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
 * Usage: kb backup --list
 */
export async function runBackupList(projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  const backups = await manager.listBackups();
  
  if (backups.length === 0) {
    console.log("No backups found.");
    return;
  }
  
  console.log(`Found ${backups.length} backup(s):\n`);
  
  // Calculate total size
  const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
  const formattedTotal = formatBytes(totalSize);
  
  console.log("Date                      Size     Filename");
  console.log("-".repeat(60));
  
  for (const backup of backups) {
    const date = new Date(backup.createdAt).toLocaleString();
    const size = formatBytes(backup.size).padEnd(8);
    console.log(`${date}  ${size}  ${backup.filename}`);
  }
  
  console.log("-".repeat(60));
  console.log(`Total: ${formattedTotal}`);
}

/**
 * Restore database from a backup file.
 * Usage: kb backup --restore <filename>
 */
export async function runBackupRestore(filename: string, projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  console.log(`Restoring backup: ${filename}`);
  console.log("A pre-restore backup will be created first.\n");
  
  try {
    await manager.restoreBackup(filename, { createPreRestoreBackup: true });
    console.log(`Successfully restored from ${filename}`);
    console.log("Note: The pre-restore backup was saved in case you need to undo this operation.");
  } catch (err) {
    console.error(`Restore failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Remove old backups exceeding retention limit.
 * Usage: kb backup --cleanup
 */
export async function runBackupCleanup(projectName?: string): Promise<void> {
  const { manager } = await getBackupManager(projectName);
  
  console.log("Cleaning up old backups...");
  
  const deletedCount = await manager.cleanupOldBackups();
  
  if (deletedCount > 0) {
    console.log(`Removed ${deletedCount} old backup(s).`);
  } else {
    console.log("No backups to clean up (within retention limit).");
  }
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
