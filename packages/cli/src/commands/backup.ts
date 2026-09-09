import {
  BackupManager,
  createBackupManager,
  runBackupCommand,
  resolveGlobalBackupRoot,
} from "@fusion/core";
import { resolveProject, createLocalStore, closeProjectStore, asLocalProjectContext, type ProjectContext } from "../project-context.js";
import { retryOnLock, LockRetryExhaustedError } from "../lock-retry.js";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7739 audit finding: `resolveBackupStore` resolves a `TaskStore` (cached
 * via `resolveProject`, OR an UNCACHED `new TaskStore(process.cwd())`
 * CWD-fallback) and, before this change, no `runBackup*` handler ever closed
 * it — a leaked SQLite/WAL handle keeps the CLI process's event loop alive
 * after the command's real work (a filesystem backup operation) is done.
 * The only board interaction in this file is the `getSettings()` read used
 * to build the `BackupManager`; it did not retry through a momentary
 * `database is locked`. This mirrors the class FN-7731 fixed for `fn task
 * show`/`move` and FN-7738 fixed for `fn branch-group`/`fn pr`; the fix
 * below reuses the SAME `retryOnLock`/`closeProjectStore` helpers (no
 * forked second implementation). The resolved store is closed on every exit
 * path — success return, restore-failure `process.exit(1)`, and both
 * `runBackupCreate` `process.exit()` paths (closed explicitly BEFORE the
 * exit call, since a pending `finally` does not run after `process.exit()`
 * — see project memory) — including the uncached CWD-fallback branch via
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

/**
 * Find the project root and create a backup manager.
 */
async function getBackupManager(projectName?: string): Promise<{
  manager: BackupManager;
  context: ProjectContext;
  fusionDir: string;
}> {
  const context = await resolveBackupContext(projectName);
  try {
    const { store } = context;
    // Access the private fusionDir property via type assertion
    const fusionDir = resolveGlobalBackupRoot(store);
    const settings = await retryOnLock(async () => store.getSettings(), { id: "backup-settings", action: "read settings" });
    const manager = createBackupManager(fusionDir, settings);
    return { manager, context, fusionDir };
  } catch (error) {
    // Settings-read exhaustion must not strand the resolved store unclosed —
    // close it here since the caller never receives `context` on throw.
    await closeProjectStore(context);
    throw error;
  }
}

async function failBackupCommand(error: unknown, context?: ProjectContext): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (context) {
    await closeProjectStore(context);
  }
  return process.exit(1);
}

/**
 * Create a database backup immediately.
 * Usage: fn backup --create
 */
export async function runBackupCreate(projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getBackupManager(projectName);
    context = resolved.context;
    const { fusionDir, context: ctx } = resolved;
    const settings = await retryOnLock(async () => ctx.store.getSettings(), { id: "backup-settings", action: "read settings" });

    console.log("Creating database backup...");

    const result = await runBackupCommand(fusionDir, settings);

    await closeProjectStore(ctx);
    if (result.success) {
      console.log(result.output);
      process.exit(0);
    } else {
      console.error(result.output);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBackupCommand(error, context);
    } else if (context) {
      // FNXC:CliBoardMutation 2026-07-09-00:10:
      // A non-lock exception thrown after `getBackupManager` resolved (e.g.
      // `runBackupCommand` itself throwing on an unexpected filesystem
      // failure, rather than returning `{success:false}`) previously fell
      // through to `throw error` WITHOUT closing the resolved store — the
      // only close call on this path was gated behind
      // `LockRetryExhaustedError`. Close it here too so every exit path
      // (lock-exhaustion, generic exception, and the two explicit
      // process.exit() success/failure branches above) releases the store.
      await closeProjectStore(context);
    }
    throw error;
  }
}

/**
 * List all database backups.
 * Usage: fn backup --list
 */
export async function runBackupList(projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getBackupManager(projectName);
    context = resolved.context;
    const { manager } = resolved;

    const pairs = await manager.listBackupPairs();

    if (pairs.length === 0) {
      console.log("No backups found.");
      return;
    }

    const totalSize = pairs.reduce((sum, pair) => sum + (pair.project?.size ?? 0) + (pair.central?.size ?? 0) + (pair.migrations?.size ?? 0), 0);
    const formattedTotal = formatBytes(totalSize);

    console.log("Date                      Size      Filename");
    console.log("-".repeat(60));

    for (const pair of pairs) {
      if (pair.project) {
        const date = formatListDate(pair.project.createdAt);
        const pairSize = formatBytes((pair.project?.size ?? 0) + (pair.central?.size ?? 0) + (pair.migrations?.size ?? 0)).padEnd(10);
        const noSibling = pair.central ? (pair.migrations ? "" : "   (migration bookkeeping unavailable)") : "   (no central sibling)";
        console.log(`${date}  ${pairSize}  ${pair.project.filename}${noSibling}`);
        if (pair.central) console.log(`${" ".repeat(28)}${formatBytes(pair.central.size).padEnd(10)}  └─ ${pair.central.filename}`);
        if (pair.migrations) console.log(`${" ".repeat(28)}${formatBytes(pair.migrations.size).padEnd(10)}  └─ ${pair.migrations.filename}`);
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
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBackupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

/**
 * Restore database from a backup file.
 * Usage: fn backup --restore <filename>
 */
export async function runBackupRestore(filename: string, projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getBackupManager(projectName);
    context = resolved.context;
    const { manager } = resolved;

    console.log(`Restoring PostgreSQL backup: ${filename}`);
    console.log("A retained project/archive + central + migration-bookkeeping pre-restore stem will be created first.");
    console.log("Migration bookkeeping is restored with project/archive data when the selected stem contains it; central-only and legacy restores leave it unchanged.\n");

    try {
      const result = await manager.restoreBackup(filename, { createPreRestoreBackup: true });
      if (result.restored.length === 2) {
        console.log(`Successfully restored project/archive and central schemas from the selected dump pair.`);
      } else if (result.restored[0] === "central") {
        console.log(`Successfully restored the central schema from ${filename}`);
      } else {
        console.log(`Successfully restored the project/archive schemas from ${filename}`);
      }
      console.log(`Migration bookkeeping: ${result.migrationBookkeeping}.`);
      if (result.preRestoreBackup?.project && result.preRestoreBackup.central) {
        const migrations = result.preRestoreBackup.migrations ? ` + ${result.preRestoreBackup.migrations.filename}` : "";
        console.log(`Retained pre-restore dumps: ${result.preRestoreBackup.project.filename} + ${result.preRestoreBackup.central.filename}${migrations}`);
      }
    } catch (err) {
      console.error(`Restore failed: ${(err as Error).message}`);
      await closeProjectStore(context);
      context = undefined;
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBackupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
  }
}

/**
 * Remove old backups exceeding retention limit.
 * Usage: fn backup --cleanup
 */
export async function runBackupCleanup(projectName?: string): Promise<void> {
  let context: ProjectContext | undefined;
  try {
    const resolved = await getBackupManager(projectName);
    context = resolved.context;
    const { manager } = resolved;

    console.log("Cleaning up old backups...");

    const deletedCount = await manager.cleanupOldBackups();

    if (deletedCount > 0) {
      console.log(`Removed ${deletedCount} old backup(s) and any paired central backup files.`);
    } else {
      console.log("No backups to clean up (within retention limit).");
    }
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await failBackupCommand(error, context);
    }
    throw error;
  } finally {
    if (context) {
      await closeProjectStore(context);
    }
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
