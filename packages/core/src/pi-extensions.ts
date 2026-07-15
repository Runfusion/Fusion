import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createRequire } from "node:module";

const FUSION_DISABLED_EXTENSIONS_KEY = "fusionDisabledExtensions";
const require = createRequire(import.meta.url);

let cachedSpawnSync: typeof import("node:child_process")["spawnSync"] | undefined;
let didLoadSpawnSync = false;
function getSpawnSync(): typeof import("node:child_process")["spawnSync"] | undefined {
  if (!didLoadSpawnSync) {
    didLoadSpawnSync = true;
    cachedSpawnSync = require("node:child_process").spawnSync;
  }
  return cachedSpawnSync;
}

export type PiExtensionSource = "fusion-global" | "pi-global" | "fusion-project" | "pi-project" | "package";

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: PiExtensionSource;
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

function getHomeDir(home?: string): string {
  return home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function getFusionAgentDir(home?: string): string {
  return join(getHomeDir(home), ".fusion", "agent");
}

export function getLegacyPiAgentDir(home?: string): string {
  return join(getHomeDir(home), ".pi", "agent");
}

export function getFusionAgentSettingsPath(home?: string): string {
  return join(getFusionAgentDir(home), "settings.json");
}

export function getProjectRootFromWorktree(
  cwd: string,
  opts?: { worktreesDirCandidates?: string[] },
): string | null {
  const knownWorktreePatterns = [
    /^(.+?)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/]|$)/,
    /^(.+?)[\\/]\.fusion[\\/]worktrees[\\/][^\\/]+(?:[\\/]|$)/,
  ];
  for (const pattern of knownWorktreePatterns) {
    const match = cwd.match(pattern);
    if (match) {
      return match[1]!;
    }
  }

  for (const candidate of opts?.worktreesDirCandidates ?? []) {
    const normalizedCandidate = resolve(candidate);
    const normalizedCwd = resolve(cwd);
    const rel = relative(normalizedCandidate, normalizedCwd);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const firstSegment = rel.split(/[\\/]/).filter(Boolean)[0];
      if (firstSegment) {
        const parent = normalizedCandidate.split(/[\\/]/).slice(0, -1).join("/");
        if (parent) {
          return parent;
        }
      }
    }
  }

  const gitLinkedWorktreeRoot = getProjectRootFromGitLinkedWorktree(cwd);
  if (gitLinkedWorktreeRoot) {
    return gitLinkedWorktreeRoot;
  }

  return null;
}

/**
 * FNXC:Storage 2026-07-09-00:00:
 * FN-7730 root cause: board mutations issued from a pi-extension tool session
 * (fn_task_update, etc.) resolve their TaskStore against `resolveProjectRoot(cwd)`
 * in packages/cli/src/extension.ts, which calls getProjectRootFromWorktree(cwd)
 * with NO worktreesDirCandidates. When a project configures a non-default
 * `settings.worktreesDir` (packages/engine/src/worktree-paths.ts
 * resolveWorktreesDir supports an arbitrary relative/absolute location — common in
 * containerized deployments), neither hardcoded regex above matches, and the ONLY
 * remaining path was getProjectRootFromGitLinkedWorktree(), which shelled out to
 * `git rev-parse` via spawnSync. A failing git invocation (missing `git` binary in
 * a minimal container, Docker's "detected dubious ownership" safe.directory
 * refusal on a bind-mounted repo owned by a different UID, or any other non-zero
 * exit) returned null with NO thrown error — by design, so a non-worktree cwd
 * doesn't explode — but with no non-git fallback. resolveProjectRoot's caller then
 * FNXC:PostgresWorktreeStorage 2026-07-14-18:49:
 * The fallback landed on the first ancestor with a `.fusion` directory.
 * That historical SQLite hydration behavior is removed; worktrees now share
 * the project-scoped PostgreSQL store. Resolving the main repository remains
 * required so filesystem artifacts and project identity use the correct root.
 *
 * Fix: resolve the linked-worktree relationship directly from git's own on-disk
 * worktree metadata (the `.git` file + its `commondir` sidecar) FIRST. This is
 * pure filesystem I/O — no subprocess, no git-binary dependency, unaffected by
 * Docker UID/safe.directory restrictions. The `git rev-parse` CLI path is kept as
 * a secondary fallback for any layout the fs parser can't resolve (e.g. detached
 * gitdir configurations outside the standard worktree layout), preserving prior
 * behavior for those edge cases.
 */
