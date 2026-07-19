/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Branch-ahead-of-base probe peeled from self-healing.ts.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Task } from "@fusion/core";
import { resolveTaskWorkingBranch } from "./worktree-names.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { createLogger } from "./logger.js";

const log = createLogger("self-healing");
const execFileAsync = promisify(execFile);

export async function isBranchAheadOfBase(
  task: Task,
  rootDir: string,
  preferredBaseRef?: string,
): Promise<{ aheadCount: number; baseRef: string } | null> {
  const branchName = resolveTaskWorkingBranch(task);

  try {
    await execFileAsync("git", ["rev-parse", "--verify", branchName], {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  const requestedBaseRef = preferredBaseRef || task.mergeDetails?.mergeTargetBranch || await resolveIntegrationBranch(rootDir, undefined);
  let resolvedBaseRef = requestedBaseRef;

  try {
    await execFileAsync("git", ["rev-parse", "--verify", requestedBaseRef], {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    const remoteRef = `origin/${requestedBaseRef}`;
    try {
      await execFileAsync("git", ["rev-parse", "--verify", remoteRef], {
        cwd: rootDir,
        timeout: 30_000,
      });
      resolvedBaseRef = remoteRef;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `${resolvedBaseRef}..${branchName}`],
      { cwd: rootDir, timeout: 30_000 },
    );
    const aheadCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(aheadCount)) {
      return null;
    }
    return { aheadCount, baseRef: resolvedBaseRef };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(
      `Failed to compare ${branchName} against ${resolvedBaseRef} for ${task.id}: ${errorMessage}`,
    );
    return null;
  }
}
