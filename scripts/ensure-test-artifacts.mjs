#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeContentHash,
  defaultGitRunner,
  fusionCacheDir,
  readJsonCache,
} from "./lib/content-hash.mjs";

export const REQUIRED_BUILD_PACKAGES = [
  {
    name: "@fusion/core",
    requiredArtifacts: ["packages/core/dist/index.js"],
    sourceInputs: ["packages/core/src"],
  },
  {
    name: "@fusion/dashboard",
    requiredArtifacts: ["packages/dashboard/dist/index.js"],
    // Dashboard's `vite build && tsc` reads both app/ and src/.
    sourceInputs: ["packages/dashboard/app", "packages/dashboard/src"],
  },
  {
    name: "@fusion/engine",
    requiredArtifacts: ["packages/engine/dist/index.js"],
    staleAgainstGlobs: [{ sourcePath: "packages/engine/src" }],
  },
  {
    name: "@fusion/plugin-sdk",
    requiredArtifacts: ["packages/plugin-sdk/dist/index.js"],
    sourceInputs: ["packages/plugin-sdk/src"],
  },
  {
    name: "@fusion-plugin-examples/dependency-graph",
    requiredArtifacts: [
      "plugins/fusion-plugin-dependency-graph/dist/index.js",
      "plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-dependency-graph/src" }],
  },
  {
    name: "@fusion-plugin-examples/hermes-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-hermes-runtime/dist/index.js",
      "plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-hermes-runtime/src" }],
  },
  {
    name: "@fusion-plugin-examples/openclaw-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-openclaw-runtime/dist/index.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/pi-module.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/probe.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-openclaw-runtime/src" }],
  },
  {
    name: "@fusion-plugin-examples/paperclip-runtime",
    requiredArtifacts: ["plugins/fusion-plugin-paperclip-runtime/dist/index.js"],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-paperclip-runtime/src" }],
  },
  {
    // dist-freshness.test.ts reads the compiled settings + orchestrator to guard
    // against stale dist (FN-6596). dist/ is build output, so a fresh CI checkout
    // must build the plugin before its tests run or the guard throws "dist/ is
    // missing". Build these artifacts up front like the other bundled plugins.
    name: "@fusion-plugin-examples/compound-engineering",
    requiredArtifacts: [
      "plugins/fusion-plugin-compound-engineering/dist/settings.js",
      "plugins/fusion-plugin-compound-engineering/dist/session/orchestrator.js",
    ],
    staleAgainstGlobs: [{ sourcePath: "plugins/fusion-plugin-compound-engineering/src" }],
  },
];

// ---------------------------------------------------------------------------
// U3: content-hash artifact cache.
//
// The mtime-based staleness check (collectNewestSourceMtimeMs vs the dist
// artifact mtime) fires spuriously on branch switches: `git checkout` rewrites
// source-file mtimes to "now" even when content is identical, so dist looks
// stale and we pay a needless `tsc` rebuild inside the inner-loop budget.
//
// The fix: after a successful build, cache a git-blob content hash of the
// package's source inputs. On the next run, if the current content hash matches
// the cached one, the dist is up to date regardless of mtimes — skip the
// rebuild. A real source edit changes the hash and rebuilds.
//
// Correctness over speed:
//   - computeContentHash hashes working-tree bytes for dirty/untracked files,
//     so an unstaged source edit busts the hash (git's index blob SHA would be
//     stale). See scripts/lib/content-hash.mjs.
//   - If git is unavailable, or the cache has no entry yet, we FALL BACK to the
//     mtime comparison — we never silently skip a needed rebuild.
// ---------------------------------------------------------------------------

const ARTIFACT_CACHE_VERSION = 1;

/**
 * Repo-relative source input paths for a build package. Prefers the explicit
 * `sourceInputs` list (covers packages with no mtime-staleness globs, e.g.
 * @fusion/core), and falls back to the `staleAgainstGlobs` source paths so the
 * engine + plugin entries keep a single source of truth.
 *
 * @param {object} pkgEntry
 * @returns {string[]}
 */
export function packageSourceInputs(pkgEntry) {
  if (Array.isArray(pkgEntry?.sourceInputs) && pkgEntry.sourceInputs.length > 0) {
    return [...pkgEntry.sourceInputs];
  }
  if (pkgEntry?.staleAgainstGlobs?.length) {
    return pkgEntry.staleAgainstGlobs.map((glob) => glob.sourcePath);
  }
  return [];
}

/**
 * Stable, git-based combined source hash over ALL build packages' source
 * inputs. Computable BEFORE any build (it only reads git blob SHAs / working
 * tree bytes, never dist), and branch-switch stable because it defers to git
 * content rather than file mtimes. Used as the CI dist-cache key.
 *
 * Returns null when git is unavailable (no stable key → caller must not cache).
 *
 * @param {string} rootDir
 * @param {(args: string[], cwd: string) => string|null} [gitFn]
 * @returns {string|null}
 */
