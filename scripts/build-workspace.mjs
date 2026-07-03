#!/usr/bin/env node
/*
FNXC:WorkspaceBuild 2026-06-30-00:00:
Root builds may skip unchanged plugin workspaces to keep local and CI feedback fast, but only after required dist outputs exist and a content hash proves plugin package inputs match the last successful plugin build. Non-plugin packages still build every run so the root command preserves the pre-existing recursive build contract outside plugins.
*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fg from "fast-glob";
import YAML from "yaml";
import {
  computeContentHash,
  createRepoContentSnapshot,
  defaultGitRunner,
  readJsonCache,
} from "./lib/content-hash.mjs";

export const BUILD_CACHE_VERSION = 1;
export const BUILD_CACHE_FILE = "plugin-build-cache.json";
export const ROOT_BUILD_EXCLUDED_PACKAGES = new Set(["@fusion/desktop", "@fusion/mobile"]);
export const PLUGIN_BUILD_GLOBAL_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "plugins/tsconfig.base.json",
  "scripts/build-workspace.mjs",
  "scripts/lib/content-hash.mjs",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

/**
 * Resolve the plugin build cache under .fusion/cache as a repo-local build
 * artifact. The cache is only an optimization: missing, unreadable, or stale
 * entries force a plugin build rather than allowing a skip.
 *
 * @param {string} rootDir
 * @returns {string}
 */
export function pluginBuildCachePath(rootDir) {
  return path.join(rootDir, ".fusion", "cache", BUILD_CACHE_FILE);
}

/**
 * Read the plugin build cache, normalizing invalid or older formats to an empty
 * cache so a format bump rebuilds plugins once and then records fresh hashes.
 *
 * @param {string} rootDir
 * @returns {{ version: number, entries: Record<string, { sourceHash?: string, builtAt?: string }> }}
 */
export function readPluginBuildCache(rootDir) {
  const cache = readJsonCache(pluginBuildCachePath(rootDir), null);
  if (!cache || cache.version !== BUILD_CACHE_VERSION || typeof cache.entries !== "object") {
    return { version: BUILD_CACHE_VERSION, entries: {} };
  }
  return cache;
}

/**
 * Best-effort write for the plugin build cache. A successful package build must
 * not become a failed root build just because the local optimization cache is
 * not writable.
 *
 * @param {string} rootDir
 * @param {{ version: number, entries: Record<string, { sourceHash?: string, builtAt?: string }> }} cache
 */
export function writePluginBuildCache(rootDir, cache) {
  try {
    const cachePath = pluginBuildCachePath(rootDir);
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort optimization cache; the next run will rebuild missing entries.
  }
}

/**
 * Parse pnpm-workspace.yaml and return workspace package globs.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function readWorkspacePackagePatterns(rootDir) {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  const parsed = YAML.parse(readFileSync(workspacePath, "utf8"));
  return Array.isArray(parsed?.packages) ? parsed.packages.filter((entry) => typeof entry === "string") : [];
}

/**
 * Discover workspace package manifests from pnpm workspace patterns instead of
 * hard-coding the current plugin list.
 *
 * @param {string} rootDir
 * @param {string[]} [patterns]
 * @returns {{ name: string, dir: string, manifest: object, hasBuild: boolean, isPlugin: boolean, requiredOutputs: string[], inputPaths: string[] }[]}
 */
