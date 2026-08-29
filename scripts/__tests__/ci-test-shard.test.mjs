import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A throwaway project root that contains only a stale timing snapshot, used to
// exercise the `--check-timings-staleness` exit-1 path without mutating the
// committed snapshot. The script resolves the snapshot relative to cwd.
const STALE_FIXTURE_ROOT = mkdtempSync(path.join(tmpdir(), "u6-stale-cli-"));
mkdirSync(path.join(STALE_FIXTURE_ROOT, "scripts"), { recursive: true });
writeFileSync(
  path.join(STALE_FIXTURE_ROOT, "scripts/test-timings.json"),
  JSON.stringify({
    capturedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    packages: { "@fusion/core": { files: { "packages/core/a.test.ts": 500 } } },
  }),
);
process.on("exit", () => rmSync(STALE_FIXTURE_ROOT, { recursive: true, force: true }));

import {
  computeSplitPlan,
  planShardAssignments,
  selectShardPackages,
  countPackageTestFiles,
  loadPlanningTimings,
  computePackageDurationWeight,
  laneShardFraction,
  sumFileDurations,
  enumerateDashboardLanes,
  laneProjectNames,
  buildShardCommands,
  TIMINGS_STALENESS_DAYS,
} from "../ci-test-shard.mjs";

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function writeSnapshot(dir, capturedAt, packages) {
  const file = path.join(dir, "test-timings.json");
  writeFileSync(file, JSON.stringify({ capturedAt, packages }));
  return file;
}

test("computeSplitPlan: returns unsplit entries when package weights do not exceed split limit", () => {
  const packages = [
    { name: "a", testFileCount: 2 },
    { name: "b", testFileCount: 1 },
  ];

  const result = computeSplitPlan(packages, 3, { threshold: 2 });
  assert.deepEqual(result, [
    { name: "a", weight: 2 },
    { name: "b", weight: 1 },
  ]);
});

test("computeSplitPlan: returns [] for empty input", () => {
  assert.deepEqual(computeSplitPlan([], 4), []);
});

test("computeSplitPlan: high threshold avoids splitting", () => {
  const result = computeSplitPlan([{ name: "only", testFileCount: 10 }], 4, { threshold: Number.POSITIVE_INFINITY });
  assert.deepEqual(result, [{ name: "only", weight: 10 }]);
});

test("computeSplitPlan: threshold <= 0 splits when total > 1", () => {
  const result = computeSplitPlan([{ name: "only", testFileCount: 10 }], 4, { threshold: 0 });
  assert.equal(result.length, 4);
  assert.ok(result.every((entry) => entry.shardCount === 4));
});

test("computeSplitPlan: exact split limit boundary stays unsplit", () => {
  const packages = [
    { name: "boundary", testFileCount: 2 },
    { name: "other", testFileCount: 2 },
  ];
  const total = 2;
  const threshold = 1;
  // perShardBudget = 2, splitLimit = 2, and 2 is not greater than 2.
  const result = computeSplitPlan(packages, total, { threshold });
  assert.deepEqual(result, [
    { name: "boundary", weight: 2 },
    { name: "other", weight: 2 },
  ]);
});

test("computeSplitPlan: oversized package splits into balanced virtual entries", () => {
  const result = computeSplitPlan([{ name: "big", testFileCount: 10 }], 4, { threshold: 0.5 });
  assert.equal(result.length, 4);
  assert.ok(result.every((entry) => entry.name === "big"));
  assert.deepEqual(
    result.map((entry) => entry.shardIndex),
    [1, 2, 3, 4],
  );
  assert.ok(result.every((entry) => entry.shardCount === 4));
  assert.deepEqual(result.map((entry) => entry.weight), [3, 3, 3, 3]);
  assert.equal(result.reduce((sum, entry) => sum + entry.weight, 0), 12);
});

