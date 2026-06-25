import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test("engine-core gate keeps a Node 24/macOS-safe Vitest pool without changing broad engine lanes", () => {
  const config = read("packages/engine/vitest.config.ts");
  const projectsIndex = config.indexOf("projects:");
  const rootTestConfig = projectsIndex === -1 ? config : config.slice(0, projectsIndex);
  const engineCoreBlock = config.match(/name:\s*"engine-core"[\s\S]*?include:\s*\[/)?.[0] ?? "";
  const engineDefaultBlock = config.match(/name:\s*"engine-default"[\s\S]*?include:\s*\[/)?.[0] ?? "";

  assert.match(
    engineCoreBlock,
    /pool:\s*"forks"/,
    "engine-core must use fork workers; thread workers abort with Node 24/macOS libuv kqueue",
  );
  assert.doesNotMatch(
    rootTestConfig,
    /pool:\s*"forks"/,
    "fork workers must not be configured at root scope because that slows the broad engine-default lane",
  );
  assert.match(
    rootTestConfig,
    /pool:\s*"threads"/,
    "root engine config must explicitly keep broad lanes on threads because Vitest 4 defaults to forks",
  );
  assert.doesNotMatch(
    engineDefaultBlock,
    /pool:\s*"forks"/,
    "engine-default must keep inheriting Vitest's default thread pool for broad src/**/*.test.ts runs",
  );
  assert.doesNotMatch(
    config,
    /NODE_NO_WARNINGS/,
    "the gate must not hide unmanaged-fd warnings by suppressing Node warnings",
  );
  assert.match(config, /maxWorkers,/, "worker budgeting must still flow through computeMaxWorkers");
  assert.match(config, /fileParallelism:\s*true/, "engine-core should preserve file-level parallelism");
});

test("engine-core remains an explicit allow-listed merge gate", () => {
  const config = read("packages/engine/vitest.config.ts");
  const engineCoreBlock = config.match(/name:\s*"engine-core"[\s\S]*?exclude:\s*\[/)?.[0] ?? "";
  const includeEntries = [...engineCoreBlock.matchAll(/"src\/__tests__\/[^"\n]+\.test\.ts"/g)].map((match) => match[0]);

  assert.equal(new Set(includeEntries).size, includeEntries.length, "engine-core allow-list must not contain duplicates");
  assert.ok(includeEntries.length >= 18, "engine-core allow-list must not be gutted to avoid the runtime abort");
  assert.ok(
    includeEntries.includes('"src/__tests__/workflow-graph-task-runner.test.ts"'),
    "engine-core must keep workflow graph gate coverage",
  );
  assert.ok(
    includeEntries.includes('"src/__tests__/heartbeat-monitor.test.ts"'),
    "engine-core must keep heartbeat monitor gate coverage while avoiding FN-779 scope changes",
  );
});

test("root and package gate scripts still propagate real Vitest failures", () => {
  const root = readJson("package.json");
  const engine = readJson("packages/engine/package.json");

  assert.equal(
    engine.scripts?.["test:core"],
    "vitest run --silent=passed-only --reporter=dot --project=engine-core",
  );
  assert.match(root.scripts?.["test:gate"] ?? "", /pnpm --filter @fusion\/engine test:core/);
  assert.doesNotMatch(root.scripts?.["test:gate"] ?? "", /NODE_NO_WARNINGS/);
  assert.doesNotMatch(root.scripts?.["test"] ?? "", /NODE_NO_WARNINGS/);
});
