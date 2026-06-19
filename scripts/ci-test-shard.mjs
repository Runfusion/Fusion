#!/usr/bin/env node

/**
 * CI shard planner with virtual package slices.
 *
 * Packages are weighted by discovered test-file count. Oversized packages are
 * rewritten into virtual shard entries `{ name, shardIndex, shardCount }` so
 * one package can execute across multiple CI shards via `vitest --shard`.
 * Any package above `splitLimit` always splits at least 2 ways (up to shard
 * count), even when it is smaller than one full per-shard budget.
 * The planner then uses a best-fit-decreasing strategy that packs each entry
 * toward the per-shard budget (or minimizes overshoot when necessary), while
 * keeping slices of the same package on different shards whenever possible.
 */

import { spawn, spawnSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestArtifacts } from "./ensure-test-artifacts.mjs";
import { listWorkspacePackageInfos } from "./test-changed.mjs";
import { deriveBudgetMs, runWithWatchdog } from "./lib/run-vitest-watchdog.mjs";

// Quick, non-test commands (e.g. skill-sync check) stay synchronous — they have
// no hang risk and no benefit from the watchdog.
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Test invocations run under the L2 wall-clock watchdog so a wedged vitest run
// is SIGTERM/SIGKILLed at its budget instead of blocking to the CI job ceiling.
// Preserves the fail-fast contract of `run` (exit non-zero on failure/timeout).
async function runWatched(command, commandArgs, { env, budgetMs, label } = {}) {
  const { code, signal, timedOut } = await runWithWatchdog({
    command,
    args: commandArgs,
    env: env ?? process.env,
    budgetMs,
    label: label ?? command,
    log: console.error,
    spawn,
  });
  if (timedOut) {
    console.error(`[ci-test-shard] FAILED (timeout): ${label ?? command}`);
    process.exit(124);
  }
  if (signal) {
    console.error(`[ci-test-shard] FAILED (signal ${signal}): ${label ?? command}`);
    process.exit(1);
  }
  if (code !== 0) {
    process.exit(code ?? 1);
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function defaultTestWorkerBudget(env = process.env) {
  const cpuCap = Math.max(1, cpus().length - 1);
  const defaultTotal = Math.min(12, Math.max(4, cpuCap));
  const totalWorkers = parsePositiveInteger(env.FUSION_TEST_TOTAL_WORKERS) ?? defaultTotal;
  const concurrency = Math.max(
    1,
    Math.min(parsePositiveInteger(env.FUSION_TEST_CONCURRENCY) ?? 2, totalWorkers),
  );

  return { totalWorkers, concurrency };
}

export function parseShardArgs(argv = process.argv.slice(2), env = process.env) {
  const byFlag = (name) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const shard = parsePositiveInteger(byFlag("--shard") ?? env.CI_SHARD_INDEX);
  const total = parsePositiveInteger(byFlag("--total") ?? env.CI_SHARD_TOTAL);

  if (!shard || !total || shard > total) {
    throw new Error("Usage: node scripts/ci-test-shard.mjs --shard <1..N> --total <N>");
  }

  return { shard, total };
}

/**
 * List a package's test files (repo-relative to the package dir). Single source
 * of truth for the test-file glob + dist exclusion so counting, duration
 * weighting, and the cold-start probe can't drift apart.
 *
 * @param {string} packageDir
 * @param {{ projectRoot?: string, extraExclude?: (p: string) => boolean }} [options]
 * @returns {string[]}
 */
export function listPackageTestFiles(packageDir, { projectRoot = process.cwd(), extraExclude } = {}) {
  const packageRoot = path.join(projectRoot, packageDir);
  return globSync("**/__tests__/**/*.test.{ts,tsx,mjs}", {
    cwd: packageRoot,
    nodir: true,
    exclude: (p) =>
      p.startsWith("dist/") || p.includes("/dist/") || (extraExclude ? extraExclude(p) : false),
  });
}

export function countPackageTestFiles(packageDir, options = {}) {
  return listPackageTestFiles(packageDir, options).length;
}

/**
 * @typedef {{ name: string, shardIndex?: number, shardCount?: number }} ShardEntry
 */

/**
 * @typedef {ShardEntry & { weight: number }} WeightedShardEntry
 */

const DEFAULT_BALANCE_TOLERANCE = 0.05;

/**
 * Resolve the schedulable weight of an input package descriptor. Duration-based
 * weights (U6 / R3) are preferred via the explicit `weight` field; the legacy
 * `testFileCount` field is the file-count fallback so existing callers and the
 * untimed-package fallback path keep working unchanged.
 *
 * @param {{ weight?: number, testFileCount?: number }} pkg
 * @returns {number}
 */
function inputWeightOf(pkg) {
  if (typeof pkg.weight === "number" && Number.isFinite(pkg.weight)) return pkg.weight;
  return pkg.testFileCount ?? 0;
}

function appendSplitEntries(result, pkg, total, perShardBudget) {
  const baseWeight = inputWeightOf(pkg);
  const sliceCount = Math.min(total, Math.max(2, Math.ceil(baseWeight / perShardBudget)));
  const sliceWeight = Math.ceil(baseWeight / sliceCount);
  for (let i = 1; i <= sliceCount; i += 1) {
    result.push({
      name: pkg.name,
      weight: sliceWeight,
      shardIndex: i,
      shardCount: sliceCount,
    });
  }
}

function splitEntry(entry, total, perShardBudget) {
  const splitEntries = [];
  appendSplitEntries(splitEntries, { name: entry.name, testFileCount: entry.weight }, total, perShardBudget);
  return splitEntries;
}

function assignWeightedEntries(entries, total) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const perShardBudget = total > 0 ? totalWeight / total : 0;
  const shardWeights = Array.from({ length: total }, () => 0);
  const shardAssignments = Array.from({ length: total }, () => []);
  const sorted = [...entries].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return (a.shardIndex ?? 0) - (b.shardIndex ?? 0);
  });

  for (const entry of sorted) {
    const eligibleIndices = [];
    for (let index = 0; index < total; index += 1) {
      const alreadyHasSlice =
        entry.shardCount &&
        shardAssignments[index].some((assigned) => assigned.name === entry.name && assigned.shardCount);
      if (!alreadyHasSlice) {
        eligibleIndices.push(index);
      }
    }

    const candidates = eligibleIndices.length > 0 ? eligibleIndices : Array.from({ length: total }, (_, i) => i);
    let bestUnderBudgetIndex = null;
    let bestUnderBudgetProjected = Number.NEGATIVE_INFINITY;
    let bestOvershootIndex = null;
    let bestOvershootProjected = Number.POSITIVE_INFINITY;

    for (const index of candidates) {
      const projected = shardWeights[index] + entry.weight;
      if (projected <= perShardBudget) {
        if (
          projected > bestUnderBudgetProjected ||
          (projected === bestUnderBudgetProjected && (bestUnderBudgetIndex === null || index < bestUnderBudgetIndex))
        ) {
          bestUnderBudgetIndex = index;
          bestUnderBudgetProjected = projected;
        }
        continue;
      }

      if (
        projected < bestOvershootProjected ||
        (projected === bestOvershootProjected && (bestOvershootIndex === null || index < bestOvershootIndex))
      ) {
        bestOvershootIndex = index;
        bestOvershootProjected = projected;
      }
    }

    const targetIndex = bestUnderBudgetIndex ?? bestOvershootIndex ?? candidates[0] ?? 0;
    shardAssignments[targetIndex].push(entry);
    shardWeights[targetIndex] += entry.weight;
  }

  return { shardWeights, perShardBudget };
}

