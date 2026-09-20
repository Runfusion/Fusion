#!/usr/bin/env node
/** Run Fusion's opt-in, deterministic local-Git/PostgreSQL pipeline smoke lane. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedPipelineInvocations, PIPELINE_SCENARIO_MANIFEST } from "../packages/engine/src/__tests__/pipeline-smoke/_pipeline-scenario-manifest.mjs";
import { runWithWatchdog } from "./lib/run-vitest-watchdog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const ENGINE_DIR = join(REPO_ROOT, "packages", "engine");
export const PIPELINE_SMOKE_PROJECT = "engine-pipeline-smoke";
export const PIPELINE_SMOKE_SCENARIO_COUNT = PIPELINE_SCENARIO_MANIFEST.length;
/* FNXC:PipelineSmoke 2026-08-25-06:55: The fixed 175s ceiling is a regression detector, not a knob for hiding overruns. */
export const PIPELINE_SMOKE_DURATION_BUDGET_MS = 175_000;
export const DEFAULT_REPORT_PATH = join(ENGINE_DIR, ".pipeline-smoke-report.json");

function testCountFrom(report) {
  if (typeof report?.numTotalTests === "number") return report.numTotalTests;
  return (report?.testResults ?? []).reduce((sum, file) => sum + (file.assertionResults?.length ?? 0), 0);
}
export function parsePipelineSmokeReport(raw) {
  const report = typeof raw === "string" ? JSON.parse(raw) : raw;
  const testCount = testCountFrom(report);
  if (!Number.isInteger(testCount) || testCount < 0) throw new Error("pipeline smoke report has no valid total test count");
  return { report, testCount };
}
export function parseScenarioRecords(raw) {
  const parsed = parseScenarioRecordsLenient(raw);
  if (parsed.truncatedFinalRecord) throw new Error(`pipeline smoke scenario report line ${parsed.truncatedFinalRecord.line} is invalid: ${parsed.truncatedFinalRecord.reason}`);
  return parsed.records;
}
export function parseScenarioRecordsLenient(raw) {
  const records = [];
  const lines = String(raw ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    try {
      const value = JSON.parse(lines[index]);
      if (!value || typeof value !== "object" || typeof value.scenarioId !== "string") throw new Error("missing scenarioId");
      records.push(value);
    } catch (error) {
      return { records, truncatedFinalRecord: { line: index + 1, reason: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { records, truncatedFinalRecord: undefined };
}
export function expectedScenarioIds() { return PIPELINE_SCENARIO_MANIFEST.map(({ id }) => id); }
export function invocationKey(record) { return `${record.scenarioId}\u0000${record.workflowId ?? ""}\u0000${record.variant ?? ""}`; }
export function expectedInvocationKeys() { return expectedPipelineInvocations().map(({ id, ...invocation }) => invocationKey({ scenarioId: id, ...invocation })).sort(); }
export function validateScenarioRecords(records) {
  const expected = new Set(expectedInvocationKeys());
  const keys = records.map(invocationKey);
  const received = new Set(keys);
  const duplicateKeys = [...received].filter((key) => keys.filter((candidate) => candidate === key).length > 1);
  const missing = [...expected].filter((key) => !received.has(key));
  const unexpected = [...received].filter((key) => !expected.has(key));
  if (keys.length !== expected.size || missing.length || unexpected.length || duplicateKeys.length) {
    throw new Error(`pipeline smoke invocation census mismatch: expected ${expected.size} records, received ${keys.length}; missing [${missing.join(", ") || "none"}], unexpected [${unexpected.join(", ") || "none"}], duplicates [${duplicateKeys.join(", ") || "none"}]`);
  }
  const failed = records.filter((record) => record.verdict !== "pass" || record.expectedTerminal !== record.observedTerminal || record.wedge);
  if (failed.length) throw new Error(`pipeline smoke contains failing or wedged scenario records: ${failed.map((record) => `${record.scenarioId}/${record.workflowId}/${record.variant ?? "-"}`).join(", ")}`);
  return { scenarioIds: expectedScenarioIds(), recordCount: keys.length, invocationKeys: [...received].sort() };
}
export function buildPipelineSmokeSummary({ testCount, durationMs, exitCode, records, budgetMs = PIPELINE_SMOKE_DURATION_BUDGET_MS, repeat = 1 }) {
  const census = validateScenarioRecords(records);
  return { schemaVersion: 2, project: PIPELINE_SMOKE_PROJECT, expectedScenarioCount: PIPELINE_SMOKE_SCENARIO_COUNT, expectedInvocationCount: expectedInvocationKeys().length, scenarioIds: census.scenarioIds, invocationKeys: census.invocationKeys, scenarioRecordCount: census.recordCount, testCount, durationMs, durationBudgetMs: budgetMs, repeat, passed: exitCode === 0 && testCount > 0 && durationMs <= budgetMs };
}
export function validatePipelineSmokeSummary(summary) {
  if (!Array.isArray(summary.invocationKeys) || summary.invocationKeys.length !== expectedInvocationKeys().length) throw new Error(`pipeline smoke executed an incomplete invocation census; expected exactly ${expectedInvocationKeys().length}`);
  if (!Number.isInteger(summary.testCount) || summary.testCount <= 0) throw new Error("pipeline smoke executed 0 tests — project glob/config drift must fail loudly");
  if (summary.durationMs > summary.durationBudgetMs) throw new Error(`pipeline smoke exceeded its ${summary.durationBudgetMs}ms duration budget (${summary.durationMs}ms): fix the result, do not widen the budget`);
  if (!summary.passed) throw new Error("pipeline smoke reported failing scenarios");
}
export function parseArgs(argv) {
  const options = { allowSkip: false, json: false, repeat: 1, budgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS, reportPath: DEFAULT_REPORT_PATH, diagnosticBudget: false };
  for (const arg of argv) {
    if (arg === "--allow-skip") options.allowSkip = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--repeat=")) { const value = Number(arg.slice(9)); if (!Number.isInteger(value) || value < 1) throw new Error("--repeat must be a positive integer"); options.repeat = value; }
    else if (arg.startsWith("--budget-ms=")) { const value = Number(arg.slice(12)); if (!Number.isFinite(value) || value < 1) throw new Error("--budget-ms must be a positive finite number"); options.budgetMs = value; options.diagnosticBudget = true; }
    else if (arg.startsWith("--report=")) { const value = arg.slice(9); if (!value) throw new Error("--report requires a path"); options.reportPath = resolve(process.cwd(), value); }
    else throw new Error(`unknown pipeline smoke option: ${arg}`);
  }
  return options;
}
export function checkPrerequisites({ spawn: run = spawnSync } = {}) {
  if (run("git", ["--version"], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" }).status !== 0) return { ok: false, message: "pipeline smoke requires Git; install Git and retry." };
  if (run("pnpm", ["pg:test:status"], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8", env: { ...process.env } }).status !== 0) return { ok: false, message: "pipeline smoke requires reachable PostgreSQL; run `pnpm pg:test:up` and retry." };
  return { ok: true };
}
function atomicWrite(path, value) { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameSync(temp, path); }
function boundedMessage(error) { return String(error instanceof Error ? error.message : error).slice(0, 1000); }
function failureReport({ error, attempt, durationMs, budgetMs }) {
  const scenario = attempt?.scenarioPath && existsSync(attempt.scenarioPath) ? parseScenarioRecordsLenient(readFileSync(attempt.scenarioPath, "utf8")) : { records: [], truncatedFinalRecord: undefined };
  const vitestAvailable = Boolean(attempt?.vitestPath && existsSync(attempt.vitestPath));
  let testCount;
  try { if (vitestAvailable) ({ testCount } = parsePipelineSmokeReport(readFileSync(attempt.vitestPath, "utf8"))); } catch { /* malformed JSON remains failure evidence */ }
  const completedKeys = scenario.records.map(invocationKey);
  const missingInvocationKeys = expectedInvocationKeys().filter((key) => !completedKeys.includes(key));
  const lastComplete = scenario.records.at(-1);
  return { schemaVersion: 2, project: PIPELINE_SMOKE_PROJECT, passed: false, durationMs, durationBudgetMs: budgetMs, failure: { message: boundedMessage(error), watchdog: attempt?.result ? { timedOut: Boolean(attempt.result.timedOut), code: attempt.result.code ?? null, signal: attempt.result.signal ?? null } : null, vitestReportAvailable: vitestAvailable, scenarioReportAvailable: Boolean(attempt?.scenarioPath && existsSync(attempt.scenarioPath)), testCount: testCount ?? null, completedRecordCount: scenario.records.length, lastComplete: lastComplete ? { scenarioId: lastComplete.scenarioId, workflowId: lastComplete.workflowId, variant: lastComplete.variant } : null, missingInvocationKeys, truncatedFinalRecord: scenario.truncatedFinalRecord ?? null } };
}
function compactSignature(records) { return records.map((record) => [invocationKey(record), record.expectedTerminal, record.observedTerminal, record.verdict, record.wedge ?? ""].join("\u0000")).sort().join("\n"); }
function printTable(summary, records, write = console.log) { for (const record of records) write(`${record.scenarioId} ${record.variant ?? "-"} ${record.workflowId} ${record.verdict}`); write(`✓ pipeline smoke: ${summary.scenarioRecordCount}/${summary.expectedInvocationCount} invocations passed in ${summary.durationMs}ms (budget ${summary.durationBudgetMs}ms)`); }

export async function runPipelineSmoke({ spawn: prerequisiteSpawn = spawnSync, watchdog = runWithWatchdog, watchdogSpawn = spawn, now = () => Date.now(), prerequisite = checkPrerequisites, options = {}, write = console.log, warn = console.warn } = {}) {
  const resolved = { allowSkip: false, json: false, repeat: 1, budgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS, reportPath: DEFAULT_REPORT_PATH, diagnosticBudget: false, ...options };
  rmSync(resolved.reportPath, { force: true });
  const preflight = prerequisite({ spawn: prerequisiteSpawn });
  if (!preflight.ok) { if (resolved.allowSkip) { const skipped = { schemaVersion: 2, project: PIPELINE_SMOKE_PROJECT, skipped: true, reason: preflight.message }; warn(`⚠ ${preflight.message}`); return skipped; } throw new Error(preflight.message); }
  if (resolved.diagnosticBudget) warn(`WARNING: diagnostic --budget-ms=${resolved.budgetMs}; fix an overrun rather than widening the declared budget.`);
  const reportDir = mkdtempSync(join(tmpdir(), "fusion-pipeline-smoke-report-")); const summaries = []; let baselineSignature; let attempt; let startedAt = now();
  try {
    for (let iteration = 1; iteration <= resolved.repeat; iteration += 1) {
      const vitestPath = join(reportDir, `vitest-${iteration}.json`); const scenarioPath = join(reportDir, `scenarios-${iteration}.jsonl`); startedAt = now();
      const result = await watchdog({ command: "pnpm", args: ["exec", "vitest", "run", `--project=${PIPELINE_SMOKE_PROJECT}`, "--silent=passed-only", "--reporter=dot", "--reporter=json", `--outputFile=${vitestPath}`], cwd: ENGINE_DIR, env: { ...process.env, FUSION_PIPELINE_SMOKE_REPORT: scenarioPath }, budgetMs: resolved.budgetMs, label: "pipeline smoke", spawn: watchdogSpawn, log: warn });
      const durationMs = now() - startedAt; attempt = { result, vitestPath, scenarioPath };
      if (result.timedOut) throw new Error("pipeline smoke timed out; watchdog terminated the Vitest process group");
      if (result.signal) throw new Error(`pipeline smoke terminated by signal ${result.signal}`);
      if (result.code !== 0) throw new Error(`pipeline smoke Vitest exited with code ${result.code ?? "unknown"}`);
      if (!existsSync(vitestPath)) throw new Error("pipeline smoke produced no JSON results file; cannot verify test execution");
      if (!existsSync(scenarioPath)) throw new Error("pipeline smoke produced no scenario records; cannot verify declared coverage");
      const { testCount } = parsePipelineSmokeReport(readFileSync(vitestPath, "utf8")); const records = parseScenarioRecords(readFileSync(scenarioPath, "utf8"));
      const summary = buildPipelineSmokeSummary({ testCount, durationMs, exitCode: result.code, records, budgetMs: resolved.budgetMs, repeat: resolved.repeat }); validatePipelineSmokeSummary(summary);
      const signature = compactSignature(records); if (baselineSignature !== undefined && signature !== baselineSignature) throw new Error("pipeline smoke reproducibility failure: scenario records differ between consecutive runs"); baselineSignature = signature; summaries.push({ ...summary, records });
    }
    const final = { ...summaries.at(-1), runs: summaries.map(({ records: _records, ...summary }) => summary) }; atomicWrite(resolved.reportPath, final); if (resolved.json) write(JSON.stringify(final)); else printTable(final, final.records, write); return final;
  } catch (error) {
    atomicWrite(resolved.reportPath, failureReport({ error, attempt, durationMs: now() - startedAt, budgetMs: resolved.budgetMs })); throw error;
  } finally { rmSync(reportDir, { recursive: true, force: true }); }
}
function main() { try { const options = parseArgs(process.argv.slice(2)); void runPipelineSmoke({ options }).catch((error) => { console.error(`✗ ${boundedMessage(error)}`); process.exitCode = 1; }); } catch (error) { console.error(`✗ ${boundedMessage(error)}`); process.exitCode = 1; } }
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