test("computeSplitPlan: half-budget package now splits into exactly two virtual entries (FN-4989)", () => {
  const packages = [
    { name: "dashboard", testFileCount: 553 },
    { name: "engine", testFileCount: 365 },
    { name: "core", testFileCount: 200 },
    { name: "cli", testFileCount: 71 },
    { name: "tail-a", testFileCount: 39 },
    { name: "tail-b", testFileCount: 35 },
    { name: "tail-c", testFileCount: 31 },
    { name: "tail-d", testFileCount: 19 },
    { name: "tail-e", testFileCount: 18 },
    { name: "tail-f", testFileCount: 18 },
    { name: "tail-g", testFileCount: 17 },
    { name: "tail-h", testFileCount: 16 },
    { name: "tail-i", testFileCount: 15 },
    { name: "tail-j", testFileCount: 12 },
  ];

  const result = computeSplitPlan(packages, 4);
  const coreEntries = result.filter((entry) => entry.name === "core");

  assert.equal(coreEntries.length, 2);
  assert.ok(coreEntries.every((entry) => entry.shardCount === 2));
  assert.deepEqual(
    coreEntries.map((entry) => entry.shardIndex).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [1, 2],
  );
  assert.ok(coreEntries.every((entry) => entry.weight === 100));
});

test("computeSplitPlan: package above splitLimit but below perShardBudget still splits in two", () => {
  const result = computeSplitPlan(
    [
      { name: "solo", testFileCount: 6 },
      { name: "big", testFileCount: 20 },
    ],
    4,
  );

  const soloEntries = result.filter((entry) => entry.name === "solo");
  assert.equal(soloEntries.length, 2);
  assert.deepEqual(
    soloEntries.map((entry) => ({
      shardIndex: entry.shardIndex,
      shardCount: entry.shardCount,
      weight: entry.weight,
    })),
    [
      { shardIndex: 1, shardCount: 2, weight: 3 },
      { shardIndex: 2, shardCount: 2, weight: 3 },
    ],
  );
});

test("planShardAssignments: returns array of requested shard count", () => {
  const result = planShardAssignments([{ name: "a", testFileCount: 1 }], 3);
  assert.equal(result.length, 3);
});

test("planShardAssignments: trailing shards are empty when shard count exceeds packages", () => {
  const result = planShardAssignments([{ name: "a", testFileCount: 1 }], 3, { threshold: Number.POSITIVE_INFINITY });
  assert.deepEqual(result[1], []);
  assert.deepEqual(result[2], []);
});