export function computeCombinedSourceHash(rootDir = process.cwd(), gitFn = defaultGitRunner) {
  const probe = gitFn(["rev-parse", "--is-inside-work-tree"], rootDir);
  if (probe !== "true") return null;
  // Sorted, de-duplicated union of every package's source inputs so the order in
  // REQUIRED_BUILD_PACKAGES can't perturb the hash.
  const inputPaths = [
    ...new Set(REQUIRED_BUILD_PACKAGES.flatMap((pkg) => packageSourceInputs(pkg))),
  ].sort((a, b) => a.localeCompare(b));
  return computeContentHash({
    rootDir,
    inputPaths,
    versionPrefix: `artifact-combined-v${ARTIFACT_CACHE_VERSION}`,
    gitFn,
  });
}

function artifactCachePath(rootDir) {
  return path.join(fusionCacheDir(rootDir), "artifact-cache.json");
}

function readArtifactCache(rootDir) {
  const cache = readJsonCache(artifactCachePath(rootDir), null);
  if (!cache || cache.version !== ARTIFACT_CACHE_VERSION || typeof cache.entries !== "object") {
    return { version: ARTIFACT_CACHE_VERSION, entries: {} };
  }
  return cache;
}

/**
 * Compute the source content hash for a package entry, or null when it has no
 * source globs (missing-only packages don't use the staleness cache) or git is
 * unavailable so we must fall back to mtime.
 */
function computeArtifactSourceHash(pkgEntry, rootDir, gitFn = defaultGitRunner) {
  if (!pkgEntry?.staleAgainstGlobs?.length) return null;
  // Probe git availability once; computeContentHash also tolerates null but we
  // want an explicit "fall back to mtime" signal when not in a git work tree.
  const probe = gitFn(["rev-parse", "--is-inside-work-tree"], rootDir);
  if (probe !== "true") return null;
  const inputPaths = pkgEntry.staleAgainstGlobs.map((glob) => glob.sourcePath);
  return computeContentHash({
    rootDir,
    inputPaths,
    versionPrefix: `artifact-v${ARTIFACT_CACHE_VERSION}`,
    gitFn,
  });
}

/**
 * Persist the source content hash for each freshly-built package so the next
 * run can skip the rebuild when content is unchanged.
 */
export function recordArtifactBuild(pkgEntries, rootDir, gitFn = defaultGitRunner) {
  try {
    const cache = readArtifactCache(rootDir);
    let wrote = false;
    for (const pkgEntry of pkgEntries) {
      const hash = computeArtifactSourceHash(pkgEntry, rootDir, gitFn);
      if (hash === null) continue;
      cache.entries[pkgEntry.name] = { sourceHash: hash, builtAt: new Date().toISOString() };
      wrote = true;
    }
    if (!wrote) return;
    mkdirSync(fusionCacheDir(rootDir), { recursive: true });
    writeFileSync(artifactCachePath(rootDir), JSON.stringify(cache, null, 2));
  } catch {
    // Cache write is best-effort; a failure just means we mtime-check next time.
  }
}

function collectNewestSourceMtimeMs(sourceDir, statFn, readdirFn) {
  let newest = 0;
  const stack = [sourceDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirFn(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(fullPath);
        continue;
      }

      let stats;
      try {
        stats = statFn(fullPath);
      } catch {
        continue;
      }
      newest = Math.max(newest, stats.mtimeMs);
    }
  }

  return newest;
}

export function isStale(
  pkgEntry,
  rootDir = process.cwd(),
  statFn = statSync,
  readdirFn = readdirSync,
  existsFn = existsSync,
  cacheOptions = {},
) {
  if (!pkgEntry?.staleAgainstGlobs?.length) return false;

  // U3: content-hash short-circuit. If the package's source content hash matches
  // the hash captured at the last successful build, dist is up to date even
  // when mtimes say otherwise (branch-switch churn). Only trust this when the
  // cache opts in AND a hash is computable (git available, not dirty-fallback).
  const { artifactCache, gitFn } = cacheOptions;
  if (artifactCache) {
    const entry = artifactCache.entries?.[pkgEntry.name];
    if (entry?.sourceHash) {
      const currentHash = computeArtifactSourceHash(pkgEntry, rootDir, gitFn);
      if (currentHash !== null && currentHash === entry.sourceHash) {
        return false; // Content unchanged since last build — not stale.
      }
      // Hash mismatch or unavailable → fall through to the mtime check below,
      // which never under-reports staleness.
    }
  }

  let minArtifactMtimeMs = Number.POSITIVE_INFINITY;
  for (const artifactPath of pkgEntry.requiredArtifacts) {
    const fullPath = path.join(rootDir, artifactPath);
    if (!existsFn(fullPath)) continue;
    let stats;
    try {
      stats = statFn(fullPath);
    } catch {
      continue;
    }
    minArtifactMtimeMs = Math.min(minArtifactMtimeMs, stats.mtimeMs);
  }

  if (!Number.isFinite(minArtifactMtimeMs)) return false;

  let maxSourceMtimeMs = 0;
  for (const { sourcePath } of pkgEntry.staleAgainstGlobs) {
    const sourceDir = path.join(rootDir, sourcePath);
    maxSourceMtimeMs = Math.max(maxSourceMtimeMs, collectNewestSourceMtimeMs(sourceDir, statFn, readdirFn));
  }

  return maxSourceMtimeMs > minArtifactMtimeMs;
}