/**
 * Two-pass split planner:
 * 1) threshold pass keeps existing behavior (`threshold`, default 0.5), and
 * 2) balance pass force-splits remaining unsplit packages when keeping them
 *    whole would exceed the configured max variance target (default 5%).
 *
 * @param {Array<{name:string, testFileCount:number}>} packages
 * @param {number} total
 * @param {{ threshold?: number, balanceTolerance?: number }} [options]
 * @returns {WeightedShardEntry[]}
 */
export function computeSplitPlan(packages, total, options = {}) {
  const threshold = options.threshold ?? 0.5;
  const balanceTolerance = options.balanceTolerance ?? DEFAULT_BALANCE_TOLERANCE;
  const totalWeight = packages.reduce((sum, p) => sum + inputWeightOf(p), 0);
  const perShardBudget = total > 0 ? totalWeight / total : 0;
  const splitLimit = perShardBudget * threshold;
  const maxAllowedProjected = perShardBudget * (1 + balanceTolerance);

  const result = [];
  for (const pkg of packages) {
    const pkgWeight = inputWeightOf(pkg);
    // Lane-distributed units (dashboard, U6) and any caller that opts out are
    // never virtual-sliced via `vitest --shard`: their `test` script is a
    // multi-invocation chain, so `--shard=X/Y` cannot be forwarded coherently.
    const shouldConsiderSplit =
      pkg.splittable !== false &&
      total > 1 &&
      pkgWeight > 0 &&
      perShardBudget > 0 &&
      pkgWeight > splitLimit;

    if (!shouldConsiderSplit) {
      result.push({
        name: pkg.name,
        weight: pkgWeight,
        ...(pkg.splittable === false ? { splittable: false } : {}),
        ...(pkg.runKind ? { runKind: pkg.runKind } : {}),
        ...(pkg.lane ? { lane: pkg.lane } : {}),
      });
      continue;
    }

    appendSplitEntries(result, pkg, total, perShardBudget);
  }

  if (total <= 1 || perShardBudget <= 0 || balanceTolerance <= 0) {
    return result;
  }

  if (!Number.isFinite(threshold) || threshold > 1) {
    return result;
  }

  const forceSplitThreshold = splitLimit * threshold;
  let rebalanceResult = result.map((entry) => {
    // Lane-distributed / opt-out units (dashboard) are never `--shard`-sliced.
    if (entry.shardCount || entry.splittable === false) return entry;
    const projectedBestCaseMax = perShardBudget + entry.weight;
    const shouldForceSplit =
      entry.weight > 0 &&
      entry.weight > forceSplitThreshold &&
      projectedBestCaseMax > maxAllowedProjected;
    return shouldForceSplit ? splitEntry(entry, total, perShardBudget) : entry;
  }).flat();

  while (true) {
    const { shardWeights } = assignWeightedEntries(rebalanceResult, total);
    const varianceRatio = (Math.max(...shardWeights) - Math.min(...shardWeights)) / perShardBudget;
    if (!(varianceRatio > balanceTolerance)) {
      return rebalanceResult;
    }

    const nextCandidate = rebalanceResult
      .filter(
        (entry) =>
          !entry.shardCount && entry.splittable !== false && entry.weight > perShardBudget * balanceTolerance,
      )
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))[0];

    if (!nextCandidate) {
      return rebalanceResult;
    }

    rebalanceResult = rebalanceResult.flatMap((entry) => {
      if (!entry.shardCount && entry.name === nextCandidate.name && entry.weight === nextCandidate.weight) {
        return splitEntry(entry, total, perShardBudget);
      }
      return entry;
    });
  }
}

/**
 * Best-fit-decreasing assignment (FN-5002/FN-5036): iterate entries in
 * descending weight order and place each entry into the shard that is closest
 * to the per-shard budget without exceeding it; if all candidates would exceed
 * budget, choose the minimum overshoot shard. This best-fit-under-budget rule
 * now applies uniformly to split and non-split entries while preserving
 * split-slice isolation rules.
 *
 * @param {Array<{name:string, testFileCount:number}>} packages
 * @param {number} total
 * @param {{ threshold?: number }} [options]
 * @returns {ShardEntry[][]}
 */
