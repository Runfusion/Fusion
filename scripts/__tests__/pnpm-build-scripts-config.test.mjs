import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const decidedDeps = [
  "@google/genai",
  "better-sqlite3",
  "cpu-features",
  "electron-winstaller",
  "keytar",
  "sharp",
  "ssh2",
];

function readPackagePnpmConfig() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return packageJson.pnpm ?? {};
}

function readWorkspaceConfig() {
  return parseYaml(readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")) ?? {};
}

function assertUniqueArray(values, label) {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  assert.deepEqual(duplicates, [], `${label} must not contain duplicates`);
}

function assertDisjoint(left, right, label) {
  const overlap = left.filter((value) => right.includes(value));
  assert.deepEqual(overlap, [], `${label} must be disjoint`);
}

function assertDecisionCoverage(config, label) {
  const ignored = config.ignoredBuiltDependencies ?? [];
  const approved = config.onlyBuiltDependencies ?? [];

  assertUniqueArray(ignored, `${label}.ignoredBuiltDependencies`);
  assertUniqueArray(approved, `${label}.onlyBuiltDependencies`);
  assertDisjoint(ignored, approved, `${label} build-script arrays`);

  for (const dep of decidedDeps) {
    const membershipCount = Number(ignored.includes(dep)) + Number(approved.includes(dep));
    assert.equal(
      membershipCount,
      1,
      `${label} must categorize ${dep} in exactly one build-script array`,
    );
  }
}

test("package.json records the reviewed ignored-build decisions", () => {
  assertDecisionCoverage(readPackagePnpmConfig(), "package.json#pnpm");
});

test("pnpm-workspace.yaml keeps the effective install-time build-script policy aligned", () => {
  const workspaceConfig = readWorkspaceConfig();
  assertDecisionCoverage(workspaceConfig, "pnpm-workspace.yaml");

  const packageConfig = readPackagePnpmConfig();
  assert.deepEqual(
    workspaceConfig.ignoredBuiltDependencies,
    packageConfig.ignoredBuiltDependencies,
    "workspace ignoredBuiltDependencies should match the documented package.json decisions",
  );
});
