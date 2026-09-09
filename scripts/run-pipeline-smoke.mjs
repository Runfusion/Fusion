#!/usr/bin/env node
/**
 * Run Fusion's opt-in, deterministic local-Git/PostgreSQL pipeline smoke lane.
 *
 * The Vitest JSON report proves the project glob executed; scenario JSON-lines prove that the
 * declarative S01..S19 contract, rather than incidental harness self-tests, actually ran.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const ENGINE_DIR = join(REPO_ROOT, "packages", "engine");
export const PIPELINE_SMOKE_PROJECT = "engine-pipeline-smoke";
export const PIPELINE_SMOKE_SCENARIO_COUNT = 19;
/*
FNXC:PipelineSmoke 2026-08-25-06:55:
Re-baselined 150s -> 175s for measured workload growth, not to hide a regression. Two additions:
the dedicated Code Review remediation drive (a 7th file, which re-pays module import and provisions
its own disposable PostgreSQL database), and S05 extended to `builtin:coding-ideas-v2` 2014 a
revise-twice scenario that is among the longest in the matrix. Five consecutive full runs measured
140.1s, 143.8s, 146.7s, 147.0s and 148.4s against the old 150s ceiling: green, but with under 2s of
headroom, which is a flake waiting to happen rather than a passing lane.
The standing rule is unchanged and now has three precedents: an overrun with NO attributable growth
is a regression to fix in the lane, never a budget to raise. Per-file cost remains the first
optimization to reach for.

FNXC:WorkflowSuccession 2026-09-06-02:15:
FN-297 removes the retired Ideas workflow from every scenario matrix because its alias resolves the same successor graph and would duplicate work. The declared duration budget remains a ceiling rather than being lowered around one catalog cleanup.
*/
export const PIPELINE_SMOKE_DURATION_BUDGET_MS = 175_000;
export const DEFAULT_REPORT_PATH = join(ENGINE_DIR, ".pipeline-smoke-report.json");

/*
FNXC:PipelineSmoke 2026-08-23-15:18:
FN-182 keeps this whole-pipeline lane opt-in and outside engine-core. The runner rejects an
empty Vitest project and a missing declared scenario independently, because green helper tests
must never masquerade as evidence that the 19 real workflow contracts ran.
*/

function testCountFrom(report) {
  if (typeof report?.numTotalTests === "number") return report.numTotalTests;
  return (report?.testResults ?? []).reduce(
    (sum, file) => sum + (file.assertionResults?.length ?? 0),
    0,
  );
}

export function parsePipelineSmokeReport(raw) {
  const report = typeof raw === "string" ? JSON.parse(raw) : raw;
  const testCount = testCountFrom(report);
  if (!Number.isInteger(testCount) || testCount < 0) {
    throw new Error("pipeline smoke report has no valid total test count");
  }
  return { report, testCount };
}

