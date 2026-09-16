import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENGINE_DIR,
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

async function withReports(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-pipeline-smoke-"));
  try {
    return await fn({ reportPath: join(dir, "report.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function records(count = PIPELINE_SMOKE_SCENARIO_COUNT) {
  return expectedScenarioIds().slice(0, count).map((scenarioId) => ({
    scenarioId,
    workflowId: "builtin:coding-ideas",
    expectedTerminal: "merged-done",
    observedTerminal: "merged-done",
    verdict: "pass",
    durationMs: 1,
  }));
}

function healthyPrerequisite(command, args) {
  if (command === "git") return { status: 0 };
  if (command === "pnpm" && args[0] === "pg:test:status") return { status: 0 };
  throw new Error(`unexpected prerequisite command: ${command}`);
}

function successfulWatchdog(scenarioRecords = records(), testCount = 24) {
  return async ({ command, args, env }) => {
    assert.equal(command, "pnpm");
    assert.ok(args.includes(`--project=${PIPELINE_SMOKE_PROJECT}`));
    const rawPath = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    writeFileSync(rawPath, JSON.stringify({ numTotalTests: testCount }));
    writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, `${scenarioRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    return { code: 0, signal: null, timedOut: false };
  };
}

test("runPipelineSmoke writes a stable report after all declared scenarios pass", async () => {
  await withReports(async ({ reportPath }) => {
    const times = [100, 145];
    const summary = await runPipelineSmoke({
      spawn: healthyPrerequisite,
      watchdog: successfulWatchdog(),
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

test("runPipelineSmoke removes a prior success report when the watchdog times out", async () => {
  await withReports(async ({ reportPath }) => {
    writeFileSync(reportPath, JSON.stringify({ passed: true }));
    const calls = [];
    const times = [100, 100 + PIPELINE_SMOKE_DURATION_BUDGET_MS];
    await assert.rejects(
      runPipelineSmoke({
        spawn: healthyPrerequisite,
        watchdog: async (options) => {
          calls.push(options);
          return { code: 124, signal: null, timedOut: true };
        },
        now: () => times.shift(),
        options: { reportPath },
        write: () => undefined,
      }),
      /watchdog terminated the Vitest process group/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pnpm");
    assert.ok(calls[0].args.includes(`--project=${PIPELINE_SMOKE_PROJECT}`));
    assert.equal(calls[0].cwd, ENGINE_DIR);
    assert.equal(calls[0].env.FUSION_PIPELINE_SMOKE_REPORT.endsWith("scenarios-1.jsonl"), true);
    assert.equal(calls[0].budgetMs, PIPELINE_SMOKE_DURATION_BUDGET_MS);
    assert.equal(existsSync(reportPath), false);
  });
});

test("runPipelineSmoke rejects zero Vitest execution even with complete scenario records", async () => {
  await withReports(async ({ reportPath }) => {
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: successfulWatchdog(records(), 0), now: () => 0, options: { reportPath }, write: () => undefined }),
      /executed 0 tests/,
    );
    assert.equal(existsSync(reportPath), false);
  });
});

test("runPipelineSmoke rejects a missing declared scenario", async () => {
  await withReports(async ({ reportPath }) => {
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: successfulWatchdog(records(PIPELINE_SMOKE_SCENARIO_COUNT - 1)), now: () => 0, options: { reportPath }, write: () => undefined }),
      /scenario census mismatch/,
    );
  });
});

test("runPipelineSmoke rejects duplicate scenario records", async () => {
  await withReports(async ({ reportPath }) => {
    const duplicateRecords = [...records(), records()[0]];
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: successfulWatchdog(duplicateRecords), now: () => 0, options: { reportPath }, write: () => undefined }),
      /duplicates \[S01\]/,
    );
    assert.equal(existsSync(reportPath), false);
  });
});

test("runPipelineSmoke rejects missing Vitest or scenario evidence after a successful child", async () => {
  await withReports(async ({ reportPath }) => {
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: async () => ({ code: 0, signal: null, timedOut: false }), options: { reportPath }, write: () => undefined }),
      /produced no JSON results file/,
    );
  });
});

test("runPipelineSmoke rejects non-zero and signaled watchdog results", async () => {
  await withReports(async ({ reportPath }) => {
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: async () => ({ code: 1, signal: null, timedOut: false }), options: { reportPath }, write: () => undefined }),
      /exited with code 1/,
    );
    await assert.rejects(
      runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: async () => ({ code: null, signal: "SIGTERM", timedOut: false }), options: { reportPath }, write: () => undefined }),
      /terminated by signal SIGTERM/,
    );
  });
});

test("runPipelineSmoke rejects repeat records with mismatched signatures", async () => {
  await withReports(async ({ reportPath }) => {
    let call = 0;
    await assert.rejects(
      runPipelineSmoke({
        spawn: healthyPrerequisite,
        watchdog: async ({ args, env }) => {
          call += 1;
          const rawPath = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
          const scenarioRecords = records();
          if (call === 2) scenarioRecords[0].variant = "changed";
          writeFileSync(rawPath, JSON.stringify({ numTotalTests: 24 }));
          writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, `${scenarioRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
          return { code: 0, signal: null, timedOut: false };
        },
        options: { reportPath, repeat: 2 },
        write: () => undefined,
      }),
      /reproducibility failure/,
    );
  });
});

test("missing PostgreSQL fails with the actionable startup command unless allow-skip is explicit", async () => {
  const noPg = (command, args) => {
    if (command === "git") return { status: 0 };
    if (command === "pnpm" && args[0] === "pg:test:status") return { status: 1 };
    throw new Error("Vitest must not run when PostgreSQL is unavailable");
  };
  await assert.rejects(
    runPipelineSmoke({ spawn: noPg, options: { reportPath: "/tmp/unused-pipeline-report.json" }, write: () => undefined }),
    /pnpm pg:test:up/,
  );
  const warnings = [];
  const skipped = await runPipelineSmoke({
    spawn: noPg,
    options: { allowSkip: true, reportPath: "/tmp/unused-pipeline-report.json" },
    write: () => undefined,
    warn: (line) => warnings.push(line),
  });
  assert.equal(skipped.skipped, true);
  assert.match(warnings[0], /pnpm pg:test:up/);
});

test("validatePipelineSmokeSummary rejects a run over the declared duration budget with the no-widening instruction", () => {
  const summary = { schemaVersion: 1, scenarioIds: expectedScenarioIds(), testCount: 1, durationMs: PIPELINE_SMOKE_DURATION_BUDGET_MS + 1, durationBudgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS, passed: true };
  assert.throws(() => validatePipelineSmokeSummary(summary), /fix the result, do not widen the budget/);
});

test("argument parsing supports deterministic repeats, JSON, and a loud diagnostic budget override", () => {
  assert.deepEqual(parseArgs(["--repeat=10", "--json", "--budget-ms=123"]), { allowSkip: false, json: true, repeat: 10, budgetMs: 123, reportPath: join(process.cwd(), "packages/engine/.pipeline-smoke-report.json"), diagnosticBudget: true });
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
