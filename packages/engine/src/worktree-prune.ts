import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";

import type { RunAuditor } from "./run-audit.js";

const execAsync = promisify(exec);
const PRUNE_TIMEOUT_MS = 30_000;
const PRUNE_MAX_BUFFER = 10 * 1024 * 1024;

type PruneAuditPayload = {
  success: boolean;
  reason: string;
  target?: string;
  error?: string;
};

export type PruneWorktreeAdminEntriesOptions = {
  rootDir: string;
  auditor?: Pick<RunAuditor, "git">;
  reason: string;
  target?: string;
  logger?: { log: (m: string) => void };
};

async function emitAudit(
  opts: PruneWorktreeAdminEntriesOptions,
  metadata: PruneAuditPayload,
): Promise<void> {
  await opts.auditor?.git({
    type: "worktree:admin-entry-pruned",
    target: opts.target ?? opts.rootDir,
    metadata,
  });
}

export async function pruneWorktreeAdminEntries(opts: PruneWorktreeAdminEntriesOptions): Promise<void> {
  try {
    await execAsync("git worktree prune", {
      cwd: opts.rootDir,
      timeout: PRUNE_TIMEOUT_MS,
      maxBuffer: PRUNE_MAX_BUFFER,
      encoding: "utf-8",
    });

    opts.logger?.log?.(
      `[worktree-prune] git worktree prune succeeded (reason=${opts.reason}${opts.target ? ` target=${opts.target}` : ""})`,
    );
    await emitAudit(opts, {
      success: true,
      reason: opts.reason,
      target: opts.target,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    opts.logger?.log?.(
      `[worktree-prune] git worktree prune failed (reason=${opts.reason}${opts.target ? ` target=${opts.target}` : ""}): ${errorMessage}`,
    );
    await emitAudit(opts, {
      success: false,
      reason: opts.reason,
      target: opts.target,
      error: errorMessage,
    });
  }
}

export function pruneWorktreeAdminEntriesSync(opts: PruneWorktreeAdminEntriesOptions): void {
  try {
    execSync("git worktree prune", {
      cwd: opts.rootDir,
      timeout: PRUNE_TIMEOUT_MS,
      maxBuffer: PRUNE_MAX_BUFFER,
      encoding: "utf-8",
    });

    opts.logger?.log?.(
      `[worktree-prune] git worktree prune (sync) succeeded (reason=${opts.reason}${opts.target ? ` target=${opts.target}` : ""})`,
    );
    void emitAudit(opts, {
      success: true,
      reason: opts.reason,
      target: opts.target,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    opts.logger?.log?.(
      `[worktree-prune] git worktree prune (sync) failed (reason=${opts.reason}${opts.target ? ` target=${opts.target}` : ""}): ${errorMessage}`,
    );
    void emitAudit(opts, {
      success: false,
      reason: opts.reason,
      target: opts.target,
      error: errorMessage,
    });
  }
}
