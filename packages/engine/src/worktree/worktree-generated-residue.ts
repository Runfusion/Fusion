import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rename, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { formatError } from "../logger.js";

const execAsync = promisify(exec);

/**
 * Create (or resolve) a direct child directory of a canonical parent, refusing
 * to follow symlinked ancestors or escape the parent. Recovery/containment
 * paths that cross into unowned locations must fail closed before any
 * preserve/rename moves orphan contents.
 */
export async function ensureContainedDirectory(parentCanonicalPath: string, name: string): Promise<string> {
  const candidate = join(parentCanonicalPath, name);
  try {
    await mkdir(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalCandidate = await realpath(candidate);
  const candidateRelative = relative(parentCanonicalPath, canonicalCandidate);
  if (candidateRelative === "" || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
    throw new Error(`Refusing to use recovery directory outside ${parentCanonicalPath}: ${canonicalCandidate}`);
  }
  if (!(await stat(canonicalCandidate)).isDirectory()) {
    throw new Error(`Refusing to use non-directory recovery path: ${canonicalCandidate}`);
  }
  return canonicalCandidate;
}

/**
 * Preserve git-ignored generated residue (node_modules, dist) of a worktree
 * being reclaimed, by moving it into the Fusion recovery area instead of
 * deleting it. Removal probes include `--ignored`, so any ignored content
 * would otherwise refuse the reclaim and strand the worktree forever — yet the
 * directory may still hold user-authored files, so nothing is ever deleted.
 *
 * Tracked or otherwise non-ignored content is user content: it is preserved in
 * place and the caller's dirty probe fails closed below. Any failure preserves
 * in place too.
 */
export async function preserveGeneratedResidue(
  worktreePath: string,
  rootDir: string,
  logger?: { warn: (m: string) => void },
): Promise<() => Promise<void>> {
  const moved: Array<{ source: string; preserved: string }> = [];
  for (const name of ["node_modules", "dist"] as const) {
    const path = join(worktreePath, name);
    if (!existsSync(path)) continue;
    try {
      await execAsync(`git check-ignore -q -- ${JSON.stringify(name)}`, { cwd: worktreePath });
    } catch {
      // Tracked or otherwise non-ignored content is user content: preserve it in
      // place and let removeWorktree's dirty probe fail closed below.
      continue;
    }
    try {
      const canonicalRoot = await realpath(rootDir);
      const fusionRoot = await ensureContainedDirectory(canonicalRoot, ".fusion");
      const recoveryRoot = await ensureContainedDirectory(fusionRoot, "recovery");
      const worktreesRecovery = await ensureContainedDirectory(recoveryRoot, "worktrees");
      const preservedPath = join(worktreesRecovery, `residue-${randomUUID()}`);
      await rename(path, preservedPath);
      moved.push({ source: path, preserved: preservedPath });
    } catch (error) {
      // Preserve in place on any failure; removeWorktree's dirty probe fails closed.
      logger?.warn(`Failed to preserve generated residue at ${path}: ${formatError(error).message}`);
    }
  }
  return async () => {
    const failures: string[] = [];
    // Greptile: attempt EVERY moved entry so a conflicted/recreating source does not
    // strand its sibling dirs in recovery; report all failures after the loop.
    for (const { source, preserved } of moved.reverse()) {
      if (!existsSync(preserved)) continue;
      if (existsSync(source)) {
        failures.push(`Failed to restore generated residue at ${source}: source was recreated`);
        continue;
      }
      try {
        await rename(preserved, source);
      } catch (error) {
        failures.push(`Failed to restore generated residue at ${source}: ${formatError(error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  };
}

/**
 * Preserve a registered worktree whose checkout ROOT can no longer be probed
 * (e.g. its `.git` pointer was lost after an interrupted cleanup). Because the
 * directory's dirty state cannot be assessed, it is never deleted: the whole
 * root is renamed into the contained recovery area and the caller prunes only
 * the admin registration entry. Fails closed — any failure throws rather than
 * falling through to deletion.
 */
export async function preserveCorruptRegisteredRoot(
  worktreePath: string,
  rootDir: string,
): Promise<string> {
  const canonicalRoot = await realpath(rootDir);
  const fusionRoot = await ensureContainedDirectory(canonicalRoot, ".fusion");
  const recoveryRoot = await ensureContainedDirectory(fusionRoot, "recovery");
  const worktreesRecovery = await ensureContainedDirectory(recoveryRoot, "worktrees");
  const preservedPath = join(worktreesRecovery, `corrupt-${randomUUID()}`);
  try {
    await rename(worktreePath, preservedPath);
  } catch (error) {
    throw new Error(`Failed to preserve corrupt registered worktree ${worktreePath} in ${preservedPath}: ${formatError(error).message}`);
  }
  return preservedPath;
}
