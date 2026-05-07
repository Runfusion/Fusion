#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { ensureTestArtifacts } from "./ensure-test-artifacts.mjs";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";

const currentFilePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(currentFilePath);
const checkIsolationScript = path.join(scriptDir, "check-test-isolation.mjs");

const rootDir = process.env.FUSION_PROJECT_DIR
  ? path.resolve(process.env.FUSION_PROJECT_DIR)
  : process.cwd();

/** @type {string} Cache format version — bump when the shape or hash inputs change. */
const CACHE_FORMAT_VERSION = 1;

/** @type {string} Constant mixed into every content hash so format rev busts all entries. */
const HASH_VERSION_PREFIX = "v1";

/** @type {number} Max age (ms) for a cache entry to count as a pass. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    const error = new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function runIsolationCheck(before = false, env = process.env) {
  const args = [checkIsolationScript];
  if (before) args.push("--before");
  // Inject the names of every isolated HOME this script created so the check
  // never reports them as a leak even if the rm-rf in cleanup silently failed
  // or the baseline file got rotated mid-run. Without this, a transient EBUSY
  // on /var/folders (SQLite WAL still mmap'd, orphan child holding an fd)
  // leaks a `fusion-test-home-root-*` dir and trips the guard.
  const ignoreNames = [...knownIsolatedHomeBasenames].join(",");
  const checkEnv = ignoreNames
    ? { ...env, FUSION_TEST_ISOLATION_IGNORE_NAMES: ignoreNames }
    : env;
  run(process.execPath, args, { env: checkEnv });
}

export function shouldRunIsolationGuard(env = process.env) {
  return env.FUSION_TEST_DISABLE_ISOLATION_GUARD !== "1";
}

function pruneFusionTestHomes() {
  let tmpEntries = [];
  try {
    tmpEntries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of tmpEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith("fusion-test-home-root-")) continue;
    const rawPath = path.join(tmpdir(), entry.name);
    let resolvedPath = rawPath;
    try {
      resolvedPath = realpathSync(rawPath);
    } catch {
      // Keep raw path fallback.
    }
    try {
      rmSync(rawPath, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[test-changed] failed to prune leftover ${rawPath}: ${message}`);
    }
  }
}

function runMaybeIsolated(command, commandArgs, options = {}) {
  const enabled = shouldRunIsolationGuard();
  const env = options.env ?? process.env;
  const { onBeforeAfterCheck, ...spawnOptions } = options;
  if (enabled) runIsolationCheck(true, env);
  try {
    run(command, commandArgs, spawnOptions);
  } finally {
    if (typeof onBeforeAfterCheck === "function") {
      onBeforeAfterCheck();
    }
    pruneFusionTestHomes();
    if (enabled) runIsolationCheck(false, env);
  }
}

function gitOutput(gitArgs) {
  const result = spawnSync("git", gitArgs, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function getBaseBranch() {
  const changesetConfigPath = path.join(rootDir, ".changeset", "config.json");
  const changesetConfig = JSON.parse(readFileSync(changesetConfigPath, "utf8"));
  return changesetConfig.baseBranch || "main";
}

function readWorkspacePatterns(projectRoot = rootDir) {
  try {
    const workspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
    const parsed = parseYaml(readFileSync(workspacePath, "utf8"));
    return Array.isArray(parsed?.packages)
      ? parsed.packages.filter((pattern) => typeof pattern === "string")
      : [];
  } catch {
    return ["packages/*"];
  }
}

function expandWorkspacePattern(projectRoot, pattern) {
  if (pattern.trim().startsWith("!")) {
    return [];
  }

  return fg.sync(workspacePatternToPackageJsonGlob(pattern), {
    absolute: true,
    cwd: projectRoot,
    dot: false,
    onlyFiles: true,
    unique: true,
  });
}

function expandWorkspacePatterns(projectRoot, patterns) {
  if (!patterns.some((pattern) => pattern.trim().startsWith("!"))) {
    return patterns.flatMap((pattern) => expandWorkspacePattern(projectRoot, pattern));
  }

  return fg.sync(patterns.map(workspacePatternToPackageJsonGlob), {
    absolute: true,
    cwd: projectRoot,
    dot: false,
    onlyFiles: true,
    unique: true,
  });
}

function workspacePatternToPackageJsonGlob(pattern) {
  const trimmed = pattern.trim();
  const isNegated = trimmed.startsWith("!");
  const body = (isNegated ? trimmed.slice(1) : trimmed)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const packageJsonGlob = body.endsWith("package.json") ? body : `${body}/package.json`;
  return isNegated ? `!${packageJsonGlob}` : packageJsonGlob;
}

function collectWorkspaceDependencyNames(pkg) {
  return [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ].flatMap((deps) => deps && typeof deps === "object" ? Object.keys(deps) : []);
}

export function listWorkspacePackageInfos({ projectRoot = rootDir } = {}) {
  const packageJsonPaths = [
    ...new Set(expandWorkspacePatterns(projectRoot, readWorkspacePatterns(projectRoot))),
  ];

  return packageJsonPaths
    .map((packageJsonPath) => {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (typeof pkg.name !== "string") {
          return null;
        }

        const dir = path.relative(projectRoot, path.dirname(packageJsonPath)).split(path.sep).join("/");
        return {
          name: pkg.name,
          dir,
          hasTestScript: typeof pkg.scripts?.test === "string",
          dependencyNames: collectWorkspaceDependencyNames(pkg),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function listWorkspacePackages(workspacePackages = listWorkspacePackageInfos()) {
  const packageNameByDir = new Map();
  for (const workspacePackage of workspacePackages) {
    packageNameByDir.set(workspacePackage.dir, workspacePackage.name);
    if (workspacePackage.dir.startsWith("packages/")) {
      packageNameByDir.set(workspacePackage.dir.split("/")[1], workspacePackage.name);
    }
  }

  return packageNameByDir;
}

export function buildPackageDirByName(workspacePackages) {
  const packageDirByName = new Map();
  for (const workspacePackage of workspacePackages) {
    packageDirByName.set(workspacePackage.name, workspacePackage.dir);
  }
  return packageDirByName;
}

export function buildReverseDependencyMap(workspacePackages) {
  const workspaceNames = new Set(workspacePackages.map((workspacePackage) => workspacePackage.name));
  const reverseDependencyMap = new Map(workspacePackages.map((workspacePackage) => [workspacePackage.name, []]));

  for (const workspacePackage of workspacePackages) {
    for (const dependencyName of workspacePackage.dependencyNames ?? []) {
      if (workspaceNames.has(dependencyName)) {
        reverseDependencyMap.get(dependencyName)?.push(workspacePackage.name);
      }
    }
  }

  return reverseDependencyMap;
}

export function expandWithReverseDependents(packageNames, reverseDependencyMap) {
  const expanded = new Set(packageNames);
  const queue = [...packageNames];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of reverseDependencyMap.get(current) ?? []) {
      if (expanded.has(dependent)) continue;
      expanded.add(dependent);
      queue.push(dependent);
    }
  }

  return [...expanded];
}

export function shouldForceFullSuite(changedFiles) {
  const fullSuitePaths = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".changeset/config.json",
    "vitest.workspace.ts",
    "eslint.config.mjs",
    "tsconfig.base.json",
    "scripts/test-with-lock.mjs",
    "scripts/test-changed.mjs",
  ];

  return changedFiles.some((file) => {
    if (fullSuitePaths.includes(file)) {
      return true;
    }

    if (file.startsWith(".github/workflows/") || file.startsWith("scripts/test-") || file.startsWith("scripts/check-test-")) {
      return true;
    }

    if ((file.startsWith("packages/") || file.startsWith("plugins/")) && /vitest|test/.test(path.basename(file))) {
      return false;
    }

    if (!file.startsWith("packages/") && !file.startsWith("plugins/") && !file.startsWith("docs/")) {
      return true;
    }

    return false;
  });
}

function detectComparisonBase(baseBranch) {
  const candidates = [
    `origin/${baseBranch}`,
    `refs/remotes/origin/${baseBranch}`,
    baseBranch,
  ];

  for (const candidate of candidates) {
    const mergeBase = gitOutput(["merge-base", "HEAD", candidate]);
    if (mergeBase) {
      return mergeBase;
    }
  }

  return null;
}

function changedFilesSince(baseSha) {
  const diff = gitOutput(["diff", "--name-only", `${baseSha}...HEAD`]);
  if (diff === null) {
    return null;
  }
  if (!diff) {
    return [];
  }
  return diff.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

export function resolveAffectedPackages(changedFiles, packageNameByDir) {
  const affected = new Set();
  const packageDirs = [...packageNameByDir.keys()]
    .filter((dir) => dir.includes("/"))
    .sort((a, b) => b.length - a.length);

  for (const file of changedFiles) {
    let packageName = null;

    for (const packageDir of packageDirs) {
      if (file === packageDir || file.startsWith(`${packageDir}/`)) {
        packageName = packageNameByDir.get(packageDir);
        break;
      }
    }

    if (!packageName && file.startsWith("packages/")) {
      const [, dir] = file.split("/");
      packageName = packageNameByDir.get(dir) ?? packageNameByDir.get(`packages/${dir}`) ?? null;
    }

    if (!packageName) {
      if (file.startsWith("packages/") || file.startsWith("plugins/")) {
        return null;
      }
      continue;
    }

    affected.add(packageName);
  }

  return [...affected];
}

// ---------------------------------------------------------------------------
// Content-hash cache
// ---------------------------------------------------------------------------

/**
 * @typedef {{ hash: string; passedAt: string; command: string }} CacheEntry
 * @typedef {{ version: number; entries: Record<string, CacheEntry> }} CacheFile
 */