test("planShardAssignments: best-fit balancing keeps shard totals within 1", () => {
  const packages = [
    { name: "a", testFileCount: 5 },
    { name: "b", testFileCount: 4 },
    { name: "c", testFileCount: 3 },
    { name: "d", testFileCount: 2 },
  ];
  const splitPlan = computeSplitPlan(packages, 2, { threshold: Number.POSITIVE_INFINITY });
  const byName = new Map(splitPlan.map((entry) => [entry.name, entry.weight]));

  const shards = planShardAssignments(packages, 2, { threshold: Number.POSITIVE_INFINITY });
  const totals = shards.map((entries) => entries.reduce((sum, entry) => sum + (byName.get(entry.name) ?? 0), 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 1);
});

test("planShardAssignments: oversized package can be split across shards with consistent shardCount", () => {
  const packages = [
    { name: "big", testFileCount: 20 },
    { name: "small", testFileCount: 2 },
  ];
  const shards = planShardAssignments(packages, 4);
  const bigEntries = shards.flat().filter((entry) => entry.name === "big");

  assert.ok(bigEntries.some((entry) => (entry.shardCount ?? 0) > 1));
  const shardCounts = new Set(bigEntries.map((entry) => entry.shardCount));
  assert.equal(shardCounts.size, 1);
});

test("planShardAssignments: preserves total input weight via computeSplitPlan-derived mapping", () => {
  const packages = [
    { name: "big", testFileCount: 20 },
    { name: "small", testFileCount: 2 },
  ];
  const splitPlan = computeSplitPlan(packages, 4);
  const keyFor = (entry) => `${entry.name}:${entry.shardIndex ?? 0}/${entry.shardCount ?? 0}`;
  const weightByKey = new Map(splitPlan.map((entry) => [keyFor(entry), entry.weight]));

  const assigned = planShardAssignments(packages, 4);
  const assignedWeight = assigned
    .flat()
    .reduce((sum, entry) => sum + (weightByKey.get(keyFor(entry)) ?? 0), 0);

  const inputWeight = packages.reduce((sum, pkg) => sum + pkg.testFileCount, 0);
  assert.equal(assignedWeight, inputWeight);
});

test("planShardAssignments: FN-4989 real-ci-like distribution stays below 2% total variance", () => {
  const packages = [
    { name: "@fusion/dashboard", testFileCount: 553 },
    { name: "@fusion/engine", testFileCount: 365 },
    { name: "@fusion/core", testFileCount: 200 },
    { name: "@runfusion/fusion", testFileCount: 71 },
    { name: "tail-a", testFileCount: 39 },
    { name: "tail-b", testFileCount: 35 },
    { name: "tail-c", testFileCount: 31 },
    { name: "tail-d", testFileCount: 19 },
    { name: "tail-e", testFileCount: 18 },
    { name: "tail-f", testFileCount: 18 },
    { name: "tail-g", testFileCount: 17 },
    { name: "tail-h", testFileCount: 16 },
    { name: "tail-i", testFileCount: 15 },
    { name: "tail-j", testFileCount: 12 },
  ];

  const shards = planShardAssignments(packages, 4);
  const totals = shards.map((entries) => entries.reduce((sum, entry) => sum + entry.weight, 0));
  const totalWeight = totals.reduce((sum, weight) => sum + weight, 0);
  const varianceRatio = (Math.max(...totals) - Math.min(...totals)) / totalWeight;

  assert.ok(
    varianceRatio < 0.02,
    `expected <2% variance but got ${(varianceRatio * 100).toFixed(2)}% (${totals.join("/")})`,
  );
});

test("planShardAssignments: FN-5036 keeps split engine slices from co-locating with heavy core and stays within 5% variance", () => {
  const packages = [
    { name: "@fusion/dashboard", testFileCount: 606 },
    { name: "@fusion/engine", testFileCount: 365 },
    { name: "@fusion/core", testFileCount: 200 },
    { name: "@runfusion/fusion", testFileCount: 71 },
    { name: "tail-a", testFileCount: 39 },
    { name: "tail-b", testFileCount: 35 },
    { name: "tail-c", testFileCount: 31 },
    { name: "tail-d", testFileCount: 19 },
    { name: "tail-e", testFileCount: 18 },
    { name: "tail-f", testFileCount: 18 },
    { name: "tail-g", testFileCount: 17 },
    { name: "tail-h", testFileCount: 16 },
    { name: "tail-i", testFileCount: 15 },
    { name: "tail-j", testFileCount: 12 },
  ];

  const shards = planShardAssignments(packages, 4);
  const totals = shards.map((entries) => entries.reduce((sum, entry) => sum + entry.weight, 0));
  const mean = totals.reduce((sum, weight) => sum + weight, 0) / totals.length;
  const varianceRatio = (Math.max(...totals) - Math.min(...totals)) / mean;

  assert.ok(
    varianceRatio <= 0.05,
    `expected <=5% variance but got ${(varianceRatio * 100).toFixed(2)}% (${totals.join("/")})`,
  );

  for (const entries of shards) {
    const hasCore = entries.some((entry) => entry.name === "@fusion/core");
    if (!hasCore) continue;
    const engineSliceCount = entries.filter((entry) => entry.name === "@fusion/engine" && entry.shardCount).length;
    assert.ok(
      engineSliceCount < 2,
      "expected @fusion/core to not share a shard with both @fusion/engine virtual slices",
    );
  }
});

test("planShardAssignments: FN-5033 regression workload stays below 5% 4-shard variance", () => {
  const packages = [
    { name: "@fusion/dashboard", testFileCount: 608 },
    { name: "@fusion/engine", testFileCount: 380 },
    { name: "@fusion/core", testFileCount: 202 },
    { name: "@runfusion/fusion", testFileCount: 120 },
    { name: "tail-a", testFileCount: 90 },
    { name: "tail-b", testFileCount: 80 },
    { name: "tail-c", testFileCount: 70 },
    { name: "tail-d", testFileCount: 70 },
  ];

  const shards = planShardAssignments(packages, 4);
  const totals = shards.map((entries) => entries.reduce((sum, entry) => sum + entry.weight, 0));
  const perShardBudget = totals.reduce((sum, weight) => sum + weight, 0) / totals.length;
  const varianceRatio = (Math.max(...totals) - Math.min(...totals)) / perShardBudget;

  assert.ok(
    varianceRatio < 0.05,
    `expected <5% variance but got ${(varianceRatio * 100).toFixed(2)}% (${totals.join("/")})`,
  );
});

test("planShardAssignments: best-fit places unsplit large package on tightest under-budget shard", () => {
  const packages = [
    { name: "anchor", testFileCount: 290 },
    { name: "preload", testFileCount: 220 },
    { name: "x-large-unsplit", testFileCount: 200 },
    { name: "near-budget", testFileCount: 170 },
    { name: "small", testFileCount: 40 },
    { name: "tiny", testFileCount: 30 },
  ];

  const shards = planShardAssignments(packages, 3, { threshold: Number.POSITIVE_INFINITY });
  const targetIndex = shards.findIndex((entries) => entries.some((entry) => entry.name === "x-large-unsplit"));

  assert.equal(targetIndex, 2, "best-fit should place 200-weight package onto the empty shard");
});

test("planShardAssignments: uses minimum overshoot and deterministic tie-break when all candidates exceed budget", () => {
  const packages = [
    { name: "gamma", testFileCount: 80 },
    { name: "beta", testFileCount: 70 },
    { name: "alpha", testFileCount: 60 },
    { name: "overshoot", testFileCount: 100 },
  ];

  const first = planShardAssignments(packages, 2, { threshold: Number.POSITIVE_INFINITY });
  const second = planShardAssignments(packages, 2, { threshold: Number.POSITIVE_INFINITY });

  const overshootShard = first.findIndex((entries) => entries.some((entry) => entry.name === "overshoot"));
  assert.equal(overshootShard, 0);
  assert.deepEqual(first, second);
});

test("planShardAssignments: keeps split slices isolated across distinct shards", () => {
  const packages = [
    { name: "split-me", testFileCount: 16 },
    { name: "small", testFileCount: 2 },
  ];

  const shards = planShardAssignments(packages, 2, { threshold: 0.5 });
  const splitSliceShardIndices = shards
    .map((entries, shardIndex) => ({ entries, shardIndex }))
    .filter(({ entries }) => entries.some((entry) => entry.name === "split-me"))
    .map(({ shardIndex }) => shardIndex);

  assert.deepEqual(splitSliceShardIndices, [0, 1]);
});

test("planShardAssignments: deterministic output for repeated calls", () => {
  const packages = [
    { name: "p1", testFileCount: 41 },
    { name: "p2", testFileCount: 39 },
    { name: "p3", testFileCount: 27 },
    { name: "p4", testFileCount: 12 },
    { name: "p5", testFileCount: 8 },
  ];

  assert.deepEqual(
    planShardAssignments(packages, 3, { threshold: Number.POSITIVE_INFINITY }),
    planShardAssignments(packages, 3, { threshold: Number.POSITIVE_INFINITY }),
  );
});

test("selectShardPackages: returns the same shard assignment as planShardAssignments", () => {
  const packages = [
    { name: "a", testFileCount: 5 },
    { name: "b", testFileCount: 1 },
  ];
  const total = 3;
  const shard = 2;

  assert.deepEqual(
    selectShardPackages(packages, shard, total),
    planShardAssignments(packages, total)[shard - 1],
  );
});

test("selectShardPackages: returns [] for empty shard index assignment", () => {
  const result = selectShardPackages([{ name: "a", testFileCount: 1 }], 3, 3, {
    threshold: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(result, []);
});

test("countPackageTestFiles: counts matching test files under __tests__", (t) => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "fn-4207-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  mkdirSync(path.join(tmpRoot, "pkg/src/__tests__"), { recursive: true });
  mkdirSync(path.join(tmpRoot, "pkg/app/__tests__"), { recursive: true });
  mkdirSync(path.join(tmpRoot, "pkg/scripts/__tests__"), { recursive: true });

  writeFileSync(path.join(tmpRoot, "pkg/src/__tests__/foo.test.ts"), "");
  writeFileSync(path.join(tmpRoot, "pkg/app/__tests__/bar.test.tsx"), "");
  writeFileSync(path.join(tmpRoot, "pkg/scripts/__tests__/baz.test.mjs"), "");
  writeFileSync(path.join(tmpRoot, "pkg/src/__tests__/helper.ts"), "");
  writeFileSync(path.join(tmpRoot, "pkg/README.md"), "");

  assert.equal(countPackageTestFiles("pkg", { projectRoot: tmpRoot }), 3);
});

test("countPackageTestFiles: returns 0 when no __tests__ matches exist", (t) => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "fn-4207-empty-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  mkdirSync(path.join(tmpRoot, "pkg/src"), { recursive: true });
  writeFileSync(path.join(tmpRoot, "pkg/src/index.ts"), "export {}\n");

  assert.equal(countPackageTestFiles("pkg", { projectRoot: tmpRoot }), 0);
});

// ---------------------------------------------------------------------------
// U6 (R3, R4): duration-based weighting, staleness, dashboard lane distribution
// ---------------------------------------------------------------------------

test("U6: duration weights produce balanced shards on skewed inputs where file-count would skew", () => {
  // 10 "engine" real-git files at 10s each (100s) vs 50 "core" unit files at
  // 0.4s each (20s). File-count weighting would call core the heavier package.
  const durationPackages = [
    { name: "engine", weight: 100_000, splittable: true },
    { name: "core", weight: 20_000, splittable: true },
    { name: "cli", weight: 12_000, splittable: true },
    { name: "tail", weight: 8_000, splittable: true },
  ];
  const shards = planShardAssignments(durationPackages, 2);
  const totals = shards.map((entries) => entries.reduce((sum, e) => sum + e.weight, 0));
  const spread = (Math.max(...totals) - Math.min(...totals)) / (totals.reduce((a, b) => a + b, 0) / 2);
  assert.ok(spread <= 0.05, `duration spread ${(spread * 100).toFixed(1)}% should be <=5% (${totals.join("/")})`);

  // Motivation fixture: the SAME workload weighted by file count is badly
  // skewed because the heavy engine has few files.
  const fileCountPackages = [
    { name: "engine", testFileCount: 10 },
    { name: "core", testFileCount: 50 },
    { name: "cli", testFileCount: 30 },
    { name: "tail", testFileCount: 20 },
  ];
  // Disable splitting to expose the raw file-count balance signal.
  const fcShards = planShardAssignments(fileCountPackages, 2, { threshold: Number.POSITIVE_INFINITY });
  const fcDurations = { engine: 100_000, core: 20_000, cli: 12_000, tail: 8_000 };
  const fcTotals = fcShards.map((entries) => entries.reduce((sum, e) => sum + fcDurations[e.name], 0));
  const fcSpread =
    (Math.max(...fcTotals) - Math.min(...fcTotals)) / (fcTotals.reduce((a, b) => a + b, 0) / 2);
  assert.ok(
    fcSpread > 0.05,
    `file-count weighting should mis-balance real durations (got ${(fcSpread * 100).toFixed(1)}%, ${fcTotals.join("/")})`,
  );
});

test("U6: loadPlanningTimings sums per-package durations and derives a median per-file fallback", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "u6-timings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = writeSnapshot(dir, new Date().toISOString(), {
    "@fusion/core": { files: { "packages/core/a.test.ts": 200, "packages/core/b.test.ts": 600 } },
    "@fusion/engine": { files: { "packages/engine/x.test.ts": 1000 } },
  });
  const timings = loadPlanningTimings({ snapshotPath });
  assert.equal(timings.present, true);
  assert.equal(timings.stale, false);
  assert.equal(timings.fileDurations.get("packages/core/a.test.ts"), 200);
  // median of [200, 600, 1000] = 600
  assert.equal(timings.medianPerFileMs, 600);
});

