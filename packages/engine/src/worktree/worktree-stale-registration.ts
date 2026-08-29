import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

export function parseStaleRegistrationPath(stderrOrMessage: string): string | null {
  if (!stderrOrMessage) return null;
  const match = /'([^']+)'\s+is a missing but already registered worktree/i.exec(stderrOrMessage);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function parseWorktreeListPorcelain(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function recoverStaleRegistration(input: {
  rootDir: string;
  worktreePath: string;
  logger?: { log?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ recovered: boolean; actions: string[]; reason?: string }> {
  const actions: string[] = [];

  try {
    await execAsync("git worktree prune", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    actions.push("prune");
  } catch (error) {
    return {
      recovered: false,
      actions,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: input.rootDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const registered = parseWorktreeListPorcelain(stdout);
    const targetPath = normalizePath(input.worktreePath);
    if (!registered.some((path) => normalizePath(path) === targetPath)) {
      input.logger?.warn?.("[worktree-stale-registration] worktree not listed after prune; attempting remove --force as safety fallback");
    }
  } catch (error) {
    input.logger?.warn?.(`[worktree-stale-registration] failed to list worktrees before remove --force: ${error instanceof Error ? error.message : String(error)}`);
  }

  {
    try {
      await execAsync(`git worktree remove --force ${quoteShellArg(input.worktreePath)}`, {
        cwd: input.rootDir,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      actions.push("remove-force");
    } catch (error) {
      actions.push("remove-force");
      input.logger?.log?.(
        `[worktree-stale-registration] remove --force failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { recovered: true, actions };
}
