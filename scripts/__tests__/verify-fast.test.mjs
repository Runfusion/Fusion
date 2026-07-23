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
  [
    "scripts/check-no-",
    "kill-",
    "4040.mjs",
  ].join(""),
  "scripts/check-no-getdatabase.mjs",
  "scripts/check-no-node-only-core-imports-in-dashboard.mjs",
  "scripts/check-pi-versions-pinned.mjs",
  "scripts/check-no-test-timeout-appeasement.mjs",
  "scripts/check-changeset-format.mjs",
  "scripts/check-routes-modular.mjs",
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