/**
 * Return the path to the per-project test-cache JSON file.
 * Honours FUSION_PROJECT_DIR (already reflected in rootDir).
 *
 * @returns {string}
 */
export function cacheFilePath() {
  return path.join(rootDir, "node_modules", ".cache", "fusion", "test-cache.json");
}

/**
 * Read and parse the cache file. Returns an empty cache structure on any
 * read/parse failure (corruption, missing file, etc.) and logs a warning.
 *
 * @param {string} filePath
 * @returns {CacheFile}
 */
export function readCache(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === CACHE_FORMAT_VERSION &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return parsed;
    }
    console.warn("[test-changed] cache file has unexpected shape; treating as empty.");
    return { version: CACHE_FORMAT_VERSION, entries: {} };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[test-changed] could not read cache (${err.message}); treating as empty.`);
    }
    return { version: CACHE_FORMAT_VERSION, entries: {} };
  }
}

/**
 * Atomically write the cache file (write to temp then rename).
 *
 * @param {string} filePath
 * @param {CacheFile} cache
 */
export function writeCache(filePath, cache) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, filePath);
}

/**
 * Compute a stable content hash for a package directory.
 *
 * The hash is SHA-256 over:
 *   - The constant version prefix HASH_VERSION_PREFIX
 *   - The blob SHA of pnpm-lock.yaml at HEAD
 *   - The blob SHA of tsconfig.base.json at HEAD
 *   - Every (relativePath, blobSha) pair from `git ls-files -s <pkgDir>`,
 *     sorted lexicographically by path for stability.
 *
 * Using git blob SHAs means we never read file contents ourselves — git
 * already hashes them, so this is fast even for large packages.
 *
 * @param {string} packageDir  Relative path to the package dir (e.g. "packages/engine")
 * @param {(args: string[]) => string|null} gitFn  Injectable git runner (for tests)
 * @returns {string} 64-char hex SHA-256
 */
export function computePackageHash(packageDir, gitFn = gitOutput) {
  const hash = createHash("sha256");
  hash.update(HASH_VERSION_PREFIX);
  hash.update("\0");

  // Bust when lock file or shared TS config changes.
  for (const rootFile of ["pnpm-lock.yaml", "tsconfig.base.json"]) {
    // `git ls-files -s <path>` → "<mode> <blobSha> <stage>\t<path>"
    const out = gitFn(["ls-files", "-s", rootFile]);
    const blobSha = out ? out.split(/\s+/)[1] ?? "" : "";
    hash.update(rootFile);
    hash.update("=");
    hash.update(blobSha);
    hash.update("\0");
  }

  // All tracked files inside the package directory.
  const lsOut = gitFn(["ls-files", "-s", packageDir]);
  const entries = [];
  if (lsOut) {
    for (const line of lsOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: <mode> SP <object> SP <stage> TAB <file>
      const tabIdx = trimmed.indexOf("\t");
      if (tabIdx === -1) continue;
      const fields = trimmed.slice(0, tabIdx).split(/\s+/);
      const blobSha = fields[1] ?? "";
      const filePath = trimmed.slice(tabIdx + 1);
      entries.push({ filePath, blobSha });
    }
  }

  // Sort for determinism (git output is usually sorted, but let's be explicit).
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
  for (const { filePath, blobSha } of entries) {
    hash.update(filePath);
    hash.update("=");
    hash.update(blobSha);
    hash.update("\0");
  }

  return hash.digest("hex");
}

/**
 * Return a human-readable relative time string like "3h ago" or "2d ago".
 *
 * @param {string} isoTimestamp
 * @returns {string}
 */
function relativeTime(isoTimestamp) {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * @typedef {Object} CacheOptions
 * @property {boolean} [noCache]       When true, bypass cache reads AND writes.
 * @property {(args: string[]) => string|null} [gitFn]  Injectable git runner.
 * @property {() => CacheFile} [readCacheFn]            Injectable cache reader.
 * @property {(cache: CacheFile) => void} [writeCacheFn] Injectable cache writer.
 * @property {Map<string, string>} [packageDirByName]   pkg-name → relative dir.
 */

/**
 * Apply the content-hash cache to an execution plan.
 *
 * This is a SEPARATE function from decideExecutionPlan so it can be tested
 * independently (decideExecutionPlan remains pure / I/O-free).
 *
 * For "full" plans, cache lookups are always skipped (running full means full).
 * For "changed" plans, any package whose hash matches a fresh cache entry is
 * removed from the run set. If all packages are cached, returns a synthetic
 * "all-cached" result so the caller can skip the pnpm invocation entirely.
 *
 * @param {{ mode: string; packages?: string[]; reason?: string }} plan
 * @param {CacheOptions} [options]
 * @returns {{ plan: typeof plan; cachedPackages: string[]; activePackages: string[] }}
 */
export function applyCacheToPlan(plan, options = {}) {
  const {
    noCache = false,
    gitFn = gitOutput,
    readCacheFn,
    writeCacheFn,
    packageDirByName = new Map(),
  } = options;

  // Full suite runs always bypass cache (full means full).
  if (plan.mode !== "changed" || noCache) {
    return { plan, cachedPackages: [], activePackages: plan.packages ?? [] };
  }

  const filePath = cacheFilePath();
  const cache = readCacheFn ? readCacheFn() : readCache(filePath);
  const now = Date.now();

  const cachedPackages = [];
  const activePackages = [];

  for (const pkg of plan.packages ?? []) {
    const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
    const computedHash = computePackageHash(pkgDir, gitFn);
    const entry = cache.entries[pkg];

    const isHit =
      entry &&
      entry.hash === computedHash &&
      now - new Date(entry.passedAt).getTime() < CACHE_MAX_AGE_MS;

    if (isHit) {
      const sha7 = computedHash.slice(0, 7);
      const when = relativeTime(entry.passedAt);
      console.log(`[test-changed] cache HIT  for ${pkg} (hash ${sha7}, passed ${when})`);
      cachedPackages.push(pkg);
    } else {
      activePackages.push(pkg);
    }
  }

  return { plan, cachedPackages, activePackages };
}

/**
 * Persist passing results for the given packages into the cache.
 *
 * @param {string[]} packages
 * @param {Map<string, string>} packageDirByName
 * @param {CacheOptions} [options]
 */
export function recordCachePass(packages, packageDirByName, options = {}) {
  const {
    noCache = false,
    gitFn = gitOutput,
    readCacheFn,
    writeCacheFn,
  } = options;

  if (noCache || packages.length === 0) return;

  const filePath = cacheFilePath();
  const cache = readCacheFn ? readCacheFn() : readCache(filePath);
  const now = new Date().toISOString();

  for (const pkg of packages) {
    const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
    const hash = computePackageHash(pkgDir, gitFn);
    cache.entries[pkg] = { hash, passedAt: now, command: "test" };
  }

  if (writeCacheFn) {
    writeCacheFn(cache);
  } else {
    writeCache(filePath, cache);
  }
}

// ---------------------------------------------------------------------------
// Execution plan
// ---------------------------------------------------------------------------

const workspaceConcurrency = process.env.FUSION_TEST_WORKSPACE_CONCURRENCY || "2";

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function defaultTestWorkerBudget(env = process.env) {
  const cpuCap = Math.max(1, cpus().length - 1);
  const defaultTotal = Math.min(12, Math.max(4, cpuCap));
  const totalWorkers = parsePositiveInteger(env.FUSION_TEST_TOTAL_WORKERS) ?? defaultTotal;
  const concurrency = Math.max(
    1,
    Math.min(parsePositiveInteger(env.FUSION_TEST_CONCURRENCY) ?? 2, totalWorkers),
  );

  return {
    totalWorkers,
    concurrency,
  };
}

const { totalWorkers, concurrency } = defaultTestWorkerBudget(process.env);

const isolatedHomesToCleanup = new Set();
// Basenames of every fusion-test-home-root-* dir this process has minted.
// Passed to check-test-isolation.mjs via env so it allow-lists them
// unconditionally, even if cleanup's rm silently failed.
const knownIsolatedHomeBasenames = new Set();

function cleanupIsolatedHomePath(homePath) {
  try {
    rmSync(homePath, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[test-changed] failed to remove isolated HOME ${homePath}: ${message}`);
  }
  isolatedHomesToCleanup.delete(homePath);
}