export function detectMissingOrStaleArtifacts(
  rootDir = process.cwd(),
  existsFn = existsSync,
  statFn = statSync,
  readdirFn = readdirSync,
  cacheOptions = {},
) {
  return REQUIRED_BUILD_PACKAGES.filter((pkg) => {
    const missing = pkg.requiredArtifacts.some((artifactPath) => !existsFn(path.join(rootDir, artifactPath)));
    if (missing) return true;
    return isStale(pkg, rootDir, statFn, readdirFn, existsFn, cacheOptions);
  });
}

function classifyArtifactIssues(pkgEntry, rootDir, existsFn, statFn, readdirFn) {
  const missingPaths = pkgEntry.requiredArtifacts.filter((artifactPath) => !existsFn(path.join(rootDir, artifactPath)));
  if (missingPaths.length > 0) {
    return { missingPaths, stalePaths: [] };
  }
  if (isStale(pkgEntry, rootDir, statFn, readdirFn, existsFn)) {
    return { missingPaths: [], stalePaths: [...pkgEntry.requiredArtifacts] };
  }
  return { missingPaths: [], stalePaths: [] };
}

function writeRemediation(stderrWrite, pkgEntries, filterCommand, rootDir, existsFn = existsSync, statFn = statSync, readdirFn = readdirSync) {
  stderrWrite("\n[test-bootstrap] FAILED: workspace dist artifact rebuild did not complete.\n");
  stderrWrite(`[test-bootstrap] command: ${filterCommand}\n`);
  stderrWrite(`[test-bootstrap] affected packages: ${pkgEntries.map((pkg) => pkg.name).join(", ")}\n`);
  for (const pkgEntry of pkgEntries) {
    const { missingPaths, stalePaths } = classifyArtifactIssues(pkgEntry, rootDir, existsFn, statFn, readdirFn);
    for (const missingPath of missingPaths) {
      stderrWrite(`[test-bootstrap] missing: ${missingPath}\n`);
    }
    for (const stalePath of stalePaths) {
      stderrWrite(`[test-bootstrap] stale (src newer than dist): ${stalePath}\n`);
    }
  }
  stderrWrite("[test-bootstrap] next steps:\n");
  stderrWrite("  1) pnpm install --frozen-lockfile\n");
  stderrWrite("  2) pnpm --filter <pkg> build\n");
  stderrWrite("  3) delete <plugin>/dist and re-run pnpm test\n");
  stderrWrite("[test-bootstrap] reference: FN-4232, FN-4605\n\n");
}

function run(
  command,
  args,
  cwd,
  {
    exitFn = process.exit,
    stderrWrite = process.stderr.write.bind(process.stderr),
    spawnFn = spawnSync,
    pkgEntries = [],
    existsFn = existsSync,
    statFn = statSync,
    readdirFn = readdirSync,
  } = {},
) {
  const result = spawnFn(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    const filterCommand = `${command} ${args.join(" ")}`;
    const packageNames = args.filter((entry, index) => args[index - 1] === "--filter");
    const packagesToReport = pkgEntries.length > 0
      ? pkgEntries
      : REQUIRED_BUILD_PACKAGES.filter((pkg) => packageNames.includes(pkg.name));
    writeRemediation(stderrWrite, packagesToReport, filterCommand, cwd, existsFn, statFn, readdirFn);
    exitFn(result.status ?? 1);
  }
}

function resolveWorkspaceRoot(explicitRootDir) {
  if (process.env.FUSION_PROJECT_DIR) {
    return path.resolve(process.env.FUSION_PROJECT_DIR);
  }
  if (explicitRootDir) {
    return path.resolve(explicitRootDir);
  }

  let current = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(process.cwd());
}

