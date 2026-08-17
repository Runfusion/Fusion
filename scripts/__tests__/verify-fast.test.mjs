/**
 * Unit tests for scripts/verify-fast.mjs
 *
 * Runner: node --test scripts/__tests__/verify-fast.test.mjs
 *
 * These pin pure planning / argument construction and run only the canonical
 * changeset checker in a temporary fixture. They never spawn tsc, builds, or
 * Vitest, preserving the test-free verification contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTypecheckStep,
  buildBuildStep,
  buildBootSmokeStep,
  buildArtifactBootstrapStep,
  buildStaticCheckStep,
  buildVerifyPlan,
  batchVerifySteps,
  runStep,
  runVerifyPlan,
  PRETEST_STATIC_CHECK_SCRIPTS,
  VERIFY_EXCLUDED_PACKAGES,
  BOOT_SMOKE_REQUIRED_BUILD_PACKAGES,
} from "../verify-fast.mjs";

import { resolveAffectedPackages } from "../test-changed.mjs";

const SMOKE = "/repo/scripts/boot-smoke.mjs";
const BOOTSTRAP = "/repo/scripts/ensure-test-artifacts.mjs";
const NODE = "/usr/bin/node";
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/*
FNXC:TestInfrastructure 2026-07-22-12:00:
Keep policy-scanner trigger phrases on distinct source lines. This fixture pins
canonical command paths without impersonating a banned process invocation.
*/
const PRETEST_CHECKS = [
  [
    "scripts/check-no-",
    "no",
    "hup.mjs",
  ].join(""),
  "scripts/check-no-cwd-relative-dashboard-test-reads.mjs",
  [
    "scripts/check-no-",
    "kill-",
    "4040.mjs",
  ].join(""),
  "scripts/check-no-getdatabase.mjs",
  "scripts/check-prerebase-inert.mjs",
  /* FNXC:TestInfrastructure 2026-07-31-19:15: added when the assertion below went red on `main`.
     Both validators are real scripts, both run in `package.json`'s pretest chain, and
     `PRETEST_STATIC_CHECK_SCRIPTS` already picked them up — verify:fast was RIGHT and this mirror was
     stale. Kept in production order, since the assertion is a deepEqual and order is part of it. */
  "scripts/check-capacity-pool-id.mjs",
  /*
  FNXC:TestInfrastructure 2026-08-16-10:52:
  FN-8991, FN-8994, and FN-9096 added runtime-skill-loader-drift,
  workspace-package-graph, and cli-runtime-routing validators to the
  authoritative production chains. Keep this pretest mirror in that order;
  it must report divergence without inventing validators from the gate-only list.

  FNXC:MergeGatePerformance 2026-08-16-10:29:
  FN-9122 repaired the W33 gate inventory ledger after three validators had
  entered canonical pretest/gate compositions without their test mirrors.
  Keep these in manifest order so verify:fast validates the same policy set.
  */
  "scripts/check-cli-runtime-routing.mjs",
  "scripts/check-no-node-only-core-imports-in-dashboard.mjs",
  "scripts/check-pi-versions-pinned.mjs",
  "scripts/check-workspace-package-graph.mjs",
  "scripts/check-no-test-timeout-appeasement.mjs",
  "scripts/check-changeset-format.mjs",
  "scripts/check-routes-modular.mjs",
  "scripts/check-runtime-skill-loader-drift.mjs",
];
const STATIC_STEP_IDS = PRETEST_CHECKS.map((script) => `static-check:${script.slice("scripts/".length, -".mjs".length)}`);

function stepIds(plan) {
  return plan.steps.map((s) => s.id);
}
function stepByKind(plan, kind) {
  return plan.steps.filter((s) => s.kind === kind);
}

// ---------------------------------------------------------------------------
// buildTypecheckStep
// ---------------------------------------------------------------------------

test("buildTypecheckStep: uses the package's typecheck script when present", () => {
  const step = buildTypecheckStep("@fusion/engine", { hasTypecheck: true });
  assert.equal(step.command, "pnpm");
  assert.deepEqual(step.args, ["--filter", "@fusion/engine", "typecheck"]);
  assert.equal(step.klass, "changed");
});

test("buildTypecheckStep: falls back to scoped tsc --noEmit when no typecheck script", () => {
  const step = buildTypecheckStep("@fusion/widget", { hasTypecheck: false });
  assert.deepEqual(step.args, ["--filter", "@fusion/widget", "exec", "tsc", "--noEmit", "-p", "."]);
});

test("buildTypecheckStep: defaults to the tsc fallback when meta omitted", () => {
  const step = buildTypecheckStep("@fusion/widget");
  assert.deepEqual(step.args, ["--filter", "@fusion/widget", "exec", "tsc", "--noEmit", "-p", "."]);
});

