import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractLeadingStaticGateChecks,
  readStaticGateChecks,
  runStaticGateChecks,
} from "../run-static-gate-checks.mjs";

const check = (name) => `scripts/check-${name}.mjs`;
const EXPECTED_GATE_CHECKS = [
  check(["no-", ["no", "hup"].join("")].join("")),
  check("no-cwd-relative-dashboard-test-reads"),
  check(["no-", "kill-", "40" + "40"].join("")),
  check("no-getdatabase"),
  check("prerebase-inert"),
  check("capacity-pool-id"),
  check("no-node-only-core-imports-in-dashboard"),
  check("pi-versions-pinned"),
  check("no-test-timeout-appeasement"),
  check("changeset-format"),
  check("mock-completeness"),
  check("inert-sync-lane-conversions"),
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "static-gate-checks-"));
  mkdirSync(join(root, "scripts"));
  return root;
}

function writeFixtureCheck(root, name, source) {
  writeFileSync(join(root, "scripts", `${name}.mjs`), source);
}

test("extractLeadingStaticGateChecks keeps only the blocking validator prefix", () => {
  assert.deepEqual(
    extractLeadingStaticGateChecks("node scripts/check-one.mjs && node scripts/check-two.mjs && sh -c 'test lanes'"),
    ["scripts/check-one.mjs", "scripts/check-two.mjs"],
  );
  assert.throws(
    () => extractLeadingStaticGateChecks("pnpm --filter @fusion/engine test:core"),
    /must contain one or more canonical static validators/,
  );
});

test("production gate inventory contains each canonical validator exactly once", () => {
  const checks = readStaticGateChecks();
  assert.deepEqual(checks, EXPECTED_GATE_CHECKS);
  assert.equal(new Set(checks).size, checks.length);
});

test("runStaticGateChecks runs clean fixture validators and waits for all", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-first", 'console.log("first passed");');
    writeFixtureCheck(root, "check-second", 'console.log("second passed");');
    const messages = [];
    const results = await runStaticGateChecks(
      ["scripts/check-first.mjs", "scripts/check-second.mjs"],
      { root, log: (message) => messages.push(message) },
    );

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.deepEqual(messages, ["[static-gate] 2 validators passed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStaticGateChecks reports every violating fixture validator before failing closed", async () => {
  const root = createFixture();
  try {
    writeFixtureCheck(root, "check-clean", 'process.exit(0);');
    writeFixtureCheck(root, "check-first-violation", 'console.error("first violation"); process.exit(1);');
    writeFixtureCheck(root, "check-second-violation", 'console.error("second violation"); process.exit(2);');
    const errors = [];

    await assert.rejects(
      () => runStaticGateChecks(
        [
          "scripts/check-clean.mjs",
          "scripts/check-first-violation.mjs",
          "scripts/check-second-violation.mjs",
        ],
        { root, errorLog: (message) => errors.push(message) },
      ),
      /2 static merge-gate validators failed/,
    );

    assert.deepEqual(errors, [
      "[static-gate] validator failed: scripts/check-first-violation.mjs (exit 1)",
      "[static-gate] validator failed: scripts/check-second-violation.mjs (exit 2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
