import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeSplitPlan,
  planShardAssignments,
  selectShardPackages,
  countPackageTestFiles,
} from "../ci-test-shard.mjs";

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