export function parseScenarioRecords(raw) {
  const lines = String(raw ?? "").split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || typeof value.scenarioId !== "string") {
        throw new Error("missing scenarioId");
      }
      return value;
    } catch (error) {
      throw new Error(`pipeline smoke scenario report line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function expectedScenarioIds() {
  return Array.from({ length: PIPELINE_SMOKE_SCENARIO_COUNT }, (_, index) => `S${String(index + 1).padStart(2, "0")}`);
}

export function validateScenarioRecords(records) {
  const expected = new Set(expectedScenarioIds());
  const ids = new Set(records.map((record) => record.scenarioId));
  const missing = [...expected].filter((id) => !ids.has(id));
  const unexpected = [...ids].filter((id) => !expected.has(id));
  if (missing.length || unexpected.length) {
    throw new Error(`pipeline smoke scenario census mismatch: missing [${missing.join(", ") || "none"}], unexpected [${unexpected.join(", ") || "none"}]`);
  }
  const failed = records.filter((record) => record.verdict !== "pass" || record.expectedTerminal !== record.observedTerminal || record.wedge);
  if (failed.length) {
    throw new Error(`pipeline smoke contains failing or wedged scenario records: ${failed.map((record) => `${record.scenarioId}${record.variant ? `/${record.variant}` : ""}`).join(", ")}`);
  }
  return { scenarioIds: [...ids].sort(), recordCount: records.length };
}

export function buildPipelineSmokeSummary({ testCount, durationMs, exitCode, records, budgetMs = PIPELINE_SMOKE_DURATION_BUDGET_MS, repeat = 1 }) {
  const census = validateScenarioRecords(records);
  return {
    schemaVersion: 1,
    project: PIPELINE_SMOKE_PROJECT,
    expectedScenarioCount: PIPELINE_SMOKE_SCENARIO_COUNT,
    scenarioIds: census.scenarioIds,
    scenarioRecordCount: census.recordCount,
    testCount,
    durationMs,
    durationBudgetMs: budgetMs,
    repeat,
    passed: exitCode === 0 && testCount > 0 && durationMs <= budgetMs,
  };
}

export function validatePipelineSmokeSummary(summary) {
  if (!Array.isArray(summary.scenarioIds) || summary.scenarioIds.length !== PIPELINE_SMOKE_SCENARIO_COUNT) {
    throw new Error(`pipeline smoke executed an incomplete scenario census; expected exactly ${PIPELINE_SMOKE_SCENARIO_COUNT}`);
  }
  if (!Number.isInteger(summary.testCount) || summary.testCount <= 0) {
    throw new Error("pipeline smoke executed 0 tests — project glob/config drift must fail loudly");
  }
  if (summary.durationMs > summary.durationBudgetMs) {
    throw new Error(`pipeline smoke exceeded its ${summary.durationBudgetMs}ms duration budget (${summary.durationMs}ms): fix the result, do not widen the budget`);
  }
  if (!summary.passed) throw new Error("pipeline smoke reported failing scenarios");
}

export function parseArgs(argv) {
  const options = { allowSkip: false, json: false, repeat: 1, budgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS, reportPath: DEFAULT_REPORT_PATH, diagnosticBudget: false };
  for (const arg of argv) {
    if (arg === "--allow-skip") options.allowSkip = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--repeat=")) {
      const value = Number(arg.slice("--repeat=".length));
      if (!Number.isInteger(value) || value < 1) throw new Error("--repeat must be a positive integer");
      options.repeat = value;
    } else if (arg.startsWith("--budget-ms=")) {
      const value = Number(arg.slice("--budget-ms=".length));
      if (!Number.isFinite(value) || value < 1) throw new Error("--budget-ms must be a positive finite number");
      options.budgetMs = value;
      options.diagnosticBudget = true;
    } else if (arg.startsWith("--report=")) {
      const value = arg.slice("--report=".length);
      if (!value) throw new Error("--report requires a path");
      options.reportPath = resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown pipeline smoke option: ${arg}`);
    }
  }
  return options;
}

