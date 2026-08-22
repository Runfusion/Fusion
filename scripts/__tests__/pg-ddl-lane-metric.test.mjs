import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_RUNS_PER_LANE,
  decideVerdict,
  extractWallTimeMs,
  orderStatistics,
  parseDiagnosticsJsonl,
  summarizeRun,
} from "../pg-ddl-lane-metric.mjs";

const log = (duration, failures = 0) => ` Test Files  ${failures ? `${failures} failed` : "1 passed"}\n Tests  ${failures ? `${failures} failed` : "1 passed"}\n Duration  ${duration}s\n`;
const run = (label, wallTimeMs, leaks = 0) => ({ label, wallTimeMs, leaks, green: true });
const interleave = (controls, candidates) => controls.flatMap((control, index) => [control, candidates[index]]);

test("parses valid diagnostics while ignoring malformed and incomplete rows", () => {
  const rows = parseDiagnosticsJsonl(`${JSON.stringify({ phase: "dropDatabase", trigger: "phase-complete", phaseDurationsMs: { dropDatabase: 40 } })}\nnot-json\n${JSON.stringify({ phase: "dropDatabase", trigger: "phase-watchdog", phaseIncomplete: true, phaseDurationsMs: { dropDatabase: 2000 } })}\n`);
  const summary = summarizeRun({ label: "control", diagnostics: rows, log: log(12.5) });
  assert.equal(rows.length, 2);
  assert.equal(summary.wallTimeMs, 12_500);
  assert.equal(summary.watchdogs, 1);
  assert.deepEqual(summary.dropDatabase, { count: 1, median: 40, p95: 40, max: 40 });
  assert.equal(summarizeRun({ label: "control", log: "migration: 1 failed verification\n Tests 1 failed" }).green, false);
});

test("requires affirmative green runner summaries", () => {
  assert.equal(summarizeRun({ label: "control", log: "No test files found, exiting with code 1\nDuration  1s" }).green, false);
  assert.equal(summarizeRun({ label: "control", log: `${log(1)} Errors  1 error\n` }).green, false);
  assert.equal(summarizeRun({ label: "control", log: `${log(1)} Unhandled Errors\n` }).green, false);
  assert.equal(summarizeRun({ label: "control", log: log(1) }).green, true);
});

test("extracts runner wall time and computes nearest-rank statistics", () => {
  assert.equal(extractWallTimeMs("\u001b[2m Duration \u001b[22m 1m 02s\nDuration  123.4s"), 123_400);
  assert.equal(extractWallTimeMs("Duration  1m 02s"), 62_000);
  assert.deepEqual(orderStatistics([8, 1, 4, 2]), { count: 4, median: 2, p95: 8, max: 8 });
});

test("requires the preregistered repetition floor", () => {
  const partial = Array.from({ length: MINIMUM_RUNS_PER_LANE - 1 }, () => run("control", 100_000));
  assert.equal(decideVerdict([...partial, ...partial.map((item) => ({ ...item, label: "candidate" }))]), "insufficient-data");
});

test("requires interleaved control/candidate pairs", () => {
  const controls = Array.from({ length: MINIMUM_RUNS_PER_LANE }, () => run("control", 120_000));
  const candidates = Array.from({ length: MINIMUM_RUNS_PER_LANE }, () => run("candidate", 90_000));
  assert.equal(decideVerdict([...controls, ...candidates]), "no-improvement");
  assert.equal(decideVerdict(interleave(controls, candidates)), "improved");
});

test("rejects any recorded leak regardless of timing", () => {
  const controls = Array.from({ length: MINIMUM_RUNS_PER_LANE }, () => run("control", 120_000));
  const candidates = Array.from({ length: MINIMUM_RUNS_PER_LANE }, () => run("candidate", 100_000));
  candidates[0] = { ...candidates[0], leaks: 1 };
  assert.equal(decideVerdict(interleave(controls, candidates)), "no-improvement");
});

test("does not call FN-9130-shaped noisy samples an improvement", () => {
  const controls = [105_100, 118_100, 120_900, 122_100, 124_600, 114_300, 118_100].map((wallTimeMs) => run("control", wallTimeMs));
  const candidates = [105_100, 114_300, 118_100, 120_900, 122_100, 124_600, 118_100].map((wallTimeMs) => run("candidate", wallTimeMs));
  assert.equal(decideVerdict(interleave(controls, candidates)), "no-improvement");
});
