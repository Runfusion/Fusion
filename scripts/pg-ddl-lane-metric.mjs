#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/*
FNXC:PgDdlLaneMetric 2026-08-17-00:59:
FN-9130 showed that inline DROP DATABASE watchdog counts vary too widely on
unchanged code to judge a structural remedy. This parser is report-only: it
reads already-captured runner/diagnostic files and never opens PostgreSQL or
changes test execution. The acceptance band is derived from interleaved control
runs so moving work out of a teardown hook cannot masquerade as an improvement.

FNXC:PgDdlLaneMetric 2026-08-17-03:14:
The acceptance verdict requires ordered control/candidate pairs and affirmative
Vitest pass summaries without runner or unhandled errors. Grouped lanes and
failed or empty runs must never satisfy the timing band.
*/

export const MINIMUM_RUNS_PER_LANE = 7;

export function parseDiagnosticsJsonl(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row && typeof row === "object" ? [row] : [];
    } catch {
      return [];
    }
  });
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function orderStatistics(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

export function stripAnsi(text) {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

export function extractWallTimeMs(log) {
  const matches = [...stripAnsi(log).matchAll(/Duration\s+(?:(\d+(?:\.\d+)?)\s*m\s*)?(\d+(?:\.\d+)?)\s*(ms|s)/gi)];
  const match = matches.at(-1);
  if (!match) return null;
  const minutes = match[1] == null ? 0 : Number(match[1]);
  const duration = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(duration)) return null;
  return Math.round(minutes * 60_000 + (match[3].toLowerCase() === "s" ? duration * 1_000 : duration));
}

export function summarizeRun({ label, diagnostics = [], log = "", leaks = 0 }) {
  const dropRecords = diagnostics.filter((row) => row.phase === "dropDatabase");
  // Completed durations and watchdog snapshots are different descriptive series.
  const durations = dropRecords
    .filter((row) => row.trigger === "phase-complete")
    .map((row) => Number(row.phaseDurationsMs?.dropDatabase))
    .filter(Number.isFinite);
  const watchdogs = dropRecords.filter((row) => row.trigger === "phase-watchdog" || row.phaseIncomplete).length;
  const cleanLog = stripAnsi(log);
  const hasPassingFiles = /^\s*Test Files\s+.*\b[1-9]\d*\s+passed\b/im.test(cleanLog);
  const hasPassingTests = /^\s*Tests\s+.*\b[1-9]\d*\s+passed\b/im.test(cleanLog);
  const hasFailure =
    /^\s*(?:Test Files|Tests)\s+.*\b[1-9]\d*\s+failed\b/im.test(cleanLog) ||
    /^\s*Errors?\s+.*\b[1-9]\d*\s+errors?\b/im.test(cleanLog) ||
    /\bUnhandled Errors?\b/i.test(cleanLog) ||
    /\bNo test files found\b/i.test(cleanLog) ||
    /\bexiting with code\s+[1-9]\d*\b/i.test(cleanLog);
  return {
    label,
    wallTimeMs: extractWallTimeMs(cleanLog),
    green: hasPassingFiles && hasPassingTests && !hasFailure,
    leaks: Number.isInteger(leaks) && leaks >= 0 ? leaks : 0,
    watchdogs,
    degradationCount: diagnostics.filter((row) => row.trigger === "teardown-watchdog").length,
    dropDatabase: orderStatistics(durations),
  };
}

function hasAlternatingPairs(runs) {
  return runs.length % 2 === 0 && runs.every((run, index) => run.label === (index % 2 === 0 ? "control" : "candidate"));
}

export function decideVerdict(runs) {
  const control = runs.filter((run) => run.label === "control");
  const candidate = runs.filter((run) => run.label === "candidate");
  if (control.length < MINIMUM_RUNS_PER_LANE || candidate.length < MINIMUM_RUNS_PER_LANE) return "insufficient-data";
  if (!hasAlternatingPairs(runs)) return "no-improvement";
  if (runs.some((run) => !run.green || run.leaks !== 0 || run.wallTimeMs == null)) return "no-improvement";
  const controlWalls = control.map((run) => run.wallTimeMs);
  const candidateWalls = candidate.map((run) => run.wallTimeMs);
  const controlMedian = percentile(controlWalls, 0.5);
  const controlLowerQuartile = percentile(controlWalls, 0.25);
  const candidateMedian = percentile(candidateWalls, 0.5);
  const candidateWorst = Math.max(...candidateWalls);
  return candidateMedian < controlLowerQuartile && candidateWorst <= controlMedian ? "improved" : "no-improvement";
}

function parseRunArgument(argument) {
  const [label, diagnosticsPath, logPath, leaks = "0"] = argument.split(":");
  if (!(["control", "candidate"].includes(label) && diagnosticsPath && logPath && /^\d+$/.test(leaks))) {
    throw new Error("Expected --run <control|candidate>:<diagnostics.jsonl>:<runner.log>:<leaks>");
  }
  return summarizeRun({
    label,
    diagnostics: parseDiagnosticsJsonl(readFileSync(diagnosticsPath, "utf8")),
    log: readFileSync(logPath, "utf8"),
    leaks: Number(leaks),
  });
}

export function report(runs) {
  const byLane = (label) => runs.filter((run) => run.label === label);
  return {
    runs,
    control: orderStatistics(byLane("control").map((run) => run.wallTimeMs).filter(Number.isFinite)),
    candidate: orderStatistics(byLane("candidate").map((run) => run.wallTimeMs).filter(Number.isFinite)),
    verdict: decideVerdict(runs),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const runArguments = args.filter((value, index) => args[index - 1] === "--run");
  if (runArguments.length === 0) throw new Error("Supply one or more --run arguments");
  console.log(JSON.stringify(report(runArguments.map(parseRunArgument)), null, 2));
}
