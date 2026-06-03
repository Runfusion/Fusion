/**
 * Unit tests for the U1 timing-telemetry aggregation built into
 * scripts/ci-test-shard.mjs.
 *
 * Runner: node --test scripts/__tests__/ci-test-shard-timings.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bucketDuration,
  attributeTestFile,
  extractFileDurations,
  buildTimingsSnapshot,
  writeTimings,
  TIMINGS_SNAPSHOT_RELATIVE,
} from "../ci-test-shard.mjs";

const PACKAGES = [
  { name: "@fusion/core", dir: "packages/core" },
  { name: "@fusion/engine", dir: "packages/engine" },
];

function makeReport(projectRoot, files) {
  // files: Array<{ rel: string, durationMs: number }>
  return {
    testResults: files.map(({ rel, durationMs }) => ({
      name: path.join(projectRoot, rel),
      startTime: 1000,
      endTime: 1000 + durationMs,
      assertionResults: [],
    })),
  };
}

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-timings-test-"));
}

test("bucketDuration rounds to nearest 100ms, floors non-zero to one bucket", () => {
  assert.equal(bucketDuration(0), 0);
  assert.equal(bucketDuration(40), 100); // sub-bucket non-zero floors up
  assert.equal(bucketDuration(149), 100);
  assert.equal(bucketDuration(150), 200);
  assert.equal(bucketDuration(1234), 1200);
  assert.equal(bucketDuration(-5), 0);
});

test("attributeTestFile maps absolute paths to owning package, repo-relative", () => {
  const root = "/repo";
  const got = attributeTestFile("/repo/packages/core/src/__tests__/a.test.ts", PACKAGES, root);
  assert.deepEqual(got, { pkg: "@fusion/core", file: "packages/core/src/__tests__/a.test.ts" });
  assert.equal(attributeTestFile("/repo/tools/x.test.ts", PACKAGES, root), null);
});

test("extractFileDurations sums per-file durations and tolerates bad rows", () => {
  const root = "/repo";
  const report = {
    testResults: [
      { name: "/repo/packages/core/a.test.ts", startTime: 0, endTime: 250 },
      { name: "/repo/packages/core/a.test.ts", startTime: 250, endTime: 500 }, // same file, summed
      { name: "/repo/packages/engine/b.test.ts", startTime: 0, endTime: 700 },
      { name: 42, startTime: 0, endTime: 1 }, // bad name
      { name: "/repo/packages/core/c.test.ts", startTime: 500, endTime: 100 }, // end<start ignored
      { name: "/repo/outside/d.test.ts", startTime: 0, endTime: 5 }, // unattributable
    ],
  };
  const byPkg = extractFileDurations(report, PACKAGES, root);
  assert.equal(byPkg.get("@fusion/core").get("packages/core/a.test.ts"), 500);
  assert.equal(byPkg.get("@fusion/engine").get("packages/engine/b.test.ts"), 700);
  assert.ok(!byPkg.get("@fusion/core").has("packages/core/c.test.ts"));
});

test("buildTimingsSnapshot merges two shard JSON fixtures, sums per file, buckets", () => {
  const root = tmpRoot();
  try {
    const f1 = path.join(root, "s1.json");
    const f2 = path.join(root, "s2.json");
    writeFileSync(f1, JSON.stringify(makeReport(root, [
      { rel: "packages/core/src/__tests__/a.test.ts", durationMs: 240 },
      { rel: "packages/engine/src/__tests__/b.test.ts", durationMs: 1010 },
    ])));
    writeFileSync(f2, JSON.stringify(makeReport(root, [
      // same file as f1 → durations sum across shards before bucketing
      { rel: "packages/core/src/__tests__/a.test.ts", durationMs: 60 },
    ])));

    const snap = buildTimingsSnapshot([f1, f2], { projectRoot: root, packages: PACKAGES, capturedAt: "2026-06-03T00:00:00.000Z" });
    assert.equal(snap.capturedAt, "2026-06-03T00:00:00.000Z");
    // 240 + 60 = 300 → bucketed to 300
    assert.equal(snap.packages["@fusion/core"].files["packages/core/src/__tests__/a.test.ts"], 300);
    // 1010 → 1000
    assert.equal(snap.packages["@fusion/engine"].files["packages/engine/src/__tests__/b.test.ts"], 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTimingsSnapshot tolerates a corrupt shard file: skips it, keeps others", () => {
  const root = tmpRoot();
  try {
    const good = path.join(root, "good.json");
    const bad = path.join(root, "bad.json");
    writeFileSync(good, JSON.stringify(makeReport(root, [
      { rel: "packages/core/x.test.ts", durationMs: 300 },
    ])));
    writeFileSync(bad, "{not valid json");

    const snap = buildTimingsSnapshot([bad, good, path.join(root, "missing.json")], {
      projectRoot: root,
      packages: PACKAGES,
      capturedAt: "2026-06-03T00:00:00.000Z",
    });
    assert.equal(snap.packages["@fusion/core"].files["packages/core/x.test.ts"], 300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTimingsSnapshot omits a zero-test package entirely (no zero entry)", () => {
  const root = tmpRoot();
  try {
    const f = path.join(root, "s.json");
    writeFileSync(f, JSON.stringify(makeReport(root, [
      { rel: "packages/core/y.test.ts", durationMs: 200 },
    ])));
    const snap = buildTimingsSnapshot([f], { projectRoot: root, packages: PACKAGES, capturedAt: "2026-06-03T00:00:00.000Z" });
    assert.ok(snap.packages["@fusion/core"]);
    assert.ok(!("@fusion/engine" in snap.packages));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeTimings writes snapshot to scripts/test-timings.json under a project root", () => {
  const root = tmpRoot();
  try {
    const inputDir = path.join(root, ".timings");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "timings-shard1-0.json"), JSON.stringify(makeReport(root, [
      { rel: "packages/core/z.test.ts", durationMs: 500 },
    ])));
    const snapshotPath = path.join(root, TIMINGS_SNAPSHOT_RELATIVE);
    const result = writeTimings({
      projectRoot: root,
      inputDir,
      snapshotPath,
      packages: PACKAGES,
      capturedAt: "2026-06-03T00:00:00.000Z",
    });
    assert.equal(result.written, true);
    const written = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(written.packages["@fusion/core"].files["packages/core/z.test.ts"], 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeTimings refuses to overwrite a newer snapshot", () => {
  const root = tmpRoot();
  try {
    const inputDir = path.join(root, ".timings");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "timings-shard1-0.json"), JSON.stringify(makeReport(root, [
      { rel: "packages/core/z.test.ts", durationMs: 500 },
    ])));
    const snapshotPath = path.join(root, "snap.json");
    // Existing snapshot dated in the future.
    writeFileSync(snapshotPath, JSON.stringify({ capturedAt: "2999-01-01T00:00:00.000Z", packages: { keep: { files: {} } } }));

    const result = writeTimings({
      projectRoot: root,
      inputDir,
      snapshotPath,
      packages: PACKAGES,
      capturedAt: "2026-06-03T00:00:00.000Z",
    });
    assert.equal(result.written, false);
    assert.equal(result.reason, "newer-snapshot");
    // Original untouched.
    const after = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(after.capturedAt, "2999-01-01T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeTimings warns and does not write when there are no input files", () => {
  const root = tmpRoot();
  try {
    const result = writeTimings({
      projectRoot: root,
      inputDir: path.join(root, ".timings-empty"),
      snapshotPath: path.join(root, "snap.json"),
    });
    assert.equal(result.written, false);
    assert.equal(result.reason, "no-inputs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
