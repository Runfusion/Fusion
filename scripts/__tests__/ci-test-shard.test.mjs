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

test("planShardAssignments: returns array of requested shard count", () => {
  const result = planShardAssignments([{ name: "a", testFileCount: 1 }], 3);
  assert.equal(result.length, 3);
});

test("planShardAssignments: trailing shards are empty when shard count exceeds packages", () => {
  const result = planShardAssignments([{ name: "a", testFileCount: 1 }], 3, { threshold: Number.POSITIVE_INFINITY });
  assert.deepEqual(result[1], []);
  assert.deepEqual(result[2], []);
});

test("planShardAssignments: greedy balancing keeps shard totals within 1", () => {
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