function getMainRepoRootFromGitFile(cwd: string): string | null {
  let current = resolve(cwd);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    const gitPath = join(current, ".git");
    let gitStat: ReturnType<typeof statSync> | undefined;
    try {
      gitStat = statSync(gitPath);
    } catch {
      gitStat = undefined;
    }

    if (gitStat?.isDirectory()) {
      // A `.git` directory means `current` IS a normal repo root (or the main
      // worktree), not itself a linked worktree — no linked-worktree parent
      // to resolve at this level.
      return null;
    }

    if (gitStat?.isFile()) {
      const commonGitDir = resolveCommonGitDirFromWorktreeGitFile(gitPath, current);
      if (!commonGitDir) {
        return null;
      }
      const parentRoot = commonGitDir.endsWith(`${sep}.git`) ? dirname(commonGitDir) : commonGitDir;
      return existsSync(join(parentRoot, ".fusion")) ? parentRoot : null;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return null;
}

/**
 * Parse a linked worktree's `.git` file (`gitdir: <path>`) and its sidecar
 * `commondir` file (relative or absolute path to the shared `.git` directory) —
 * the same on-disk contract `git worktree add` writes and `git rev-parse
 * --git-common-dir` reads, but via plain file reads instead of a subprocess.
 */
function resolveCommonGitDirFromWorktreeGitFile(gitFilePath: string, gitFileDir: string): string | null {
  let gitFileContent: string;
  try {
    gitFileContent = readFileSync(gitFilePath, "utf8");
  } catch {
    return null;
  }

  const match = gitFileContent.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return null;
  }
  const worktreeGitDir = resolve(gitFileDir, match[1]!.trim());

  const commondirPath = join(worktreeGitDir, "commondir");
  try {
    const commondirContent = readFileSync(commondirPath, "utf8").trim();
    if (commondirContent) {
      return resolve(worktreeGitDir, commondirContent);
    }
  } catch {
    // commondir sidecar missing/unreadable — fall through to the pattern-based
    // derivation below.
  }

  // Standard worktree gitdir shape: `<repo>/.git/worktrees/<name>`. Strip the
  // `worktrees/<name>` suffix to recover `<repo>/.git`.
  const worktreesSuffix = /^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+[\\/]?$/;
  const suffixMatch = worktreeGitDir.match(worktreesSuffix);
  return suffixMatch ? suffixMatch[1]! : null;
}

function getProjectRootFromGitLinkedWorktree(cwd: string): string | null {
  const fsResolvedRoot = getMainRepoRootFromGitFile(cwd);
  if (fsResolvedRoot) {
    return fsResolvedRoot;
  }

  const spawnSync = getSpawnSync();
  if (!spawnSync) {
    return null;
  }

  const resolvedCwd = resolve(cwd);
  const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: resolvedCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: resolvedCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (commonDir.status !== 0 || gitDir.status !== 0) {
    return null;
  }

  const resolvedCommonDir = resolve(resolvedCwd, commonDir.stdout.trim());
  const resolvedGitDir = resolve(resolvedCwd, gitDir.stdout.trim());
  if (!resolvedCommonDir || !resolvedGitDir || resolvedCommonDir === resolvedGitDir) {
    return null;
  }

  const parentRoot = resolvedCommonDir.endsWith(`${sep}.git`)
    ? dirname(resolvedCommonDir)
    : resolvedCommonDir;
  return existsSync(join(parentRoot, ".fusion")) ? parentRoot : null;
}

export function resolvePiExtensionProjectRoot(cwd: string): string {
  const worktreeProjectRoot = getProjectRootFromWorktree(cwd);
  if (worktreeProjectRoot && existsSync(join(worktreeProjectRoot, ".fusion"))) {
    return worktreeProjectRoot;
  }

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".fusion"))) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return resolve(cwd);
    }
    current = parent;
  }
}

function sourceForDir(dir: string, cwd: string, home?: string): PiExtensionSource {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const resolved = resolve(dir);
  if (resolved === resolve(projectRoot, ".fusion", "extensions")) return "fusion-project";
  if (resolved === resolve(projectRoot, ".pi", "extensions")) return "pi-project";
  if (resolved === resolve(getFusionAgentDir(home), "extensions")) return "fusion-global";
  return "pi-global";
}

function extensionName(extensionPath: string): string {
  const base = basename(extensionPath).replace(/\.(ts|js)$/i, "");
  if (base === "index") {
    return basename(resolve(extensionPath, ".."));
  }
  return base;
}

