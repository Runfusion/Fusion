import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rename, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { formatError } from "../logger.js";
import { WORKTREE_RECOVERY_DIRNAME } from "./worktree-paths.js";

const execAsync = promisify(exec);

const PACKAGE_MANAGER_MARKERS = [".package-lock.json", ".yarn-integrity", ".modules.yaml", ".pnpm"] as const;

// Recognized build-output shapes for dist/ top-level files. Deliberately
// excludes user-content shapes (.txt, .md, extensionless) so a hand-authored
// file beside one sourcemap fails the whole directory closed.
const DIST_BUILD_ARTIFACT_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".d.ts",
  ".tsbuildinfo",
  ".xml",
] as const;

/**
 * A git-ignored sibling (node_modules, dist) only counts as generated residue
 * worth moving ahead of the dirty probe when its contents are PROVABLY
 * generated output. A directory that merely carries a generated-looking name
 * (Greptile: residue provenance) may hold user-authored ignored content, so it
 * must NOT be moved: leaving it in place makes the removal's dirty probe fail
 * closed and the checkout stays valid. Returns true only for structure that
 * cannot be hand-authored in any realistic sense.
 *
 * A SINGLE recognized marker must not classify a MIXED directory as generated
 * (Greptile: "Mixed residue bypasses validation"). When a marker sits next to
 * user-authored ignored content, EVERY entry must still look generated, or the
 * directory is left in place so the dirty probe refuses the removal.
 */
async function looksGeneratedResidue(worktreePath: string, name: string): Promise<boolean> {
  const dir = join(worktreePath, name);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  if (name === "node_modules") {
    // A real dependency install always carries a package-manager marker or at
    // least one installed package subdir with its own manifest. Require EVERY
    // top-level entry to be a known marker or a package dir; any stray plain
    // file or unknown directory next to a marker fails closed.
    let sawInstallEvidence = false;
    for (const entry of entries) {
      if ((PACKAGE_MANAGER_MARKERS as readonly string[]).includes(entry)) {
        sawInstallEvidence = true;
        continue;
      }
      let sub: string[];
      try {
        sub = await readdir(join(dir, entry));
      } catch {
        // A top-level plain file (not a marker) is user content: fail closed.
        return false;
      }
      if (sub.includes("package.json")) {
        sawInstallEvidence = true;
        continue;
      }
      // Scoped package dirs (@scope/pkg) hold package.json one level deeper.
      if (entry.startsWith("@")) {
        let scoped = false;
        for (const scopeEntry of sub) {
          try {
            if ((await readdir(join(dir, entry, scopeEntry))).includes("package.json")) {
              scoped = true;
              break;
            }
          } catch {
            // ignore unreadable scope entries; fall through
          }
        }
        if (scoped) {
          sawInstallEvidence = true;
          continue;
        }
      }
      // A directory that is neither a marker nor a package dir may be
      // user-authored ignored content: fail closed.
      return false;
    }
    return sawInstallEvidence && entries.length > 0;
  }
  if (name === "dist") {
    // Build output carries a sourcemap or a build manifest. Require EVERY entry
    // to be a build artifact or a manifest; any other file fails closed.
    const hasBuildEvidence =
      entries.some((entry) => entry.endsWith(".map")) || entries.includes("package.json");
    if (!hasBuildEvidence) return false;
    for (const entry of entries) {
      if (entry.endsWith(".map") || entry === "package.json") continue;
      if (DIST_BUILD_ARTIFACT_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      // A file that is not a recognized build artifact may be user-authored
      // ignored content (e.g. `user-notes.txt` next to `bundle.js.map`).
      return false;
    }
    return entries.length > 0;
  }
  return false;
}

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
): Promise<(removedSuccessfully?: boolean) => Promise<void>> {
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
    // Greptile (residue provenance): a git-ignored sibling only earns moving
    // ahead of the dirty probe when it is PROVABLY generated output. A merely
    // generated-looking dir may hold user-authored ignored files; leaving it
    // in place fails the removal cleanly and keeps the checkout valid.
    if (!(await looksGeneratedResidue(worktreePath, name))) continue;
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
  return async (removedSuccessfully = false) => {
    if (removedSuccessfully) {
      // Greptile (find: residue discarded on success): the preserved directory may hold
      // user-authored ignored files beneath node_modules/dist. It is moved to the
      // CONTAINED recovery area (never deleted) so a reclaim proceeds without destroying
      // those recoverable files. On successful removal there is no source to restore
      // into, so the residue simply remains in recovery for manual recovery rather than
      // being recursively discarded.
      return;
    }
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
  worktreesRoot?: string,
  renameDirectory: typeof rename = rename,
): Promise<string> {
  const canonicalRoot = await realpath(rootDir);
  const fusionRoot = await ensureContainedDirectory(canonicalRoot, ".fusion");
  const recoveryRoot = await ensureContainedDirectory(fusionRoot, "recovery");
  const worktreesRecovery = await ensureContainedDirectory(recoveryRoot, "worktrees");
  let preservedPath = join(worktreesRecovery, `corrupt-${randomUUID()}`);
  try {
    await renameDirectory(worktreePath, preservedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV" || !worktreesRoot) {
      throw new Error(`Failed to preserve corrupt registered worktree ${worktreePath} in ${preservedPath}: ${formatError(error).message}`);
    }
    const canonicalWorktreesRoot = await realpath(worktreesRoot);
    const localRecoveryRoot = await ensureContainedDirectory(canonicalWorktreesRoot, WORKTREE_RECOVERY_DIRNAME);
    const localRecoveryWorktrees = await ensureContainedDirectory(localRecoveryRoot, "worktrees");
    preservedPath = join(localRecoveryWorktrees, `corrupt-${randomUUID()}`);
    await renameDirectory(worktreePath, preservedPath);
  }
  return preservedPath;
}