test("U6: sumFileDurations reports timed/untimed counts", () => {
  const map = new Map([["a.test.ts", 300]]);
  const result = sumFileDurations(["a.test.ts", "missing.test.ts"], map);
  assert.equal(result.durationMs, 300);
  assert.equal(result.timedCount, 1);
  assert.equal(result.untimedCount, 1);
});

test("U6: untimed package falls back to median-scaled file-count weight with a warning", (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "u6-fallback-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  // Build a fake package with 3 test files, none present in the snapshot.
  mkdirSync(path.join(projectRoot, "packages/newpkg/src/__tests__"), { recursive: true });
  for (const f of ["one", "two", "three"]) {
    writeFileSync(path.join(projectRoot, `packages/newpkg/src/__tests__/${f}.test.ts`), "");
  }
  const snapshotPath = writeSnapshot(projectRoot, new Date().toISOString(), {
    "@fusion/core": { files: { "packages/core/a.test.ts": 500, "packages/core/b.test.ts": 500 } },
  });
  const timings = loadPlanningTimings({ snapshotPath });
  const weighted = computePackageDurationWeight(
    { name: "@fusion/newpkg", dir: "packages/newpkg" },
    timings,
    { projectRoot },
  );
  assert.equal(weighted.fullyUntimed, true);
  // 3 untimed files * median(500) = 1500
  assert.equal(weighted.weight, 1500);
});