export function ensureTestArtifacts(
  rootDir,
  runFn = run,
  existsFn = existsSync,
  statFn = statSync,
  readdirFn = readdirSync,
  runOptions = {},
) {
  const resolvedRootDir = resolveWorkspaceRoot(rootDir);

  // U3: load the content-hash cache so branch-switch mtime churn doesn't force a
  // rebuild. The default-runner (real CLI) path uses it; injected test runners
  // can opt in via runOptions.artifactCache / runOptions.gitFn but default to
  // disabled so existing mtime-based tests keep exercising the mtime path.
  const useContentCache = runFn === run || runOptions.artifactCache !== undefined;
  const cacheOptions = useContentCache
    ? {
        artifactCache: runOptions.artifactCache ?? readArtifactCache(resolvedRootDir),
        gitFn: runOptions.gitFn ?? defaultGitRunner,
      }
    : {};

  const missingOrStale = detectMissingOrStaleArtifacts(resolvedRootDir, existsFn, statFn, readdirFn, cacheOptions);

  // U3: seed the content-hash cache for packages whose dist is already fresh
  // (by mtime or a prior build) but have no cache entry yet. This "adopts" the
  // current source content as the built baseline so the NEXT run — e.g. after a
  // branch switch rewrites mtimes to "now" without changing content — gets a
  // content-hash hit instead of a spurious tsc rebuild. We never seed a package
  // that is currently missing/stale (those still build below and record then).
  if (useContentCache) {
    const staleNames = new Set(missingOrStale.map((pkg) => pkg.name));
    const cache = cacheOptions.artifactCache;
    const toSeed = REQUIRED_BUILD_PACKAGES.filter(
      (pkg) =>
        pkg.staleAgainstGlobs?.length &&
        !staleNames.has(pkg.name) &&
        !cache?.entries?.[pkg.name]?.sourceHash,
    );
    if (toSeed.length > 0) {
      recordArtifactBuild(toSeed, resolvedRootDir, cacheOptions.gitFn ?? defaultGitRunner);
    }
  }

  if (missingOrStale.length === 0) return [];

  const names = missingOrStale.map((pkg) => pkg.name);
  console.log(`[test-bootstrap] rebuilding workspace dist artifacts (missing or stale): ${names.join(", ")}`);
  if (runFn === run) {
    runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], resolvedRootDir, {
      ...runOptions,
      pkgEntries: missingOrStale,
      existsFn,
      statFn,
      readdirFn,
    });
  } else {
    runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], resolvedRootDir);
  }

  // Build succeeded (the real runner exits the process on failure, so reaching
  // here means a clean build). Record content hashes for the packages we built
  // so the next run can skip the rebuild on unchanged content.
  if (useContentCache) {
    recordArtifactBuild(missingOrStale, resolvedRootDir, cacheOptions.gitFn ?? defaultGitRunner);
  }
  return names;
}

/**
 * Seed the per-package content-hash cache for every build package whose dist
 * artifacts are ALL present, recording the current source hash as the "built
 * baseline". Intended to run right after a CI dist-cache HIT: the restored dist
 * carries the saved (older) mtime while checkout rewrites src mtimes to "now",
 * so without a seeded hash-cache `isStale`'s mtime fallback would rebuild
 * everything and defeat the cache. Seeding adopts the restored content as fresh
 * so the content-hash short-circuit fires instead.
 *
 * Only seeds packages with all artifacts present (never masks a genuinely
 * missing/partial dist). Returns the list of package names seeded.
 *
 * @param {string} rootDir
 * @param {(p: string) => boolean} [existsFn]
 * @param {(args: string[], cwd: string) => string|null} [gitFn]
 * @returns {string[]}
 */
export function seedArtifactCache(rootDir = process.cwd(), existsFn = existsSync, gitFn = defaultGitRunner) {
  const resolvedRootDir = resolveWorkspaceRoot(rootDir);
  const present = REQUIRED_BUILD_PACKAGES.filter((pkg) =>
    pkg.requiredArtifacts.every((artifactPath) => existsFn(path.join(resolvedRootDir, artifactPath))),
  );
  // recordArtifactBuild itself no-ops packages without source globs (the
  // mtime-immune @fusion/core/dashboard/plugin-sdk), so only the staleable
  // packages actually get an entry — exactly the ones that need the override.
  recordArtifactBuild(present, resolvedRootDir, gitFn);
  return present.map((pkg) => pkg.name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes("--print-source-hash")) {
    const hash = computeCombinedSourceHash();
    if (hash === null) {
      process.stderr.write("[test-bootstrap] cannot compute source hash: not a git work tree\n");
      process.exit(1);
    }
    process.stdout.write(`${hash}\n`);
  } else if (argv.includes("--seed-artifact-cache")) {
    const seeded = seedArtifactCache();
    process.stderr.write(`[test-bootstrap] seeded artifact hash-cache for: ${seeded.join(", ") || "(none)"}\n`);
  } else {
    ensureTestArtifacts();
  }
}
