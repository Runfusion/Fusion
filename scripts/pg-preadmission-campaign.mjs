#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/*
FNXC:PgTestPreAdmission 2026-08-17-03:20:
FN-9139 requires pre-admission affordability evidence to be collected by one
bounded shell, so a missing operator terminal cannot turn measurement into an
unbounded handoff. The driver alternates arms and treats incomplete or invalid
samples as insufficient data instead of retrying toward a preferred outcome.
*/
export const MINIMUM_RUNS_PER_ARM = 5;
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;
export const DEFAULT_CAMPAIGN_TIMEOUT_MS = 3_600_000;

export function parseArgs(args) {
  const result = { runs: MINIMUM_RUNS_PER_ARM, scratchDir: undefined, control: undefined, candidate: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--runs") result.runs = Number(args[++i]);
    else if (value === "--scratch-dir") result.scratchDir = args[++i];
    else if (value === "--control") result.control = args[++i];
    else if (value === "--candidate") result.candidate = args[++i];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) throw new Error("--runs must be a positive integer");
  return result;
}

export function stripAnsi(text) {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

export function classifyLog(log) {
  const clean = stripAnsi(log);
  const failed = [...clean.matchAll(/^\s*Test Files\s+.*?(\d+)\s+failed\b/gim)].at(-1);
  return {
    failingFiles: failed ? Number(failed[1]) : 0,
    projectIdentityTimedOut: /project-identity\.test\.ts[\s\S]{0,500}?timed out/i.test(clean),
  };
}

export function countProbeDegradations(jsonl) {
  return jsonl.split(/\r?\n/).filter(Boolean).reduce((count, line) => {
    try {
      const row = JSON.parse(line);
      return count + (row.event === "pg-preadmission-probe" && row.outcome !== "acquired-and-released" ? 1 : 0);
    } catch { return count; }
  }, 0);
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
}

export function decideVerdict(runs, { incomplete = false } = {}) {
  const control = runs.filter((run) => run.arm === "control" && run.valid);
  const candidate = runs.filter((run) => run.arm === "candidate" && run.valid);
  const measurementsAvailable = [...control, ...candidate].every((run) => run.measurementAvailable === true && Number.isFinite(run.peakBackends));
  if (incomplete || control.length < MINIMUM_RUNS_PER_ARM || candidate.length < MINIMUM_RUNS_PER_ARM || !measurementsAvailable) return "insufficient-data";
  if (candidate.some((run) => run.probeRecords === 0 || run.probeDegradations !== 0)) return "boundary-taxing";
  const controlMaxWall = Math.max(...control.map((run) => run.wallTimeMs));
  const controlMaxFailures = Math.max(...control.map((run) => run.failingFiles));
  const controlPeak = Math.max(...control.map((run) => run.peakBackends));
  const candidateMedian = median(candidate.map((run) => run.wallTimeMs));
  const candidateMaxFailures = Math.max(...candidate.map((run) => run.failingFiles));
  const candidatePeak = Math.max(...candidate.map((run) => run.peakBackends));
  const identityWorsened = candidate.some((run) => run.projectIdentityTimedOut) && !control.some((run) => run.projectIdentityTimedOut);
  return candidateMedian <= controlMaxWall && candidateMaxFailures <= controlMaxFailures && candidatePeak <= controlPeak + 1 && !identityWorsened
    ? "boundary-affordable" : "boundary-taxing";
}

export function aggregate(runs, incomplete) {
  const summarize = (arm) => {
    const selected = runs.filter((run) => run.arm === arm);
    return { count: selected.length, medianWallTimeMs: median(selected.map((run) => run.wallTimeMs)), maxWallTimeMs: Math.max(...selected.map((run) => run.wallTimeMs), 0), maxFailingFiles: Math.max(...selected.map((run) => run.failingFiles), 0), peakBackends: Math.max(...selected.map((run) => run.peakBackends), 0) };
  };
  return { runs, control: summarize("control"), candidate: summarize("candidate"), incomplete, verdict: decideVerdict(runs, { incomplete }) };
}

export function terminateProcessGroup(child, signal, kill = process.kill) {
  if (!child.pid) return;
  try {
    kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* The process already exited. */ }
  }
}

export function campaignRunEnvironment(diagnostics) {
  return {
    FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS: "1",
    FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: diagnostics,
  };
}

export function remainingRunTimeoutMs(startedAt, now = Date.now()) {
  return Math.min(DEFAULT_RUN_TIMEOUT_MS, DEFAULT_CAMPAIGN_TIMEOUT_MS - (now - startedAt));
}