test("U6: staleness — snapshot older than the budget is flagged stale (warning, not failure)", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "u6-stale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new Date(Date.now() - (TIMINGS_STALENESS_DAYS + 10) * 86_400_000).toISOString();
  const snapshotPath = writeSnapshot(dir, old, { p: { files: { "a.test.ts": 100 } } });
  const timings = loadPlanningTimings({ snapshotPath });
  assert.equal(timings.stale, true);
  assert.ok(timings.ageDays > TIMINGS_STALENESS_DAYS);

  const fresh = new Date(Date.now() - 1 * 86_400_000).toISOString();
  const freshPath = writeSnapshot(dir, fresh, { p: { files: { "a.test.ts": 100 } } });
  assert.equal(loadPlanningTimings({ snapshotPath: freshPath }).stale, false);
});

test("U6: --check-timings-staleness exits non-zero on a stale snapshot", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-test-shard.mjs"), "--check-timings-staleness"],
    { cwd: STALE_FIXTURE_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /stale/i);
});

test("U6: enumerateDashboardLanes expands the test chain to leaf vitest lanes (no hardcoding)", () => {
  const scripts = {
    test: "pnpm run test:app && pnpm run test:api",
    "test:app": "pnpm run test:app:foundation && pnpm run test:app:components",
    "test:app:foundation": "vitest run --project dashboard-app-quality-foundation-api",
    "test:app:components": "vitest run --project dashboard-app-quality-components-a",
    "test:api": "vitest run --project dashboard-api-quality",
  };
  const lanes = enumerateDashboardLanes(scripts, "test");
  assert.deepEqual(lanes, [
    "test:app:foundation",
    "test:app:components",
    "test:api",
  ]);
});

