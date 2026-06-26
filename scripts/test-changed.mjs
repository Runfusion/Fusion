#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, mkdtempSync, rmSync, realpathSync, globSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ensureTestArtifacts } from "./ensure-test-artifacts.mjs";
import { isSkillSyncCheckCached } from "./sync-fusion-skill-tools.mjs";
import { computeContentHash, createRepoContentSnapshot } from "./lib/content-hash.mjs";
import { deriveBudgetMs, runWithWatchdog } from "./lib/run-vitest-watchdog.mjs";

/** Generous local full-suite budget (60min): far above a real full run, far below an infinite hang. */
const FULL_SUITE_BUDGET_MS = 60 * 60 * 1000;

const currentFilePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(currentFilePath);
const checkIsolationScript = path.join(scriptDir, "check-test-isolation.mjs");
const require = createRequire(import.meta.url);

function fastGlobSync(patterns, options) {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];
  const matches = new Set();

  for (const pattern of patternList) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    const isNegated = pattern.startsWith("!");
    const body = isNegated ? pattern.slice(1) : pattern;
    const resolved = globSync(body, {
      cwd: options?.cwd,
      absolute: options?.absolute,
      dot: options?.dot,
      nodir: options?.onlyFiles,
    });

    for (const entry of resolved) {
      if (isNegated) {
        matches.delete(entry);
      } else {
        matches.add(entry);
      }
    }
  }

  return [...matches];
}

let fgSync = fastGlobSync;
try {
  const loaded = require("fast-glob");
  if (typeof loaded?.sync === "function") {
    fgSync = loaded.sync;
  }
} catch {
  // Fallback to node:fs globSync when fast-glob is not installed.
}

function parseWorkspacePackagesFromYaml(rawYaml) {
  const lines = rawYaml.split(/\r?\n/);
  const packages = [];
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inPackages) {
      if (trimmed === "packages:") {
        inPackages = true;
      }
      continue;
    }

    if (!trimmed) continue;
    if (!trimmed.startsWith("-")) {
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        break;
      }
      continue;
    }

    const value = trimmed.slice(1).trim().replace(/^['"]|['"]$/g, "");
    if (value) packages.push(value);
  }

  return packages;
}

const rootDir = process.env.FUSION_PROJECT_DIR
  ? path.resolve(process.env.FUSION_PROJECT_DIR)
  : process.cwd();

/** @type {string} Cache format version — bump when the shape or hash inputs change. */
const CACHE_FORMAT_VERSION = 1;

/**
 * @type {string} Constant mixed into every content hash so format rev busts all entries.
 *
 * U4 bumped v1 -> v2: the hash now (a) folds in every transitive workspace
 * dependency's own-hash, (b) folds in the shared `packages/core/src/__test-utils__`
 * tree globally, and (c) hashes working-tree bytes for dirty/untracked files
 * instead of trusting the (stale) index blob SHA. Any of these shifts the digest,
 * so the bump invalidates every pre-U4 entry exactly once.
 */
const HASH_VERSION_PREFIX = "v2";

/**
 * @type {string[]} Repo-relative paths whose content is folded into EVERY
 * package's hash. These are shared inputs that any package's test run depends on
 * regardless of the workspace dependency graph:
 *   - pnpm-lock.yaml / tsconfig.base.json: global build/resolution config.
 *   - packages/core/src/__test-utils__: the shared vitest setup/teardown/workers
 *     helpers are imported by nearly every package's vitest config via a relative
 *     cross-package path (e.g. `../../core/src/__test-utils__/vitest-setup.ts`),
 *     INCLUDING packages that have no `@fusion/core` workspace dependency
 *     (mobile, droid-cli, pi-*, and every plugin/example). Dep-aware hashing
 *     alone would miss those, so we fold the tree in globally — the simplest
 *     provably-correct choice (mirrors the tsconfig.base.json treatment).
 *
 * NOTE: this list intentionally overlaps `isSharedInfraChange`'s
 * `fullSuitePaths` (which decides full-suite mode, a different axis than cache
 * busting). When adding a new shared root config input, consider both lists.
 */
const SHARED_HASH_INPUT_PATHS = [
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "packages/core/src/__test-utils__",
];

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