function cleanupIsolatedHomes() {
  for (const homePath of isolatedHomesToCleanup) {
    cleanupIsolatedHomePath(homePath);
  }
}

process.on("exit", cleanupIsolatedHomes);
process.on("SIGINT", () => {
  cleanupIsolatedHomes();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupIsolatedHomes();
  process.exit(143);
});

export function createIsolatedHomeEnv(env = process.env) {
  const rawIsolatedHome = mkdtempSync(path.join(tmpdir(), "fusion-test-home-root-"));
  const isolatedHome = realpathSync(rawIsolatedHome);
  isolatedHomesToCleanup.add(rawIsolatedHome);
  isolatedHomesToCleanup.add(isolatedHome);
  knownIsolatedHomeBasenames.add(path.basename(rawIsolatedHome));
  knownIsolatedHomeBasenames.add(path.basename(isolatedHome));

  const nextEnv = {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
  };

  if (process.platform === "win32") {
    const match = isolatedHome.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      nextEnv.HOMEDRIVE = match[1];
      nextEnv.HOMEPATH = match[2] || "\\";
    }
  }

  return { env: nextEnv, isolatedHome };
}

const fullSuiteEnv = {
  ...process.env,
  FUSION_TEST_TOTAL_WORKERS: process.env.FUSION_TEST_TOTAL_WORKERS || String(totalWorkers),
  FUSION_TEST_CONCURRENCY: process.env.FUSION_TEST_CONCURRENCY || String(concurrency),
};