test("U6: enumerateDashboardLanes reads lanes from a fixture package.json shape", () => {
  const pkgJson = {
    scripts: {
      test: "pnpm run test:quality:app && pnpm run test:quality:api",
      "test:quality:app": "pnpm run test:quality:app:a && pnpm run test:quality:app:b",
      "test:quality:app:a": "vitest run --project x",
      "test:quality:app:b": "vitest run --project y",
      "test:quality:api": "vitest run --project z",
      // unrelated script not reachable from `test` must not appear
      "test:deep": "vitest run --project deep",
    },
  };
  const lanes = enumerateDashboardLanes(pkgJson.scripts, "test");
  assert.deepEqual(lanes, ["test:quality:app:a", "test:quality:app:b", "test:quality:api"]);
});

test("U6: enumerateDashboardLanes expands run-quality-tests delegators to package leaf lanes", () => {
  const scripts = {
    test: "node scripts/run-quality-tests.mjs",
    "test:quality:app": "node scripts/run-quality-tests.mjs --group app",
    "test:quality:app:a": "node scripts/run-vitest-with-heap.mjs run --project app-a",
    "test:quality:app:b": "node scripts/run-vitest-with-heap.mjs run --project app-b --shard=1/2",
    "test:quality:app:aggregate": "pnpm run test:quality:app:a && pnpm run test:quality:app:b",
    "test:quality:api": "node scripts/run-quality-tests.mjs --group=api",
    "test:quality:api:a": "node scripts/run-vitest-with-heap.mjs run --project api-a",
    "test:quality:api:delegator": "node scripts/run-quality-tests.mjs --group api",
    "test:quality:misc": "node scripts/run-vitest-with-heap.mjs run --project misc",
    "test:deep": "vitest run --project deep",
  };

  assert.deepEqual(enumerateDashboardLanes(scripts, "test"), [
    "test:quality:app:a",
    "test:quality:app:b",
    "test:quality:api:a",
    "test:quality:misc",
  ]);
  assert.deepEqual(enumerateDashboardLanes(scripts, "test:quality:app"), [
    "test:quality:app:a",
    "test:quality:app:b",
  ]);
  assert.deepEqual(enumerateDashboardLanes(scripts, "test:quality:api"), ["test:quality:api:a"]);
});

