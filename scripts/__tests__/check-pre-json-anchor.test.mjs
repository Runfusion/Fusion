import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePreJsonInvariants, ANCHOR_PACKAGE } from "../check-pre-json-anchor.mjs";

const pre = (anchor, changesets = []) => ({
  mode: "pre",
  tag: "beta",
  initialVersions: { [ANCHOR_PACKAGE]: anchor },
  changesets,
});
const rules = (result) => result.violations.map((v) => v.rule).sort();

test("healthy cycle anchored on the shipped stable passes", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.76.0", ["a", "b"]),
    latestStable: "0.76.0",
    changesetFiles: ["a", "b", "c"],
    baselinePreState: pre("0.76.0", ["a", "b"]),
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.skipped, []);
});

test("a cycle that consumed more changesets since the last release still passes", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.76.0", ["a", "b", "c"]),
    latestStable: "0.76.0",
    changesetFiles: ["a", "b", "c"],
    baselinePreState: pre("0.76.0", ["a", "b"]),
  });
  assert.deepEqual(result.violations, []);
});

/*
The PR #3472 shape: pre.json reverted to the pre-v0.76.0 cycle. The anchor fell
below the shipped stable AND the ledger swapped an older, LARGER list in for the
real entries. Both invariants must fire; the size test that a naive check would
use is asserted to be useless here.
*/
test("reverting pre.json to a pre-stable cycle fires anchor + ledger (the #3472 regression)", () => {
  const baseline = pre("0.76.0", ["real-1", "real-2"]);
  const reverted = pre("0.75.1", ["old-1", "old-2", "old-3", "old-4"]);
  const result = evaluatePreJsonInvariants({
    preState: reverted,
    latestStable: "0.76.0",
    changesetFiles: ["real-1", "real-2", "old-1", "old-2", "old-3", "old-4"],
    baselinePreState: baseline,
  });
  assert.deepEqual(rules(result), ["anchor-below-stable", "ledger-regression"]);
  // The ledger GREW while dropping every real entry — a count check passes it.
  assert.ok(reverted.changesets.length > baseline.changesets.length);
  const dropped = result.violations.find((v) => v.rule === "ledger-regression");
  assert.match(dropped.message, /real-1/);
  assert.match(dropped.message, /real-2/);
});

test("anchor below stable is reported even when the ledger is intact", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.75.1", ["a"]),
    latestStable: "0.76.0",
    changesetFiles: ["a"],
    baselinePreState: pre("0.75.1", ["a"]),
  });
  assert.deepEqual(rules(result), ["anchor-below-stable"]);
});

test("anchor equal to the shipped stable is fine (release.mjs just re-anchored)", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.76.0", []),
    latestStable: "0.76.0",
    changesetFiles: [],
    baselinePreState: pre("0.76.0", []),
  });
  assert.deepEqual(result.violations, []);
});

test("prerelease anchors compare below their own stable", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.76.0-beta.3", []),
    latestStable: "0.76.0",
    changesetFiles: [],
    baselinePreState: null,
  });
  assert.deepEqual(rules(result), ["anchor-below-stable"]);
});

test("a dropped .changeset/*.md for a consumed entry is a dangling ledger entry", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.76.0", ["a", "gone"]),
    latestStable: "0.76.0",
    changesetFiles: ["a"],
    baselinePreState: pre("0.76.0", ["a", "gone"]),
  });
  assert.deepEqual(rules(result), ["dangling-ledger-entry"]);
  assert.match(result.violations[0].message, /gone\.md/);
});

test("missing initialVersions anchor is a violation, not a silent pass", () => {
  const result = evaluatePreJsonInvariants({
    preState: { mode: "pre", tag: "beta", initialVersions: {}, changesets: [] },
    latestStable: "0.76.0",
    changesetFiles: [],
    baselinePreState: null,
  });
  assert.deepEqual(rules(result), ["anchor-below-stable"]);
});

test("no pre.json (stable track, pre exit ran) checks nothing", () => {
  for (const preState of [null, { mode: "exit", initialVersions: {}, changesets: [] }]) {
    const result = evaluatePreJsonInvariants({
      preState,
      latestStable: "0.76.0",
      changesetFiles: [],
      baselinePreState: pre("0.76.0", ["a"]),
    });
    assert.deepEqual(result.violations, []);
  }
});

test("no stable tag yet (fresh repo) skips only the anchor comparison", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.1.0", ["a"]),
    latestStable: null,
    changesetFiles: ["a"],
    baselinePreState: pre("0.1.0", ["a"]),
  });
  assert.deepEqual(result.violations, []);
});

/*
A shallow clone with no reachable `chore(release):` commit must SKIP the ledger
invariant loudly rather than pass it vacuously — the local invariants still run.
*/
test("absent baseline skips the ledger rule but still enforces the local ones", () => {
  const result = evaluatePreJsonInvariants({
    preState: pre("0.75.1", ["a", "gone"]),
    latestStable: "0.76.0",
    changesetFiles: ["a"],
    baselinePreState: null,
  });
  assert.deepEqual(rules(result), ["anchor-below-stable", "dangling-ledger-entry"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /ledger-regression/);
});