export async function runCommand(command, env, timeoutMs) {
  return await new Promise((resolveRun) => {
    const startedAt = Date.now();
    // process-supervisor-allowlist: isolation is required so the bounded campaign can kill the shell command's entire process group
    const child = spawn(command, { shell: true, detached: true, env: { ...process.env, ...env } });
    // FNXC:PgTestPreAdmission 2026-08-17-04:05:
    // The timeout owns the shell's whole process group. Killing only the shell
    // can orphan Vitest or its workers and violate both campaign deadlines.
    const samplerScript = `while kill -0 ${child.pid} 2>/dev/null; do if value=$(psql --no-password -X -Atqc 'select count(*) from pg_stat_activity;' postgres 2>/dev/null); then printf 'SAMPLE:%s\\n' "$value"; else echo SAMPLE_ERROR; exit 1; fi; sleep 1; done`;
    // process-supervisor-allowlist: the sampler shares the campaign's bounded process-group cleanup contract
    const sampler = spawn(samplerScript, { shell: true, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let sampled = "";
    let childResult;
    let samplerClosed = false;
    let samplerErrored = false;
    let timedOut = false;
    const finish = () => {
      if (!childResult || !samplerClosed) return;
      const samples = [...sampled.matchAll(/^SAMPLE:(\d+)$/gm)].map((match) => Number(match[1]));
      const measurementAvailable = !samplerErrored && !sampled.includes("SAMPLE_ERROR") && samples.length > 0;
      resolveRun({
        output,
        ...childResult,
        wallTimeMs: Date.now() - startedAt,
        peakBackends: measurementAvailable ? Math.max(...samples) : null,
        measurementAvailable,
        timedOut,
      });
    };
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    sampler.stdout.on("data", (chunk) => { sampled += chunk; });
    sampler.once("error", () => { samplerErrored = true; samplerClosed = true; finish(); });
    sampler.once("close", () => { samplerClosed = true; finish(); });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      terminateProcessGroup(child, "SIGKILL");
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      childResult = { code, signal };
      terminateProcessGroup(sampler, "SIGTERM");
      terminateProcessGroup(sampler, "SIGKILL");
      finish();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.control || !args.candidate) throw new Error("Supply --control and --candidate commands");
  const scratch = resolve(args.scratchDir ?? join(tmpdir(), `fusion-pg-preadmission-${process.pid}`));
  mkdirSync(scratch, { recursive: true });
  const startedAt = Date.now();
  const results = [];
  let incomplete = false;
  for (let index = 0; index < args.runs * 2; index += 1) {
    const runTimeoutMs = remainingRunTimeoutMs(startedAt);
    if (runTimeoutMs <= 0) { incomplete = true; break; }
    const arm = index % 2 === 0 ? "control" : "candidate";
    const diagnostics = join(scratch, `${String(index + 1).padStart(2, "0")}-${arm}.jsonl`);
    // FNXC:PgTestPreAdmission 2026-08-17-04:05:
    // Diagnostics must be explicitly enabled, and an arm may consume only the
    // smaller of its five-minute allowance and the campaign's remaining time.
    const result = await runCommand(
      arm === "control" ? args.control : args.candidate,
      campaignRunEnvironment(diagnostics),
      runTimeoutMs,
    );
    const logPath = join(scratch, `${String(index + 1).padStart(2, "0")}-${arm}.log`);
    writeFileSync(logPath, result.output);
    const parsed = classifyLog(result.output);
    const jsonl = (() => { try { return readFileSync(diagnostics, "utf8"); } catch { return ""; } })();
    const probeRecords = [...jsonl.matchAll(/"event":"pg-preadmission-probe"/g)].length;
    // FNXC:PgTestPreAdmission 2026-08-17-03:38:
    // FN-9139's affordability verdict must retain the sampler's observed peak.
    // Replacing it would falsely certify a candidate whose extra backend exceeds
    // the one-connection observation-only footprint.
    results.push({ arm, ...result, ...parsed, probeRecords, probeDegradations: arm === "control" ? null : countProbeDegradations(jsonl), valid: !result.timedOut && result.signal === null && result.measurementAvailable && (arm === "control" || probeRecords > 0) });
    if (result.timedOut || Date.now() - startedAt >= DEFAULT_CAMPAIGN_TIMEOUT_MS) { incomplete = true; break; }
  }
  const report = aggregate(results, incomplete);
  writeFileSync(join(scratch, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, scratchDir: scratch }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