export function discoverWorkspacePackages(rootDir, patterns = readWorkspacePackagePatterns(rootDir)) {
  const manifestPatterns = patterns.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`);
  const manifestPaths = fg.sync(manifestPatterns, {
    cwd: rootDir,
    onlyFiles: true,
    unique: true,
    dot: false,
    ignore: ["**/node_modules/**"],
  }).sort((a, b) => a.localeCompare(b));

  const packages = [];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, manifestPath), "utf8"));
    if (typeof manifest.name !== "string" || !manifest.name) continue;
    const dir = path.dirname(manifestPath).replaceAll(path.sep, "/");
    packages.push({
      name: manifest.name,
      dir,
      manifest,
      hasBuild: typeof manifest.scripts?.build === "string",
      isPlugin: isPluginPackageDir(dir),
      requiredOutputs: requiredPluginOutputs(rootDir, dir, manifest),
      inputPaths: [dir],
    });
  }

  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of packages) {
    if (!pkg.isPlugin) continue;
    pkg.inputPaths = collectPluginHashInputPaths(pkg, packagesByName);
  }

  return packages;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function declaredDependencyNames(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest?.[field] ?? {}));
}

/**
 * Resolve a plugin's content-hash input directories. Include local workspace
 * dependency directories and root build config/tooling files as invalidators so
 * skipping a plugin cannot hide a compile break against changed shared package
 * types, TypeScript settings, pnpm resolution, or build wrapper behavior.
 *
 * FNXC:WorkspaceBuild 2026-06-30-00:00:
 * Plugin skip decisions must include declared local workspace dependencies and
 * root build config/tooling in the content hash, not just the plugin package
 * directory, because root pnpm builds previously recompiled plugins after shared
 * package API/type changes and root TypeScript/build-tooling changes.
 *
 * @param {object} pkg
 * @param {Map<string, object>} packagesByName
 * @returns {string[]}
 */
export function collectPluginHashInputPaths(pkg, packagesByName) {
  const inputPaths = new Set([...PLUGIN_BUILD_GLOBAL_INPUT_PATHS, pkg.dir]);
  const seen = new Set();
  const visit = (current) => {
    if (seen.has(current.name)) return;
    seen.add(current.name);
    for (const dependencyName of declaredDependencyNames(current.manifest)) {
      const dependency = packagesByName.get(dependencyName);
      if (!dependency) continue;
      inputPaths.add(dependency.dir);
      visit(dependency);
    }
  };
  visit(pkg);
  return [...inputPaths].sort((a, b) => a.localeCompare(b));
}

/**
 * Plugin workspaces live under plugins/ (including plugins/examples/). This
 * directory classification keeps future plugin packages covered by the skip
 * cache without requiring a code edit for each new package name.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isPluginPackageDir(dir) {
  return dir === "plugins" || dir.startsWith("plugins/");
}

function distPathFromExportValue(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("./dist/")) return value.slice(2);
  if (!value.startsWith("./src/")) return null;
  const withoutPrefix = value.slice("./src/".length);
  if (/\.d\.[cm]?ts$/.test(withoutPrefix)) return null;
  if (!/\.[cm]?[tj]sx?$/.test(withoutPrefix)) return null;
  return path.posix.join("dist", withoutPrefix.replace(/\.[cm]?[tj]sx?$/, ".js"));
}

function collectDistExports(exportsField, outputPaths = new Set()) {
  if (typeof exportsField === "string") {
    const output = distPathFromExportValue(exportsField);
    if (output) outputPaths.add(output);
    return outputPaths;
  }
  if (!exportsField || typeof exportsField !== "object") return outputPaths;
  for (const value of Object.values(exportsField)) {
    if (typeof value === "string") {
      const output = distPathFromExportValue(value);
      if (output) outputPaths.add(output);
    } else {
      collectDistExports(value, outputPaths);
    }
  }
  return outputPaths;
}

function collectDistEntrypoints(manifest, outputPaths = new Set()) {
  for (const key of ["main", "module", "types"] ) {
    const output = distPathFromExportValue(manifest[key]);
    if (output) outputPaths.add(output);
  }
  if (typeof manifest.bin === "string") {
    const output = distPathFromExportValue(manifest.bin);
    if (output) outputPaths.add(output);
  } else if (manifest.bin && typeof manifest.bin === "object") {
    for (const value of Object.values(manifest.bin)) {
      const output = distPathFromExportValue(value);
      if (output) outputPaths.add(output);
    }
  }
  return outputPaths;
}

/**
 * Infer the required plugin build outputs. Exported dist paths are required as
 * declared, and source entrypoints are mapped to their dist JS counterparts so
 * packages that export source during development still cannot be skipped when
 * their tsc output is absent.
 *
 * @param {string} rootDir
 * @param {string} dir
 * @param {object} manifest
 * @returns {string[]}
 */
export function requiredPluginOutputs(rootDir, dir, manifest) {
  const outputs = collectDistEntrypoints(manifest, collectDistExports(manifest.exports));
  const sourceFiles = fg.sync(["src/**/*.{ts,tsx,mts,cts}"], {
    cwd: path.join(rootDir, dir),
    onlyFiles: true,
    unique: true,
    ignore: ["**/*.d.ts", "**/*.test.*", "**/__tests__/**", "**/node_modules/**", "**/dist/**"],
  });
  for (const sourceFile of sourceFiles) {
    outputs.add(sourceFile.replace(/^src\//, "dist/").replace(/\.[cm]?[tj]sx?$/, ".js"));
  }
  if (typeof manifest.scripts?.build === "string" && manifest.scripts.build.includes("copy-css")) {
    const cssFiles = fg.sync(["src/**/*.css"], {
      cwd: path.join(rootDir, dir),
      onlyFiles: true,
      unique: true,
      ignore: ["**/node_modules/**", "**/dist/**"],
    });
    for (const cssFile of cssFiles) {
      outputs.add(cssFile.replace(/^src\//, "dist/"));
    }
  }
  if (outputs.size === 0) outputs.add("dist/index.js");
  return [...outputs].sort((a, b) => a.localeCompare(b)).map((output) => path.posix.join(dir, output));
}

/**
 * Compute a plugin package input hash using the shared git-backed content hash.
 * Returns null when git is unavailable; callers must build rather than skip in
 * that case.
 *
 * @param {object} pkg
 * @param {string} rootDir
 * @param {object} [options]
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 * @param {ReturnType<typeof createRepoContentSnapshot>} [options.snapshot]
 * @returns {string|null}
 */
export function computePluginSourceHash(pkg, rootDir, { gitFn = defaultGitRunner, snapshot } = {}) {
  const probe = gitFn(["rev-parse", "--is-inside-work-tree"], rootDir);
  if (probe !== "true") return null;
  return computeContentHash({
    rootDir,
    inputPaths: pkg.inputPaths?.length ? pkg.inputPaths : [pkg.dir],
    versionPrefix: `plugin-build-v${BUILD_CACHE_VERSION}`,
    gitFn,
    snapshot,
  });
}

/**
 * Explain whether a plugin package must be built. A skip requires every required
 * output to exist plus a matching successful-build source hash.
 *
 * @param {object} pkg
 * @param {object} options
 * @param {string} options.rootDir
 * @param {{ entries?: Record<string, { sourceHash?: string }> }} options.cache
 * @param {(p: string) => boolean} [options.existsFn]
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 * @param {ReturnType<typeof createRepoContentSnapshot>} [options.snapshot]
 * @returns {{ shouldBuild: boolean, reason: string, sourceHash: string|null, missingOutputs: string[] }}
 */
export function evaluatePluginBuild(pkg, { rootDir, cache, existsFn = existsSync, gitFn = defaultGitRunner, snapshot } = {}) {
  const missingOutputs = pkg.requiredOutputs.filter((output) => !existsFn(path.join(rootDir, output)));
  const sourceHash = computePluginSourceHash(pkg, rootDir, { gitFn, snapshot });
  if (missingOutputs.length > 0) return { shouldBuild: true, reason: "missing-output", sourceHash, missingOutputs };
  if (sourceHash === null) return { shouldBuild: true, reason: "no-git-hash", sourceHash, missingOutputs };
  const entry = cache?.entries?.[pkg.name];
  if (!entry?.sourceHash) return { shouldBuild: true, reason: "no-cache", sourceHash, missingOutputs };
  if (entry.sourceHash !== sourceHash) return { shouldBuild: true, reason: "changed-inputs", sourceHash, missingOutputs };
  return { shouldBuild: false, reason: "unchanged", sourceHash, missingOutputs };
}

/**
 * Plan the root build. Non-plugin build packages are always planned; plugin
 * packages are planned only when the safe content-hash cache says they changed
 * or their required outputs/cache entry are missing.
 *
 * @param {object} options
 * @param {string} [options.rootDir]
 * @param {object[]} [options.packages]
 * @param {ReturnType<typeof readPluginBuildCache>} [options.cache]
 * @param {(p: string) => boolean} [options.existsFn]
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 * @param {ReturnType<typeof createRepoContentSnapshot>} [options.snapshot]
 * @returns {{ plannedPackages: object[], skippedPlugins: object[], excludedPackages: object[], pluginEvaluations: Map<string, object> }}
 */
export function planWorkspaceBuild({ rootDir = repoRoot, packages = discoverWorkspacePackages(rootDir), cache = readPluginBuildCache(rootDir), existsFn = existsSync, gitFn = defaultGitRunner, snapshot } = {}) {
  const plannedPackages = [];
  const skippedPlugins = [];
  const excludedPackages = [];
  const pluginEvaluations = new Map();

  for (const pkg of packages) {
    if (!pkg.hasBuild) continue;
    if (ROOT_BUILD_EXCLUDED_PACKAGES.has(pkg.name)) {
      excludedPackages.push(pkg);
      continue;
    }
    if (!pkg.isPlugin) {
      plannedPackages.push({ ...pkg, buildReason: "non-plugin" });
      continue;
    }
    const evaluation = evaluatePluginBuild(pkg, { rootDir, cache, existsFn, gitFn, snapshot });
    pluginEvaluations.set(pkg.name, evaluation);
    if (evaluation.shouldBuild) {
      plannedPackages.push({ ...pkg, buildReason: evaluation.reason, sourceHash: evaluation.sourceHash });
    } else {
      skippedPlugins.push({ ...pkg, buildReason: evaluation.reason, sourceHash: evaluation.sourceHash });
    }
  }

  return { plannedPackages, skippedPlugins, excludedPackages, pluginEvaluations };
}

/**
 * Build all planned packages through pnpm filters so each package's existing
 * build script and workspace dependency behavior remain intact.
 *
 * @param {object[]} plannedPackages
 * @param {string} rootDir
 * @param {(command: string, args: string[], options: object) => { status: number|null }} [spawnFn]
 * @returns {{ status: number, packageNames: string[] }}
 */
export function runPlannedBuilds(plannedPackages, rootDir, spawnFn = spawnSync) {
  if (plannedPackages.length === 0) return { status: 0, packageNames: [] };
  const packageNames = plannedPackages.map((pkg) => pkg.name);
  const args = [...packageNames.flatMap((name) => ["--filter", name]), "build"];
  /*
   * FNXC:WorkspaceBuild 2026-07-02-15:10:
   * On Windows `pnpm` resolves to a `.cmd` shim; Node refuses to spawn .cmd/.bat without a
   * shell (ENOENT / EINVAL since CVE-2024-27980). Without shell:true the root build failed
   * with `spawn pnpm ENOENT` on Windows. The args are workspace filters + package names
   * (no spaces or shell metacharacters), so shell quoting is safe.
   */
  const result = spawnFn("pnpm", args, { cwd: rootDir, stdio: "inherit", shell: process.platform === "win32" });
  return { status: result.status ?? 1, packageNames };
}

/**
 * Record hashes for plugins that built successfully.
 *
 * @param {object[]} builtPackages
 * @param {object} options
 * @param {string} options.rootDir
 * @param {ReturnType<typeof readPluginBuildCache>} options.cache
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 */
export function recordSuccessfulPluginBuilds(builtPackages, { rootDir, cache, gitFn = defaultGitRunner } = {}) {
  const nextCache = { version: BUILD_CACHE_VERSION, entries: { ...(cache?.entries ?? {}) } };
  let changed = false;
  const snapshot = createRepoContentSnapshot({ rootDir, gitFn });
  for (const pkg of builtPackages.filter((entry) => entry.isPlugin)) {
    const sourceHash = computePluginSourceHash(pkg, rootDir, { gitFn, snapshot });
    if (sourceHash === null) continue;
    nextCache.entries[pkg.name] = { sourceHash, builtAt: new Date().toISOString() };
    changed = true;
  }
  if (changed) writePluginBuildCache(rootDir, nextCache);
}

function formatPlanLine(pkg) {
  return `${pkg.name} (${pkg.buildReason})`;
}

export function main({ rootDir = repoRoot, spawnFn = spawnSync, gitFn = defaultGitRunner } = {}) {
  const cache = readPluginBuildCache(rootDir);
  const snapshot = createRepoContentSnapshot({ rootDir, gitFn });
  const plan = planWorkspaceBuild({ rootDir, cache, gitFn, snapshot });
  const plannedNames = plan.plannedPackages.map(formatPlanLine);
  const skippedNames = plan.skippedPlugins.map((pkg) => pkg.name);

  console.log(`[build-workspace] planned builds: ${plannedNames.join(", ") || "(none)"}`);
  if (skippedNames.length > 0) {
    console.log(`[build-workspace] skipped unchanged plugins: ${skippedNames.join(", ")}`);
  }

  const result = runPlannedBuilds(plan.plannedPackages, rootDir, spawnFn);
  if (result.status !== 0) {
    process.stderr.write(`[build-workspace] FAILED packages: ${result.packageNames.join(", ") || "(none)"}\n`);
    return result.status;
  }

  recordSuccessfulPluginBuilds(plan.plannedPackages, { rootDir, cache, gitFn });
  return 0;
}

/*
 * FNXC:WorkspaceBuild 2026-07-02-15:10:
 * Cross-platform "run as main" guard. The old `import.meta.url === \`file://${process.argv[1]}\``
 * check NEVER matched on Windows: import.meta.url is `file:///C:/…/build-workspace.mjs`
 * (triple slash, forward slashes) while process.argv[1] is `C:\…\build-workspace.mjs`
 * (backslashes, no scheme). So `pnpm build` at the repo root silently no-opped on Windows
 * (exit 0, no output, no dist) — packaging then shipped empty/stale dist. Compare against the
 * file URL of argv[1] so the guard is correct on Windows, macOS, and Linux.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