function readPiManifest(packageJsonPath: string): { extensions?: string[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (parsed.pi && Array.isArray(parsed.pi.extensions)) {
      return { extensions: parsed.pi.extensions.filter((entry): entry is string => typeof entry === "string") };
    }
  } catch {
    // Ignore invalid extension manifests.
  }
  return null;
}

function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries = manifest.extensions
        .map((entry) => resolve(dir, entry))
        .filter((entry) => existsSync(entry));
      if (entries.length > 0) return entries;
    }
  }

  const indexTs = join(dir, "index.ts");
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = join(dir, "index.js");
  if (existsSync(indexJs)) return [indexJs];
  return null;
}

function discoverExtensionsInDir(dir: string, cwd: string, home?: string): PiExtensionEntry[] {
  if (!existsSync(dir)) return [];

  const discovered: PiExtensionEntry[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(dir, entry.name);

      if ((entry.isFile() || entry.isSymbolicLink()) && /\.(ts|js)$/i.test(entry.name)) {
        const resolved = resolve(entryPath);
        discovered.push({
          id: resolved,
          name: extensionName(resolved),
          path: resolved,
          source: sourceForDir(dir, cwd, home),
          enabled: true,
        });
        continue;
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = statSync(entryPath).isDirectory();
          } catch {
            isDirectory = false;
          }
        }
        if (!isDirectory) continue;

        const entries = resolveExtensionEntries(entryPath);
        for (const extensionPath of entries ?? []) {
          const resolved = resolve(extensionPath);
          discovered.push({
            id: resolved,
            name: extensionName(resolved),
            path: resolved,
            source: sourceForDir(dir, cwd, home),
            enabled: true,
          });
        }
      }
    }
  } catch {
    return [];
  }

  return discovered;
}

export function getPiExtensionDiscoveryDirs(cwd: string, home?: string): string[] {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  return [
    join(projectRoot, ".fusion", "extensions"),
    join(projectRoot, ".pi", "extensions"),
    join(getFusionAgentDir(home), "extensions"),
    join(getLegacyPiAgentDir(home), "extensions"),
  ];
}

function readFusionDisabledExtensions(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const disabled = parsed[FUSION_DISABLED_EXTENSIONS_KEY];
    return Array.isArray(disabled)
      ? disabled.filter((entry): entry is string => typeof entry === "string").map((entry) => resolve(entry))
      : [];
  } catch {
    return [];
  }
}

export function discoverPiExtensions(cwd: string, home?: string): PiExtensionSettings {
  const settingsPath = getFusionAgentSettingsPath(home);
  const disabledIds = readFusionDisabledExtensions(settingsPath);
  const disabled = new Set(disabledIds);
  const byPath = new Map<string, PiExtensionEntry>();

  for (const dir of getPiExtensionDiscoveryDirs(cwd, home)) {
    for (const entry of discoverExtensionsInDir(dir, cwd, home)) {
      byPath.set(entry.id, { ...entry, enabled: !disabled.has(entry.id) });
    }
  }

  return {
    extensions: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    disabledIds,
    settingsPath,
  };
}

export function getEnabledPiExtensionPaths(cwd: string, home?: string): string[] {
  return discoverPiExtensions(cwd, home)
    .extensions
    .filter((entry) => entry.enabled)
    .map((entry) => entry.path);
}

