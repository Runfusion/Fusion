/**
 * Unit tests for scripts/verify-fast.mjs
 *
 * Runner: node --test scripts/__tests__/verify-fast.test.mjs
 *
 * These exercise the PURE planning / arg-construction logic only. They never
 * spawn real tsc / build / vitest — the test-free verification command's value
 * is its deterministic plan, so that is what we pin.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTypecheckStep,
  buildBuildStep,
  buildBootSmokeStep,
  buildVerifyPlan,
  VERIFY_EXCLUDED_PACKAGES,
} from "../verify-fast.mjs";

import { resolveAffectedPackages } from "../test-changed.mjs";

const SMOKE = "/repo/scripts/boot-smoke.mjs";
const NODE = "/usr/bin/node";

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
// buildBuildStep / buildBootSmokeStep
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

// ---------------------------------------------------------------------------
// buildVerifyPlan
// ---------------------------------------------------------------------------

test("buildVerifyPlan: no packages -> boot smoke only", () => {
  const plan = buildVerifyPlan({ packages: [], bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), ["boot-smoke"]);
  assert.deepEqual(plan.eligiblePackages, []);
});

test("buildVerifyPlan: typecheck for all eligible, then builds, then boot smoke (ordered)", () => {
  const packageMeta = new Map([
    ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/core", { hasTypecheck: true, hasBuild: true }],
  ]);
  const plan = buildVerifyPlan({ packages: ["@fusion/engine", "@fusion/core"], packageMeta, bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), [
    "typecheck:@fusion/engine",
    "typecheck:@fusion/core",
    "build:@fusion/engine",
    "build:@fusion/core",
    "boot-smoke",
  ]);
});

test("buildVerifyPlan: a package without a build script gets a typecheck step but no build step", () => {
  const packageMeta = new Map([
    ["@fusion/engine", { hasTypecheck: true, hasBuild: true }],
    ["@fusion/test-only", { hasTypecheck: false, hasBuild: false }],
  ]);
  const plan = buildVerifyPlan({ packages: ["@fusion/engine", "@fusion/test-only"], packageMeta, bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), [
    "typecheck:@fusion/engine",
    "typecheck:@fusion/test-only",
    "build:@fusion/engine",
    "boot-smoke",
  ]);
  // The test-only package's typecheck uses the tsc fallback (no typecheck script).
  const tc = stepByKind(plan, "typecheck").find((s) => s.pkg === "@fusion/test-only");
  assert.deepEqual(tc.args, ["--filter", "@fusion/test-only", "exec", "tsc", "--noEmit", "-p", "."]);
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
    bootSmokeScriptPath: SMOKE,
    nodeBin: NODE,
  });
  assert.deepEqual(plan.eligiblePackages, ["@fusion/engine"]);
  assert.deepEqual(plan.excludedPackages.sort(), ["@fusion/desktop", "@fusion/mobile"]);
  assert.deepEqual(stepIds(plan), ["typecheck:@fusion/engine", "build:@fusion/engine", "boot-smoke"]);
});

test("VERIFY_EXCLUDED_PACKAGES mirrors the root build/typecheck exclusions", () => {
  assert.ok(VERIFY_EXCLUDED_PACKAGES.has("@fusion/desktop"));
  assert.ok(VERIFY_EXCLUDED_PACKAGES.has("@fusion/mobile"));
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
  const plan = buildVerifyPlan({ packages: affected, packageMeta, bootSmokeScriptPath: SMOKE, nodeBin: NODE });
  assert.deepEqual(stepIds(plan), ["typecheck:@fusion/engine", "build:@fusion/engine", "boot-smoke"]);
});