test("U6: enumerateDashboardLanes preserves single-leaf fallback for non-delegating scripts", () => {
  assert.deepEqual(enumerateDashboardLanes({ test: "node custom-runner.mjs" }, "test"), ["test"]);
  assert.deepEqual(enumerateDashboardLanes({}, "test"), []);
});

test("U6: laneProjectNames extracts --project targets including = and space forms", () => {
  assert.deepEqual(laneProjectNames("vitest run --project foo --project=bar baz"), ["foo", "bar"]);
});

test("U6: every dashboard lane is assigned to exactly one shard (union == enumerated list)", () => {
  const lanes = ["lane-a", "lane-b", "lane-c", "lane-d", "lane-e"];
  const units = [
    { name: "@fusion/engine", weight: 50_000, splittable: true },
    { name: "@fusion/core", weight: 40_000, splittable: true },
    ...lanes.map((lane, i) => ({
      name: "@fusion/dashboard",
      lane,
      runKind: "dashboard-lane",
      weight: 10_000 + i * 1000,
      splittable: false,
    })),
  ];
  const shards = planShardAssignments(units, 4);
  const occur = new Map();
  let dashboardShardSlices = 0;
  for (const shard of shards) {
    for (const entry of shard) {
      if (entry.runKind === "dashboard-lane") occur.set(entry.lane, (occur.get(entry.lane) ?? 0) + 1);
      if (entry.name === "@fusion/dashboard" && entry.shardCount) dashboardShardSlices += 1;
    }
  }
  assert.equal(dashboardShardSlices, 0, "dashboard lane units must never be vitest --shard sliced");
  assert.deepEqual([...occur.keys()].sort(), [...lanes].sort());
  for (const lane of lanes) assert.equal(occur.get(lane), 1, `lane ${lane} should appear exactly once`);
});