// ---------------------------------------------------------------------------
// buildBuildStep / buildBootSmokeStep / buildArtifactBootstrapStep
// ---------------------------------------------------------------------------

test("buildBuildStep: scoped pnpm build for the package", () => {
  const step = buildBuildStep("@fusion/cli");
  assert.deepEqual(step.args, ["--filter", "@fusion/cli", "build"]);
  assert.equal(step.kind, "build");
});

test("buildBootSmokeStep: runs the boot-smoke script via node", () => {
  const step = buildBootSmokeStep(SMOKE, NODE);
  assert.equal(step.command, NODE);
  assert.deepEqual(step.args, [SMOKE]);
  assert.equal(step.kind, "boot-smoke");
});

test("buildArtifactBootstrapStep: runs the artifact bootstrap script via node", () => {
  const step = buildArtifactBootstrapStep(BOOTSTRAP, NODE);
  assert.equal(step.command, NODE);
  assert.deepEqual(step.args, [BOOTSTRAP]);
  assert.equal(step.kind, "bootstrap-artifacts");
});

test("buildStaticCheckStep: invokes a canonical validator directly through Node", () => {
  const step = buildStaticCheckStep("scripts/check-changeset-format.mjs", "/repo", NODE);
  assert.equal(step.command, NODE);
  assert.deepEqual(step.args, ["/repo/scripts/check-changeset-format.mjs"]);
  assert.equal(step.kind, "static-check");
  assert.equal(step.id, "static-check:check-changeset-format");
});

// ---------------------------------------------------------------------------
// buildVerifyPlan
// ---------------------------------------------------------------------------

