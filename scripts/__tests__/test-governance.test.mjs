import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const patterns = [...workspaceYaml.matchAll(/^\s*-\s+"([^"]+)"\s*$/gm)].map((match) => match[1]);
  const dirs = new Set();

  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parentDir = path.join(repoRoot, pattern.slice(0, -2));
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packageDir = path.join(parentDir, entry.name);
        if (existsSync(path.join(packageDir, "package.json"))) {
          dirs.add(packageDir);
        }
      }
      continue;
    }

    const packageDir = path.join(repoRoot, pattern);
    if (existsSync(path.join(packageDir, "package.json"))) {
      dirs.add(packageDir);
    }
  }

  return [...dirs].sort();
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
  return (
    /computeMaxWorkers/.test(config) &&
    /\bmaxWorkers\b/.test(config) &&
    /\bpoolOptions\b/.test(config) &&
    /\bmax(?:Threads|Forks)\s*:\s*maxWorkers\b/.test(config)
  );
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
      failures.push(`${manifest.name}: missing shared computeMaxWorkers/maxWorkers poolOptions budget`);
    }
  }

  assert.ok(testedPackages.length > 0, "expected at least one workspace package with a test script");
  assert.deepEqual(failures, []);
});