export function checkPrerequisites({ spawn = spawnSync } = {}) {
  const git = spawn("git", ["--version"], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
  if (git.status !== 0) return { ok: false, message: "pipeline smoke requires Git; install Git and retry." };
  const pg = spawn("pnpm", ["pg:test:status"], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8", env: { ...process.env } });
  if (pg.status !== 0) {
    return { ok: false, message: "pipeline smoke requires reachable PostgreSQL; run `pnpm pg:test:up` and retry." };
  }
  return { ok: true };
}

function compactSignature(records) {
  return records
    .map((record) => [record.scenarioId, record.variant ?? "", record.workflowId, record.expectedTerminal, record.observedTerminal, record.verdict, record.wedge ?? ""].join("\u0000"))
    .sort()
    .join("\n");
}

function printTable(summary, records, write = console.log) {
  write("scenario  variant                 workflow                 expected       observed       verdict");
  for (const record of records) {
    write(`${String(record.scenarioId).padEnd(9)} ${String(record.variant ?? "-").padEnd(23)} ${String(record.workflowId).padEnd(24)} ${String(record.expectedTerminal).padEnd(14)} ${String(record.observedTerminal).padEnd(14)} ${record.verdict}`);
  }
  write(`✓ pipeline smoke: ${summary.scenarioIds.length}/${summary.expectedScenarioCount} scenarios passed in ${summary.durationMs}ms (budget ${summary.durationBudgetMs}ms)`);
}

export function runPipelineSmoke({
  spawn = spawnSync,
  now = () => Date.now(),
  prerequisite = checkPrerequisites,
  options = {},
  write = console.log,
  warn = console.warn,
} = {}) {
  const resolvedOptions = {
    allowSkip: false,
    json: false,
    repeat: 1,
    budgetMs: PIPELINE_SMOKE_DURATION_BUDGET_MS,
    reportPath: DEFAULT_REPORT_PATH,
    diagnosticBudget: false,
    ...options,
  };
  const preflight = prerequisite({ spawn });
  if (!preflight.ok) {
    if (resolvedOptions.allowSkip) {
      const skipped = { schemaVersion: 1, project: PIPELINE_SMOKE_PROJECT, skipped: true, reason: preflight.message };
      warn(`⚠ ${preflight.message}`);
      return skipped;
    }
    throw new Error(preflight.message);
  }
  if (resolvedOptions.diagnosticBudget) {
    warn(`WARNING: diagnostic --budget-ms=${resolvedOptions.budgetMs}; fix an overrun rather than widening the declared budget.`);
  }

  const reportDir = mkdtempSync(join(tmpdir(), "fusion-pipeline-smoke-report-"));
  const summaries = [];
  let baselineSignature;
  try {
    for (let iteration = 1; iteration <= resolvedOptions.repeat; iteration += 1) {
      const rawReportPath = join(reportDir, `vitest-${iteration}.json`);
      const scenarioReportPath = join(reportDir, `scenarios-${iteration}.jsonl`);
      const startedAt = now();
      const result = spawn(
        "pnpm",
        ["exec", "vitest", "run", `--project=${PIPELINE_SMOKE_PROJECT}`, "--silent=passed-only", "--reporter=dot", "--reporter=json", `--outputFile=${rawReportPath}`],
        {
          cwd: ENGINE_DIR,
          stdio: "inherit",
          env: { ...process.env, FUSION_PIPELINE_SMOKE_REPORT: scenarioReportPath },
          timeout: resolvedOptions.budgetMs + 30_000,
        },
      );
      const durationMs = now() - startedAt;
      if (result.error) throw new Error(`failed to run pipeline smoke: ${result.error.message}`);
      if (!existsSync(rawReportPath)) throw new Error("pipeline smoke produced no JSON results file; cannot verify test execution");
      if (!existsSync(scenarioReportPath)) throw new Error("pipeline smoke produced no scenario records; cannot verify declared coverage");
      const { testCount } = parsePipelineSmokeReport(readFileSync(rawReportPath, "utf8"));
      const records = parseScenarioRecords(readFileSync(scenarioReportPath, "utf8"));
      const summary = buildPipelineSmokeSummary({
        testCount,
        durationMs,
        exitCode: result.status ?? 1,
        records,
        budgetMs: resolvedOptions.budgetMs,
        repeat: resolvedOptions.repeat,
      });
      validatePipelineSmokeSummary(summary);
      const signature = compactSignature(records);
      if (baselineSignature !== undefined && signature !== baselineSignature) {
        throw new Error("pipeline smoke reproducibility failure: scenario records differ between consecutive runs");
      }
      baselineSignature = signature;
      summaries.push({ ...summary, records });
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }

  const final = { ...summaries.at(-1), runs: summaries.map(({ records: _records, ...summary }) => summary) };
  writeFileSync(resolvedOptions.reportPath, `${JSON.stringify(final, null, 2)}\n`);
  if (resolvedOptions.json) write(JSON.stringify(final));
  else printTable(final, final.records, write);
  return final;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    runPipelineSmoke({ options });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