export function planShardAssignments(packages, total, options = {}) {
  const splitPlan = computeSplitPlan(packages, total, options);
  const totalWeight = splitPlan.reduce((sum, entry) => sum + entry.weight, 0);
  const perShardBudget = total > 0 ? totalWeight / total : 0;
  const shardAssignments = Array.from({ length: total }, () => []);
  const shardWeights = Array.from({ length: total }, () => 0);
  const sorted = [...splitPlan].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return (a.shardIndex ?? 0) - (b.shardIndex ?? 0);
  });

  for (const entry of sorted) {
    const eligibleIndices = [];
    for (let index = 0; index < total; index += 1) {
      const alreadyHasSlice =
        entry.shardCount &&
        shardAssignments[index].some((assigned) => assigned.name === entry.name && assigned.shardCount);
      if (!alreadyHasSlice) {
        eligibleIndices.push(index);
      }
    }

    const candidates = eligibleIndices.length > 0 ? eligibleIndices : Array.from({ length: total }, (_, i) => i);
    if (eligibleIndices.length === 0 && entry.shardCount) {
      console.warn(
        `[ci-test-shard] unable to isolate split slices for ${entry.name}; placing multiple slices in one shard`,
      );
    }

    const selectBestFitCandidate = () => {
      let bestUnderBudgetIndex = null;
      let bestUnderBudgetProjected = Number.NEGATIVE_INFINITY;
      let bestOvershootIndex = null;
      let bestOvershootProjected = Number.POSITIVE_INFINITY;

      for (const index of candidates) {
        const projected = shardWeights[index] + entry.weight;
        if (projected <= perShardBudget) {
          if (
            projected > bestUnderBudgetProjected ||
            (projected === bestUnderBudgetProjected && (bestUnderBudgetIndex === null || index < bestUnderBudgetIndex))
          ) {
            bestUnderBudgetIndex = index;
            bestUnderBudgetProjected = projected;
          }
          continue;
        }

        if (
          projected < bestOvershootProjected ||
          (projected === bestOvershootProjected && (bestOvershootIndex === null || index < bestOvershootIndex))
        ) {
          bestOvershootIndex = index;
          bestOvershootProjected = projected;
        }
      }

      return bestUnderBudgetIndex ?? bestOvershootIndex ?? candidates[0] ?? 0;
    };

    const targetIndex = selectBestFitCandidate();

    shardAssignments[targetIndex].push(entry.shardCount ? {
      name: entry.name,
      shardIndex: entry.shardIndex,
      shardCount: entry.shardCount,
      weight: entry.weight,
    } : {
      name: entry.name,
      weight: entry.weight,
      ...(entry.runKind ? { runKind: entry.runKind } : {}),
      ...(entry.lane ? { lane: entry.lane } : {}),
    });
    shardWeights[targetIndex] += entry.weight;
  }

  return shardAssignments;
}

/**
 * @param {Array<{name:string, testFileCount:number}>} packages
 * @param {number} shard
 * @param {number} total
 * @param {{ threshold?: number }} [options]
 * @returns {ShardEntry[]}
 */
export function selectShardPackages(packages, shard, total, options = {}) {
  return planShardAssignments(packages, total, options)[shard - 1] || [];
}

export function listWorkspaceTestPackages({ projectRoot = process.cwd() } = {}) {
  return listWorkspacePackageInfos({ projectRoot })
    .filter((workspacePackage) => workspacePackage.hasTestScript)
    .map((workspacePackage) => ({
      name: workspacePackage.name,
      dir: workspacePackage.dir,
      testFileCount: countPackageTestFiles(workspacePackage.dir, { projectRoot }),
    }));
}

// ---------------------------------------------------------------------------
// Duration-based weighting and dashboard lane distribution (U6 / R3, R4)
// ---------------------------------------------------------------------------

/** Snapshot older than this is reported as stale (warning, not a failure). */
export const TIMINGS_STALENESS_DAYS = 30;

/** Dashboard package name; its `test` chain is distributed lane-by-lane. */
export const DASHBOARD_PACKAGE_NAME = "@fusion/dashboard";

/**
 * Load the committed timing snapshot into a flat per-file duration map plus a
 * derived median per-file duration (used to scale the file-count fallback so
 * untimed packages are weighed commensurably with timed ones).
 *
 * @param {{ projectRoot?: string, snapshotPath?: string }} [options]
 * @returns {{
 *   present: boolean,
 *   capturedAt: string|null,
 *   fileDurations: Map<string, number>,
 *   pkgDurations: Map<string, number>,
 *   medianPerFileMs: number,
 *   ageDays: number|null,
 *   stale: boolean,
 * }}
 */
