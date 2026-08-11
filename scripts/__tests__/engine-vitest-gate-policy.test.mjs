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
  /*
  FNXC:MergeGatePerformance 2026-08-04-16:09:
  FN-8783's warm import/setup efficiency is a transform cache, not a result
  cache: every engine-core assertion still executes in fork isolation. Pin its
  project-local path so a later config edit cannot silently widen this cache to
  the broad engine lanes or replace it with stale hand-maintained artifacts.
  */
  assert.match(engineCoreBlock, /experimental:\s*\{[\s\S]*?fsModuleCache:\s*true/,
    "engine-core must retain Vitest's filesystem transform cache");
  assert.match(engineCoreBlock, /fsModuleCachePath:\s*resolve\(__dirname, "node_modules\/.engine-core-fs-module-cache"\)/,
    "engine-core transform cache must stay isolated from broad engine lanes");
});

test("engine-core remains an explicit allow-listed merge gate", () => {
  const config = read("packages/engine/vitest.config.ts");
  const engineCoreBlock = config.match(/name:\s*"engine-core"[\s\S]*?exclude:\s*\[/)?.[0] ?? "";
  const includeEntries = [...engineCoreBlock.matchAll(/"src\/__tests__\/[^"\n]+\.test\.ts"/g)].map((match) => match[0]);

  assert.equal(new Set(includeEntries).size, includeEntries.length, "engine-core allow-list must not contain duplicates");
  /*
  FNXC:MergeGatePerformance 2026-08-04-15:44:
  FN-8783 measured the W32 gate after six policy files joined the former
  16-file lane. Exact membership is the coverage contract: an efficiency change
  may reduce scheduling overhead, never silently drop an assertion group.

  FNXC:TestInfrastructure 2026-08-10-09:16:
  `project-engine.test.ts` is now intentionally excluded by its FN-8811
  quarantine in the engine config, while `check-prerebase-inert.mjs` joined the
  blocking static composition. Keep this ledger aligned with those authoritative
  declarations so unrelated policy drift cannot mask PG-gate membership checks.
  */
  const expectedMembers = [
    '"src/__tests__/legacy-column-literal-census.test.ts"',
    '"src/__tests__/no-legacy-move-targets.test.ts"',
    '"src/__tests__/merger-merge-lifecycle.test.ts"',
    '"src/__tests__/merger-conflict-resolution.test.ts"',
    '"src/__tests__/merger-diff-scope.test.ts"',
    '"src/__tests__/merger-landed-files-capture.test.ts"',
    '"src/__tests__/branch-attribution.test.ts"',
    '"src/__tests__/merge-single-flight-invariant.test.ts"',
    '"src/__tests__/workflow-step-verdict-parsing.test.ts"',
    '"src/__tests__/u9-merge-region-node-config-authority.test.ts"',
    '"src/__tests__/executor-graph-requeue-gate.test.ts"',
    '"src/__tests__/workflow-graph-executor-parity.test.ts"',
    '"src/__tests__/task-pipeline-smoke.test.ts"',
    '"src/__tests__/scheduler-workflow-cutover.test.ts"',
    '"src/__tests__/executor-base-commit-capture.test.ts"',
    '"src/__tests__/executor-capture-modified-files-attribution.test.ts"',
    '"src/__tests__/triage-preflight.test.ts"',
    '"src/__tests__/mission-scheduler.test.ts"',
    '"src/__tests__/heartbeat-monitor.test.ts"',
    '"src/__tests__/workflow-node-handlers.test.ts"',
    '"src/__tests__/workflow-policy-ownership-map.test.ts"',
  ];
  assert.deepEqual(includeEntries, expectedMembers, "engine-core must retain its complete ordered 21-file coverage map");
});

test("root and package gate scripts still propagate real Vitest failures", () => {
  const root = readJson("package.json");
  const engine = readJson("packages/engine/package.json");
  const core = readJson("packages/core/package.json");
  const staticChecks = root.scripts?.["test:gate:static"] ?? "";
  const gate = root.scripts?.["test:gate"] ?? "";

  assert.equal(
    engine.scripts?.["test:core"],
    "vitest run --silent=passed-only --reporter=dot --project=engine-core",
  );
  assert.match(gate, /^node scripts\/run-static-gate-checks\.mjs &&/);
  const gateValidators = [...staticChecks.matchAll(/node (scripts\/check-[\w-]+\.mjs)/g)].map((match) => match[1]);
  const staticCheck = (name) => `scripts/check-${name}.mjs`;
  assert.deepEqual(gateValidators, [
    staticCheck(["no-", ["no", "hup"].join("")].join("")),
    staticCheck("no-cwd-relative-dashboard-test-reads"),
    staticCheck(["no-", "kill-", "40" + "40"].join("")),
    staticCheck("no-getdatabase"),
    staticCheck("prerebase-inert"),
    staticCheck("capacity-pool-id"),
    staticCheck("no-node-only-core-imports-in-dashboard"),
    staticCheck("pi-versions-pinned"),
    staticCheck("no-test-timeout-appeasement"),
    staticCheck("changeset-format"),
    staticCheck("mock-completeness"),
    staticCheck("inert-sync-lane-conversions"),
  ], "every static policy validator must remain once in the blocking composition");
  assert.equal(new Set(gateValidators).size, gateValidators.length, "the static validator composition must be duplicate-free");
  assert.match(gate, /pnpm --filter @fusion\/engine test:core/);
  assert.match(gate, /pnpm --filter @fusion\/core test:pg-gate/);
  assert.match(gate, /pnpm --filter @fusion\/core test:unit-gate/);
  assert.match(gate, /wait \$engine_pid \|\| status=1/);
  assert.match(gate, /wait \$pg_pid \|\| status=1/);
  assert.match(gate, /wait \$unit_pid \|\| status=1/);
  assert.match(gate, /&& pnpm --filter @runfusion\/fusion test:ci-shape$/);
  assert.equal(
    core.scripts?.["test:unit-gate"],
    "vitest run src/__tests__/task-merge.test.ts src/__tests__/legacy-adoption.test.ts src/__tests__/no-hardcoded-lifecycle-columns.test.ts src/__tests__/sync-workflow-ir-callsite-allowlist.test.ts --silent=passed-only --reporter=dot",
  );
  assert.doesNotMatch(gate, /NODE_NO_WARNINGS/);
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
  /*
  FNXC:TestInfrastructure 2026-07-31-20:30:
  FN-8928 evicted `sync-workflow-ir-is-always-default.pg.test.ts` after FN-8912 observed its
  setup hook exceed the inherited 15s budget in the loaded PG gate lane. The AGENTS.md gate rule
  requires eviction rather than a skip; its default-core discovery remains enabled, preserving the
  regression proof outside the blocking canary list. Local evidence was clean in five loaded-gate,
  three isolated, and five uncapped default-config PostgreSQL runs, which does not undo the observed
  gate flake or the required disposition.

  A red policy test protects nothing: while it fails, the NEXT gate admission or eviction is invisible,
  which is the opposite of what a narrow-canary ledger is for. The ledger must never be left red.
  */
  const expectedCanaries = [
    "src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts",
    "src/__tests__/postgres/task-lifecycle-e2e.pg.test.ts",
  ];
  const formerGateMembers = [
    ...expectedCanaries,
    "src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts",
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
  assert.equal(removedFromGate.length, 22, "all non-canary former gate members must remain in the non-blocking lane");
  assert.ok(removedFromGate.every((file) => discoveredPgFiles.has(file)), "removed PG members must remain discoverable");
});