export function updatePiExtensionDisabledIds(cwd: string, disabledIds: string[], home?: string, extraKnownIds: string[] = []): PiExtensionSettings {
  const settingsPath = getFusionAgentSettingsPath(home);
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const known = new Set([
    ...discoverPiExtensions(cwd, home).extensions.map((entry) => entry.id),
    ...extraKnownIds.map((entry) => resolve(entry)),
  ]);
  const normalizedDisabledIds = Array.from(new Set(
    disabledIds.map((entry) => resolve(entry)).filter((entry) => known.has(entry)),
  )).sort();

  mkdirSync(resolve(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({
    ...existing,
    [FUSION_DISABLED_EXTENSIONS_KEY]: normalizedDisabledIds,
  }, null, 2)}\n`);

  return discoverPiExtensions(cwd, home);
}

/**
 * Heuristic: does this extension path look like an external (non-Fusion)
 * `pi-claude-cli` install? We match any path with a directory segment named
 * exactly `pi-claude-cli`, except for the explicit vendored path that callers
 * pass in (which always wins).
 *
 * Example matches: `/opt/homebrew/lib/node_modules/pi-claude-cli/index.ts`,
 * `~/.pi/agent/extensions/pi-claude-cli/index.ts`.
 */
function isExternalClaudeCliPath(p: string, vendoredPath: string | null): boolean {
  if (vendoredPath && p === vendoredPath) return false;
  // Match a path segment "pi-claude-cli" delimited by either separator.
  return /(^|[/\\])pi-claude-cli([/\\]|$)/i.test(p);
}

/**
 * Reconcile the assembled pi-extension load list so Fusion's vendored
 * `@fusion/pi-claude-cli` always wins over any externally-installed
 * `pi-claude-cli` (e.g. a stale `npm install -g pi-claude-cli` left in
 * `/opt/homebrew/lib/node_modules`, or `npm:pi-claude-cli` in agent
 * settings).
 *
 * Two motivating scenarios:
 *  1. The published upstream package has a once-and-lock MCP-config bug that
 *     causes "Extension runtime not initialized" during early streamSimple
 *     calls; our fork fixes it via context.tools-driven regeneration.
 *  2. Side-by-side loading of two extensions that register the same
 *     provider name (`pi-claude-cli`) produces unpredictable winners
 *     depending on load order.
 *
 * Behaviour:
 *  - When `vendoredPath` is null (caller couldn't find the fork — typically
 *    because Fusion isn't running): return the input unchanged.
 *  - When `vendoredPath` is set: drop every external pi-claude-cli path and
 *    ensure the vendored path is loaded first.
 */
export function reconcileClaudeCliPaths(
  paths: readonly string[],
  vendoredPath: string | null,
): string[] {
  if (!vendoredPath) {
    return [...paths];
  }
  const filtered = paths.filter((p) => !isExternalClaudeCliPath(p, vendoredPath));
  if (!filtered.includes(vendoredPath)) {
    return [vendoredPath, ...filtered];
  }
  return filtered;
}

/**
 * Heuristic: does this extension path look like an external (non-Fusion)
 * `droid-cli` install? We match any path with a directory segment named
 * exactly `droid-cli`, except for the explicit vendored path that callers
 * pass in (which always wins).
 */
function isExternalDroidCliPath(p: string, vendoredPath: string | null): boolean {
  if (vendoredPath && p === vendoredPath) return false;
  return /(^|[/\\])droid-cli([/\\]|$)/i.test(p);
}

/**
 * Reconcile the assembled pi-extension load list so Fusion's vendored
 * `@fusion/droid-cli` always wins over any externally-installed
 * `droid-cli` (e.g. a stale `npm install -g droid-cli` left in
 * `/opt/homebrew/lib/node_modules`, or `npm:droid-cli` in agent
 * settings).
 *
 * Side-by-side loading of two extensions that register the same
 * provider name (`droid-cli`) produces unpredictable winners
 * depending on load order.
 */
export function reconcileDroidCliPaths(
  paths: readonly string[],
  vendoredPath: string | null,
): string[] {
  if (!vendoredPath) {
    return [...paths];
  }
  const filtered = paths.filter((p) => !isExternalDroidCliPath(p, vendoredPath));
  if (!filtered.includes(vendoredPath)) {
    return [vendoredPath, ...filtered];
  }
  return filtered;
}

function getDisplayPathWithinRoot(root: string, targetPath: string): string | null {
  const usesWindowsPaths = /^[A-Za-z]:[\\/]/.test(root) || /^[A-Za-z]:[\\/]/.test(targetPath) || root.includes("\\") || targetPath.includes("\\");
  const pathApi = usesWindowsPaths ? win32 : { relative, isAbsolute, sep };
  const rel = pathApi.relative(root, targetPath);
  if (rel === "") {
    return "";
  }
  if (!rel || rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) {
    return null;
  }
  return rel.split(pathApi.sep).join("/");
}

export function formatPiExtensionSource(source: PiExtensionSource, extensionPath: string, cwd: string, home?: string): string {
  const homeDir = getHomeDir(home);
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const relativeToHome = getDisplayPathWithinRoot(homeDir, extensionPath);
  const relativeToProject = getDisplayPathWithinRoot(projectRoot, extensionPath);
  const relativePath = relativeToHome !== null
    ? relativeToHome.length > 0 ? `~/${relativeToHome}` : "~"
    : relativeToProject !== null
      ? relativeToProject || "."
      : extensionPath;
  return `${source}: ${relativePath}`;
}