export function loadPlanningTimings(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const snapshotPath = options.snapshotPath ?? path.join(projectRoot, TIMINGS_SNAPSHOT_RELATIVE);
  const snapshot = readTimingsSnapshot(snapshotPath);

  const fileDurations = new Map();
  const pkgDurations = new Map();
  const allDurations = [];
  if (snapshot && snapshot.packages && typeof snapshot.packages === "object") {
    for (const [pkgName, pkgEntry] of Object.entries(snapshot.packages)) {
      const files = pkgEntry && typeof pkgEntry === "object" ? pkgEntry.files : null;
      if (!files || typeof files !== "object") continue;
      let pkgTotal = 0;
      for (const [file, duration] of Object.entries(files)) {
        const ms = Number(duration);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const normalized = file.split(path.sep).join("/");
        fileDurations.set(normalized, ms);
        allDurations.push(ms);
        pkgTotal += ms;
      }
      pkgDurations.set(pkgName, pkgTotal);
    }
  }

  let medianPerFileMs = 0;
  if (allDurations.length > 0) {
    const sorted = [...allDurations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianPerFileMs =
      sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  }

  let ageDays = null;
  let stale = false;
  if (snapshot && typeof snapshot.capturedAt === "string") {
    const captured = new Date(snapshot.capturedAt).getTime();
    if (Number.isFinite(captured)) {
      ageDays = (Date.now() - captured) / (1000 * 60 * 60 * 24);
      stale = ageDays > TIMINGS_STALENESS_DAYS;
    }
  }

  return {
    present: Boolean(snapshot),
    capturedAt: snapshot?.capturedAt ?? null,
    fileDurations,
    pkgDurations,
    medianPerFileMs,
    ageDays,
    stale,
  };
}

/**
 * Sum the snapshot durations for a set of repo-relative test files. Returns the
 * matched duration total and the count of files with no timing data.
 *
 * @param {string[]} files  repo-relative paths
 * @param {Map<string, number>} fileDurations
 * @returns {{ durationMs: number, timedCount: number, untimedCount: number }}
 */
export function sumFileDurations(files, fileDurations) {
  let durationMs = 0;
  let timedCount = 0;
  let untimedCount = 0;
  for (const file of files) {
    const normalized = file.split(path.sep).join("/");
    const ms = fileDurations.get(normalized);
    if (typeof ms === "number" && ms > 0) {
      durationMs += ms;
      timedCount += 1;
    } else {
      untimedCount += 1;
    }
  }
  return { durationMs, timedCount, untimedCount };
}

/**
 * Compute a duration weight for a package from its files. Files present in the
 * snapshot contribute their measured duration; files absent fall back to the
 * snapshot's median per-file duration (R3 commensurable scaling). When the
 * whole package is untimed, the entire weight is the fallback and the package
 * name is collected for a logged warning.
 *
 * @param {{ name: string, dir: string }} pkg
 * @param {ReturnType<typeof loadPlanningTimings>} timings
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ name: string, dir: string, weight: number, fullyUntimed: boolean, partiallyUntimed: boolean }}
 */
export function computePackageDurationWeight(pkg, timings, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  // Exclude `*.slow.test.*` from weighting: the slow tier never runs in a
  // package's `test` script (it has its own CI gate), so counting those files
  // — always untimed, hence median-fallback-weighted — inflates the package's
  // shard weight with work the shard does not execute.
  const files = listPackageTestFiles(pkg.dir, {
    projectRoot,
    extraExclude: (p) => /\.slow\.test\./.test(p),
  }).map((f) => `${pkg.dir}/${f}`);

  const fallbackPerFile = timings.medianPerFileMs > 0 ? timings.medianPerFileMs : DURATION_BUCKET_MS;
  const { durationMs, timedCount, untimedCount } = sumFileDurations(files, timings.fileDurations);
  const weight = durationMs + untimedCount * fallbackPerFile;

  return {
    name: pkg.name,
    dir: pkg.dir,
    weight,
    fullyUntimed: timedCount === 0 && files.length > 0,
    partiallyUntimed: timedCount > 0 && untimedCount > 0,
  };
}

/**
 * Recursively expand a package's `test` script into the leaf vitest lanes it
 * runs. A leaf lane is a script whose command does NOT delegate to another
 * `pnpm run <name>`; the dashboard chain is `pnpm run a && pnpm run b ...`, so
 * we follow each `pnpm run <name>` edge until reaching commands that invoke
 * vitest. Lanes are enumerated from package.json — never hardcoded.
 *
 * @param {Record<string, string>} scripts  package.json `scripts` map
 * @param {string} [entryScript]
 * @returns {string[]} ordered, de-duplicated leaf lane script names
 */
export function enumerateDashboardLanes(scripts, entryScript = "test") {
  const lanes = [];
  const seen = new Set();
  const referencedRuns = (command) => {
    const names = [];
    const re = /pnpm\s+run\s+([\w:-]+)/g;
    let match;
    while ((match = re.exec(command)) !== null) names.push(match[1]);
    return names;
  };
  const delegatedGroup = (command) => {
    const match = command.match(/--group(?:=|\s+)(app|api)\b/);
    return match?.[1] ?? null;
  };
  const isQualityLeaf = ([name, command]) => (
    name.startsWith("test:quality:")
    && command.includes("--project")
    && !command.includes("run-quality-tests")
    && referencedRuns(command).length === 0
  );
  const pushLane = (lane) => {
    if (seen.has(lane)) return;
    seen.add(lane);
    lanes.push(lane);
  };
  const expandQualityDelegation = (command) => {
    // The dashboard package's quality-test runner owns the current lane manifest;
    // expand delegators back to real package.json leaf scripts so CI can shard them.
    const group = delegatedGroup(command);
    const prefix = group ? `test:quality:${group}:` : "test:quality:";
    for (const [name, leafCommand] of Object.entries(scripts ?? {})) {
      if (name.startsWith(prefix) && isQualityLeaf([name, leafCommand])) pushLane(name);
    }
  };

  const visit = (scriptName) => {
    if (seen.has(scriptName)) return;
    seen.add(scriptName);
    const command = scripts?.[scriptName];
    if (typeof command !== "string") return;
    if (command.includes("run-quality-tests")) {
      expandQualityDelegation(command);
      return;
    }
    const children = referencedRuns(command);
    if (children.length === 0) {
      // Leaf: a lane that actually invokes a test runner.
      lanes.push(scriptName);
      return;
    }
    for (const child of children) visit(child);
  };

  visit(entryScript);
  return lanes;
}

/**
 * Extract the vitest `--project <name>` targets referenced by a lane command.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function laneProjectNames(command) {
  const names = [];
  const re = /--project[=\s]+([\w-]+)/g;
  let match;
  while ((match = re.exec(command)) !== null) names.push(match[1]);
  return names;
}

/**
 * Resolve dashboard project name → repo-relative test files by importing the
 * dashboard vitest config (via `tsx`, which resolves its extensionless TS
 * imports) and globbing each project's `include`/`exclude`. This is the
 * "derive from the vitest config project includes" path. On any failure
 * (config not importable, tsx missing) it returns null so the caller falls back
 * to even apportionment of the package duration across lanes.
 *
 * @param {string} dashboardDir  repo-relative dashboard dir
 * @param {{ projectRoot?: string }} [options]
 * @returns {Record<string, string[]>|null}  projectName → repo-relative files
 */
export function resolveDashboardProjectFiles(dashboardDir, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dashboardAbs = path.join(projectRoot, dashboardDir);
  const script = `
    import config from "./vitest.config.ts";
    import { globSync } from "node:fs";
    const projects = config?.test?.projects ?? [];
    const out = {};
    for (const p of projects) {
      const name = p?.test?.name;
      if (!name) continue;
      const include = Array.isArray(p.test.include) ? p.test.include : [p.test.include].filter(Boolean);
      const exclude = Array.isArray(p.test.exclude) ? p.test.exclude : [];
      const files = new Set();
      for (const g of include) for (const f of globSync(g, { cwd: process.cwd(), nodir: true })) files.add(f);
      const excluded = new Set();
      for (const g of exclude) for (const f of globSync(g, { cwd: process.cwd(), nodir: true })) excluded.add(f);
      out[name] = [...files].filter((f) => !excluded.has(f));
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const tsxBin = path.join(projectRoot, "node_modules/.bin/tsx");
  const result = spawnSync(
    tsxBin,
    ["--eval", script],
    { cwd: dashboardAbs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const out = {};
  for (const [name, files] of Object.entries(parsed)) {
    out[name] = (Array.isArray(files) ? files : []).map((f) => `${dashboardDir}/${f}`.split(path.sep).join("/"));
  }
  return out;
}

/**
 * Build the dashboard lane schedulable units. Each enumerated leaf lane becomes
 * one unit weighted by the durations of the files its `--project`s execute
 * (a lane carrying `--shard=i/n` runs 1/n of those files). When the config
 * cannot be imported, the package duration is apportioned evenly across lanes.
 *
 * @param {{ name: string, dir: string }} pkg
 * @param {ReturnType<typeof loadPlanningTimings>} timings
 * @param {{ projectRoot?: string }} [options]
 * @returns {{ units: Array<{ name: string, lane: string, runKind: "dashboard-lane", weight: number, splittable: false }>, lanes: string[], method: string, untimed: string[] }}
 */
/**
 * Fraction of a project a lane command actually runs, derived from its
 * `--shard=i/n` flags. A lane may chain MULTIPLE --shard invocations of the
 * same project (e.g. `--shard=1/2 && --shard=2/2` runs the full project):
 * sum the fractions across all matches, capped at 1. A lane with a single
 * `--shard=i/n` invocation genuinely runs 1/n. No --shard flag means the
 * whole project.
 *
 * @param {string} command
 * @returns {number} (0, 1]
 */
export function laneShardFraction(command) {
  const shardMatches = [...command.matchAll(/--shard[=\s]+(\d+)\/(\d+)/g)];
  if (shardMatches.length === 0) return 1;
  return Math.min(
    1,
    shardMatches.reduce((sum, m) => sum + 1 / Number(m[2]), 0),
  );
}

export function buildDashboardLaneUnits(pkg, timings, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const pkgJson = JSON.parse(readFileSync(path.join(projectRoot, pkg.dir, "package.json"), "utf8"));
  const scripts = pkgJson.scripts ?? {};
  const lanes = enumerateDashboardLanes(scripts, "test");

  const projectFiles = resolveDashboardProjectFiles(pkg.dir, { projectRoot });
  const fallbackPerFile = timings.medianPerFileMs > 0 ? timings.medianPerFileMs : DURATION_BUCKET_MS;
  const untimed = [];

  if (projectFiles) {
    const units = lanes.map((lane) => {
      const command = scripts[lane] ?? "";
      const projects = laneProjectNames(command);
      const shardFraction = laneShardFraction(command);
      const files = new Set();
      for (const project of projects) for (const f of projectFiles[project] ?? []) files.add(f);
      const { durationMs, timedCount, untimedCount } = sumFileDurations([...files], timings.fileDurations);
      const weight = (durationMs + untimedCount * fallbackPerFile) * shardFraction;
      if (timedCount === 0 && files.size > 0) untimed.push(lane);
      return { name: pkg.name, lane, runKind: "dashboard-lane", weight: Math.max(weight, fallbackPerFile), splittable: false };
    });
    return { units, lanes, method: "vitest-config-includes", untimed };
  }

  // Fallback: even apportionment of the package's measured duration.
  const pkgWeight = computePackageDurationWeight(pkg, timings, { projectRoot }).weight;
  const perLane = lanes.length > 0 ? pkgWeight / lanes.length : 0;
  const units = lanes.map((lane) => ({
    name: pkg.name,
    lane,
    runKind: "dashboard-lane",
    weight: Math.max(perLane, fallbackPerFile),
    splittable: false,
  }));
  return { units, lanes, method: "even-apportionment", untimed: lanes };
}

/**
 * Translate the raw workspace package list into duration-weighted schedulable
 * units for the planner: the dashboard expands into per-lane units; every other
 * package is a single duration-weighted unit (engine stays virtual-sliceable).
 * Untimed packages fall back to median-scaled file-count weight with a warning.
 *
 * @param {{ projectRoot?: string, logger?: Console, timings?: ReturnType<typeof loadPlanningTimings> }} [options]
 * @returns {{ units: Array<{ name: string, weight: number, runKind?: string, lane?: string, splittable?: boolean }>, dashboardLanes: string[], timings: ReturnType<typeof loadPlanningTimings> }}
 */
export function buildScheduleUnits(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const logger = options.logger ?? console;
  const timings = options.timings ?? loadPlanningTimings({ projectRoot });
  const packages = listWorkspaceTestPackages({ projectRoot });

  if (!timings.present) {
    logger.warn(
      "[ci-test-shard] no timing snapshot found; falling back to file-count weighting for all packages.",
    );
  } else if (timings.stale) {
    logger.warn(
      `[ci-test-shard] WARNING: timing snapshot is ${Math.round(timings.ageDays)} days old ` +
        `(> ${TIMINGS_STALENESS_DAYS}d staleness budget; capturedAt ${timings.capturedAt}). ` +
        "Shard balance may have drifted. Refresh it from the default branch's CI timing artifacts " +
        "via `node scripts/ci-test-shard.mjs --write-timings`.",
    );
  }

  const units = [];
  let dashboardLanes = [];
  const untimedPackages = [];

  for (const pkg of packages) {
    if (pkg.name === DASHBOARD_PACKAGE_NAME) {
      const { units: laneUnits, lanes, method, untimed } = buildDashboardLaneUnits(pkg, timings, { projectRoot });
      units.push(...laneUnits);
      dashboardLanes = lanes;
      logger.log(
        `[ci-test-shard] dashboard distributed across ${lanes.length} lanes (weights via ${method}).`,
      );
      if (untimed.length > 0) {
        logger.warn(
          `[ci-test-shard] dashboard lanes without timing data (median-scaled fallback): ${untimed.join(", ")}`,
        );
      }
      continue;
    }

    const weighted = computePackageDurationWeight(pkg, timings, { projectRoot });
    if (weighted.fullyUntimed) untimedPackages.push(pkg.name);
    units.push({
      name: pkg.name,
      weight: weighted.weight,
      // Engine remains virtual-sliceable; everything else stays whole unless
      // the planner's force-split balance pass decides otherwise.
      splittable: true,
    });
  }

  if (untimedPackages.length > 0) {
    logger.warn(
      `[ci-test-shard] no timing data for: ${untimedPackages.join(", ")}; ` +
        `using median-scaled (${timings.medianPerFileMs}ms/file) file-count weight.`,
    );
  }

  return { units, dashboardLanes, timings };
}

function entryLabel(entry) {
  if (entry.runKind === "dashboard-lane") {
    return `${entry.name} run ${entry.lane}`;
  }
  if (entry.shardCount) {
    return `${entry.name} [${entry.shardIndex}/${entry.shardCount}]`;
  }
  return entry.name;
}

// ---------------------------------------------------------------------------
// Timing telemetry aggregation (U1 / R4)
// ---------------------------------------------------------------------------

/** @type {string} Repo-relative path of the committed timing snapshot. */
export const TIMINGS_SNAPSHOT_RELATIVE = "scripts/test-timings.json";

/** @type {number} Durations are rounded to this bucket (ms) to suppress noise. */
export const DURATION_BUCKET_MS = 100;

/**
 * Round a raw duration (ms) to the nearest DURATION_BUCKET_MS, with a floor of
 * one bucket for any non-zero duration so sub-bucket files are not lost.
 *
 * @param {number} durationMs
 * @returns {number}
 */
export function bucketDuration(durationMs, bucket = DURATION_BUCKET_MS) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const rounded = Math.round(durationMs / bucket) * bucket;
  return rounded === 0 ? bucket : rounded;
}

/**
 * Map an absolute or repo-relative test-file path to its owning package name,
 * using the workspace dir→name table. Returns { pkg, file } where `file` is
 * repo-relative, or null when the file is outside any known package.
 *
 * @param {string} filePath
 * @param {Array<{ name: string, dir: string }>} packages
 * @param {string} projectRoot
 */
export function attributeTestFile(filePath, packages, projectRoot = process.cwd()) {
  const relative = path.isAbsolute(filePath)
    ? path.relative(projectRoot, filePath)
    : filePath;
  const normalized = relative.split(path.sep).join("/");
  // Longest dir first so nested packages win over their parents.
  const sorted = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  for (const pkg of sorted) {
    if (normalized === pkg.dir || normalized.startsWith(`${pkg.dir}/`)) {
      return { pkg: pkg.name, file: normalized };
    }
  }
  return null;
}

/**
 * Parse one vitest `--reporter=json` output object and return per-file
 * durations attributed to packages. Tolerant of partial/odd shapes.
 *
 * @param {unknown} report  Parsed JSON reporter output.
 * @param {Array<{ name: string, dir: string }>} packages
 * @param {string} projectRoot
 * @returns {Map<string, Map<string, number>>} pkg → (file → durationMs)
 */
export function extractFileDurations(report, packages, projectRoot = process.cwd()) {
  const byPackage = new Map();
  const results = report && typeof report === "object" ? report.testResults : null;
  if (!Array.isArray(results)) return byPackage;

  for (const entry of results) {
    if (!entry || typeof entry.name !== "string") continue;
    const start = Number(entry.startTime);
    const end = Number(entry.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const attributed = attributeTestFile(entry.name, packages, projectRoot);
    if (!attributed) continue;
    const { pkg, file } = attributed;
    if (!byPackage.has(pkg)) byPackage.set(pkg, new Map());
    const files = byPackage.get(pkg);
    files.set(file, (files.get(file) ?? 0) + (end - start));
  }

  return byPackage;
}

/**
 * Build a fresh timing snapshot object from a set of per-shard JSON reporter
 * files. Missing/corrupt files are warned about and skipped (exit 0 path).
 *
 * @param {string[]} outputFiles  Absolute paths to vitest JSON reporter outputs.
 * @param {{ projectRoot?: string, capturedAt?: string, packages?: Array<{name:string,dir:string}> }} [options]
 * @returns {{ capturedAt: string, packages: Record<string, { files: Record<string, number> }> }}
 */
export function buildTimingsSnapshot(outputFiles, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const packages = options.packages ?? listWorkspaceTestPackages({ projectRoot });
  const capturedAt = options.capturedAt ?? new Date().toISOString();

  /** @type {Map<string, Map<string, number>>} */
  const merged = new Map();

  for (const outputFile of outputFiles) {
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[ci-test-shard] skipping unreadable timing file ${outputFile}: ${message}`);
      continue;
    }

    const perFile = extractFileDurations(report, packages, projectRoot);
    for (const [pkg, files] of perFile) {
      if (!merged.has(pkg)) merged.set(pkg, new Map());
      const target = merged.get(pkg);
      for (const [file, duration] of files) {
        target.set(file, (target.get(file) ?? 0) + duration);
      }
    }
  }

  const packagesOut = {};
  for (const pkg of [...merged.keys()].sort()) {
    const files = merged.get(pkg);
    if (files.size === 0) continue; // zero-test package → no entry
    const filesOut = {};
    for (const file of [...files.keys()].sort()) {
      filesOut[file] = bucketDuration(files.get(file));
    }
    packagesOut[pkg] = { files: filesOut };
  }

  return { capturedAt, packages: packagesOut };
}

