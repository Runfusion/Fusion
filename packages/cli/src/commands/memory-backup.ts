import {
  createMemoryBackupManager,
  runMemoryBackupCommand,
  TaskStore,
  type ProjectSettings,
} from "@fusion/core";
import { resolveProject, createLocalStore } from "../project-context.js";

type MemoryBackupScope = "project" | "agents" | "all";

async function resolveBackupStore(projectName?: string): Promise<TaskStore> {
  try {
    return (await resolveProject(projectName)).store;
  } catch {
    // FNXC:PostgresCutover 2026-07-05-12:00: the cwd fallback must boot through
    // the PostgreSQL startup factory (createLocalStore); a bare `new TaskStore`
    // resolves to the removed SQLite runtime, which throws on first DB access.
    return createLocalStore(process.cwd());
  }
}

async function getMemoryBackupContext(projectName?: string): Promise<{
  store: TaskStore;
  fusionDir: string;
  settings: ProjectSettings;
}> {
  const store = await resolveBackupStore(projectName);
  const fusionDir = (store as unknown as { fusionDir: string }).fusionDir;
  const settings = await store.getSettings();
  return { store, fusionDir, settings };
}

export async function runMemoryBackupCreate(options?: { projectName?: string; scope?: MemoryBackupScope }): Promise<void> {
  const { fusionDir, settings } = await getMemoryBackupContext(options?.projectName);
  const effectiveSettings = options?.scope ? { ...settings, memoryBackupScope: options.scope } : settings;

  console.log("Creating memory backup...");
  const result = await runMemoryBackupCommand(fusionDir, effectiveSettings);
  if (result.success) {
    console.log(result.output);
    process.exit(0);
  }
  console.error(result.output);
  process.exit(1);
}

export async function runMemoryBackupList(projectName?: string): Promise<void> {
  const { fusionDir, settings } = await getMemoryBackupContext(projectName);
  const manager = createMemoryBackupManager(fusionDir, settings);
  const backups = await manager.listBackups();

  if (backups.length === 0) {
    console.log("No memory backups found.");
    return;
  }

  console.log(`Found ${backups.length} memory backup(s):\n`);
  console.log("Date                      Scope    Entries  Size      Filename");
  console.log("-".repeat(80));

  let totalSize = 0;
  for (const backup of backups) {
    totalSize += backup.size;
    const date = new Date(backup.createdAt).toLocaleString();
    const scope = backup.scope.padEnd(7);
    const entries = String(backup.entryCount).padEnd(7);
    const size = formatBytes(backup.size).padEnd(9);
    console.log(`${date}  ${scope}  ${entries}  ${size} ${backup.filename}`);
  }

  console.log("-".repeat(80));
  console.log(`Total: ${formatBytes(totalSize)}`);
}

export async function runMemoryBackupRestore(filename: string, projectName?: string): Promise<void> {
  const { fusionDir, settings } = await getMemoryBackupContext(projectName);
  const manager = createMemoryBackupManager(fusionDir, settings);

  console.log(`Restoring memory backup: ${filename}`);
  console.log("This may overwrite project and/or agent memory files.\n");

  try {
    await manager.restoreBackup(filename, { overwrite: true });
    console.log(`Successfully restored memory from ${filename}`);
  } catch (err) {
    console.error(`Memory restore failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
