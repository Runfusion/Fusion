import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PIPELINE_SMOKE_DURATION_BUDGET_MS,
  PIPELINE_SMOKE_PROJECT,
  PIPELINE_SMOKE_SCENARIO_COUNT,
  buildPipelineSmokeSummary,
  expectedScenarioIds,
  parseArgs,
  parsePipelineSmokeReport,
  runPipelineSmoke,
  validatePipelineSmokeSummary,
} from "../run-pipeline-smoke.mjs";

/*
FNXC:PipelineSmoke 2026-08-23-15:18:
The wrapper tests replace only subprocess/report boundaries. They prove missing prerequisites,
zero execution, incomplete scenario census, and budget overruns fail without starting PostgreSQL
or a real Git fixture, preserving the smoke lane's deterministic test boundary.
*/

function withReports(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-pipeline-smoke-"));
  try {
    return fn({ reportPath: join(dir, "report.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function records(count = PIPELINE_SMOKE_SCENARIO_COUNT) {
  return expectedScenarioIds().slice(0, count).map((scenarioId) => ({
    scenarioId,
    workflowId: "builtin:coding-ideas-v2",
    expectedTerminal: "merged-done",
    observedTerminal: "merged-done",
    verdict: "pass",
    durationMs: 1,
  }));
}

function successfulSpawn(scenarioRecords = records(), testCount = 24) {
  return (command, args, options) => {
    if (command === "git") return { status: 0 };
    if (command === "pnpm" && args[0] === "pg:test:status") return { status: 0 };
    assert.equal(command, "pnpm");
    assert.ok(args.includes(`--project=${PIPELINE_SMOKE_PROJECT}`));
    const rawPath = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    writeFileSync(rawPath, JSON.stringify({ numTotalTests: testCount }));
    writeFileSync(options.env.FUSION_PIPELINE_SMOKE_REPORT, `${scenarioRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return { status: 0 };
  };
}

test("runPipelineSmoke writes a stable report after all declared scenarios pass", () => {
  withReports(({ reportPath }) => {
    const times = [100, 145];
    const summary = runPipelineSmoke({
      spawn: successfulSpawn(),
      now: () => times.shift(),
      options: { reportPath },
      write: () => undefined,
    });

    assert.equal(summary.passed, true);
    assert.equal(summary.scenarioIds.length, PIPELINE_SMOKE_SCENARIO_COUNT);
    assert.equal(summary.testCount, 24);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), summary);
  });
});

test("runPipelineSmoke rejects zero Vitest execution even with complete scenario records", () => {
  withReports(({ reportPath }) => {
    assert.throws(
      () => runPipelineSmoke({
        spawn: successfulSpawn(records(), 0),
        now: () => 0,
        options: { reportPath },
        write: () => undefined,
      }),
      /executed 0 tests/,
    );
    assert.equal(existsSync(reportPath), false);
  });
});

test("runPipelineSmoke rejects a missing declared scenario", () => {
  withReports(({ reportPath }) => {
    assert.throws(
      () => runPipelineSmoke({
        spawn: successfulSpawn(records(PIPELINE_SMOKE_SCENARIO_COUNT - 1)),
        now: () => 0,
        options: { reportPath },
        write: () => undefined,
      }),
      /scenario census mismatch/,
    );
  });
});

test("missing PostgreSQL fails with the actionable startup command unless allow-skip is explicit", () => {
  const noPg = (command, args) => {
    if (command === "git") return { status: 0 };
    if (command === "pnpm" && args[0] === "pg:test:status") return { status: 1 };
    throw new Error("Vitest must not run when PostgreSQL is unavailable");
  };
  assert.throws(
    () => runPipelineSmoke({ spawn: noPg, options: { reportPath: "/tmp/unused-pipeline-report.json" }, write: () => undefined }),
    /pnpm pg:test:up/,
  );
  const warnings = [];
  const skipped = runPipelineSmoke({
    spawn: noPg,
    options: { allowSkip: true, reportPath: "/tmp/unused-pipeline-report.json" },
    write: () => undefined,
    warn: (line) => warnings.push(line),
  });
  assert.equal(skipped.skipped, true);
  assert.match(warnings[0], /pnpm pg:test:up/);
});

test("validatePipelineSmokeSummary rejects a run over the declared duration budget with the no-widening instruction", () => {
  const summary = {
    schemaVersion: 1,
    scenarioIds: expectedScenarioIds(),
    testCount: 1,
    durationMs: PIPELINE_SMOKE_DURATION_BUDGET_MS + 1,
    durationBudgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS,
    passed: true,
  };
  assert.throws(() => validatePipelineSmokeSummary(summary), /fix the result, do not widen the budget/);
});

test("argument parsing supports deterministic repeats, JSON, and a loud diagnostic budget override", () => {
  assert.deepEqual(parseArgs(["--repeat=10", "--json", "--budget-ms=123"]), {
    allowSkip: false,
    json: true,
    repeat: 10,
    budgetMs: 123,
    reportPath: join(process.cwd(), "packages/engine/.pipeline-smoke-report.json"),
    diagnosticBudget: true,
  });
  assert.throws(() => parseArgs(["--repeat=0"]), /positive integer/);
});

test("parsePipelineSmokeReport retains Vitest's reporter fallback", () => {
  const { testCount } = parsePipelineSmokeReport({ testResults: [{ assertionResults: [{}, {}] }, { assertionResults: [{}] }] });
  assert.equal(testCount, 3);
});

test("buildPipelineSmokeSummary validates the declared scenario set", () => {
  const summary = buildPipelineSmokeSummary({ testCount: 1, durationMs: 1, exitCode: 0, records: records() });
  assert.equal(summary.passed, true);
});
