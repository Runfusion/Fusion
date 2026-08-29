import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const CONFIG_EXCEPTIONS = new Map([
  // package name -> reason
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readWorkspacePackageDirs() {
  const workspaceFile = path.join(repoRoot, "pnpm-workspace.yaml");
  const workspaceYaml = readFileSync(workspaceFile, "utf8");
  const parsed = parseYaml(workspaceYaml);
  const patterns = Array.isArray(parsed?.packages)
    ? parsed.packages.filter((pattern) => typeof pattern === "string")
    : [];
  return fg.sync(patterns.map(workspacePatternToPackageJsonGlob), {
    absolute: true,
    cwd: repoRoot,
    dot: false,
    onlyFiles: true,
    unique: true,
  }).map((packageJsonPath) => path.dirname(packageJsonPath)).sort();
}

function workspacePatternToPackageJsonGlob(pattern) {
  const trimmed = pattern.trim();
  const isNegated = trimmed.startsWith("!");
  const body = (isNegated ? trimmed.slice(1) : trimmed)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const packageJsonGlob = body.endsWith("package.json") ? body : `${body}/package.json`;
  return isNegated ? `!${packageJsonGlob}` : packageJsonGlob;
}

function hasSharedIsolation(config) {
  return (
    /\bsetupFiles\b/.test(config) &&
    /\bglobalSetup\b/.test(config) &&
    /__test-utils__\/vitest-setup\.ts/.test(config) &&
    /__test-utils__\/vitest-teardown\.ts/.test(config)
  );
}

function hasSharedWorkerBudget(config) {
  return /computeMaxWorkers/.test(config) && /\bmaxWorkers\b/.test(config);
}

test("workspace packages with test scripts use shared Vitest governance", () => {
  const failures = [];
  const testedPackages = [];

  for (const packageDir of readWorkspacePackageDirs()) {
    const manifest = readJson(path.join(packageDir, "package.json"));
    if (!manifest.scripts?.test) continue;

    testedPackages.push(manifest.name);

    const exception = CONFIG_EXCEPTIONS.get(manifest.name);
    if (exception) {
      assert.match(exception, /\S{12,}/, `${manifest.name} exception must include a reason`);
      continue;
    }

    const configPath = path.join(packageDir, "vitest.config.ts");
    if (!existsSync(configPath)) {
      failures.push(`${manifest.name}: missing vitest.config.ts`);
      continue;
    }

    const config = readFileSync(configPath, "utf8");
    if (!hasSharedIsolation(config)) {
      failures.push(`${manifest.name}: missing shared vitest setup/teardown isolation`);
    }
    if (!hasSharedWorkerBudget(config)) {
      failures.push(`${manifest.name}: missing shared computeMaxWorkers/maxWorkers budget`);
    }
  }

  assert.ok(testedPackages.length > 0, "expected at least one workspace package with a test script");
  assert.deepEqual(failures, []);
});
