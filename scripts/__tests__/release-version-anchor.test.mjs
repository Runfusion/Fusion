/*
FNXC:UpdateChannels 2026-07-24-09:40:
Guards the release version-anchor contract:
- after a stable ships, the next beta is based on THAT stable version;
- no release (either channel) may number at or below the newest published stable.
Regression context: v0.73.0 was cut on `release` while `main` stayed in the
0.72.0-anchored pre-mode cycle, so the next beta would have been v0.73.0-beta.7
(below the shipped v0.73.0) and `pnpm dev` on main still reported the beta.
*/

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareReleaseVersions,
  evaluateBetaCycleAnchor,
  isVersionAheadOfStable,
  latestStableVersionFromTags,
  setPackageJsonVersions,
} from "../lib/release-version-anchor.mjs";

test("compareReleaseVersions ranks a prerelease below its stable", () => {
  assert.ok(compareReleaseVersions("0.73.0-beta.6", "0.73.0") < 0);
  assert.ok(compareReleaseVersions("0.73.0", "0.73.0-beta.6") > 0);
  assert.equal(compareReleaseVersions("0.73.0", "0.73.0"), 0);
});

test("compareReleaseVersions compares numeric identifiers numerically", () => {
  assert.ok(compareReleaseVersions("0.73.0-beta.9", "0.73.0-beta.10") < 0);
  assert.ok(compareReleaseVersions("0.9.0", "0.73.0") < 0);
  assert.ok(compareReleaseVersions("0.73.1", "0.73.0") > 0);
});

test("latestStableVersionFromTags ignores prerelease tags", () => {
  const tags = [
    "v0.72.0",
    "v0.73.0",
    "v0.73.0-beta.0",
    "v0.73.0-beta.6",
    "v0.74.0-beta.0",
    "not-a-tag",
  ];
  assert.equal(latestStableVersionFromTags(tags), "0.73.0");
  assert.equal(latestStableVersionFromTags(tags.join("\n")), "0.73.0");
  assert.equal(latestStableVersionFromTags(["v0.73.0-beta.1"]), null);
  assert.equal(latestStableVersionFromTags([]), null);
});

test("a beta cycle anchored below a shipped stable is re-anchored on that stable", () => {
  // The exact v0.73.0 shape: pre.json still snapshots the 0.72.0 cycle base.
  assert.deepEqual(
    evaluateBetaCycleAnchor({ cycleBase: "0.72.0", latestStable: "0.73.0" }),
    { stale: true, anchor: "0.73.0" },
  );
});

test("a beta cycle already at or above the shipped stable is left alone", () => {
  assert.deepEqual(
    evaluateBetaCycleAnchor({ cycleBase: "0.73.0", latestStable: "0.73.0" }),
    { stale: false, anchor: "0.73.0" },
  );
  assert.deepEqual(
    evaluateBetaCycleAnchor({ cycleBase: "0.74.0", latestStable: "0.73.0" }),
    { stale: false, anchor: "0.74.0" },
  );
});

test("with no stable tag yet, no cycle is considered stale", () => {
  assert.deepEqual(
    evaluateBetaCycleAnchor({ cycleBase: "0.1.0", latestStable: null }),
    { stale: false, anchor: "0.1.0" },
  );
});

test("isVersionAheadOfStable rejects releases at or below the newest stable", () => {
  // The bug: the next beta of a stale cycle numbers beneath the shipped stable.
  assert.equal(isVersionAheadOfStable("0.73.0-beta.7", "0.73.0"), false);
  assert.equal(isVersionAheadOfStable("0.73.0", "0.73.0"), false);
  assert.equal(isVersionAheadOfStable("0.72.9", "0.73.0"), false);
  // Both channels' healthy shapes stay allowed.
  assert.equal(isVersionAheadOfStable("0.73.1-beta.0", "0.73.0"), true);
  assert.equal(isVersionAheadOfStable("0.74.0-beta.0", "0.73.0"), true);
  assert.equal(isVersionAheadOfStable("0.74.0", "0.73.0"), true);
  assert.equal(isVersionAheadOfStable("0.1.0", null), true);
});

test("setPackageJsonVersions re-anchors only the files that need it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-anchor-test-"));
  const root = join(dir, "package.json");
  const cli = join(dir, "cli.package.json");
  const missing = join(dir, "nope.package.json");
  writeFileSync(root, JSON.stringify({ name: "root", version: "0.73.0-beta.6" }, null, 2) + "\n");
  writeFileSync(cli, JSON.stringify({ name: "cli", version: "0.73.0" }, null, 2) + "\n");

  const rewritten = setPackageJsonVersions([root, cli, missing], "0.73.0");

  // Already-anchored and absent files are left alone; the stale one is rewritten.
  assert.deepEqual(rewritten, [root]);
  assert.equal(JSON.parse(readFileSync(root, "utf8")).version, "0.73.0");
  assert.equal(JSON.parse(readFileSync(cli, "utf8")).version, "0.73.0");
  // Unrelated fields survive the rewrite.
  assert.equal(JSON.parse(readFileSync(root, "utf8")).name, "root");
});