test("U6: buildShardCommands emits per-lane `run <lane>`, plain `test`, and virtual `--shard`", () => {
  const entries = [
    { name: "@fusion/core", weight: 1 },
    { name: "@fusion/engine", weight: 1, shardIndex: 1, shardCount: 2 },
    { name: "@fusion/dashboard", weight: 1, runKind: "dashboard-lane", lane: "test:quality:api" },
  ];
  const commands = buildShardCommands(entries);
  const plain = commands.find((c) => c.kind === "plain");
  const virtual = commands.find((c) => c.kind === "virtual");
  const lane = commands.find((c) => c.kind === "dashboard-lane");
  assert.deepEqual(plain.args, ["--filter", "@fusion/core", "test"]);
  assert.deepEqual(virtual.args, ["--filter", "@fusion/engine", "test", "--shard=1/2"]);
  assert.deepEqual(lane.args, ["--filter", "@fusion/dashboard", "run", "test:quality:api"]);
});

test("U6: --dry-run prints planned commands and per-shard weight for all 4 shards", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-test-shard.mjs"), "--dry-run", "--total", "4"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  for (let n = 1; n <= 4; n += 1) {
    assert.match(result.stdout, new RegExp(`shard ${n}/4 — weight`));
  }
  // Each dashboard lane appears exactly once across the printed plan.
  const laneMatches = result.stdout.match(/--filter @fusion\/dashboard run [\w:-]+/g) ?? [];
  const laneNames = laneMatches.map((m) => m.split("run ")[1]);
  assert.equal(new Set(laneNames).size, laneNames.length, "no dashboard lane should be printed twice");
  assert.ok(laneNames.length >= 10, `expected the dashboard lane chain, saw ${laneNames.length}`);
  // Dashboard must NOT be virtual-sliced.
  assert.doesNotMatch(result.stdout, /--filter @fusion\/dashboard test --shard/);
});

test("U6 fix: laneShardFraction sums chained --shard invocations, capped at 1", () => {
  // Single half-shard lane (app backfill style): genuinely runs 1/4.
  assert.equal(laneShardFraction("vitest run --project p --shard=1/4"), 0.25);
  // Chained halves in one lane (api backfill style): runs the FULL project.
  assert.equal(
    laneShardFraction("run-heap --shard=1/2 && run-heap --shard=2/2"),
    1,
  );
  // No shard flag: whole project.
  assert.equal(laneShardFraction("vitest run --project p"), 1);
  // Over-complete chains clamp at 1.
  assert.equal(
    laneShardFraction("a --shard=1/2 && b --shard=2/2 && c --shard=1/2"),
    1,
  );
});

test("U6 fix: computePackageDurationWeight excludes slow-tier files from weighting", (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "u6-slow-excl-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(path.join(projectRoot, "packages/eng/src/__tests__"), { recursive: true });
  writeFileSync(path.join(projectRoot, "packages/eng/src/__tests__/fast.test.ts"), "");
  writeFileSync(path.join(projectRoot, "packages/eng/src/__tests__/heavy.slow.test.ts"), "");
  const snapshotPath = writeSnapshot(projectRoot, new Date().toISOString(), {
    "@x/eng": { files: { "packages/eng/src/__tests__/fast.test.ts": 400 } },
  });
  const timings = loadPlanningTimings({ snapshotPath });
  const weighted = computePackageDurationWeight({ name: "@x/eng", dir: "packages/eng" }, timings, {
    projectRoot,
  });
  // Only the fast file counts: 400ms timed, zero untimed fallback for the
  // slow file (which the package `test` script never runs).
  assert.equal(weighted.weight, 400);
  assert.equal(weighted.partiallyUntimed, false);
});

test("U6: buildShardCommands forwards JSON timing flags to plain package test scripts", () => {
  const timingFlags = ["--reporter=json", "--outputFile.json=.timings/timings-shard3-0.json"];
  const [command] = buildShardCommands([{ name: "@fusion/desktop", weight: 1 }], {
    timingFlags: () => timingFlags,
  });

  assert.deepEqual(command.args, ["--filter", "@fusion/desktop", "test", ...timingFlags]);
});
