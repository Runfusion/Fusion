#!/usr/bin/env node

/**
 * CI shard planner with virtual package slices.
 *
 * Packages are weighted by discovered test-file count. Oversized packages are
 * rewritten into virtual shard entries `{ name, shardIndex, shardCount }` so
 * one package can execute across multiple CI shards via `vitest --shard`.
 * The planner then greedily bin-packs weighted entries into the lightest shard
 * while keeping slices of the same package on different shards whenever
 * possible.
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
  }).length;
}

/**
 * @typedef {{ name: string, shardIndex?: number, shardCount?: number }} ShardEntry
 */

/**
 * @typedef {ShardEntry & { weight: number }} WeightedShardEntry
 */

/**
 * @param {Array<{name:string, testFileCount:number}>} packages
 * @param {number} total
 * @param {{ threshold?: number }} [options]
 * @returns {WeightedShardEntry[]}
 */
export function computeSplitPlan(packages, total, options = {}) {
  const threshold = options.threshold ?? 0.5;
  const totalWeight = packages.reduce((sum, p) => sum + p.testFileCount, 0);
  const perShardBudget = total > 0 ? totalWeight / total : 0;
  const splitLimit = perShardBudget * threshold;

  const result = [];
  for (const pkg of packages) {
    const shouldConsiderSplit =
      total > 1 &&
      pkg.testFileCount > 0 &&
      perShardBudget > 0 &&
      pkg.testFileCount > splitLimit;
    const sliceCount = shouldConsiderSplit
      ? Math.min(total, Math.ceil(pkg.testFileCount / perShardBudget))
      : 1;

    if (sliceCount < 2) {
      result.push({ name: pkg.name, weight: pkg.testFileCount });
      continue;
    }

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

  return result;
}

/**
 * @param {Array<{name:string, testFileCount:number}>} packages
 * @param {number} total
 * @param {{ threshold?: number }} [options]
 * @returns {ShardEntry[][]}
 */
export function planShardAssignments(packages, total, options = {}) {
  const splitPlan = computeSplitPlan(packages, total, options);
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

    let targetIndex = candidates[0] ?? 0;
    for (const index of candidates) {
      if (shardWeights[index] < shardWeights[targetIndex]) {
        targetIndex = index;
      }
    }

    shardAssignments[targetIndex].push(entry.shardCount ? {
      name: entry.name,
      shardIndex: entry.shardIndex,
      shardCount: entry.shardCount,
    } : { name: entry.name });
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
    run("pnpm", ["--filter", entry.name, "test", "--", "--shard", `${entry.shardIndex}/${entry.shardCount}`], {
      env: shardEnv,
    });
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
