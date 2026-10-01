import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIPELINE_SMOKE_DURATION_BUDGET_MS, PIPELINE_SMOKE_MAX_WORKERS, PIPELINE_SMOKE_PROJECT, buildPipelineSmokeSummary, expectedInvocationKeys, expectedScenarioIds, invocationKey, parseArgs, parsePipelineSmokeReport, runPipelineSmoke, validatePipelineSmokeSummary } from "../run-pipeline-smoke.mjs";
import { expectedPipelineInvocations } from "../../packages/engine/src/__tests__/pipeline-smoke/_pipeline-scenario-manifest.mjs";

async function withReports(fn) { const dir = mkdtempSync(join(tmpdir(), "fusion-pipeline-smoke-")); try { return await fn({ reportPath: join(dir, "report.json") }); } finally { rmSync(dir, { recursive: true, force: true }); } }
function records() { return expectedPipelineInvocations().map(({ id: scenarioId, workflowId, variant }) => ({ scenarioId, workflowId, ...(variant ? { variant } : {}), expectedTerminal: "merged-done", observedTerminal: "merged-done", verdict: "pass", durationMs: 1 })); }
function healthyPrerequisite(command, args) { if (command === "git" || (command === "pnpm" && args[0] === "pg:test:status")) return { status: 0 }; throw new Error(`unexpected prerequisite command: ${command}`); }
function successfulWatchdog(scenarioRecords = records(), testCount = 80) { return async ({ command, args, env }) => { assert.equal(command, "pnpm"); assert.ok(args.includes(`--project=${PIPELINE_SMOKE_PROJECT}`)); writeFileSync(args.find((arg) => arg.startsWith("--outputFile=")).slice(13), JSON.stringify({ numTotalTests: testCount })); writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, `${scenarioRecords.map(JSON.stringify).join("\n")}\n`); return { code: 0, signal: null, timedOut: false }; }; }

test("runPipelineSmoke writes a strict multi-workflow invocation report", async () => withReports(async ({ reportPath }) => {
  const summary = await runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: successfulWatchdog(), now: (() => { const values = [0, 1, 30]; return () => values.shift(); })(), options: { reportPath }, write: () => undefined });
  assert.equal(summary.passed, true); assert.equal(summary.scenarioIds.length, expectedScenarioIds().length); assert.deepEqual(summary.invocationKeys, expectedInvocationKeys()); assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), summary);
}));
test("runPipelineSmoke overrides inherited Vitest worker fan-out for the real smoke child", async () => withReports(async ({ reportPath }) => {
  const watchdog = async ({ args, env }) => {
    assert.equal(env.VITEST_MAX_WORKERS, String(PIPELINE_SMOKE_MAX_WORKERS));
    writeFileSync(args.find((arg) => arg.startsWith("--outputFile=")).slice(13), JSON.stringify({ numTotalTests: 1 }));
    writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, `${records().map(JSON.stringify).join("\n")}\n`);
    return { code: 0, signal: null, timedOut: false };
  };
  const summary = await runPipelineSmoke({
    spawn: healthyPrerequisite,
    watchdog,
    now: (() => { const values = [0, 1, 2]; return () => values.shift(); })(),
    options: { reportPath },
    write: () => undefined,
  });
  assert.equal(summary.passed, true);
}));
test("timeout replaces stale success with bounded partial S17 attribution and still fails closed", async () => withReports(async ({ reportPath }) => {
  writeFileSync(reportPath, JSON.stringify({ passed: true })); const complete = records().filter((record) => record.scenarioId !== "S17"); const partial = { scenarioId: "S17", workflowId: "builtin:coding-ideas-v2", variant: "post-merge" };
  await assert.rejects(runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: async ({ env }) => { writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, `${complete.map(JSON.stringify).join("\n")}\n${JSON.stringify(partial).slice(0, -3)}`); return { code: 124, signal: null, timedOut: true }; }, now: (() => { const values = [100, 100 + PIPELINE_SMOKE_DURATION_BUDGET_MS]; return () => values.shift(); })(), options: { reportPath }, write: () => undefined }), /pipeline smoke timed out; watchdog terminated the Vitest process group/);
  const report = JSON.parse(readFileSync(reportPath, "utf8")); assert.equal(report.passed, false); assert.equal(report.failure.watchdog.timedOut, true); assert.equal(report.failure.lastComplete.scenarioId, "S21"); assert.equal(report.failure.truncatedFinalRecord.line > 0, true); assert.ok(report.failure.missingInvocationKeys.includes(invocationKey(partial))); assert.equal(existsSync(reportPath), true);
}));
test("strict success rejects duplicate, malformed, missing, unexpected, and failing invocation records", async () => withReports(async ({ reportPath }) => {
  const all = records();
  for (const [name, recordsForCase, match] of [
    ["duplicate", [...all, all[0]], /duplicates/], ["missing", all.slice(1), /missing/], ["unexpected", [...all, { ...all[0], workflowId: "other" }], /unexpected/], ["failing", all.map((record, index) => index ? record : { ...record, verdict: "fail" }), /failing or wedged/],
  ]) await assert.rejects(runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: successfulWatchdog(recordsForCase), options: { reportPath }, write: () => undefined }), match, name);
  await assert.rejects(runPipelineSmoke({ spawn: healthyPrerequisite, watchdog: async ({ args, env }) => { writeFileSync(args.find((arg) => arg.startsWith("--outputFile=")).slice(13), "{"); writeFileSync(env.FUSION_PIPELINE_SMOKE_REPORT, "{"); return { code: 0, signal: null, timedOut: false }; }, options: { reportPath }, write: () => undefined }), /JSON/);
}));
test("duration overruns retain the no-widening refusal", () => { const summary = { invocationKeys: expectedInvocationKeys(), testCount: 1, durationMs: PIPELINE_SMOKE_DURATION_BUDGET_MS + 1, durationBudgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS, passed: true }; assert.throws(() => validatePipelineSmokeSummary(summary), /fix the result, do not widen the budget/); });
test("argument parsing and Vitest reporter fallback remain supported", () => { assert.equal(parseArgs(["--repeat=2", "--json"]).repeat, 2); assert.throws(() => parseArgs(["--repeat=0"]), /positive integer/); assert.equal(parsePipelineSmokeReport({ testResults: [{ assertionResults: [{}, {}] }] }).testCount, 2); assert.equal(buildPipelineSmokeSummary({ testCount: 1, durationMs: 1, exitCode: 0, records: records() }).passed, true); });
