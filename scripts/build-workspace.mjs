#!/usr/bin/env node
/*
FNXC:WorkspaceBuild 2026-06-30-00:00:
Root builds may skip unchanged plugin workspaces to keep local and CI feedback fast, but only after required dist outputs exist and a content hash proves plugin package inputs match the last successful plugin build. Non-plugin packages still build every run so the root command preserves the pre-existing recursive build contract outside plugins.

FNXC:WorkspaceBuild 2026-07-15-03:20:
Root `pnpm build` was pegging CPU for ~2 minutes even when nothing changed: non-plugin packages always rebuilt, CLI packaging always staged desktop + 15 plugins + DTS, and tsc had no incremental cache. Extend the content-hash skip cache to ALL workspace packages (not just plugins), support `--force` / `--full`, and default CLI packaging to a fast local mode (full package on CI or FUSION_CLI_FULL_PACKAGE=1).
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

/*
FNXC:WorkspaceBuild 2026-07-15-03:20:
Bump cache version when the skip contract expands from plugins-only to all packages so stale plugin-only entries cannot incorrectly interact with the broader skip set. File name stays plugin-build-cache.json for path stability under .fusion/cache.
*/
export const BUILD_CACHE_VERSION = 2;
export const BUILD_CACHE_FILE = "plugin-build-cache.json";
export const ROOT_BUILD_EXCLUDED_PACKAGES = new Set(["@fusion/desktop", "@fusion/mobile"]);
export const PACKAGE_BUILD_GLOBAL_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "plugins/tsconfig.base.json",
  "scripts/build-workspace.mjs",
  "scripts/lib/content-hash.mjs",
];
/** @deprecated Use PACKAGE_BUILD_GLOBAL_INPUT_PATHS — kept for existing tests. */
export const PLUGIN_BUILD_GLOBAL_INPUT_PATHS = PACKAGE_BUILD_GLOBAL_INPUT_PATHS;

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
    // FNXC:WorkspaceBuild 2026-07-15-03:20: Hash inputs for every package (plugins and non-plugins) so core/engine/dashboard/cli can skip when unchanged.
    pkg.inputPaths = collectPackageHashInputPaths(pkg, packagesByName);
  }

  return packages;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function declaredDependencyNames(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest?.[field] ?? {}));
}

/**
 * Resolve a package's content-hash input directories. Include local workspace
 * dependency directories and root build config/tooling files as invalidators so
 * skipping cannot hide a compile break against changed shared package types,
 * TypeScript settings, pnpm resolution, or build wrapper behavior.
 *
 * FNXC:WorkspaceBuild 2026-06-30-00:00:
 * Plugin skip decisions must include declared local workspace dependencies and
 * root build config/tooling in the content hash, not just the plugin package
 * directory, because root pnpm builds previously recompiled plugins after shared
 * package API/type changes and root TypeScript/build-tooling changes.
 *
 * FNXC:WorkspaceBuild 2026-07-15-03:20:
 * Same contract now applies to non-plugin packages so unchanged core/engine/
 * dashboard/cli skip the multi-minute full rebuild.
 *
 * @param {object} pkg
 * @param {Map<string, object>} packagesByName
 * @returns {string[]}
 */