/**
 * Read an existing snapshot (or null when absent/corrupt).
 * @param {string} snapshotPath
 */
export function readTimingsSnapshot(snapshotPath) {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.capturedAt === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Discover candidate vitest JSON reporter output files in a directory.
 * Looks for files matching `*timings*.json` (the convention CI shards write).
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
export function discoverTimingFiles(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /timings.*\.json$/.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Discover timing files across the whole workspace: the root .timings/ dir
 * plus every package/plugin's own .timings/ dir (shard runs emit RELATIVE
 * outputFile paths, so each package writes under its own directory — see
 * the timingFlags comment in main()).
 *
 * @param {string} projectRoot
 * @returns {string[]} Absolute paths, sorted.
 */
export function discoverWorkspaceTimingFiles(projectRoot) {
  const dirs = [
    path.join(projectRoot, ".timings"),
    ...globSync("{packages,plugins,plugins/examples}/*/.timings", { cwd: projectRoot }).map((d) =>
      path.join(projectRoot, d),
    ),
  ];
  const files = new Set();
  for (const dir of dirs) for (const f of discoverTimingFiles(dir)) files.add(f);
  return [...files].sort();
}

/**
 * Merge per-shard JSON reporter outputs into the committed snapshot.
 * Refuses to overwrite a snapshot whose capturedAt is newer than this run's.
 *
 * @param {{ inputDir?: string, inputs?: string[], projectRoot?: string, snapshotPath?: string, capturedAt?: string }} [options]
 * @returns {{ written: boolean, snapshot: object, reason?: string }}
 */
export function writeTimings(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const snapshotPath = options.snapshotPath ?? path.join(projectRoot, TIMINGS_SNAPSHOT_RELATIVE);
  const inputs = options.inputs
    ?? (options.inputDir
      ? discoverTimingFiles(options.inputDir)
      : discoverWorkspaceTimingFiles(projectRoot));

  if (inputs.length === 0) {
    console.warn("[ci-test-shard] no timing input files found; snapshot unchanged.");
    return { written: false, snapshot: readTimingsSnapshot(snapshotPath) ?? null, reason: "no-inputs" };
  }

  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const snapshot = buildTimingsSnapshot(inputs, { projectRoot, capturedAt, packages: options.packages });

  if (Object.keys(snapshot.packages).length === 0) {
    console.warn("[ci-test-shard] timing inputs yielded zero packages; snapshot unchanged.");
    return { written: false, snapshot, reason: "empty" };
  }

  const existing = readTimingsSnapshot(snapshotPath);
  if (existing && new Date(existing.capturedAt).getTime() > new Date(capturedAt).getTime()) {
    console.warn(
      `[ci-test-shard] existing snapshot (${existing.capturedAt}) is newer than this run (${capturedAt}); refusing to overwrite.`,
    );
    return { written: false, snapshot: existing, reason: "newer-snapshot" };
  }

  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tmp = `${snapshotPath}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmp, snapshotPath);
  const pkgCount = Object.keys(snapshot.packages).length;
  console.log(`[ci-test-shard] wrote ${TIMINGS_SNAPSHOT_RELATIVE} (${pkgCount} packages, capturedAt ${capturedAt}).`);
  return { written: true, snapshot };
}

/**
 * Cold-start probe: measure per-package vitest startup-to-first-test overhead.
 * Runs `vitest run <oneCheapFile>` with the JSON reporter, then estimates
 * overhead = totalWallClockMs − sum(per-file test durations).
 *
 * @param {string} packageName
 * @param {{ projectRoot?: string, env?: NodeJS.ProcessEnv, testFile?: string }} [options]
 * @returns {{ packageName: string, wallClockMs: number, testDurationMs: number, overheadMs: number, testFile: string|null }}
 */
export function runColdStartProbe(packageName, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const packages = listWorkspaceTestPackages({ projectRoot });
  const pkg = packages.find((p) => p.name === packageName);
  if (!pkg) {
    throw new Error(`[ci-test-shard] cold-start-probe: unknown package "${packageName}"`);
  }

  // Pick the cheapest (smallest) test file as the probe target unless given.
  let testFile = options.testFile ?? null;
  if (!testFile) {
    const candidates = listPackageTestFiles(pkg.dir, {
      projectRoot,
      extraExclude: (p) => /\.slow\./.test(p),
    });
    testFile = candidates.sort((a, b) => a.length - b.length)[0] ?? null;
  }
  if (!testFile) {
    throw new Error(`[ci-test-shard] cold-start-probe: no test file found for ${packageName}`);
  }

  const outputFile = path.join(projectRoot, ".timings", `coldstart-${packageName.replace(/[^a-z0-9]+/gi, "-")}.json`);
  mkdirSync(path.dirname(outputFile), { recursive: true });

  const start = Date.now();
  // NB: no `--` before flags (cac mis-parse); mirror the virtual-shard pattern.
  spawnSync(
    "pnpm",
    [
      "--filter",
      packageName,
      "exec",
      "vitest",
      "run",
      testFile,
      "--reporter=dot",
      "--reporter=json",
      `--outputFile.json=${outputFile}`,
    ],
    { cwd: projectRoot, stdio: "inherit", env },
  );
  const wallClockMs = Date.now() - start;

  let testDurationMs = 0;
  const perFile = (() => {
    try {
      return extractFileDurations(JSON.parse(readFileSync(outputFile, "utf8")), packages, projectRoot);
    } catch {
      return new Map();
    }
  })();
  for (const files of perFile.values()) {
    for (const duration of files.values()) testDurationMs += duration;
  }

  return {
    packageName,
    testFile,
    wallClockMs,
    testDurationMs: Math.round(testDurationMs),
    overheadMs: Math.max(0, Math.round(wallClockMs - testDurationMs)),
  };
}

/**
 * Translate the resolved shard entries into the concrete pnpm command argument
 * vectors that execute them. Plain duration-weighted packages run together in
 * one `pnpm --filter ... test` invocation; virtual engine slices each get a
 * `--shard=i/n` invocation; dashboard lane units each run their own
 * `pnpm --filter @fusion/dashboard run <lane>`. `timingFlags()` (if provided)
 * appends the JSON reporter flags so telemetry keeps flowing (U1/R4).
 *
 * @param {ShardEntry[]} shardEntries
 * @param {{ timingFlags?: () => string[] }} [options]
 * @returns {Array<{ kind: string, label: string, args: string[] }>}
 */
export function buildShardCommands(shardEntries, options = {}) {
  const timingFlags = options.timingFlags ?? (() => []);
  const commands = [];

  const plain = shardEntries.filter((e) => !e.shardCount && e.runKind !== "dashboard-lane");
  const virtual = shardEntries.filter((e) => e.shardCount);
  const lanes = shardEntries.filter((e) => e.runKind === "dashboard-lane");

  if (plain.length > 0) {
    const filters = plain.flatMap((e) => ["--filter", e.name]);
    commands.push({
      kind: "plain",
      label: plain.map((e) => e.name).join(", "),
      // A single plain command fans out across every packed package, so its
      // expected duration is the SUM of their weights — not a per-package value
      // (see the watchdog budget aggregation, KTD-2).
      weightMs: plain.reduce((sum, e) => sum + (e.weight ?? 0), 0),
      args: [...filters, "test", ...timingFlags()],
    });
  }

  for (const entry of virtual) {
    commands.push({
      kind: "virtual",
      label: `${entry.name} [${entry.shardIndex}/${entry.shardCount}]`,
      weightMs: entry.weight ?? 0,
      // NB: no `--` between `test` and `--shard`; cac would treat the value as a
      // positional file filter and silently disable sharding.
      args: ["--filter", entry.name, "test", `--shard=${entry.shardIndex}/${entry.shardCount}`, ...timingFlags()],
    });
  }

  for (const entry of lanes) {
    commands.push({
      kind: "dashboard-lane",
      label: `${entry.name} run ${entry.lane}`,
      weightMs: entry.weight ?? 0,
      args: ["--filter", entry.name, "run", entry.lane, ...timingFlags()],
    });
  }

  return commands;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--write-timings")) {
    const dirIdx = argv.indexOf("--inputs-dir");
    const inputDir = dirIdx >= 0 ? argv[dirIdx + 1] : undefined;
    writeTimings({ inputDir });
    return;
  }

  if (argv.includes("--check-timings-staleness")) {
    const timings = loadPlanningTimings();
    if (!timings.present) {
      console.error("[ci-test-shard] no timing snapshot present; refresh required.");
      process.exitCode = 1;
      return;
    }
    if (timings.stale) {
      console.error(
        `[ci-test-shard] timing snapshot is stale: ${Math.round(timings.ageDays)} days old ` +
          `(> ${TIMINGS_STALENESS_DAYS}d). capturedAt ${timings.capturedAt}. ` +
          "Refresh from the default branch via `node scripts/ci-test-shard.mjs --write-timings`.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `[ci-test-shard] timing snapshot fresh: ${Math.round(timings.ageDays ?? 0)} days old ` +
        `(<= ${TIMINGS_STALENESS_DAYS}d). capturedAt ${timings.capturedAt}.`,
    );
    return;
  }

  if (argv.includes("--dry-run")) {
    const total = parsePositiveInteger(
      (() => {
        const i = argv.indexOf("--total");
        return i >= 0 ? argv[i + 1] : undefined;
      })() ?? env.CI_SHARD_TOTAL,
    );
    const singleShard = parsePositiveInteger(
      (() => {
        const i = argv.indexOf("--shard");
        return i >= 0 ? argv[i + 1] : undefined;
      })() ?? env.CI_SHARD_INDEX,
    );
    if (!total) {
      throw new Error("Usage: node scripts/ci-test-shard.mjs --dry-run --total <N> [--shard <1..N>]");
    }
    const { units } = buildScheduleUnits();
    const assignments = planShardAssignments(units, total);
    const weightOf = (entry) => entry.weight ?? 0;
    const shardsToPrint = singleShard ? [singleShard] : Array.from({ length: total }, (_, i) => i + 1);
    for (const shardNum of shardsToPrint) {
      const entries = assignments[shardNum - 1] ?? [];
      const totalMs = entries.reduce((sum, e) => sum + weightOf(e), 0);
      console.log(
        `\n[ci-test-shard] shard ${shardNum}/${total} — weight ${(totalMs / 1000).toFixed(1)}s, ${entries.length} unit(s):`,
      );
      const commands = buildShardCommands(entries);
      for (const command of commands) {
        console.log(`  pnpm ${command.args.join(" ")}`);
      }
      if (commands.length === 0) console.log("  (no assigned units)");
    }
    return;
  }

  if (argv.includes("--cold-start-probe")) {
    const pkgIdx = argv.indexOf("--cold-start-probe");
    const packageName = argv[pkgIdx + 1];
    if (!packageName || packageName.startsWith("--")) {
      throw new Error("Usage: node scripts/ci-test-shard.mjs --cold-start-probe <package-name>");
    }
    const result = runColdStartProbe(packageName, { env });
    console.log(
      `[ci-test-shard] cold-start probe ${result.packageName}: wall=${result.wallClockMs}ms ` +
        `tests=${result.testDurationMs}ms overhead=${result.overheadMs}ms (file ${result.testFile})`,
    );
    console.log(JSON.stringify(result));
    return;
  }

  const { shard, total } = parseShardArgs(argv, env);
  const { units, timings } = buildScheduleUnits();
  // Only trust timings to TIGHTEN the watchdog budget when the snapshot is
  // present and fresh; otherwise deriveBudgetMs falls back to the generous
  // per-class ceiling (KTD-2).
  const timingsFresh = Boolean(timings?.present) && !timings?.stale;
  const shardEntries = planShardAssignments(units, total)[shard - 1] || [];

  if (shardEntries.length === 0) {
    console.log(`[ci-test-shard] shard ${shard}/${total} has no assigned units; skipping.`);
    return;
  }

  console.log(`[ci-test-shard] shard ${shard}/${total}: ${shardEntries.map(entryLabel).join(", ")}`);

  const { totalWorkers, concurrency } = defaultTestWorkerBudget(env);
  const shardEnv = {
    ...env,
    FUSION_TEST_TOTAL_WORKERS: env.FUSION_TEST_TOTAL_WORKERS || String(totalWorkers),
    FUSION_TEST_CONCURRENCY: env.FUSION_TEST_CONCURRENCY || String(concurrency),
  };

  run("pnpm", ["sync:fusion-skill:check"], { env: shardEnv });
  ensureTestArtifacts(process.cwd());

  // Per-shard timing telemetry (U1 / R4): each test invocation also emits a
  // vitest JSON reporter file under .timings/. These are uploaded as CI
  // artifacts and consumed by `--write-timings` to refresh the snapshot.
  //
  // The path MUST be RELATIVE: one pnpm invocation can fan out to several
  // packages, each spawning its own vitest with these identical forwarded
  // flags. A relative path resolves against each package's cwd, giving every
  // package its own <pkgDir>/.timings/ file; an absolute path would make all
  // packages in the invocation overwrite the same file (last writer wins,
  // silently dropping every other package's timings).
  let invocationIndex = 0;
  const timingFlags = () => {
    const outputFile = path.join(".timings", `timings-shard${shard}-${invocationIndex++}.json`);
    return ["--reporter=json", `--outputFile.json=${outputFile}`];
  };

  const commands = buildShardCommands(shardEntries, { timingFlags });
  for (const command of commands) {
    const klass = command.kind === "dashboard-lane" ? "dashboard-lane" : "shard";
    const budgetMs = deriveBudgetMs({
      klass,
      expectedDurationMs: command.weightMs,
      timingsFresh,
    });
    const label = `shard ${shard}/${total}: ${command.label}`;
    console.log(`[ci-test-shard] ${label} (watchdog budget ${Math.round(budgetMs / 1000)}s)`);
    await runWatched("pnpm", command.args, { env: shardEnv, budgetMs, label });
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
