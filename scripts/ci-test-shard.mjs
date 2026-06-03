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

import { spawnSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestArtifacts } from "./ensure-test-artifacts.mjs";
import { listWorkspacePackageInfos } from "./test-changed.mjs";

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

export function countPackageTestFiles(packageDir, { projectRoot = process.cwd() } = {}) {
  const packageRoot = path.join(projectRoot, packageDir);
  return globSync("**/__tests__/**/*.test.{ts,tsx,mjs}", {
    cwd: packageRoot,
    nodir: true,
    exclude: (p) => p.startsWith("dist/") || p.includes("/dist/"),
  }).length;
}

/**
 * @typedef {{ name: string, shardIndex?: number, shardCount?: number }} ShardEntry
 */

/**
 * @typedef {ShardEntry & { weight: number }} WeightedShardEntry
 */

const DEFAULT_BALANCE_TOLERANCE = 0.05;

function appendSplitEntries(result, pkg, total, perShardBudget) {
  const sliceCount = Math.min(total, Math.max(2, Math.ceil(pkg.testFileCount / perShardBudget)));
  const sliceWeight = Math.ceil(pkg.testFileCount / sliceCount);
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
  const totalWeight = packages.reduce((sum, p) => sum + p.testFileCount, 0);
  const perShardBudget = total > 0 ? totalWeight / total : 0;
  const splitLimit = perShardBudget * threshold;
  const maxAllowedProjected = perShardBudget * (1 + balanceTolerance);

  const result = [];
  for (const pkg of packages) {
    const shouldConsiderSplit =
      total > 1 &&
      pkg.testFileCount > 0 &&
      perShardBudget > 0 &&
      pkg.testFileCount > splitLimit;

    if (!shouldConsiderSplit) {
      result.push({ name: pkg.name, weight: pkg.testFileCount });
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
    if (entry.shardCount) return entry;
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
      .filter((entry) => !entry.shardCount && entry.weight > perShardBudget * balanceTolerance)
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
    } : { name: entry.name, weight: entry.weight });
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

function entryLabel(entry) {
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
    ?? discoverTimingFiles(options.inputDir ?? path.join(projectRoot, ".timings"));

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
    const candidates = globSync("**/__tests__/**/*.test.{ts,tsx,mjs}", {
      cwd: path.join(projectRoot, pkg.dir),
      nodir: true,
      exclude: (p) => p.startsWith("dist/") || p.includes("/dist/") || /\.slow\./.test(p),
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

export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--write-timings")) {
    const dirIdx = argv.indexOf("--inputs-dir");
    const inputDir = dirIdx >= 0 ? argv[dirIdx + 1] : undefined;
    writeTimings({ inputDir });
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
  const shardEntries = selectShardPackages(listWorkspaceTestPackages(), shard, total);

  if (shardEntries.length === 0) {
    console.log(`[ci-test-shard] shard ${shard}/${total} has no assigned packages; skipping.`);
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
  // Reporters are appended as CLI flags following the same no-`--` quirk as the
  // virtual `--shard` forwarding; package `test` scripts already pass
  // `--reporter=dot`, and vitest accepts multiple `--reporter` flags.
  const timingsDir = path.join(process.cwd(), ".timings");
  mkdirSync(timingsDir, { recursive: true });
  let invocationIndex = 0;
  const timingFlags = () => {
    const outputFile = path.join(timingsDir, `timings-shard${shard}-${invocationIndex++}.json`);
    return ["--reporter=json", `--outputFile.json=${outputFile}`];
  };

  // Group entries: plain packages run together in one pnpm invocation;
  // virtual (sharded) entries each get their own vitest --shard invocation.
  const plain = shardEntries.filter((e) => !e.shardCount);
  const virtual = shardEntries.filter((e) => e.shardCount);

  if (plain.length > 0) {
    const filters = plain.flatMap((e) => ["--filter", e.name]);
    run("pnpm", [...filters, "test", ...timingFlags()], { env: shardEnv });
  }

  for (const entry of virtual) {
    console.log(
      `[ci-test-shard] shard ${shard}/${total}: running ${entry.name} --shard ${entry.shardIndex}/${entry.shardCount}`,
    );
    // NB: no `--` between `test` and `--shard`. pnpm 10 forwards extra args to
    // the script regardless, and inserting `--` causes vitest's CLI parser
    // (cac) to treat `--shard X/Y` as positional file filters → sharding is
    // silently disabled and every shard runs the full suite.
    run(
      "pnpm",
      ["--filter", entry.name, "test", `--shard=${entry.shardIndex}/${entry.shardCount}`, ...timingFlags()],
      { env: shardEnv },
    );
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