function runIsolationCheck(before = false, env = process.env, fastBefore = false) {
  const args = [checkIsolationScript];
  // U3: the before-pass is the costly one (2s mutability probe). Use the cheap
  // `--before-fast` variant, which reuses the prior run's externally-active
  // classification and skips the probe. The script falls back to the full probe
  // when no prior baseline exists, so detection is never weakened.
  if (before) args.push(fastBefore ? "--before-fast" : "--before");
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

// U3: bound the prune scan. It only ever targets our own
// `fusion-test-home-root-*` prefix (it always did), but we additionally cap the
// number of entries removed per call and skip very-fresh dirs, so a single run
// can't spend unbounded time rm-rf'ing a tmpdir that accumulated thousands of
// stale homes — and so the cache-fresh fast path can skip it entirely.
const PRUNE_MAX_ENTRIES = 64;
let cleanupRmSync = rmSync;
const PRUNE_REMOVE_RETRIES = 3;
const PRUNE_REMOVE_DELAY_MS = 75;
const PRUNE_DIAGNOSTIC_CHILD_LIMIT = 8;
const FUSION_WORKER_ROOT_OWNER_FILE = ".fusion-test-worker-root-owner";
const FUSION_TEST_RUN_TOKEN_ENV = "FUSION_TEST_RUN_TOKEN";
const LEGACY_MARKERLESS_ACTIVE_ROOT_MAX_AGE_MS = 30_000;

function ensureFusionTestRunToken(env = process.env) {
  const existing = env[FUSION_TEST_RUN_TOKEN_ENV];
  if (typeof existing === "string" && existing.trim().length > 0) return existing;
  const token = randomUUID();
  env[FUSION_TEST_RUN_TOKEN_ENV] = token;
  return token;
}

ensureFusionTestRunToken();

function isEnoentError(err) {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

let processAliveForTests = null;

export function __setProcessAliveForTests(nextProcessAlive) {
  processAliveForTests = typeof nextProcessAlive === "function" ? nextProcessAlive : null;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (processAliveForTests) return Boolean(processAliveForTests(pid));
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function readWorkerRootOwnerInfo(rootPath) {
  try {
    const raw = readFileSync(path.join(rootPath, FUSION_WORKER_ROOT_OWNER_FILE), "utf8").trim();
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pid = Number.parseInt(lines[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const info = { pid, runToken: null };
    for (const line of lines.slice(1)) {
      const match = /^runToken=(.+)$/.exec(line);
      if (match) info.runToken = match[1];
    }
    return info;
  } catch {
    return null;
  }
}

function hasCurrentRunToken(ownerInfo) {
  const currentToken = process.env[FUSION_TEST_RUN_TOKEN_ENV];
  return Boolean(ownerInfo?.runToken && currentToken && ownerInfo.runToken === currentToken);
}

function isFreshLegacyMarkerlessRoot(rootPath) {
  try {
    return Date.now() - statSync(rootPath).mtimeMs <= LEGACY_MARKERLESS_ACTIVE_ROOT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function isActiveFusionWorkerRoot(rootPath) {
  const ownerInfo = readWorkerRootOwnerInfo(rootPath);
  if (ownerInfo !== null && isProcessAlive(ownerInfo.pid)) {
    if (ownerInfo.pid === process.pid || hasCurrentRunToken(ownerInfo)) return true;
    // FN-6396/FN-6360 recurrence: bare pid liveness is not enough evidence.
    // macOS can recycle a dead Vitest owner's pid to an unrelated process, so
    // the pnpm-test prune must require the same-run token before preserving the
    // root. Otherwise stale fusion-test-workers-* shells survive to the after
    // check-test-isolation pass and fail the merge gate.
  }

  // Backward-compatible guard for markerless roots. New roots are marked by
  // globalSetup or by vitest-setup's self-minted fallback path; old markerless
  // redir roots are only considered active while very fresh, preventing stale
  // redir-<pid> pid reuse from keeping orphans alive forever.
  try {
    for (const child of readdirSync(rootPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const match = /^redir-(\d+)$/.exec(child.name);
      if (!match) continue;
      const redirPid = Number.parseInt(match[1], 10);
      if (!isProcessAlive(redirPid)) continue;
      if (redirPid === process.pid || (ownerInfo && hasCurrentRunToken(ownerInfo)) || isFreshLegacyMarkerlessRoot(rootPath)) {
        return true;
      }
    }
  } catch {
    // If we cannot inspect it, fall through to normal best-effort pruning.
  }
  return false;
}

function listImmediateChildrenForPruneWarning(rootPath) {
  try {
    const children = readdirSync(rootPath).slice(0, PRUNE_DIAGNOSTIC_CHILD_LIMIT);
    if (children.length === 0) return "";
    const suffix = children.length === PRUNE_DIAGNOSTIC_CHILD_LIMIT ? ", ..." : "";
    return `; remaining children: ${children.join(", ")}${suffix}`;
  } catch {
    return "";
  }
}

function removePrunedRootWithRetry(rawPath, { retries = PRUNE_REMOVE_RETRIES, delayMs = PRUNE_REMOVE_DELAY_MS } = {}) {
  if (!existsSync(rawPath)) return true;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // FN-6371/FN-6360: macOS can report a transient ENOTEMPTY/EBUSY while
      // child handles inside an orphaned fusion-test-* root are still closing.
      // Keep this a short bounded retry (not a long live-root deletion loop) and
      // keep the surrounding scan single-level/prefix-capped.
      cleanupRmSync(rawPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (isEnoentError(err)) return true;
      lastError = err;
      if (attempt < retries) {
        sleepMsSync(delayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const children = listImmediateChildrenForPruneWarning(rawPath);
  console.warn(`[test-changed] failed to prune leftover ${rawPath} after ${retries} attempts: ${message}${children}`);
  return false;
}

function pruneFusionTestRoots(prefix, maxEntries = PRUNE_MAX_ENTRIES, retryOptions = {}) {
  let tmpEntries = [];
  try {
    tmpEntries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  let processed = 0;
  for (const entry of tmpEntries) {
    if (processed >= maxEntries) break;
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    processed++;
    const rawPath = path.join(tmpdir(), entry.name);
    try {
      realpathSync(rawPath);
    } catch {
      // Keep raw path fallback.
    }
    if (isActiveFusionWorkerRoot(rawPath)) continue;
    removePrunedRootWithRetry(rawPath, retryOptions);
  }
}

export function pruneFusionTestHomes(maxEntries = PRUNE_MAX_ENTRIES, retryOptions = {}) {
  pruneFusionTestRoots("fusion-test-home-root-", maxEntries, retryOptions);
}

export function pruneFusionTestWorkers(maxEntries = PRUNE_MAX_ENTRIES, retryOptions = {}) {
  pruneFusionTestRoots("fusion-test-workers-", maxEntries, retryOptions);
}

// Run a test invocation under the L2 wall-clock watchdog (async). Throws on
// failure/timeout/signal with an `.exitCode` — same shape as `run` — so the
// caller's catch and the `finally` cleanup below behave identically. On a
// watchdog kill the child group is already dead, and the `finally` prune +
// isolation post-check then reap any leaked isolated HOME (no leak slips past
// the guard).
async function runWatchedTest(command, commandArgs, { env, budgetMs, label } = {}) {
  const { code, signal, timedOut } = await runWithWatchdog({
    command,
    args: commandArgs,
    env: env ?? process.env,
    // Preserve the original `run`'s fixed working directory; pnpm must execute
    // from the repo root regardless of where test-changed was invoked.
    cwd: rootDir,
    budgetMs,
    label: label ?? `${command} ${commandArgs.join(" ")}`,
    log: console.error,
    spawn,
  });
  if (timedOut || signal || code !== 0) {
    const reason = timedOut ? "watchdog timeout" : signal ? `signal ${signal}` : `exit code ${code}`;
    const error = new Error(`${command} ${commandArgs.join(" ")} failed (${reason})`);
    error.exitCode = timedOut ? 124 : signal ? 1 : code ?? 1;
    throw error;
  }
}

async function runMaybeIsolated(command, commandArgs, options = {}) {
  const enabled = shouldRunIsolationGuard();
  /*
   * FNXC:TestInfrastructure 2026-06-15-12:12:
   * Conflict resolution for PR #1669 must keep main's per-run temp-root token so cleanup can distinguish live roots while still passing watchdog budgets and labels into async test invocations.
   */
  const env = { ...(options.env ?? process.env), [FUSION_TEST_RUN_TOKEN_ENV]: ensureFusionTestRunToken(options.env ?? process.env) };
  const { onBeforeAfterCheck, budgetMs, label, ...spawnOptions } = options;
  void spawnOptions; // cwd/stdio defaults live in the watchdog/spawn path now
  if (enabled) runIsolationCheck(true, env, /* fastBefore */ true);
  try {
    await runWatchedTest(command, commandArgs, { env, budgetMs, label });
  } finally {
    if (typeof onBeforeAfterCheck === "function") {
      onBeforeAfterCheck();
    }
    pruneFusionTestHomes();
    pruneFusionTestWorkers();
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

// FNXC:TestInfrastructure 2026-06-25-00:00:
// Exported so the test-free verification path (scripts/verify-fast.mjs) reuses
// the SAME base-branch / comparison-base / changed-file / workspace-resolution
// logic instead of reinventing git-diff. verify:fast runs typecheck + build +
// boot-smoke (no test suite) and must scope to exactly the packages a
// changed-only run would scope to.
export function getBaseBranch() {
  const changesetConfigPath = path.join(rootDir, ".changeset", "config.json");
  const changesetConfig = JSON.parse(readFileSync(changesetConfigPath, "utf8"));
  return changesetConfig.baseBranch || "main";
}

function readWorkspacePatterns(projectRoot = rootDir) {
  try {
    const workspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
    return parseWorkspacePackagesFromYaml(readFileSync(workspacePath, "utf8"));
  } catch {
    return ["packages/*"];
  }
}

function expandWorkspacePattern(projectRoot, pattern) {
  if (pattern.trim().startsWith("!")) {
    return [];
  }

  return fgSync(workspacePatternToPackageJsonGlob(pattern), {
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

  return fgSync(patterns.map(workspacePatternToPackageJsonGlob), {
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

export function listWorkspacePackages(workspacePackages = listWorkspacePackageInfos()) {
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

/**
 * Build forward dependency map: package name → [workspace dependency names].
 * Only workspace-internal dependencies are included (external npm deps are
 * already captured by the shared pnpm-lock.yaml hash).
 *
 * @param {{ name: string, dependencyNames?: string[] }[]} workspacePackages
 * @returns {Map<string, string[]>}
 */
export function buildForwardDependencyMap(workspacePackages) {
  const workspaceNames = new Set(workspacePackages.map((p) => p.name));
  const forwardDependencyMap = new Map();
  for (const pkg of workspacePackages) {
    const deps = (pkg.dependencyNames ?? []).filter((dep) => workspaceNames.has(dep) && dep !== pkg.name);
    forwardDependencyMap.set(pkg.name, [...new Set(deps)]);
  }
  return forwardDependencyMap;
}

/**
 * Collect the transitive closure of workspace dependencies for a package
 * (excluding the package itself), returned sorted for hash stability.
 *
 * @param {string} packageName
 * @param {Map<string, string[]>} forwardDependencyMap
 * @returns {string[]} sorted transitive dependency names
 */
export function collectTransitiveDependencies(packageName, forwardDependencyMap) {
  const seen = new Set();
  const queue = [...(forwardDependencyMap.get(packageName) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current) || current === packageName) continue;
    seen.add(current);
    for (const next of forwardDependencyMap.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
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

// FN-5154 / FN-5157: root docs, changeset summaries, and .fusion artifacts should not expand changed-only test runs into a full workspace suite.
function isTestIrrelevantRootPath(file) {
  if (file.startsWith(".fusion/")) {
    return true;
  }

  if (/^\.changeset\/[^/]+\.md$/.test(file)) {
    return true;
  }

  if (!file.includes("/") && file.toLowerCase().endsWith(".md")) {
    return true;
  }

  // The quarantine list is runtime DATA (which tests are skipped), not
  // executable test infra. Editing it must not trip the root catch-all below
  // and force gate mode — gate mode drops affected-package coverage, so a
  // dev's real changes would go untested just because they touched the list.
  if (file === "scripts/lib/test-quarantine.json") {
    return true;
  }

  return ["README", "CHANGELOG.md", "LICENSE", "LICENSE.md"].includes(file);
}

export function isSharedInfraChange(changedFiles) {
  // NOTE: overlaps SHARED_HASH_INPUT_PATHS by intent (different axis: this list
  // signals shared-infra changes; that one busts every package's cache hash).
  // When adding a new shared root config input, consider both lists.
  //
  // HISTORY: previously named `shouldForceFullSuite` — this signal used to
  // escalate `pnpm test` to an implicit full
  // recursive run — which was the local OOM path (two concurrent heavy
  // packages, 6GB dashboard heaps). Since the merge-gate redesign
  // (docs/plans/2026-06-04-001-refactor-fast-trusted-test-gate-plan.md) it
  // routes to GATE mode instead: run the merge-gate suite and point at
  // `pnpm test:full` for the explicit full sweep. The full suite only ever
  // runs on explicit opt-in (--full / FUSION_TEST_FULL=1).
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

    if (isTestIrrelevantRootPath(file)) {
      return false;
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

export function detectComparisonBase(baseBranch) {
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

export function changedFilesSince(baseSha) {
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
 * Adapt a 1-arg test-changed gitFn `(args) => string|null` into the 2-arg
 * `(args, cwd) => string|null` shape that scripts/lib/content-hash.mjs expects.
 * The cwd is ignored because the inner-loop gitFn already runs with cwd=rootDir.
 *
 * @param {(args: string[]) => string|null} gitFn
 * @returns {(args: string[], cwd: string) => string|null}
 */
function adaptGitFnForContentHash(gitFn) {
  return (args) => gitFn(args);
}

/**
 * Compute the OWN content hash for a single package directory: a SHA-256 over
 * just that directory's files, WITHOUT any shared inputs or transitive deps.
 *
 * R11 / U4 correctness: this defers to scripts/lib/content-hash.mjs, which hashes
 * the working-tree bytes of dirty (modified-tracked) and untracked-not-ignored
 * files instead of the stale index blob SHA. The pre-U4 implementation used
 * `git ls-files -s` (index only), so an UNSTAGED edit to a tracked file produced
 * an identical hash → a false cache HIT that skipped a package whose on-disk
 * source had actually changed. Routing through computeContentHash fixes that.
 *
 * Results are memoized per (packageDir, gitFn) for the lifetime of a `memo` Map
 * so that folding a dependency's own-hash into many dependents stays O(packages),
 * not O(packages^2).
 *
 * @param {string} packageDir  Relative path to the package dir (e.g. "packages/engine")
 * @param {(args: string[]) => string|null} gitFn  Injectable git runner (for tests)
 * @param {Map<string, string>} [memo]  Per-call memo keyed by packageDir.
 * @returns {string} 64-char hex SHA-256
 */
export function computeOwnHash(packageDir, gitFn = gitOutput, memo, snapshot) {
  if (memo?.has(packageDir)) return memo.get(packageDir);

  const ownHash = computeContentHash({
    rootDir,
    inputPaths: [packageDir],
    versionPrefix: `${HASH_VERSION_PREFIX}:own`,
    gitFn: adaptGitFnForContentHash(gitFn),
    snapshot,
  });

  memo?.set(packageDir, ownHash);
  return ownHash;
}

/**
 * Compute the hash for the SHARED inputs folded into every package's hash
 * (pnpm-lock.yaml, tsconfig.base.json, and the shared __test-utils__ tree).
 * Memoized per call so it's computed at most once per run.
 *
 * @param {(args: string[]) => string|null} gitFn
 * @param {Map<string, string>} [memo]
 * @returns {string}
 */
function computeSharedInputsHash(gitFn = gitOutput, memo, snapshot) {
  const memoKey = "\0shared-inputs\0";
  if (memo?.has(memoKey)) return memo.get(memoKey);

  const sharedHash = computeContentHash({
    rootDir,
    inputPaths: SHARED_HASH_INPUT_PATHS,
    versionPrefix: `${HASH_VERSION_PREFIX}:shared`,
    gitFn: adaptGitFnForContentHash(gitFn),
    snapshot,
  });

  memo?.set(memoKey, sharedHash);
  return sharedHash;
}

/**
 * Compute the dependency-aware cache hash for a package directory.
 *
 * The hash is SHA-256 over, in a stable order:
 *   - The constant version prefix HASH_VERSION_PREFIX.
 *   - The shared-inputs hash (pnpm-lock.yaml + tsconfig.base.json + the shared
 *     packages/core/src/__test-utils__ tree).
 *   - The package's own dirty-aware content hash.
 *   - Every TRANSITIVE workspace dependency's own dirty-aware hash, sorted by
 *     dependency name.
 *
 * Folding transitive dependencies in means a change to (say) @fusion/core busts
 * the cache entry of every package that transitively depends on it, even when
 * the dependent's own files are untouched — closing the R11 correctness hole
 * where a stale-but-own-hash-matching dependent could be cache-skipped after its
 * dependency's source changed.
 *
 * @param {string} packageDir  Relative path to the package dir (e.g. "packages/engine")
 * @param {(args: string[]) => string|null} gitFn  Injectable git runner (for tests)
 * @param {object} [options]
 * @param {string} [options.packageName]  Package name, to resolve transitive deps.
 * @param {Map<string, string[]>} [options.forwardDependencyMap]  name → [dep names].
 * @param {Map<string, string>} [options.packageDirByName]  name → relative dir.
 * @param {Map<string, string>} [options.memo]  Per-run own-hash memo (perf).
 * @param {object} [options.snapshot]  Repo-wide content snapshot (from
 *        createRepoContentSnapshot — 2 git spawns total) shared across all hash
 *        computations in a run; without it each own-hash pays its own spawns.
 * @returns {string} 64-char hex SHA-256
 */
export function computePackageHash(packageDir, gitFn = gitOutput, options = {}) {
  const { packageName, forwardDependencyMap, packageDirByName, memo = new Map(), snapshot } = options;

  const hash = createHash("sha256");
  hash.update(HASH_VERSION_PREFIX);
  hash.update("\0");

  // Shared inputs (lockfile, base tsconfig, shared __test-utils__ tree).
  hash.update("shared=");
  hash.update(computeSharedInputsHash(gitFn, memo, snapshot));
  hash.update("\0");

  // This package's own dirty-aware content.
  hash.update("own=");
  hash.update(computeOwnHash(packageDir, gitFn, memo, snapshot));
  hash.update("\0");

  // Transitive workspace dependencies' own hashes (sorted by name for stability).
  if (packageName && forwardDependencyMap && packageDirByName) {
    const transitiveDeps = collectTransitiveDependencies(packageName, forwardDependencyMap);
    for (const depName of transitiveDeps) {
      const depDir = packageDirByName.get(depName);
      if (!depDir) continue; // Unknown dir (defensive); skip rather than crash.
      hash.update("dep:");
      hash.update(depName);
      hash.update("=");
      hash.update(computeOwnHash(depDir, gitFn, memo, snapshot));
      hash.update("\0");
    }
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
 * @property {Map<string, string[]>} [forwardDependencyMap] pkg-name → workspace dep names.
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
    forwardDependencyMap = new Map(),
    // Shared per-RUN memo + repo snapshot: main() passes the same pair to
    // recordCachePass so the record pass re-spawns zero git and re-hashes
    // nothing (test runs don't modify hashed source).
    memo = new Map(),
    snapshot,
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
    const computedHash = computePackageHash(pkgDir, gitFn, {
      packageName: pkg,
      forwardDependencyMap,
      packageDirByName,
      memo,
      snapshot,
    });
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
    forwardDependencyMap = new Map(),
    // When main() passes the memo/snapshot already populated by
    // applyCacheToPlan, every hash below is a memo hit — zero git spawns.
    memo = new Map(),
    snapshot,
  } = options;

  if (noCache || packages.length === 0) return;

  const filePath = cacheFilePath();
  const cache = readCacheFn ? readCacheFn() : readCache(filePath);
  const now = new Date().toISOString();

  for (const pkg of packages) {
    const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
    const hash = computePackageHash(pkgDir, gitFn, {
      packageName: pkg,
      forwardDependencyMap,
      packageDirByName,
      memo,
      snapshot,
    });
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
export const knownIsolatedHomeBasenames = new Set();

export function __setCleanupRmSyncForTests(nextRmSync) {
  cleanupRmSync = typeof nextRmSync === "function" ? nextRmSync : rmSync;
}

function sleepMsSync(ms) {
  if (ms <= 0) return;
  spawnSync("sleep", [String(ms / 1000)], { stdio: "ignore" });
}

/**
 * Retry isolated HOME cleanup synchronously to absorb transient EBUSY races
 * (common on macOS when Vitest workers still hold file descriptors briefly).
 * If cleanup still fails, check-test-isolation gets an allow-list of every
 * minted fusion-test-home-root-* basename to avoid false leak failures.
 */
export function cleanupIsolatedHomePath(homePath, retries = 3, delayMs = 75) {
  try {
    if (!existsSync(homePath)) return;

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        cleanupRmSync(homePath, { recursive: true, force: true });
        return;
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          return;
        }
        lastError = err;
        if (attempt < retries) {
          sleepMsSync(delayMs);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(`[test-changed] failed to remove isolated HOME ${homePath} after ${retries} attempts: ${message}`);
  } finally {
    isolatedHomesToCleanup.delete(homePath);
  }
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

  const inheritedHome = env.HOME || env.USERPROFILE;
  const corepackHome = env.COREPACK_HOME || (inheritedHome
    ? path.join(inheritedHome, ".cache", "node", "corepack")
    : undefined);

  const nextEnv = {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ...(corepackHome ? { COREPACK_HOME: corepackHome } : {}),
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

export function createTestProcessEnv(env = process.env) {
  /*
  FNXC:TestInfrastructure 2026-06-17-17:02:
  Developer shells and release scripts can export NODE_ENV=production, but Vitest must resolve React, Testing Library, and Vite transforms through their test/development paths. Normalize spawned test processes here so pnpm test cannot inherit production React test-utils and stall/fail jsdom lanes.
  */
  return {
    ...env,
    NODE_ENV: "test",
  };
}

const fullSuiteEnv = {
  ...createTestProcessEnv(process.env),
  FUSION_TEST_TOTAL_WORKERS: process.env.FUSION_TEST_TOTAL_WORKERS || String(totalWorkers),
  FUSION_TEST_CONCURRENCY: process.env.FUSION_TEST_CONCURRENCY || String(concurrency),
};

/*
FNXC:TestInfrastructure 2026-06-21-10:42:
Reverse-dependent blast cap thresholds. A foundational-package edit (e.g.
@fusion/core) reverse-expands to ~the whole workspace; capping past 60% of a
workspace of at least 8 packages keeps a one-line core edit from triggering a
25-package vitest sweep, while leaving leaf-package expansion (a few dependents)
and small synthetic test fixtures untouched.
*/
export const WIDE_REVERSE_DEPENDENT_FRACTION = 0.6;
export const MIN_WORKSPACE_FOR_BLAST_CAP = 8;

export function decideExecutionPlan({
  forceFullSuite,
  comparisonBase,
  changedFiles,
  packageNameByDir,
  reverseDependencyMap,
}) {
  if (forceFullSuite) return { mode: "full", reason: "forced" };
  // Every implicit wide-blast condition below routes to GATE mode (merge-gate
  // suite only), never to an implicit full-suite run — the old escalation was
  // the local OOM path. `pnpm test:full` is the explicit opt-in full sweep.
  if (!comparisonBase) return { mode: "gate", reason: "missing-comparison-base" };
  if (!changedFiles) return { mode: "gate", reason: "diff-failed" };
  if (changedFiles.length === 0) return { mode: "gate", reason: "no-changes" };
  if (isSharedInfraChange(changedFiles)) return { mode: "gate", reason: "shared-infra-changed" };

  const affectedPackages = resolveAffectedPackages(changedFiles, packageNameByDir);
  if (!affectedPackages || affectedPackages.length === 0) return { mode: "gate", reason: "no-affected-package" };

  if (!reverseDependencyMap) return { mode: "changed", packages: affectedPackages };

  const expanded = expandWithReverseDependents(affectedPackages, reverseDependencyMap);

  /*
  FNXC:TestInfrastructure 2026-06-21-10:42:
  Cap the reverse-dependent fan-out for foundational-package edits. A single
  `@fusion/core` source change reverse-expands to ~the entire workspace (every
  package imports core), so `pnpm test` bundled all 25 packages into one
  `vitest --changed` invocation that ran for the full 20-min `changed`-class
  watchdog ceiling and pinned the task (the engine runs project testCommand
  "pnpm test" as its verification gate; on timeout the task fully restarts and
  re-runs the sweep, stacking into hours). When expansion balloons past most of
  a real (non-fixture) workspace, test only the DIRECTLY changed packages scoped
  and delegate cross-cutting reverse-dependent coverage to the merge-gate suite,
  which already runs first in changed mode and is the project's thin/trusted net.
  Guarded by MIN_WORKSPACE_FOR_BLAST_CAP so tiny synthetic maps still expand fully.
  */
  const totalPackages = reverseDependencyMap.size;
  const expandedBeyondDirect = expanded.length > affectedPackages.length;
  const isWideBlast =
    totalPackages >= MIN_WORKSPACE_FOR_BLAST_CAP &&
    expanded.length >= Math.ceil(totalPackages * WIDE_REVERSE_DEPENDENT_FRACTION);
  if (expandedBeyondDirect && isWideBlast) {
    return { mode: "changed", packages: affectedPackages, reason: "reverse-dependent-blast-capped" };
  }

  return { mode: "changed", packages: expanded };
}

/**
 * R5: Emit one structured line describing why the inner loop chose its mode.
 * Shape: `[test-changed] mode=<changed|full> reason=<reason> packages=<n>`.
 *
 * For changed plans the reason is `changed-packages`; for full plans the
 * reason mirrors decideExecutionPlan's reason field.
 *
 * @param {{ mode: string, reason?: string, packages?: string[] }} plan
 * @param {(line: string) => void} [log]
 * @returns {string} the emitted line (for testing)
 */
export function emitModeDecision(plan, log = console.log) {
  const reason = plan.mode === "changed" ? (plan.reason ?? "changed-packages") : (plan.reason ?? "unknown");
  const packageCount = plan.mode === "changed" ? (plan.packages?.length ?? 0) : 0;
  const line = `[test-changed] mode=${plan.mode} reason=${reason} packages=${packageCount}`;
  log(line);
  return line;
}

const VITEST_CONFIG_BASENAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
];

/**
 * Whether a package can be run with `vitest --changed` scoping. True only when
 * the package directory has a vitest config — otherwise the caller falls back to
 * the package's own `test` script (e.g. desktop's `tsx scripts/test.ts`).
 *
 * @param {string|undefined} pkgDir  repo-relative package dir (e.g. "packages/engine")
 * @param {string} [projectRoot]
 * @returns {boolean}
 */
export function packageHasVitestConfig(pkgDir, projectRoot = rootDir) {
  if (!pkgDir) return false;
  return VITEST_CONFIG_BASENAMES.some((name) => existsSync(path.join(projectRoot, pkgDir, name)));
}

/*
FNXC:TestInfrastructure 2026-06-26-13:05:
Scoped-affected worker fan-out was raised 1 -> 4 (operator decision). It was 1
purely for OOM safety (FN-6854/FN-6874: heavy affected lanes OS-OOM-SIGKILLed
even at concurrency=1). Two things make 4 acceptable now: (1) the wide-fan-out
guard below bounds each heavy lane to a few directly-changed test files, so the
hundreds-of-files set that drove the OOM no longer reaches these workers; (2) the
heap cap stays 6144MB PER WORKER, so this lane can now use up to ~4x6GB ≈ 24GB —
fine on the 256GB host, but if a RAM-constrained CI runner OOM-SIGKILLs a heavy
lane again, lower this back toward 1 (or drop the per-worker heap) rather than
widening timeouts. This intentionally trades the FN-5048 "don't raise worker
knobs" guidance for throughput, scoped to the bounded affected lanes only.
*/
export const ENGINE_SCOPED_AFFECTED_PACKAGE = "@fusion/engine";
export const ENGINE_SCOPED_AFFECTED_HEAP_MB = "6144";
export const ENGINE_SCOPED_AFFECTED_WORKERS = "4";
export const DASHBOARD_SCOPED_AFFECTED_PACKAGE = "@fusion/dashboard";
export const DASHBOARD_SCOPED_AFFECTED_HEAP_MB = "6144";
export const DASHBOARD_SCOPED_AFFECTED_WORKERS = "4";
export const CORE_SCOPED_AFFECTED_PACKAGE = "@fusion/core";
export const CORE_SCOPED_AFFECTED_HEAP_MB = "6144";
export const CORE_SCOPED_AFFECTED_WORKERS = "4";

/*
FNXC:TestInfrastructure 2026-06-26-12:40:
`@fusion/core` is a memory-envelope/wide-fan-out package too — it was the
remaining `pnpm test` timeout path after engine/dashboard were bounded. core is
the hub nearly every package imports and has ~354 test files (db.test 21s,
mission-store 16s, ...). A non-test core SOURCE edit (e.g. store.ts/db.ts) makes
`vitest --changed` expand to ~the whole core suite at this real-git +
sqlite-heavy lane and blow past the engine's 15-min verification kill, which then
SIGKILLs `pnpm test` and RESTARTS the task — stacked 15-min timeouts. Listing
core here makes `partitionScopedAffectedPackages` treat it as its own
memory-envelope group so the wide-fan-out guard (run only directly-changed core
test files, else delegate) and the bounded heap/worker env both apply. core is
intentionally NOT in GATE_COVERED_MEMORY_ENVELOPE_PACKAGES (the gate runs no core
suite), so a delegated core lane emits the loud "not covered by gate; run
`pnpm test:full`" warning rather than a silent false-green.
*/
export const SCOPED_AFFECTED_MEMORY_ENVELOPES = Object.freeze({
  [ENGINE_SCOPED_AFFECTED_PACKAGE]: Object.freeze({
    packageName: ENGINE_SCOPED_AFFECTED_PACKAGE,
    heapMb: ENGINE_SCOPED_AFFECTED_HEAP_MB,
    workers: ENGINE_SCOPED_AFFECTED_WORKERS,
  }),
  [DASHBOARD_SCOPED_AFFECTED_PACKAGE]: Object.freeze({
    packageName: DASHBOARD_SCOPED_AFFECTED_PACKAGE,
    heapMb: DASHBOARD_SCOPED_AFFECTED_HEAP_MB,
    workers: DASHBOARD_SCOPED_AFFECTED_WORKERS,
  }),
  [CORE_SCOPED_AFFECTED_PACKAGE]: Object.freeze({
    packageName: CORE_SCOPED_AFFECTED_PACKAGE,
    heapMb: CORE_SCOPED_AFFECTED_HEAP_MB,
    workers: CORE_SCOPED_AFFECTED_WORKERS,
  }),
});

/*
FNXC:TestInfrastructure 2026-06-26-09:15:
Which heavy memory-envelope packages the merge gate (`pnpm test:gate`) genuinely
re-covers when the wide-fan-out guard delegates their cross-cutting coverage.
The gate runs `@fusion/engine test:core` (a curated engine-core allow-list) plus
the CI-shape test — it runs NO `@fusion/dashboard` tests. So a delegated engine
lane still gets a real (curated subset) safety net, but a delegated dashboard
lane gets ZERO gate coverage and would be a silent false-green. Treat dashboard
delegation as a loud "not covered by the gate; CI full-suite.yml is the backstop"
warning instead of a reassuring "delegated to the gate" message.
*/
export const GATE_COVERED_MEMORY_ENVELOPE_PACKAGES = Object.freeze(new Set([ENGINE_SCOPED_AFFECTED_PACKAGE]));

export function prependNodeOption(currentOptions, option) {
  return [option, currentOptions || ""].join(" ").trim();
}

export function createScopedAffectedMemoryEnvelopeEnv(packageName, env = process.env) {
  const envelope = SCOPED_AFFECTED_MEMORY_ENVELOPES[packageName];
  if (!envelope) return env;
  /*
  FNXC:TestInfrastructure 2026-06-21-11:24:
  The engine affected lane can select hundreds of real-git-heavy files when `vitest --changed` sees a widely imported boundary. Run that scoped lane in its own memory envelope: cap Node old-space like the dashboard heap runner and bound Vitest worker fan-out (see SCOPED_AFFECTED_WORKERS) so the lane returns a real pass/fail verdict instead of an OS OOM SIGKILL. Keep watchdog timing outside this env so hangs still fail through `runWithWatchdog`.

  FNXC:TestInfrastructure 2026-06-21-16:28:
  FN-6874 showed the dashboard changed-mode affected lane can OOM/SIGKILL even with `FUSION_TEST_CONCURRENCY=1 FUSION_TEST_WORKSPACE_CONCURRENCY=1`, so worker fan-out alone is not the failure mode. Give each heavy scoped package its own bounded heap envelope while preserving caller env and keeping the finite changed-class watchdog outside this env so hangs still fail instead of being masked.
  */
  return {
    ...env,
    NODE_OPTIONS: prependNodeOption(env.NODE_OPTIONS, `--max-old-space-size=${envelope.heapMb}`),
    FUSION_TEST_TOTAL_WORKERS: envelope.workers,
    FUSION_TEST_CONCURRENCY: envelope.workers,
    VITEST_MAX_WORKERS: envelope.workers,
  };
}

export function createEngineScopedAffectedEnv(env = process.env) {
  return createScopedAffectedMemoryEnvelopeEnv(ENGINE_SCOPED_AFFECTED_PACKAGE, env);
}

export function createDashboardScopedAffectedEnv(env = process.env) {
  return createScopedAffectedMemoryEnvelopeEnv(DASHBOARD_SCOPED_AFFECTED_PACKAGE, env);
}

export function partitionScopedAffectedPackages(packages) {
  const memoryEnvelopePackages = Object.keys(SCOPED_AFFECTED_MEMORY_ENVELOPES);
  const memoryEnvelopePackageSet = new Set(memoryEnvelopePackages);
  const requestedPackageSet = new Set(packages);
  const regularPackages = packages.filter((pkg) => !memoryEnvelopePackageSet.has(pkg));
  const groups = [];
  if (regularPackages.length > 0) {
    groups.push({ packages: regularPackages, engineMemoryEnvelope: false, memoryEnvelopePackage: null, memoryEnvelope: null });
  }
  for (const packageName of memoryEnvelopePackages) {
    if (!requestedPackageSet.has(packageName)) continue;
    groups.push({
      packages: [packageName],
      engineMemoryEnvelope: packageName === ENGINE_SCOPED_AFFECTED_PACKAGE,
      memoryEnvelopePackage: packageName,
      memoryEnvelope: SCOPED_AFFECTED_MEMORY_ENVELOPES[packageName],
    });
  }
  return groups;
}

/**
 * Fraction of a heavy package's affected-lane work that, once a non-test source
 * file in its module graph changes, is delegated to the merge gate instead of
 * run via the unbounded `vitest --changed` graph expansion. See the FNXC note on
 * `changedSourceFilesAffectingPackage`.
 */
export function isTestFilePath(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/*
FNXC:TestInfrastructure 2026-06-26-09:15:
`changedFiles` comes from `git diff --name-only`, which lists DELETED and
renamed-away `.test`/`.spec` paths alongside live ones. Those paths no longer
exist on disk, but the wide-fan-out guard passes its picks positionally to
`vitest run <file>` (via `path.relative`). A removed test path reaching Vitest
makes the bounded changed lane fail on a file that is gone instead of treating
the deletion as the no-test-left case. Filter the directly-changed test files
to paths that still EXIST on disk; if every changed test in the package was a
deletion the result is empty, and the caller must then take the same
delegate-to-the-gate path as the "no changed test files" case rather than
handing Vitest an empty/garbage positional set.
*/
/**
 * Directly-changed, still-on-disk test files inside a package directory.
 * @param {string[]|null|undefined} changedFiles  repo-relative diff paths
 * @param {string} pkgDir  repo-relative package dir (e.g. "packages/engine")
 * @param {{ projectRoot?: string }} [opts]
 * @returns {string[]}
 */
/*
FNXC:TestInfrastructure 2026-06-26-13:40:
Existence checks for changed test files must anchor at the GIT REPO ROOT, not
`rootDir` (which falls back to `process.cwd()`). `git diff --name-only` returns
repo-root-relative paths regardless of the cwd it runs from, so joining them
against a `rootDir` that is a package SUBDIR (script run from a package without
FUSION_PROJECT_DIR) would form a doubled path (packages/x/packages/x/...), make
`existsSync` false, and silently DROP live changed tests into the delegate path.
Resolve the toplevel once via git so the check is correct from any cwd inside the
repo; fall back to rootDir if git can't report a toplevel.
*/
let _repoToplevelCache;
function repoRootForExistence() {
  if (_repoToplevelCache !== undefined) return _repoToplevelCache;
  const top = gitOutput(["rev-parse", "--show-toplevel"]);
  _repoToplevelCache = top && top.trim() ? top.trim() : rootDir;
  return _repoToplevelCache;
}

export function existingChangedTestFilesInPackage(changedFiles, pkgDir, { projectRoot = repoRootForExistence() } = {}) {
  return (changedFiles ?? []).filter(
    (file) =>
      isTestFilePath(file) &&
      (file === pkgDir || file.startsWith(`${pkgDir}/`)) &&
      existsSync(path.join(projectRoot, file)),
  );
}

/*
FNXC:TestInfrastructure 2026-06-25-14:30:
Why this guard exists (root cause of "pnpm test takes >15min and gets killed"):
A heavy memory-envelope package (@fusion/engine, @fusion/dashboard) runs its
affected lane at workers=1 for OOM safety (FN-6854/FN-6874). `vitest --changed
<base>` does UNBOUNDED transitive module-graph expansion: a single hub source
edit (measured: a `packages/engine/src/self-healing.ts` change selected 8393
matched test entries, and merely *listing* them took ~79s / 341s CPU). Running
that near-full suite at one worker blows past the engine's per-task verification
budget (VERIFICATION_TIMEOUT_WORKSPACE_MS = 900_000 ms / 15 min in
packages/engine/src/verification-utils.ts). The engine then SIGKILLs `pnpm test`
mid-run and RESTARTS the whole task, which re-runs the same lane -> stacked
15-min timeouts (~9 observed in one task, ~2.8h wasted). The script's own 20-min
`changed`-class watchdog ceiling is looser than that 15-min kill, so it never
engages: the "bounded/changed-only" contract is silently violated.

The fan-out only happens when a NON-test SOURCE file in the package's module
graph (its own dir OR any transitive workspace-dependency dir, e.g. @fusion/core
for engine) changes; a test-file-only diff never expands. So for heavy
envelope packages we return the list of changed non-test source files affecting
the package; when non-empty, the caller runs only the directly-changed test
files (bounded to the diff) and delegates cross-cutting coverage to the
merge-gate suite that already ran first in changed mode -- the same "delegate to
the gate" philosophy as the reverse-dependent blast cap. `pnpm test:full`
remains the explicit full sweep. This keeps the bounded path actually bounded
without widening any timeout, adding retries, or raising worker/concurrency.
*/
export function changedSourceFilesAffectingPackage(
  packageName,
  changedFiles,
  { packageDirByName, forwardDependencyMap },
) {
  const graphDirs = new Set();
  const ownDir = packageDirByName?.get(packageName);
  if (ownDir) graphDirs.add(ownDir);
  for (const depName of collectTransitiveDependencies(packageName, forwardDependencyMap ?? new Map())) {
    const depDir = packageDirByName?.get(depName);
    if (depDir) graphDirs.add(depDir);
  }
  // The shared __test-utils__ tree is imported by virtually every package's
  // vitest config; a change there also fans out wide, so treat it as in-graph.
  graphDirs.add("packages/core/src/__test-utils__");

  return (changedFiles ?? []).filter((file) => {
    if (isTestFilePath(file)) return false;
    if (isTestIrrelevantRootPath(file)) return false;
    for (const dir of graphDirs) {
      if (file === dir || file.startsWith(`${dir}/`)) return true;
    }
    return false;
  });
}

export function normalizeForwardedArgs(argv) {
  const normalized = [];

  for (const arg of argv) {
    if (arg === "--full" || arg === "--no-cache") continue;
    if (arg === "--silent" || arg.startsWith("--silent=")) continue;
    normalized.push(arg);
  }

  return normalized;
}

export async function main(argv = process.argv.slice(2)) {
  // The full suite is explicit opt-in ONLY (--full / FUSION_TEST_FULL=1).
  // CI no longer routes through this script (the gate job runs `pnpm
  // test:gate`; the demoted tier runs `test:ci:shard` in full-suite.yml), so
  // the old `CI === "true"` force-full branch is gone.
  const forceFullSuite =
    process.env.FUSION_TEST_FULL === "1" ||
    argv.includes("--full");

  const noCache =
    process.env.FUSION_TEST_NO_CACHE === "1" ||
    argv.includes("--no-cache");

  const forwardedArgs = normalizeForwardedArgs(argv);

  // Dry mode-decision probe (R5): compute and print the mode/reason line without
  // running tests. Used by `node scripts/test-changed.mjs --print-mode`.
  if (argv.includes("--print-mode") || argv.includes("--help")) {
    const baseBranch = getBaseBranch();
    const comparisonBase = detectComparisonBase(baseBranch);
    const changedFiles = comparisonBase ? changedFilesSince(comparisonBase) : null;
    const workspacePackages = listWorkspacePackageInfos();
    const packageNameByDir = listWorkspacePackages(workspacePackages);
    const reverseDependencyMap = buildReverseDependencyMap(workspacePackages);
    const plan = decideExecutionPlan({
      forceFullSuite,
      comparisonBase,
      changedFiles,
      packageNameByDir,
      reverseDependencyMap,
    });
    emitModeDecision(plan);
    return;
  }

  // Decide the execution plan and apply the cache BEFORE paying any fixed setup
  // cost. The cache-fresh fast path can then skip the skill-sync spawn, the
  // artifact-ensure pass, isolated-HOME creation, and the prune scan entirely.
  const baseBranch = getBaseBranch();
  const comparisonBase = detectComparisonBase(baseBranch);
  const changedFiles = comparisonBase ? changedFilesSince(comparisonBase) : null;
  const workspacePackages = listWorkspacePackageInfos();
  const packageNameByDir = listWorkspacePackages(workspacePackages);
  const packageDirByName = buildPackageDirByName(workspacePackages);
  const reverseDependencyMap = buildReverseDependencyMap(workspacePackages);
  const forwardDependencyMap = buildForwardDependencyMap(workspacePackages);

  const plan = decideExecutionPlan({
    forceFullSuite,
    comparisonBase,
    changedFiles,
    packageNameByDir,
    reverseDependencyMap,
  });

  // R5: structured mode-decision telemetry so fast-path hit rate is observable.
  emitModeDecision(plan);

  // For changed plans, resolve the cache now so we know whether any package
  // actually needs running before we spend setup time.
  let cachedPackages = [];
  let activePackages = plan.packages ?? [];
  // One repo-wide content snapshot (2 git spawns) + one own-hash memo for the
  // entire run: applyCacheToPlan populates them, recordCachePass reuses them,
  // so per-package git spawns and re-hashing happen exactly once per run.
  const hashMemo = new Map();
  let hashSnapshot;
  if (plan.mode === "changed") {
    if (!(noCache || forceFullSuite)) {
      hashSnapshot = createRepoContentSnapshot({ rootDir });
    }
    ({ cachedPackages, activePackages } = applyCacheToPlan(plan, {
      noCache: noCache || forceFullSuite,
      packageDirByName,
      forwardDependencyMap,
      memo: hashMemo,
      snapshot: hashSnapshot,
    }));
  }

  // Gate mode always has work: the merge-gate suite is not covered by the
  // per-package cache (it spans engine + cli with its own selection), so it
  // must never short-circuit through the cache-fresh fast path.
  const hasWork = plan.mode === "full" || plan.mode === "gate" || activePackages.length > 0;

  // Cache-fresh fast path: nothing to run. Emit a fast-path mode line, run only
  // the (now cheap) isolation guard, and skip skill-sync, artifact-ensure,
  // HOME creation, and prune.
  //
  // NOTE: this path is reachable only in CHANGED mode (gate mode sets hasWork
  // above), and it intentionally skips the merge-gate suite too: an all-cache-
  // fresh changed run means the engine/cli content feeding the gate suite is
  // byte-identical to a previously green run. Any shared-infra change that
  // could invalidate that reasoning routes to gate mode instead of here.
  if (!hasWork) {
    console.log("[test-changed] fast-path=cache-fresh (no packages to run).");
    console.log(
      `[test-changed] all changed packages are cache-fresh (${cachedPackages.join(", ")}); nothing to run.`,
    );
    if (shouldRunIsolationGuard()) {
      // No isolated HOME was created and no tests ran, so there is nothing to
      // prune and no real risk of a leak — but we still run a single cheap
      // before/after guard pass to preserve the invariant that every `pnpm test`
      // verifies isolation.
      runIsolationCheck(true, process.env, /* fastBefore */ true);
      runIsolationCheck(false, process.env);
    }
    return;
  }

  // There is work to do — pay the fixed setup cost now.
  // U3: skip the skill-sync check spawn when its inputs are unchanged since the
  // last passing run. Full runs (CI / --full) always run it unconditionally so
  // the gate never goes silent on the path that actually enforces it.
  if (forceFullSuite || !isSkillSyncCheckCached(rootDir)) {
    run("pnpm", ["sync:fusion-skill:check"]);
  } else {
    console.log("[test-changed] skill-sync check skipped (inputs unchanged since last pass).");
  }
  ensureTestArtifacts(rootDir);

  const { env: isolatedHomeEnv, isolatedHome } = createIsolatedHomeEnv(fullSuiteEnv);

  const cleanupIsolatedHome = () => {
    cleanupIsolatedHomePath(isolatedHome);
  };

  try {

  if (plan.mode === "full") {
    // Explicit opt-in only ("forced": --full / FUSION_TEST_FULL=1).
    await runMaybeIsolated("pnpm", [`-r`, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs], {
      env: isolatedHomeEnv,
      onBeforeAfterCheck: cleanupIsolatedHome,
      budgetMs: FULL_SUITE_BUDGET_MS,
      label: "test:full (-r)",
    });
    return;
  }

  if (plan.mode === "gate") {
    if (plan.reason === "missing-comparison-base") {
      console.log(`[test-changed] could not resolve merge-base with ${baseBranch}; running merge-gate suite.`);
    } else if (plan.reason === "diff-failed") {
      console.log("[test-changed] failed to read git diff; running merge-gate suite.");
    } else if (plan.reason === "no-changes") {
      console.log("[test-changed] no changes detected against base; running merge-gate suite.");
    } else if (plan.reason === "shared-infra-changed") {
      console.log("[test-changed] shared/root test infrastructure changed; running merge-gate suite.");
    } else if (plan.reason === "no-affected-package") {
      console.log("[test-changed] no affected workspace package resolved; running merge-gate suite.");
    }
    console.log("[test-changed] need the full sweep instead? run `pnpm test:full` (explicit opt-in).");

    await runMaybeIsolated("pnpm", ["test:gate"], {
      env: isolatedHomeEnv,
      onBeforeAfterCheck: cleanupIsolatedHome,
      budgetMs: deriveBudgetMs({ klass: "changed" }),
      label: "test:gate",
    });
    return;
  }

  // Changed mode: merge-gate suite first, then the affected set. The gate is
  // cheap (~10s) and keeps `pnpm test` green ⇒ mergeable-signal honest; the
  // affected expansion preserves changed-code coverage. Overlap (engine in the
  // affected set re-runs the engine-core files) is accepted by design.
  console.log("[test-changed] running merge-gate suite (pnpm test:gate) before affected packages.");
  // Run the gate under the same isolation guard as the affected set — a gate
  // suite leak must trip the checker, not silently become the "before" state
  // of the later run.
  await runMaybeIsolated("pnpm", ["test:gate"], {
    env: isolatedHomeEnv,
    budgetMs: deriveBudgetMs({ klass: "changed" }),
    label: "test:gate (pre-affected)",
  });

  if (plan.reason === "reverse-dependent-blast-capped") {
    // FNXC:TestInfrastructure 2026-06-21-10:42: surface the cap so coverage is never silently dropped.
    console.log(
      "[test-changed] reverse-dependent fan-out capped: a foundational-package edit reverse-expanded to most of the workspace. " +
        "Testing only the directly changed packages scoped; cross-cutting reverse-dependent coverage is delegated to the merge-gate suite (ran above).",
    );
  }
  console.log(`[test-changed] running tests for changed packages: ${activePackages.join(", ")}`);
  if (cachedPackages.length > 0) {
    console.log(`[test-changed] skipping cached packages: ${cachedPackages.join(", ")}`);
  }

  // Scope the affected run to only the tests in the module graph of the changed
  // files (`vitest --changed <base>`) instead of each package's ENTIRE suite.
  // A dashboard task otherwise re-ran all 822 dashboard test files (~5-8 min);
  // scoping keeps verification proportional to the diff. Packages without a
  // vitest config (or when we have no base to diff against) fall back to their
  // full `test` script so coverage is never silently dropped. The curated gate
  // suite already ran above as the cross-cutting safety net.
  const scopable = comparisonBase
    ? activePackages.filter((pkg) => packageHasVitestConfig(packageDirByName.get(pkg)))
    : [];
  const fallbackPkgs = activePackages.filter((pkg) => !scopable.includes(pkg));

  // FNXC:TestInfrastructure 2026-06-25-14:30: heavy-package lanes that hit the
  // wide-fan-out guard (below) are NOT fully tested — they run only their
  // directly-changed test files or delegate entirely to the gate. Exclude them
  // from the pass-cache so a later run re-evaluates instead of trusting a
  // partial pass as a full one.
  const notFullyTestedPackages = new Set();

  for (const { packages, mode, memoryEnvelopePackage = null } of [
    ...partitionScopedAffectedPackages(scopable).map((group) => ({ ...group, mode: "scoped" })),
    { packages: fallbackPkgs, mode: "full" },
  ]) {
    if (packages.length === 0) continue;

    // Wide-fan-out guard: for a heavy memory-envelope package (engine/dashboard,
    // always its own single-package group), a changed non-test source file in its
    // module graph would make `vitest --changed` expand to ~the full suite and run
    // it at workers=1 past the engine's 15-min verification timeout. Run only the
    // directly-changed test files instead and delegate the rest to the merge gate.
    let explicitChangedTestFiles = null;
    if (mode === "scoped" && memoryEnvelopePackage) {
      const pkg = packages[0];
      const wideSource = changedSourceFilesAffectingPackage(pkg, changedFiles, {
        packageDirByName,
        forwardDependencyMap,
      });
      if (wideSource.length > 0) {
        const pkgDir = packageDirByName.get(pkg) ?? `packages/${pkg.replace(/^@[^/]+\//, "")}`;
        // Filter to test files that still EXIST on disk: `git diff --name-only`
        // includes deleted/renamed-away `.test` paths, and a removed path passed
        // positionally to `vitest run` (line ~1720) would fail the bounded lane
        // on a file that no longer exists. An all-deletions diff yields an empty
        // list, which falls into the same delegate-to-gate `continue` below as
        // the no-changed-tests case (FNXC:TestInfrastructure 2026-06-26-09:15).
        explicitChangedTestFiles = existingChangedTestFilesInPackage(changedFiles, pkgDir);
        notFullyTestedPackages.add(pkg);
        // FNXC:TestInfrastructure 2026-06-26-09:15: the gate re-covers a delegated
        // engine lane (curated engine-core subset) but runs NO dashboard tests, so
        // a delegated dashboard lane is uncovered. Don't claim "delegated to the
        // gate" for packages the gate doesn't run — warn loudly and name the real
        // backstop (CI full-suite.yml / `pnpm test:full`) so the gap is visible.
        const gateCovered = GATE_COVERED_MEMORY_ENVELOPE_PACKAGES.has(pkg);
        const wideSourceDesc = `${wideSource[0]}${wideSource.length > 1 ? `, +${wideSource.length - 1} more` : ""}`;
        const delegationNote = gateCovered
          ? "delegating wider `vitest --changed` coverage to the merge-gate suite (curated engine-core subset ran above)."
          : `the merge gate does NOT run ${pkg} tests, so this wider coverage is NOT re-run here; ` +
            "CI full-suite.yml (non-blocking, on push to main) is the backstop. Run `pnpm test:full` for the full sweep.";
        if (explicitChangedTestFiles.length === 0) {
          const log = gateCovered ? console.log : console.warn;
          log(
            `[test-changed] ${pkg}: a changed non-test source file (${wideSourceDesc}) ` +
              "would fan `vitest --changed` out to ~the full suite at this heavy memory-envelope lane; " +
              `no directly-changed ${pkg} test file to run, so ${delegationNote}`,
          );
          continue;
        }
        const log = gateCovered ? console.log : console.warn;
        log(
          `[test-changed] ${pkg}: changed non-test source detected; running ONLY the ${explicitChangedTestFiles.length} directly-changed test file(s); ` +
            delegationNote,
        );
      }
    }

    const filterArgs = packages.flatMap((pkg) => ["--filter", pkg]);
    const pkgDirForScope = memoryEnvelopePackage
      ? packageDirByName.get(packages[0]) ?? `packages/${packages[0].replace(/^@[^/]+\//, "")}`
      : null;
    const scopeSelectorArgs =
      explicitChangedTestFiles && explicitChangedTestFiles.length > 0
        ? explicitChangedTestFiles.map((file) => path.relative(pkgDirForScope, file))
        : ["--changed", comparisonBase];
    const commandArgs =
      mode === "scoped"
        ? [
            ...filterArgs,
            `--workspace-concurrency=${workspaceConcurrency}`,
            "exec",
            "vitest",
            "run",
            ...scopeSelectorArgs,
            "--passWithNoTests",
            "--silent=passed-only",
            "--reporter=dot",
            ...forwardedArgs,
          ]
        : [...filterArgs, `--workspace-concurrency=${workspaceConcurrency}`, "test", ...forwardedArgs];
    const memoryEnvelopeLabel = memoryEnvelopePackage ? ` (${memoryEnvelopePackage} memory envelope)` : "";
    console.log(
      mode === "scoped"
        ? `[test-changed] scoped (${explicitChangedTestFiles?.length ? "changed-files" : "vitest --changed"}) run for: ${packages.join(", ")}${memoryEnvelopeLabel}`
        : `[test-changed] full package-suite run for: ${packages.join(", ")} (no vitest config / no base)`,
    );
    await runMaybeIsolated("pnpm", commandArgs, {
      env: memoryEnvelopePackage
        ? createScopedAffectedMemoryEnvelopeEnv(memoryEnvelopePackage, isolatedHomeEnv)
        : isolatedHomeEnv,
      onBeforeAfterCheck: cleanupIsolatedHome,
      // Scoped runs are proportional to the diff, so the tight "changed" ceiling
      // applies; a hang fails fast instead of blocking the 60-min full backstop.
      // Full fallback runs keep the generous backstop.
      budgetMs: mode === "scoped" ? deriveBudgetMs({ klass: "changed" }) : FULL_SUITE_BUDGET_MS,
      label: `affected (${mode}): ${packages.join(", ")}`,
    });
  }

  // Tests passed — record in cache (never cache failures; process.exit on failure above).
  // Skip partially-tested/delegated heavy packages so a partial pass is never
  // cached as a full one (FNXC:TestInfrastructure 2026-06-25-14:30).
  const recordablePackages = activePackages.filter((pkg) => !notFullyTestedPackages.has(pkg));
  recordCachePass(recordablePackages, packageDirByName, {
    noCache,
    forwardDependencyMap,
    memo: hashMemo,
    snapshot: hashSnapshot,
  });
  } finally {
    cleanupIsolatedHome();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().catch((error) => {
    if (error?.exitCode) {
      process.exit(error.exitCode);
    }
    console.error(error);
    process.exit(1);
  });
}
