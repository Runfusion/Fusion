#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const BOUNDARIES = ["global-setup", "setup-top-level-await", "setup-before-all", "per-file-before-all"];
export const ARMS = ["A", "B", "C", "R"];
const DIAGNOSTIC_LIMIT = 4000;

/*
FNXC:PgSetupBoundaryProbe 2026-08-17-23:40:
FN-9140 replaces stdout scraping and one-shot, non-falsifying observations with an append-only
ledger, repeated fixture-local budget arms, and calibration. Parent and fork clocks have different
monotonic origins, so only same-pid ordering uses monotonicNs; cross-pid ordering requires an epoch
separation margin. SMALL and LARGE are measurement parameters written only to the temp fixture.
*/
export function deriveBudgets(delayMs) {
  return { D: delayMs, SMALL: Math.floor(delayMs / 4), LARGE: delayMs * 5 };
}

export function parseProbeArgs(argv) {
  const result = { workers: 2, files: 6, repeats: 3, isolate: "both", delayMs: 4000, orderingMarginMs: 50, json: undefined, runTimeoutMs: undefined };
  const names = new Map([["--workers", "workers"], ["--files", "files"], ["--repeats", "repeats"], ["--delay-ms", "delayMs"], ["--ordering-margin-ms", "orderingMarginMs"], ["--run-timeout-ms", "runTimeoutMs"]]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--json") { result.json = argv[++index]; if (!result.json) throw new Error("--json requires a path"); continue; }
    if (arg === "--isolate") { result.isolate = argv[++index]; if (!["both", "true", "false"].includes(result.isolate)) throw new Error("--isolate must be both, true, or false"); continue; }
    const name = names.get(arg);
    if (!name) throw new Error(`Unknown argument: ${arg}`);
    const value = Number(argv[++index]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${arg} must be a positive integer`);
    result[name] = value;
  }
  if (result.files <= result.workers) throw new Error("indeterminate configuration: --files must be strictly greater than --workers");
  const budgets = deriveBudgets(result.delayMs);
  if (budgets.SMALL >= budgets.D || budgets.LARGE <= budgets.D) throw new Error("delay does not produce discriminating budgets");
  result.runTimeoutMs ??= Math.max(60_000, budgets.LARGE + result.delayMs * result.files + 30_000);
  return result;
}

/** Parse append-only JSONL, intentionally ignoring an interrupted final write. */
export function parseLedger(text) {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || !Number.isFinite(event.pid) || !Number.isFinite(event.epochMs) || typeof event.monotonicNs !== "string") return [];
      return [{ ...event, ledgerIndex: index }];
    } catch { return []; }
  });
}

function eventDuration(events, boundary) {
  const start = events.find((event) => event.type === "boundary" && event.boundary === boundary && event.phase === "start");
  const end = events.find((event) => event.type === "boundary" && event.boundary === boundary && event.phase === "end" && event.pid === start?.pid && event.file === start?.file);
  return start && end ? end.epochMs - start.epochMs : null;
}

export function summarizeLedger(boundary, events, { files, orderingMarginMs }) {
  const starts = events.filter((event) => event.type === "boundary" && event.boundary === boundary && event.phase === "start");
  const pairs = new Set(starts.map((event) => `${event.pid}:${event.file ?? ""}`));
  const pidCount = new Set(starts.map((event) => event.pid)).size;
  const fileCount = new Set(starts.map((event) => event.file).filter(Boolean)).size;
  /*
  FNXC:PgSetupBoundaryProbe 2026-08-17-05:34:
  A setup-file callback can be evaluated repeatedly in one worker. Without a test-file identity,
  pid/file pairs cannot distinguish that from worker-scoped setup, even when PIDs are recycled.
  */
  const hasFileIdentity = starts.every((event) => typeof event.file === "string" && event.file.length > 0);
  const granularity = starts.length === 1 ? "per invocation"
    : !hasFileIdentity ? "indeterminate"
      : pairs.size === files && fileCount === files ? "per file"
        : pairs.size === pidCount ? "per worker"
          : "indeterminate";
  const tests = events.filter((event) => event.type === "test" && event.phase === "start");
  let ordering = "not-observed";
  if (starts.length && tests.length) {
    const last = starts.toSorted((a, b) => a.pid === b.pid ? Number(BigInt(a.monotonicNs) - BigInt(b.monotonicNs)) : a.epochMs - b.epochMs).at(-1);
    const first = tests.toSorted((a, b) => a.pid === b.pid ? Number(BigInt(a.monotonicNs) - BigInt(b.monotonicNs)) : a.epochMs - b.epochMs)[0];
    if (last.pid === first.pid) ordering = BigInt(last.monotonicNs) < BigInt(first.monotonicNs) ? "before-first-test" : "after-first-test";
    else if (Math.abs(first.epochMs - last.epochMs) < orderingMarginMs) ordering = "indeterminate";
    else ordering = last.epochMs < first.epochMs ? "before-first-test" : "after-first-test";
  }
  return { boundary, executions: starts.length, distinctPidFiles: pairs.size, workersObserved: pidCount, filesObserved: fileCount, granularity, ordering, durationMs: eventDuration(events, boundary) };
}

function excerpt(output) { return output.slice(-DIAGNOSTIC_LIMIT); }
export function classifyArm({ exitCode, output = "", events = [], boundary, delayMs, timedOut = false }) {
  if (timedOut) return { outcome: "run-timeout" };
  const summary = summarizeLedger(boundary, events, { files: Number.MAX_SAFE_INTEGER, orderingMarginMs: 1 });
  if (exitCode === 0) {
    if (summary.durationMs == null || summary.durationMs < delayMs * 0.9) return { outcome: "failed-unclassified", diagnostic: "boundary end missing or duration below tolerance" };
    return { outcome: "passed", durationMs: summary.durationMs };
  }
  if (/Test timed out in \d+ms\./i.test(output)) return { outcome: "timed-out-test" };
  if (/Hook timed out in \d+ms\./i.test(output)) return { outcome: "timed-out-hook" };
  return { outcome: "failed-unclassified", diagnostic: excerpt(output) };
}

export function resolveOwnership(arms) {
  const A = arms.A?.outcome; const B = arms.B?.outcome; const C = arms.C?.outcome; const R = arms.R?.outcome;
  if ([A, B, C, R].some((outcome) => outcome === "run-timeout")) return "run-timeout";
  if ([A, B, C, R].some((outcome) => outcome === "failed-unclassified")) return "failed-unclassified";
  if (A === "passed" && R === "passed" && B === "passed" && C === "passed") return "off-budget";
  if (A === "timed-out-test" && B === "timed-out-test" && C === "passed" && R === "passed") return "test-timeout";
  if (A === "timed-out-hook" && C === "timed-out-hook" && B === "passed" && R === "passed") return "hook-timeout";
  if (A !== "passed" && B === "timed-out-test" && C === "timed-out-hook" && R === "passed") return "both-budgets";
  // Arm R alone is an intentionally inconclusive calibration observation, never a survey fact.
  if (A === undefined && B === undefined && C === undefined && R === "passed") return "completed-within-budget";
  return "failed-unclassified";
}

/*
FNXC:PgSetupBoundaryProbe 2026-08-17-05:12:
FN-9140's qualifying off-budget evidence belongs to arm A, not the last arm executed. Preserve every
arm summary and require it to agree across repeats so an after-test A observation or arm-level flap
cannot be masked by a stable reference arm.
*/
export function summarizeRepeats(boundary, repeats) {
  const values = repeats.map((repeat) => ({
    ownership: repeat.ownership,
    arms: Object.fromEntries(ARMS.map((arm) => [arm, repeat.arms[arm]?.outcome])),
    summaries: Object.fromEntries(ARMS.map((arm) => [arm, {
      ordering: repeat.summaries[arm]?.ordering,
      granularity: repeat.summaries[arm]?.granularity,
    }])),
  }));
  const deterministic = values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
  const evidence = values[0]?.summaries.A;
  return {
    boundary,
    repeats,
    deterministic,
    ownership: deterministic ? values[0]?.ownership : "failed-unclassified",
    ordering: deterministic ? evidence?.ordering : "indeterminate",
    granularity: deterministic ? evidence?.granularity : "indeterminate",
  };
}

export function decideSurveyVerdict({ calibration, cells }) {
  if (calibration !== "passed") return "insufficient-data";
  if (cells.some((cell) => !cell.deterministic || ["failed-unclassified", "run-timeout"].includes(cell.ownership) || cell.ordering === "indeterminate")) return "insufficient-data";
  return cells.some((cell) => cell.ownership === "off-budget" && cell.ordering === "before-first-test") ? "prerequisite-established" : "prerequisite-not-established";
}

export function fixtureFiles({ boundary, arm, options, ledgerPath, vitestApiUrl, control }) {
  const budgets = deriveBudgets(options.delayMs);
  const budget = arm === "A" ? [budgets.SMALL, budgets.SMALL] : arm === "B" ? [budgets.SMALL, budgets.LARGE] : arm === "C" ? [budgets.LARGE, budgets.SMALL] : [budgets.LARGE, budgets.LARGE];
  const emit = (type, name, phase, fileExpression = '""') => `appendFileSync(process.env.FUSION_BOUNDARY_LEDGER, JSON.stringify({type:${JSON.stringify(type)},boundary:${JSON.stringify(name)},phase:${JSON.stringify(phase)},pid:process.pid,file:${fileExpression},isolate:${JSON.stringify(String(options.isolate))},arm:${JSON.stringify(arm)},epochMs:Date.now(),monotonicNs:process.hrtime.bigint().toString()})+'\\n');`;
  const sleep = `await new Promise(resolve => setTimeout(resolve, ${options.delayMs}));`;
  const boundaryBody = (fileExpression) => `${emit("boundary", boundary, "start", fileExpression)} ${sleep} ${emit("boundary", boundary, "end", fileExpression)}`;
  const testBody = control === "test" ? `${emit("boundary", "control-test", "start")} ${sleep} ${emit("boundary", "control-test", "end")}` : "";
  const config = `export default { test: { include:["tests/**/*.test.mjs"], pool:"forks", isolate:${options.isolate}, maxWorkers:${options.workers}, minWorkers:${options.workers}, fileParallelism:true, testTimeout:${budget[0]}, hookTimeout:${budget[1]}, setupFiles:["./setup.mjs"]${boundary === "global-setup" ? ',globalSetup:["./global-setup.mjs"]' : ""} } };\n`;
  /*
  FNXC:PgSetupBoundaryProbe 2026-08-17-05:34:
  FN-9140 must not infer per-file setup execution from worker PIDs. beforeAll can read Vitest's
  active test path; top-level setup has no supported file context and is deliberately indeterminate.
  */
  const setup = `import { appendFileSync } from "node:fs"; import { beforeAll, expect } from ${JSON.stringify(vitestApiUrl)}; ${boundary === "setup-top-level-await" ? boundaryBody() : ""} ${boundary === "setup-before-all" || control === "hook" ? `beforeAll(async()=>{${control === "hook" ? `${emit("boundary", "control-hook", "start")} ${sleep} ${emit("boundary", "control-hook", "end")}` : boundaryBody('expect.getState().testPath ?? ""')}});` : ""}`;
  const global = `import { appendFileSync } from "node:fs"; export default async function(){ ${boundary === "global-setup" ? boundaryBody() : ""} }`;
  const files = { "vitest.config.mjs": config, "setup.mjs": setup, "global-setup.mjs": global };
  for (let index = 0; index < options.files; index += 1) files[`tests/${index}.test.mjs`] = `import { appendFileSync } from "node:fs"; import { beforeAll,test } from ${JSON.stringify(vitestApiUrl)}; ${boundary === "per-file-before-all" ? `beforeAll(async()=>{${boundaryBody(JSON.stringify(String(index)))}});` : ""} test(${JSON.stringify(String(index))}, async()=>{${testBody} ${emit("test", "test", "start", JSON.stringify(String(index)))} ${emit("test", "test", "end", JSON.stringify(String(index)))}});`;
  return files;
}

function writeFixture(directory, files) { for (const [file, content] of Object.entries(files)) { const target = join(directory, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); } }
function vitestEntry() { return join(dirname(require.resolve("vitest", { paths: [resolve(process.cwd(), "packages/core")] })), "vitest.mjs"); }

export function resolveVitestRunner(resolveEntry = vitestEntry) {
  try {
    const entry = resolveEntry();
    return { entry, vitestVersion: JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version };
  } catch (error) {
    return { entry: undefined, vitestVersion: "unresolvable", resolutionError: error instanceof Error ? error.message : String(error) };
  }
}

export async function runFixtureCell({ boundary, arm, options, control, runner = resolveVitestRunner() }) {
  const directory = mkdtempSync(join(tmpdir(), "fusion-pg-setup-boundary-")); const ledgerPath = join(directory, "ledger.jsonl");
  try {
    if (!runner.entry) {
      const run = { exitCode: 1, output: `Vitest resolution failed: ${runner.resolutionError}`, timedOut: false, events: [] };
      return { ...run, arm: classifyArm({ ...run, boundary: control ? `control-${control}` : boundary, delayMs: options.delayMs }) };
    }
    try {
      const api = pathToFileURL(join(dirname(runner.entry), "dist", "index.js")).href;
      writeFixture(directory, fixtureFiles({ boundary, arm, options, ledgerPath, vitestApiUrl: api, control }));
      const run = await new Promise((done) => {
        const child = spawn(process.execPath, [runner.entry, "run", "--config", "vitest.config.mjs", "--reporter=verbose"], { cwd: directory, env: { ...process.env, FUSION_BOUNDARY_LEDGER: ledgerPath }, stdio: ["ignore", "pipe", "pipe"] }); let output = ""; let timedOut = false;
        child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
        child.once("error", (error) => { output += `Vitest spawn failed: ${error.message}`; });
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.runTimeoutMs);
        child.on("close", (exitCode) => { clearTimeout(timer); done({ exitCode: exitCode ?? 1, output, timedOut }); });
      });
      let events = [];
      try { events = parseLedger(readFileSync(ledgerPath, "utf8")); } catch { /* A setup failure may occur before the first ledger append. */ }
      return { ...run, events, arm: classifyArm({ ...run, events, boundary: control ? `control-${control}` : boundary, delayMs: options.delayMs }) };
    } catch (error) {
      const run = { exitCode: 1, output: `Vitest fixture failed: ${error instanceof Error ? error.message : String(error)}`, timedOut: false, events: [] };
      return { ...run, arm: classifyArm({ ...run, boundary: control ? `control-${control}` : boundary, delayMs: options.delayMs }) };
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function runSurvey(options, runner = resolveVitestRunner()) {
  const budgets = deriveBudgets(options.delayMs); const isolateModes = options.isolate === "both" ? [true, false] : [options.isolate === "true"];
  const calibrationResults = [];
  for (const [control, arm, expected] of [["hook", "C", "hook-timeout"], ["test", "B", "test-timeout"], ["test", "R", "completed-within-budget"]]) {
    const run = await runFixtureCell({ boundary: "setup-before-all", arm, options: { ...options, isolate: true }, control, runner });
    const outcome = control === "test" && arm === "R" && run.arm.outcome === "passed" ? "completed-within-budget" : run.arm.outcome === "timed-out-hook" ? "hook-timeout" : run.arm.outcome === "timed-out-test" ? "test-timeout" : run.arm.outcome;
    calibrationResults.push({ control, arm, expected, actual: outcome });
  }
  const calibration = calibrationResults.every((row) => row.actual === row.expected) ? "passed" : "failed";
  const cells = [];
  for (const isolate of isolateModes) for (const boundary of BOUNDARIES) {
    const repeats = [];
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      const arms = {}; const summaries = {};
      for (const arm of ARMS) {
        const run = await runFixtureCell({ boundary, arm, options: { ...options, isolate }, runner });
        arms[arm] = run.arm;
        summaries[arm] = summarizeLedger(boundary, run.events, options);
      }
      repeats.push({ repeat, arms, summaries, ownership: resolveOwnership(arms) });
    }
    cells.push({ isolate, ...summarizeRepeats(boundary, repeats) });
  }
  return { vitestVersion: runner.vitestVersion, nodeVersion: process.version, pool: "forks", isolateModes, workers: options.workers, files: options.files, repeats: options.repeats, budgetMatrix: { ...budgets, orderingMarginMs: options.orderingMarginMs, runTimeoutMs: options.runTimeoutMs }, calibration, calibrationFailureReason: calibration === "failed" ? "classifier-uncalibrated" : undefined, runnerResolutionError: runner.resolutionError, calibrationResults, cells, verdict: decideSurveyVerdict({ calibration, cells }) };
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2));
  if (options.help) return console.log("Usage: node scripts/pg-setup-boundary-probe.mjs --workers 2 --files 6 --repeats 3 --delay-ms 4000 [--json path]");
  const isolateModes = options.isolate === "both" ? [true, false] : [options.isolate === "true"];
  console.log(`[pg-setup-boundary-probe] per-cell bound ${options.runTimeoutMs}ms; total bounded cells ${(3 + BOUNDARIES.length * isolateModes.length * ARMS.length) * options.repeats}`);
  const report = await runSurvey(options);
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`[pg-setup-boundary-probe] ${error.message}`); process.exitCode = 1; });
