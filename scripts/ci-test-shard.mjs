#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TEST_PACKAGES = [
  "@fusion/core",
  "@fusion/engine",
  "@fusion/dashboard",
  "@runfusion/fusion",
  "@fusion/plugin-sdk",
  "@fusion/desktop",
  "@fusion/mobile",
  "@fusion/droid-cli",
  "@fusion/pi-claude-cli",
];

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

export function selectShardPackages(packages, shard, total) {
  return packages.filter((_, index) => index % total === shard - 1);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { shard, total } = parseShardArgs(argv, env);
  const shardPackages = selectShardPackages(DEFAULT_TEST_PACKAGES, shard, total);

  if (shardPackages.length === 0) {
    console.log(`[ci-test-shard] shard ${shard}/${total} has no assigned packages; skipping.`);
    return;
  }

  console.log(`[ci-test-shard] shard ${shard}/${total}: ${shardPackages.join(", ")}`);

  const shardEnv = {
    ...env,
    FUSION_TEST_TOTAL_WORKERS: env.FUSION_TEST_TOTAL_WORKERS || "4",
    FUSION_TEST_CONCURRENCY: env.FUSION_TEST_CONCURRENCY || "1",
  };

  run("pnpm", ["sync:fusion-skill:check"], { env: shardEnv });
  const filters = shardPackages.flatMap((pkg) => ["--filter", pkg]);
  run("pnpm", [...filters, "test"], { env: shardEnv });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