export function collectPackageHashInputPaths(pkg, packagesByName) {
  const inputPaths = new Set([...PACKAGE_BUILD_GLOBAL_INPUT_PATHS, pkg.dir]);
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

/** @deprecated Use collectPackageHashInputPaths */
export function collectPluginHashInputPaths(pkg, packagesByName) {
  return collectPackageHashInputPaths(pkg, packagesByName);
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
  const buildScript = typeof manifest.scripts?.build === "string" ? manifest.scripts.build : "";
  /*
  FNXC:WorkspaceBuild 2026-07-15-03:50:
  Bundlers (tsup/esbuild without tsc) emit entry bundles only — never per-source dist mirrors.
  Mapping src/** → dist/** for @runfusion/fusion made every warm build report missing-output and
  force a full CLI rebuild. Only tsc-style packages require per-file dist outputs.
  */
  const isBundledPackage =
    /\b(tsup|esbuild)\b/.test(buildScript) && !/\btsc\b/.test(buildScript);

  if (!isBundledPackage) {
    const sourceFiles = fg.sync(["src/**/*.{ts,tsx,mts,cts}"], {
      cwd: path.join(rootDir, dir),
      onlyFiles: true,
      unique: true,
      ignore: [
        "**/*.d.ts",
        "**/*.test.*",
        "**/__tests__/**",
        "**/__test-utils__/**",
        "**/node_modules/**",
        "**/dist/**",
      ],
    });
    for (const sourceFile of sourceFiles) {
      outputs.add(sourceFile.replace(/^src\//, "dist/").replace(/\.[cm]?[tj]sx?$/, ".js"));
    }
  }
  if (buildScript.includes("copy-css")) {
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
  /*
  FNXC:WorkspaceBuild 2026-07-15-03:20:
  Dashboard client is produced by Vite into dist/client (from app/), not by mapping package src to dist.
  Require the client index so a warm tsc-only dist cannot skip a missing UI build.
  */
  if (/\bvite\b/.test(buildScript)) {
    outputs.add("dist/client/index.html");
  }
  if (manifest.name === "@runfusion/fusion") {
    outputs.add("dist/bin.js");
    outputs.add("dist/extension.js");
  }
  if (outputs.size === 0) outputs.add("dist/index.js");
  return [...outputs].sort((a, b) => a.localeCompare(b)).map((output) => path.posix.join(dir, output));
}

/** Alias — required outputs apply to every workspace package, not only plugins. */
export const requiredPackageOutputs = requiredPluginOutputs;

/**
 * Compute a package input hash using the shared git-backed content hash.
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
export function computePackageSourceHash(pkg, rootDir, { gitFn = defaultGitRunner, snapshot } = {}) {
  const probe = gitFn(["rev-parse", "--is-inside-work-tree"], rootDir);
  if (probe !== "true") return null;
  return computeContentHash({
    rootDir,
    inputPaths: pkg.inputPaths?.length ? pkg.inputPaths : [pkg.dir],
    versionPrefix: `package-build-v${BUILD_CACHE_VERSION}`,
    gitFn,
    snapshot,
  });
}

/** @deprecated Use computePackageSourceHash */
export function computePluginSourceHash(pkg, rootDir, options) {
  return computePackageSourceHash(pkg, rootDir, options);
}

/**
 * Explain whether a package must be built. A skip requires every required
 * output to exist plus a matching successful-build source hash.
 *
 * @param {object} pkg
 * @param {object} options
 * @param {string} options.rootDir
 * @param {{ entries?: Record<string, { sourceHash?: string }> }} options.cache
 * @param {(p: string) => boolean} [options.existsFn]
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 * @param {ReturnType<typeof createRepoContentSnapshot>} [options.snapshot]
 * @param {boolean} [options.force]
 * @returns {{ shouldBuild: boolean, reason: string, sourceHash: string|null, missingOutputs: string[] }}
 */
export function evaluatePackageBuild(pkg, { rootDir, cache, existsFn = existsSync, gitFn = defaultGitRunner, snapshot, force = false } = {}) {
  const missingOutputs = pkg.requiredOutputs.filter((output) => !existsFn(path.join(rootDir, output)));
  const sourceHash = computePackageSourceHash(pkg, rootDir, { gitFn, snapshot });
  if (force) return { shouldBuild: true, reason: "force", sourceHash, missingOutputs };
  if (missingOutputs.length > 0) return { shouldBuild: true, reason: "missing-output", sourceHash, missingOutputs };
  if (sourceHash === null) return { shouldBuild: true, reason: "no-git-hash", sourceHash, missingOutputs };
  const entry = cache?.entries?.[pkg.name];
  if (!entry?.sourceHash) return { shouldBuild: true, reason: "no-cache", sourceHash, missingOutputs };
  if (entry.sourceHash !== sourceHash) return { shouldBuild: true, reason: "changed-inputs", sourceHash, missingOutputs };
  return { shouldBuild: false, reason: "unchanged", sourceHash, missingOutputs };
}

/** @deprecated Use evaluatePackageBuild */
export function evaluatePluginBuild(pkg, options) {
  return evaluatePackageBuild(pkg, options);
}

/**
 * Plan the root build. Every buildable workspace package (plugins and non-plugins)
 * is planned only when the content-hash cache says inputs changed or required
 * outputs/cache entries are missing. Desktop/mobile stay excluded.
 *
 * @param {object} options
 * @param {string} [options.rootDir]
 * @param {object[]} [options.packages]
 * @param {ReturnType<typeof readPluginBuildCache>} [options.cache]
 * @param {(p: string) => boolean} [options.existsFn]
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 * @param {ReturnType<typeof createRepoContentSnapshot>} [options.snapshot]
 * @param {boolean} [options.force]
 * @returns {{ plannedPackages: object[], skippedPackages: object[], skippedPlugins: object[], excludedPackages: object[], packageEvaluations: Map<string, object>, pluginEvaluations: Map<string, object> }}
 */
export function planWorkspaceBuild({ rootDir = repoRoot, packages = discoverWorkspacePackages(rootDir), cache = readPluginBuildCache(rootDir), existsFn = existsSync, gitFn = defaultGitRunner, snapshot, force = false } = {}) {
  const plannedPackages = [];
  const skippedPackages = [];
  const excludedPackages = [];
  const packageEvaluations = new Map();

  for (const pkg of packages) {
    if (!pkg.hasBuild) continue;
    if (ROOT_BUILD_EXCLUDED_PACKAGES.has(pkg.name)) {
      excludedPackages.push(pkg);
      continue;
    }
    const evaluation = evaluatePackageBuild(pkg, { rootDir, cache, existsFn, gitFn, snapshot, force });
    packageEvaluations.set(pkg.name, evaluation);
    if (evaluation.shouldBuild) {
      plannedPackages.push({ ...pkg, buildReason: evaluation.reason, sourceHash: evaluation.sourceHash });
    } else {
      skippedPackages.push({ ...pkg, buildReason: evaluation.reason, sourceHash: evaluation.sourceHash });
    }
  }

  // Back-compat: callers/tests that only inspect skippedPlugins keep working.
  const skippedPlugins = skippedPackages.filter((pkg) => pkg.isPlugin);
  return {
    plannedPackages,
    skippedPackages,
    skippedPlugins,
    excludedPackages,
    packageEvaluations,
    pluginEvaluations: packageEvaluations,
  };
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
export function runPlannedBuilds(plannedPackages, rootDir, spawnFn = spawnSync, { fullPackage = false, env = process.env } = {}) {
  if (plannedPackages.length === 0) return { status: 0, packageNames: [] };
  const packageNames = plannedPackages.map((pkg) => pkg.name);
  const args = [...packageNames.flatMap((name) => ["--filter", name]), "build"];
  /*
   * FNXC:WorkspaceBuild 2026-07-02-15:10:
   * On Windows `pnpm` resolves to a `.cmd` shim; Node refuses to spawn .cmd/.bat without a
   * shell (ENOENT / EINVAL since CVE-2024-27980). Without shell:true the root build failed
   * with `spawn pnpm ENOENT` on Windows. The args are workspace filters + package names
   * (no spaces or shell metacharacters), so shell quoting is safe.
   *
   * FNXC:WorkspaceBuild 2026-07-15-03:20:
   * Propagate FUSION_CLI_FULL_PACKAGE so @runfusion/fusion tsup stages desktop + bundled
   * plugins + DTS only when root build was invoked with --full (or CI already set the env).
   * Day-to-day local builds skip that multi-minute packaging tail.
   */
  const childEnv = {
    ...env,
    ...(fullPackage ? { FUSION_CLI_FULL_PACKAGE: "1" } : {}),
  };
  const result = spawnFn("pnpm", args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: childEnv,
  });
  return { status: result.status ?? 1, packageNames };
}

/**
 * Record hashes for packages that built successfully (plugins and non-plugins).
 *
 * @param {object[]} builtPackages
 * @param {object} options
 * @param {string} options.rootDir
 * @param {ReturnType<typeof readPluginBuildCache>} options.cache
 * @param {(args: string[], cwd: string) => string|null} [options.gitFn]
 */
export function recordSuccessfulPackageBuilds(builtPackages, { rootDir, cache, gitFn = defaultGitRunner } = {}) {
  const nextCache = { version: BUILD_CACHE_VERSION, entries: { ...(cache?.entries ?? {}) } };
  let changed = false;
  const snapshot = createRepoContentSnapshot({ rootDir, gitFn });
  for (const pkg of builtPackages) {
    const sourceHash = computePackageSourceHash(pkg, rootDir, { gitFn, snapshot });
    if (sourceHash === null) continue;
    nextCache.entries[pkg.name] = { sourceHash, builtAt: new Date().toISOString() };
    changed = true;
  }
  if (changed) writePluginBuildCache(rootDir, nextCache);
}

/** @deprecated Use recordSuccessfulPackageBuilds */
export function recordSuccessfulPluginBuilds(builtPackages, options) {
  return recordSuccessfulPackageBuilds(builtPackages, options);
}

function formatPlanLine(pkg) {
  return `${pkg.name} (${pkg.buildReason})`;
}

/*
 * FNXC:WorkspaceBuild 2026-07-10-15:40:
 * FN-7779 stale-plugin-dist: `--plugins-only` narrows the plan to plugin
 * packages so the fast `pnpm dev dashboard` prebuild can incrementally rebuild
 * ONLY changed plugins (reusing the content-hash skip cache) without also
 * rebuilding every non-plugin workspace package. Plugins load their built
 * dist/ at runtime, so a never-rebuilt plugin dist silently runs phantom-old
 * code — exactly the Grok "messages aren't sending" wrong-CLI-flags failure.
 *
 * FNXC:WorkspaceBuild 2026-07-15-03:20:
 * `--force` rebuilds every package ignoring the skip cache. `--full` sets
 * FUSION_CLI_FULL_PACKAGE for the CLI packaging path (desktop + plugins + DTS).
 */
/**
 * FNXC:WorkspaceBuild 2026-07-15-08:15:
 * Greptile P1: a warm fast build caches CLI after emitting only bin.js/extension.js.
 * `pnpm build:full` must still run tsup so desktop/plugins/DTS stage. Force-include
 * @runfusion/fusion whenever fullPackage is requested, even if content-hash says skip.
 */
export function ensureFullPackageCliPlanned(plannedPackages, skippedPackages, { fullPackage = false } = {}) {
  if (!fullPackage) {
    return { plannedPackages, skippedPackages };
  }
  const cliName = "@runfusion/fusion";
  if (plannedPackages.some((pkg) => pkg.name === cliName)) {
    return { plannedPackages, skippedPackages };
  }
  const skippedCli = (skippedPackages ?? []).find((pkg) => pkg.name === cliName);
  if (!skippedCli) {
    return { plannedPackages, skippedPackages };
  }
  return {
    plannedPackages: [
      ...plannedPackages,
      { ...skippedCli, buildReason: "full-package", sourceHash: skippedCli.sourceHash },
    ],
    skippedPackages: (skippedPackages ?? []).filter((pkg) => pkg.name !== cliName),
  };
}

export function main({
  rootDir = repoRoot,
  spawnFn = spawnSync,
  gitFn = defaultGitRunner,
  pluginsOnly = false,
  force = false,
  fullPackage = false,
} = {}) {
  const cache = force ? { version: BUILD_CACHE_VERSION, entries: {} } : readPluginBuildCache(rootDir);
  const snapshot = createRepoContentSnapshot({ rootDir, gitFn });
  const plan = planWorkspaceBuild({ rootDir, cache, gitFn, snapshot, force });
  let plannedPackages = pluginsOnly ? plan.plannedPackages.filter((pkg) => pkg.isPlugin) : plan.plannedPackages;
  let skippedPackages = plan.skippedPackages ?? plan.skippedPlugins;
  if (!pluginsOnly) {
    ({ plannedPackages, skippedPackages } = ensureFullPackageCliPlanned(plannedPackages, skippedPackages, { fullPackage }));
  }
  const plannedNames = plannedPackages.map(formatPlanLine);
  const skippedNames = skippedPackages.map((pkg) => pkg.name);

  const scope = pluginsOnly ? "changed plugins" : "planned builds";
  console.log(`[build-workspace] ${scope}: ${plannedNames.join(", ") || "(none)"}`);
  if (skippedNames.length > 0) {
    console.log(`[build-workspace] skipped unchanged packages: ${skippedNames.join(", ")}`);
  }
  if (fullPackage) {
    console.log("[build-workspace] full CLI packaging enabled (FUSION_CLI_FULL_PACKAGE=1)");
  }

  const result = runPlannedBuilds(plannedPackages, rootDir, spawnFn, { fullPackage });
  if (result.status !== 0) {
    process.stderr.write(`[build-workspace] FAILED packages: ${result.packageNames.join(", ") || "(none)"}\n`);
    return result.status;
  }

  // When force used empty cache for planning, still merge into on-disk cache.
  const persistCache = force ? readPluginBuildCache(rootDir) : cache;
  recordSuccessfulPackageBuilds(plannedPackages, { rootDir, cache: persistCache, gitFn });
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
  const args = process.argv.slice(2);
  const pluginsOnly = args.includes("--plugins-only");
  const force = args.includes("--force");
  const fullPackage = args.includes("--full");
  process.exit(main({ pluginsOnly, force, fullPackage }));
}