export function decideExecutionPlan({
  forceFullSuite,
  comparisonBase,
  changedFiles,
  packageNameByDir,
  reverseDependencyMap,
}) {
  if (forceFullSuite) return { mode: "full", reason: "forced" };
  if (!comparisonBase) return { mode: "full", reason: "missing-comparison-base" };
  if (!changedFiles) return { mode: "full", reason: "diff-failed" };
  if (changedFiles.length === 0) return { mode: "full", reason: "no-changes" };
  if (shouldForceFullSuite(changedFiles)) return { mode: "full", reason: "shared-infra-changed" };

  const affectedPackages = resolveAffectedPackages(changedFiles, packageNameByDir);
  if (!affectedPackages || affectedPackages.length === 0) return { mode: "full", reason: "no-affected-package" };

  return {
    mode: "changed",
    packages: reverseDependencyMap
      ? expandWithReverseDependents(affectedPackages, reverseDependencyMap)
      : affectedPackages,
  };
}

export function main(argv = process.argv.slice(2)) {
  const forceFullSuite =
    process.env.CI === "true" ||
    process.env.FUSION_TEST_FULL === "1" ||
    argv.includes("--full");

  const noCache =
    process.env.FUSION_TEST_NO_CACHE === "1" ||
    argv.includes("--no-cache");

  const forwardedArgs = argv.filter((arg) => arg !== "--full" && arg !== "--no-cache");

  run("pnpm", ["sync:fusion-skill:check"]);
  ensureTestArtifacts(rootDir);

  const { env: isolatedHomeEnv, isolatedHome } = createIsolatedHomeEnv(fullSuiteEnv);

  const cleanupIsolatedHome = () => {
    cleanupIsolatedHomePath(isolatedHome);
  };

  try {

  const baseBranch = getBaseBranch();
  const comparisonBase = detectComparisonBase(baseBranch);
  const changedFiles = comparisonBase ? changedFilesSince(comparisonBase) : null;
  const workspacePackages = listWorkspacePackageInfos();
  const packageNameByDir = listWorkspacePackages(workspacePackages);
  const packageDirByName = buildPackageDirByName(workspacePackages);
  const reverseDependencyMap = buildReverseDependencyMap(workspacePackages);

  const plan = decideExecutionPlan({
    forceFullSuite,
    comparisonBase,
    changedFiles,
    packageNameByDir,
    reverseDependencyMap,
  });

  if (plan.mode === "full") {
    if (plan.reason === "missing-comparison-base") {
      console.log(`[test-changed] could not resolve merge-base with ${baseBranch}; running full suite.`);
    } else if (plan.reason === "diff-failed") {
      console.log("[test-changed] failed to read git diff; running full suite.");
    } else if (plan.reason === "no-changes") {
      console.log("[test-changed] no changes detected against base; running full suite.");
    } else if (plan.reason === "shared-infra-changed") {
      console.log("[test-changed] shared/root test infrastructure changed; running full suite.");
    } else if (plan.reason === "no-affected-package") {
      console.log("[test-changed] no affected workspace package resolved; running full suite.");
    }

    runMaybeIsolated("pnpm", [`-r`, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs], {
      env: isolatedHomeEnv,
      onBeforeAfterCheck: cleanupIsolatedHome,
    });
    return;
  }

  // Apply the content-hash cache to prune already-passing packages.
  const { cachedPackages, activePackages } = applyCacheToPlan(plan, {
    noCache: noCache || forceFullSuite,
    packageDirByName,
  });

  if (activePackages.length === 0) {
    console.log(
      `[test-changed] all changed packages are cache-fresh (${cachedPackages.join(", ")}); nothing to run.`,
    );
    if (shouldRunIsolationGuard()) {
      runIsolationCheck(true, isolatedHomeEnv);
      cleanupIsolatedHome();
      runIsolationCheck(false, isolatedHomeEnv);
    }
    return;
  }

  const filterArgs = activePackages.flatMap((pkg) => ["--filter", pkg]);
  console.log(`[test-changed] running tests for changed packages: ${activePackages.join(", ")}`);
  if (cachedPackages.length > 0) {
    console.log(`[test-changed] skipping cached packages: ${cachedPackages.join(", ")}`);
  }

  runMaybeIsolated("pnpm", [...filterArgs, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs], {
    env: isolatedHomeEnv,
    onBeforeAfterCheck: cleanupIsolatedHome,
  });

  // Tests passed — record in cache (never cache failures; process.exit on failure above).
  recordCachePass(activePackages, packageDirByName, { noCache });
  } finally {
    cleanupIsolatedHome();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  try {
    main();
  } catch (error) {
    if (error?.exitCode) {
      process.exit(error.exitCode);
    }
    throw error;
  }
}
