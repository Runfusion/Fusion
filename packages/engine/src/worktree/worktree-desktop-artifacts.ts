import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

export const DESKTOP_ARTIFACT_RELATIVE_PATHS = ["packages/desktop/dist", "packages/desktop/dist-electron"] as const;

type CleanupLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export async function removeDesktopBuildArtifacts(
  worktreePath: string,
  logger?: CleanupLogger,
): Promise<{ removed: string[]; skipped: string[]; failures: Array<{ path: string; error: string }> }> {
  const removed: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  if (!worktreePath) {
    logger?.warn?.("Desktop artifact cleanup skipped: missing worktree path");
    return { removed, skipped, failures };
  }

  for (const relativePath of DESKTOP_ARTIFACT_RELATIVE_PATHS) {
    const absolutePath = resolve(worktreePath, relativePath);
    if (!existsSync(absolutePath)) {
      skipped.push(relativePath);
      continue;
    }

    try {
      await rm(absolutePath, { recursive: true, force: true });
      removed.push(relativePath);
      logger?.log?.(`Removed desktop build artifact directory: ${relativePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ path: relativePath, error: message });
      logger?.warn?.(`Failed to remove desktop build artifact directory ${relativePath}: ${message}`);
    }
  }

  return { removed, skipped, failures };
}
