import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { formatError } from "../logger.js";
import { WORKTREE_RECOVERY_DIRNAME } from "./worktree-paths.js";

const execAsync = promisify(exec);

const PACKAGE_MANAGER_MARKERS = [".package-lock.json", ".yarn-integrity", ".modules.yaml", ".pnpm"] as const;

// Recognized names/extensions inside an installed package directory. Anything
// else (notes.txt, custom.env, settings.config, an extensionless file that is
// not a license/readme, a stray .yaml/.log) fails the whole directory closed,
// because a user can drop a hand-authored ignored file inside node_modules.
const GENERATED_PACKAGE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "README.md", "README.txt", "README",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
  "CHANGELOG.md", "CHANGELOG",
  "NOTICE",
  "index.js", "index.mjs", "index.cjs", "index.d.ts",
]);

const GENERATED_PACKAGE_EXTENSIONS = [
  ".js", ".mjs", ".cjs", ".d.ts", ".tsbuildinfo",
  ".json", ".node", ".wasm", ".map",
  ".css", ".html", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot",
] as const;

function isGeneratedPackageEntry(entry: string): boolean {
  if (GENERATED_PACKAGE_FILES.has(entry)) return true;
  return GENERATED_PACKAGE_EXTENSIONS.some((ext) => entry.endsWith(ext));
}

/**
 * Walk an installed package directory (depth-limited) and return false as soon
 * as any entry is not provably package-manager output. This is what makes the
 * nested case fail closed: a `node_modules/pkg/user-notes.txt` (or any file
 * that is not a build artifact, manifest, readme, or license) stops the whole
 * node_modules directory from being moved ahead of the dirty probe.
 */
async function packageDirIsGenerated(packageDir: string, depth: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(packageDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (isGeneratedPackageEntry(entry)) continue;
    let subEntries: string[];
    try {
      subEntries = await readdir(join(packageDir, entry));
    } catch {
      // A file that is not a recognized package artifact (e.g. user-notes.txt,
      // custom.env, settings.config, extensionless): user content, fail closed.
      return false;
    }
    if (depth <= 0 || !subEntries.length) {
      // Dir we cannot prove generated at this depth is fail-closed, except the
      // common package subdir shapes that are always generated.
      if (GENERATED_PACKAGE_FILES.has(entry) || GENERATED_PACKAGE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      return false;
    }
    if (!(await packageDirIsGenerated(join(packageDir, entry), depth - 1))) return false;
  }
  return true;
}

// Recognized build-output shapes for dist/. A sourcemap alone does NOT prove
// the whole directory is generated — every executable file must carry its own
// .map companion (build tools emit bundle.js + bundle.js.map together), and a
// lone .json/.svg/.xml may be hand-authored, so it only passes when emitted by
// an accompanying sourcemap. Anything else fails the whole directory closed.
const DIST_EXECUTABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".css", ".html"] as const;

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
 *
 * Greptile (4/5, "generated-looking extensions"): filename extensions are not
 * proof. A `dist` with one sourcemap plus arbitrary `.js`/`.json` files, or a
 * `node_modules` package with a manifest plus hand-placed JS/JSON, would move
 * user-authored content. Proof is therefore per-file:
 *   - dist: every executable file MUST have its own `.map` companion in the
 *     same directory (bundlers emit bundle.js + bundle.js.map together); the
 *     only bare JSON allowed is a build manifest (package.json / manifest.json
 *     / tsconfig.tsbuildinfo).
 *   - node_modules: a package is only accepted when the worktree's root
 *     package-lock.json actually lists it (`node_modules/<name>` under
 *     "packages"), i.e. the package manager installed it. No lockfile or
 *     unknown package -> fail closed, keep in place.
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
    // file or unknown directory next to a marker fails closed. Package dirs
    // are also inspected recursively (depth-limited) so a nested user-authored
    // file (e.g. `node_modules/pkg/user-notes.txt`) fails the whole directory.
    // Installed packages must be listed in the root package-lock.json; a
    // hand-assembled package.json + user .js/.json is not install proof.
    let installedNames: Set<string> | null = null;
    try {
      const lock = JSON.parse(await readFile(join(worktreePath, "package-lock.json"), "utf8"));
      const names = new Set<string>();
      for (const key of Object.keys(lock.packages ?? {})) {
        if (key.startsWith("node_modules/")) names.add(key.slice("node_modules/".length));
      }
      for (const dep of Object.keys(lock.dependencies ?? {})) names.add(dep);
      installedNames = names;
    } catch {
      installedNames = null;
    }
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
        // Greptile (4/5): a package manifest plus .js/.json inside it is not
        // proof of an install — the lockfile must list this package. Without
        // the lockfile or without this entry, fail closed.
        if (installedNames === null || !installedNames.has(entry)) return false;
        // Inspect nested package contents: any user-authored file inside the
        // package (notes.txt, custom.env, settings.config, extensionless)
        // fails the whole node_modules directory closed.
        if (!(await packageDirIsGenerated(join(dir, entry), 3))) return false;
        continue;
      }
      // Scoped package dirs (@scope/pkg) hold package.json one level deeper.
      if (entry.startsWith("@")) {
        let scoped = false;
        for (const scopeEntry of sub) {
          try {
            const scopeSub = await readdir(join(dir, entry, scopeEntry));
            if (scopeSub.includes("package.json")) {
              scoped = true;
              if (installedNames === null || !installedNames.has(`${entry}/${scopeEntry}`)) return false;
              if (!(await packageDirIsGenerated(join(dir, entry, scopeEntry), 3))) return false;
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
    // Build output requires proof per file: every executable entry must carry
    // its own sourcemap companion (bundle.js + bundle.js.map). `.map`, `.d.ts`
    // and `.tsbuildinfo` are build metadata. The only bare JSON accepted is a
    // build manifest (package.json / manifest.json). A lonely `.js`/`.json`/
    // asset without its own `.map` may be user-authored (Greptile 4/5) and
    // fails the whole directory closed.
    const isBuildMetadata = (e: string) =>
      e.endsWith(".map") || e.endsWith(".d.ts") || e.endsWith(".tsbuildinfo") ||
      e === "package.json" || e === "manifest.json";
    const hasMapCompanion = (e: string) => entries.includes(`${e}.map`);
    let sawSourcemap = false;
    for (const entry of entries) {
      if (isBuildMetadata(entry)) {
        if (entry.endsWith(".map")) sawSourcemap = true;
        continue;
      }
      if (DIST_EXECUTABLE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
        if (!hasMapCompanion(entry)) return false;
        sawSourcemap = true;
        continue;
      }
      // A file that is neither metadata nor an executables-with-map pair is
      // user-authored ignored content (e.g. `data.json`, `user.png`).
      return false;
    }
    return sawSourcemap && entries.length > 0;
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
