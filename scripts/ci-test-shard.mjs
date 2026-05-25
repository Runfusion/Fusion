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
import { globSync } from "node:fs";
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

export function main(argv = process.argv.slice(2), env = process.env) {
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

  // Group entries: plain packages run together in one pnpm invocation;
  // virtual (sharded) entries each get their own vitest --shard invocation.
  const plain = shardEntries.filter((e) => !e.shardCount);
  const virtual = shardEntries.filter((e) => e.shardCount);

  if (plain.length > 0) {
    const filters = plain.flatMap((e) => ["--filter", e.name]);
    run("pnpm", [...filters, "test"], { env: shardEnv });
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
      ["--filter", entry.name, "test", `--shard=${entry.shardIndex}/${entry.shardCount}`],
      { env: shardEnv },
    );
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