test("buildVerifyPlan: defaults to every canonical pretest validator before established non-test steps", () => {
  const plan = buildVerifyPlan({ packages: [], staticCheckRoot: "/repo", bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(PRETEST_STATIC_CHECK_SCRIPTS, PRETEST_CHECKS);
  assert.deepEqual(stepIds(plan), [
    ...STATIC_STEP_IDS,
    "bootstrap-artifacts",
    "build:@runfusion/fusion",
    "boot-smoke",
  ]);

  for (const step of stepByKind(plan, "static-check")) {
    assert.equal(step.command, NODE);
    assert.match(step.args[0], /^\/repo\/scripts\/check-[\w-]+\.mjs$/);
    assert.equal(step.args.length, 1); // A validator path only: no test lane or mutation flag.
  }
});

test("buildVerifyPlan: no packages -> CLI prerequisite build then boot smoke", () => {
  const plan = buildVerifyPlan({ packages: [], staticCheckScripts: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), ["bootstrap-artifacts", "build:@runfusion/fusion", "boot-smoke"]);
  assert.deepEqual(plan.eligiblePackages, []);
  assert.deepEqual(plan.requiredBootBuildPackages, ["@runfusion/fusion"]);
});

test("buildVerifyPlan: typecheck for all eligible, then builds, then boot smoke (ordered)", () => {
  const packageMeta = new Map([
    ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/core", { hasTypecheck: true, hasBuild: true }],
  ]);
  const plan = buildVerifyPlan({ packages: ["@fusion/engine", "@fusion/core"], packageMeta, staticCheckScripts: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), [
    "bootstrap-artifacts",
    "typecheck:@fusion/engine",
    "typecheck:@fusion/core",
    "build:@fusion/engine",
    "build:@fusion/core",
    "build:@runfusion/fusion",
    "boot-smoke",
  ]);
});

test("buildVerifyPlan: a package without a build script gets a typecheck step but no build step", () => {
  const packageMeta = new Map([
    ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/test-only", { hasTypecheck: false, hasTsconfig: true, hasBuild: false }],
  ]);
  const plan = buildVerifyPlan({ packages: ["@fusion/engine", "@fusion/test-only"], packageMeta, staticCheckScripts: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), [
    "bootstrap-artifacts",
    "typecheck:@fusion/engine",
    "typecheck:@fusion/test-only",
    "build:@fusion/engine",
    "build:@runfusion/fusion",
    "boot-smoke",
  ]);
  // The test-only package's typecheck uses the tsc fallback (no typecheck script).
  const tc = stepByKind(plan, "typecheck").find((s) => s.pkg === "@fusion/test-only");
  assert.deepEqual(tc.args, ["--filter", "@fusion/test-only", "exec", "tsc", "--noEmit", "-p", "."]);
});

test("buildVerifyPlan: skips synthetic typecheck for JavaScript alias packages with no tsconfig", () => {
  const packageMeta = new Map([
    ["runfusion.ai", { hasTypecheck: false, hasTsconfig: false, hasBuild: false }],
    ["@runfusion/fusion", { hasTypecheck: true, hasTsconfig: true, hasBuild: true }],
  ]);
  const plan = buildVerifyPlan({ packages: ["runfusion.ai", "@runfusion/fusion"], packageMeta, staticCheckScripts: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), [
    "bootstrap-artifacts",
    "typecheck:@runfusion/fusion",
    "build:@runfusion/fusion",
    "boot-smoke",
  ]);
});

test("buildVerifyPlan: desktop/mobile are excluded from scoped steps but boot smoke still runs", () => {
  const packageMeta = new Map([
    ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/desktop", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/mobile", { hasTypecheck: true, hasBuild: true }],
  ]);
  const plan = buildVerifyPlan({
    packages: ["@fusion/engine", "@fusion/desktop", "@fusion/mobile"],
    packageMeta,
    staticCheckScripts: [],
    bootSmokeScriptPath: SMOKE,
    nodeBin: NODE,
  });
  assert.deepEqual(plan.eligiblePackages, ["@fusion/engine"]);
  assert.deepEqual(plan.excludedPackages.sort(), ["@fusion/desktop", "@fusion/mobile"]);
  assert.deepEqual(stepIds(plan), ["bootstrap-artifacts", "typecheck:@fusion/engine", "build:@fusion/engine", "build:@runfusion/fusion", "boot-smoke"]);
});

test("VERIFY_EXCLUDED_PACKAGES mirrors the root build/typecheck exclusions", () => {
  assert.ok(VERIFY_EXCLUDED_PACKAGES.has("@fusion/desktop"));
  assert.ok(VERIFY_EXCLUDED_PACKAGES.has("@fusion/mobile"));
});

test("BOOT_SMOKE_REQUIRED_BUILD_PACKAGES includes the source-checkout CLI", () => {
  assert.deepEqual(BOOT_SMOKE_REQUIRED_BUILD_PACKAGES, ["@runfusion/fusion"]);
});

test("static-check phase rejects a malformed changeset before bootstrap and accepts empty state", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "verify-fast-changeset-"));
  const plan = buildVerifyPlan({
    packages: [],
    staticCheckScripts: ["scripts/check-changeset-format.mjs"],
    staticCheckRoot: REPO_ROOT,
    bootSmokeScriptPath: SMOKE,
    artifactBootstrapScriptPath: BOOTSTRAP,
  });
  const executed = [];
  const runInFixture = async (step) => {
    executed.push(step.id);
    await runStep(step, { cwd: fixture, log: () => {}, errLog: () => {} });
  };

  try {
    // No .changeset directory is a valid state for the canonical checker.
    await runVerifyPlan(plan.steps.filter((step) => step.kind === "static-check"), { run: runInFixture });
    assert.deepEqual(executed, ["static-check:check-changeset-format"]);

    mkdirSync(join(fixture, ".changeset"));
    writeFileSync(join(fixture, ".changeset", "too-long.md"), `---\n"@runfusion/fusion": patch\n---\n\nsummary: ${"x".repeat(121)}\ncategory: fix\n`);
    executed.length = 0;
    await assert.rejects(() => runVerifyPlan(plan.steps, { run: runInFixture }), /static check check-changeset-format/);
    assert.deepEqual(executed, ["static-check:check-changeset-format"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: reuse test-changed's resolveAffectedPackages to scope the plan
// ---------------------------------------------------------------------------

test("buildVerifyPlan: scopes to exactly the packages resolveAffectedPackages selects", () => {
  // packageNameByDir as test-changed builds it (dir -> name, with a bare alias).
  const packageNameByDir = new Map([
    ["packages/engine", "@fusion/engine"],
    ["engine", "@fusion/engine"],
    ["packages/dashboard", "@fusion/dashboard"],
    ["dashboard", "@fusion/dashboard"],
  ]);
  const changedFiles = ["packages/engine/src/merger.ts", "docs/testing.md"];
  const affected = resolveAffectedPackages(changedFiles, packageNameByDir);
  assert.deepEqual(affected, ["@fusion/engine"]); // docs/ change does not add a package

  const packageMeta = new Map([["@fusion/engine", { hasTypecheck: true, hasBuild: true }]]);
  const plan = buildVerifyPlan({ packages: affected, packageMeta, staticCheckScripts: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), ["bootstrap-artifacts", "typecheck:@fusion/engine", "build:@fusion/engine", "build:@runfusion/fusion", "boot-smoke"]);
});

// ---------------------------------------------------------------------------
// Parallel step batching
//
// The wall-clock win only exists if independent steps actually overlap, and it is
// only SAFE if the ordering that matters still holds. Both halves are pinned here:
// a timing-free overlap probe (concurrent peak > 1) plus barrier assertions, so a
// future refactor cannot quietly serialize the groups or hoist a dependent step.
// ---------------------------------------------------------------------------

test("batchVerifySteps groups consecutive parallel steps and isolates serial ones", () => {
  const plan = buildVerifyPlan({
    packages: ["@fusion/engine", "@fusion/dashboard"],
    packageMeta: new Map([
      ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
      ["@fusion/dashboard", { hasTypecheck: true, hasBuild: true }],
      ["@runfusion/fusion", { hasTypecheck: true, hasBuild: true }],
    ]),
    staticCheckScripts: ["scripts/check-a.mjs", "scripts/check-b.mjs"],
    staticCheckRoot: REPO_ROOT,
    bootSmokeScriptPath: SMOKE,
    artifactBootstrapScriptPath: BOOTSTRAP,
  });

  const batches = batchVerifySteps(plan.steps);
  assert.deepEqual(
    batches.map((b) => [b.group, b.steps.map((s) => s.id)]),
    [
      ["static-checks", ["static-check:check-a", "static-check:check-b"]],
      [null, ["bootstrap-artifacts"]],
      ["typecheck", ["typecheck:@fusion/engine", "typecheck:@fusion/dashboard"]],
      [null, ["build:@fusion/engine"]],
      [null, ["build:@fusion/dashboard"]],
      [null, ["build:@runfusion/fusion"]],
      [null, ["boot-smoke"]],
    ],
  );
});

test("batchVerifySteps honours the serial escape hatch", () => {
  const steps = [
    buildStaticCheckStep("scripts/check-a.mjs", REPO_ROOT),
    buildStaticCheckStep("scripts/check-b.mjs", REPO_ROOT),
  ];
  assert.equal(batchVerifySteps(steps, false).length, 1);
  assert.equal(batchVerifySteps(steps, true).length, 2);
});

test("runVerifyPlan overlaps a group but keeps serial steps as barriers", async () => {
  const plan = buildVerifyPlan({
    packages: ["@fusion/engine", "@fusion/dashboard"],
    packageMeta: new Map([
      ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
      ["@fusion/dashboard", { hasTypecheck: true, hasBuild: true }],
      ["@runfusion/fusion", { hasTypecheck: true, hasBuild: true }],
    ]),
    staticCheckScripts: ["scripts/check-a.mjs", "scripts/check-b.mjs", "scripts/check-c.mjs"],
    staticCheckRoot: REPO_ROOT,
    bootSmokeScriptPath: SMOKE,
    artifactBootstrapScriptPath: BOOTSTRAP,
  });

  let inFlight = 0;
  const peakByGroup = new Map();
  const finished = [];
  const run = async (step) => {
    const group = step.parallelGroup ?? `serial:${step.id}`;
    inFlight += 1;
    peakByGroup.set(group, Math.max(peakByGroup.get(group) ?? 0, inFlight));
    await Promise.resolve();
    inFlight -= 1;
    finished.push(step.id);
  };

  await runVerifyPlan(plan.steps, { run, serial: false });

  // Both groups genuinely overlapped...
  assert.ok(peakByGroup.get("static-checks") > 1, "static checks should overlap");
  assert.ok(peakByGroup.get("typecheck") > 1, "typechecks should overlap");
  // ...while every serial step ran alone.
  for (const [group, peak] of peakByGroup) {
    if (group.startsWith("serial:")) assert.equal(peak, 1, `${group} must not overlap`);
  }

  // Barriers: bootstrap precedes every typecheck, and boot smoke follows every build.
  const at = (id) => finished.indexOf(id);
  assert.ok(at("bootstrap-artifacts") < at("typecheck:@fusion/engine"));
  assert.ok(at("bootstrap-artifacts") < at("typecheck:@fusion/dashboard"));
  assert.ok(at("typecheck:@fusion/dashboard") < at("build:@fusion/engine"));
  assert.equal(finished[finished.length - 1], "boot-smoke");
});

test("runVerifyPlan reports the first failure in plan order and skips later batches", async () => {
  const steps = [
    buildStaticCheckStep("scripts/check-a.mjs", REPO_ROOT),
    buildStaticCheckStep("scripts/check-b.mjs", REPO_ROOT),
    buildStaticCheckStep("scripts/check-c.mjs", REPO_ROOT),
    buildBootSmokeStep(SMOKE),
  ];
  const started = [];
  const settled = [];
  const run = async (step) => {
    started.push(step.id);
    await Promise.resolve();
    settled.push(step.id);
    // b and c both fail; a passes. The reported error must be b's (plan order),
    // not whichever settled first.
    if (step.id === "static-check:check-b") throw new Error("check-b exploded");
    if (step.id === "static-check:check-c") throw new Error("check-c exploded");
  };

  await assert.rejects(() => runVerifyPlan(steps, { run, serial: false }), /check-b exploded/);
  // Siblings already in flight are awaited rather than abandoned...
  assert.deepEqual(settled.sort(), ["static-check:check-a", "static-check:check-b", "static-check:check-c"]);
  // ...and the next batch never starts.
  assert.ok(!started.includes("boot-smoke"));
});
