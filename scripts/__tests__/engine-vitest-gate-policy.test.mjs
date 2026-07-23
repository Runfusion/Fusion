import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  /*
  FNXC:MergeGatePerformance 2026-07-22-15:36:
  FN-8497 exercises this policy after profiling the complete gate. The current
  curated engine lane has 16 explicit files after the documented SQLite and
  obsolete graph-runner retirements; guard its real floor instead of the stale
  18-file count, while still requiring the replacement graph executor seam.
  */
  assert.ok(includeEntries.length >= 16, "engine-core allow-list must not be gutted to avoid the runtime abort");
  assert.ok(
    includeEntries.includes('"src/__tests__/workflow-graph-executor-parity.test.ts"'),
    "engine-core must keep workflow graph executor gate coverage",
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
  assert.match(root.scripts?.["test:gate"] ?? "", /wait \$engine_pid \|\| status=1/);
  assert.match(root.scripts?.["test:gate"] ?? "", /wait \$pg_pid \|\| status=1/);
  assert.doesNotMatch(root.scripts?.["test:gate"] ?? "", /NODE_NO_WARNINGS/);
  assert.doesNotMatch(root.scripts?.["test"] ?? "", /NODE_NO_WARNINGS/);
});

/*
FNXC:MergeGatePerformance 2026-07-22-15:35:
FN-8497 keeps only lifecycle and transactional-handoff PostgreSQL canaries in
`test:pg-gate`: 23 independent PG files each create/copy a real database, so
putting the whole integration inventory on every PR made the sequential merge
gate take 26–45 seconds. The other PG files must remain ordinary enabled core
tests; this structural guard prevents a future package-script/config change
from silently converting the speed fix into lost coverage.
*/
test("pg gate canaries remain a subset of the enabled non-blocking PG suite", () => {
  const core = readJson("packages/core/package.json");
  const coreConfig = read("packages/core/vitest.config.ts");
  const pgDirectory = path.join(repoRoot, "packages/core/src/__tests__/postgres");
  const discoveredPgFiles = new Set(
    readdirSync(pgDirectory)
      .filter((file) => file.endsWith(".pg.test.ts"))
      .map((file) => `src/__tests__/postgres/${file}`),
  );
  const gateMembers = core.scripts?.["test:pg-gate"]?.match(/src\/__tests__\/postgres\/[^ ]+\.pg\.test\.ts/g) ?? [];
  const expectedCanaries = [
    "src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts",
    "src/__tests__/postgres/task-lifecycle-e2e.pg.test.ts",
  ];
  const formerGateMembers = [
    ...expectedCanaries,
    "src/__tests__/postgres/store-list.pg.test.ts",
    "src/__tests__/postgres/soft-delete-resurrection-FN-5233.pg.test.ts",
    "src/__tests__/postgres/agent-logs-and-monitor.pg.test.ts",
    "src/__tests__/postgres/todo-store.pg.test.ts",
    "src/__tests__/postgres/workflow-definitions.pg.test.ts",
    "src/__tests__/postgres/message-store.pg.test.ts",
    "src/__tests__/postgres/insight-store.pg.test.ts",
    "src/__tests__/postgres/insight-run-execution.pg.test.ts",
    "src/__tests__/postgres/research-store.pg.test.ts",
    "src/__tests__/postgres/mission-store.pg.test.ts",
    "src/__tests__/postgres/goal-store.pg.test.ts",
    "src/__tests__/postgres/artifacts-documents-evals.pg.test.ts",
    "src/__tests__/postgres/command-center-analytics.pg.test.ts",
    "src/__tests__/postgres/command-center-remaining-analytics.pg.test.ts",
    "src/__tests__/postgres/research-execution.pg.test.ts",
    "src/__tests__/postgres/async-store-events.pg.test.ts",
    "src/__tests__/postgres/signal-ingestion.pg.test.ts",
    "src/__tests__/postgres/mission-autopilot.pg.test.ts",
    "src/__tests__/postgres/workflow-create.pg.test.ts",
    "src/__tests__/postgres/monitor-trait-storm-guard.pg.test.ts",
    "src/__tests__/postgres/agent-wake-getagent.pg.test.ts",
  ];

  assert.deepEqual(gateMembers, expectedCanaries, "the PG gate must stay a narrow, explicit canary list");
  assert.match(core.scripts?.test ?? "", /^vitest run\b/, "the non-blocking core lane must execute Vitest");
  assert.doesNotMatch(core.scripts?.test ?? "", /\s(?:--exclude|--include)\b/, "the non-blocking core lane must not narrow discovery");
  assert.match(coreConfig, /include:\s*\["src\/\*\*\/\*.test\.ts"\]/, "the default core config must discover PG tests");
  assert.match(coreConfig, /const quarantinedCoreTests: string\[\] = \[\]/, "no PG test may be hidden by quarantine exclusion");

  for (const file of formerGateMembers) {
    assert.ok(discoveredPgFiles.has(file), `former PG gate member must remain discovered: ${file}`);
  }
  const removedFromGate = formerGateMembers.filter((file) => !gateMembers.includes(file));
  assert.equal(removedFromGate.length, 21, "all non-canary former gate members must remain in the non-blocking lane");
  assert.ok(removedFromGate.every((file) => discoveredPgFiles.has(file)), "removed PG members must remain discoverable");
});
