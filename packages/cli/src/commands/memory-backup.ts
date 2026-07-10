import {
  createMemoryBackupManager,
  runMemoryBackupCommand,
  TaskStore,
  type ProjectSettings,
} from "@fusion/core";
import { resolveProject, createLocalStore, closeProjectStore, asLocalProjectContext, type ProjectContext } from "../project-context.js";
import { retryOnLock, LockRetryExhaustedError } from "../lock-retry.js";

type MemoryBackupScope = "project" | "agents" | "all";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7739 audit finding: same shape as `backup.ts` — `resolveBackupContext`
 * resolves a `TaskStore` (cached via `resolveProject`, OR an UNCACHED
 * `new TaskStore(process.cwd())` CWD-fallback) that no `runMemoryBackup*`
 * handler ever closed, leaking a SQLite/WAL handle that keeps the CLI
 * process's event loop alive. The only board interaction is the
 * `getSettings()` read; it did not retry through a momentary `database is
 * locked`. Fix reuses the FN-7731/FN-7738 `retryOnLock`/`closeProjectStore`
 * helpers — no forked implementation. Store closed on every exit path
 * (success return, restore-failure `process.exit(1)`, and both
 * `runMemoryBackupCreate` `process.exit()` paths, closed BEFORE the exit
 * call per project memory), including the uncached CWD-fallback branch via
 * `asLocalProjectContext`.
 */
async function resolveBackupContext(projectName?: string): Promise<ProjectContext> {
  try {
    return await resolveProject(projectName);
  } catch {
    // FNXC:PostgresCutover 2026-07-05-12:00: the cwd fallback must boot through
    // the PostgreSQL startup factory (createLocalStore); a bare `new TaskStore`
    // resolves to the removed SQLite runtime, which throws on first DB access.
    const store = await createLocalStore(process.cwd());
    return asLocalProjectContext(store);
  }
}

async function getMemoryBackupContext(projectName?: string): Promise<{
  context: ProjectContext;
  fusionDir: string;
  settings: ProjectSettings;
}> {
  const context = await resolveBackupContext(projectName);
  try {
    const fusionDir = (context.store as unknown as { fusionDir: string }).fusionDir;
    const settings = await retryOnLock(async () => context.store.getSettings(), { id: "memory-backup-settings", action: "read settings" });
    return { context, fusionDir, settings };
  } catch (error) {
    // Settings-read exhaustion must not strand the resolved store unclosed —
    // close it here since the caller never receives `context` on throw.
    await closeProjectStore(context);
    throw error;
  }
}

async function failMemoryBackupCommand(error: unknown, context?: ProjectContext): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (context) {
    await closeProjectStore(context);
  }
  return process.exit(1);
}

export async function runMemoryBackupCreate(options?: { projectName?: string; scope?: MemoryBackupScope }): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getMemoryBackupContext(options?.projectName);
    context = resolved.context;
    const { fusionDir, settings } = resolved;
    const effectiveSettings = options?.scope ? { ...settings, memoryBackupScope: options.scope } : settings;

    console.log("Creating memory backup...");
    const result = await runMemoryBackupCommand(fusionDir, effectiveSettings);
    await closeProjectStore(context);
    if (result.success) {
      console.log(result.output);
      process.exit(0);
    }
    console.error(result.output);
    process.exit(1);
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failMemoryBackupCommand(error, context);
    } else if (context) {
      // FNXC:CliBoardMutation 2026-07-09-00:10:
      // A non-lock exception thrown after `getMemoryBackupContext` resolved
      // (e.g. `runMemoryBackupCommand` itself throwing rather than
      // returning `{success:false}`) previously fell through to `throw
      // error` WITHOUT closing the resolved store — the only close call on
      // this path was gated behind `LockRetryExhaustedError`. Close it here
      // too so every exit path releases the store.
      await closeProjectStore(context);
    }
    throw error;
  }
}

export async function runMemoryBackupList(projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getMemoryBackupContext(projectName);
    context = resolved.context;
    const { fusionDir, settings } = resolved;
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
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failMemoryBackupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

export async function runMemoryBackupRestore(filename: string, projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getMemoryBackupContext(projectName);
    context = resolved.context;
    const { fusionDir, settings } = resolved;
    const manager = createMemoryBackupManager(fusionDir, settings);

    console.log(`Restoring memory backup: ${filename}`);
    console.log("This may overwrite project and/or agent memory files.\n");

    try {
      await manager.restoreBackup(filename, { overwrite: true });
      console.log(`Successfully restored memory from ${filename}`);
    } catch (err) {
      console.error(`Memory restore failed: ${(err as Error).message}`);
      await closeProjectStore(context);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failMemoryBackupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
