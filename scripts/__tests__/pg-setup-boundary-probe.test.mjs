import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import {
  classifyArm,
  decideSurveyVerdict,
  deriveBudgets,
  fixtureFiles,
  parseLedger,
  parseProbeArgs,
  resolveOwnership,
  resolveVitestRunner,
  runFixtureCell,
  runSurvey,
  summarizeLedger,
  summarizeRepeats,
} from "../pg-setup-boundary-probe.mjs";

const event = (overrides = {}) => ({ type: "boundary", boundary: "sample", phase: "start", pid: 1, file: "one", epochMs: 1000, monotonicNs: "100", ...overrides });
const options = { workers: 2, files: 6, repeats: 3, isolate: true, delayMs: 4000, orderingMarginMs: 50, runTimeoutMs: 60_000 };

/*
FNXC:PgSetupBoundaryProbe 2026-08-17-23:40:
FN-9140 keeps survey verification connectionless by using synthetic ledgers for ownership and
ordering. The opt-in smoke is the only test that starts Vitest, so normal script checks remain fast.
*/
test("arguments derive a discriminating matrix and reject undecidable file/worker counts", () => {
  assert.deepEqual(deriveBudgets(4000), { D: 4000, SMALL: 1000, LARGE: 20000 });
  assert.deepEqual(parseProbeArgs([]), { ...options, isolate: "both", json: undefined, runTimeoutMs: 74_000 });
  assert.throws(() => parseProbeArgs(["--files", "2", "--workers", "2"]), /indeterminate configuration/);
  assert.throws(() => parseProbeArgs(["--isolate", "maybe"]), /isolate/);
});

test("ledger parser ignores malformed or truncated final records", () => {
  const text = `${JSON.stringify(event())}\n{"type":"boundary"`;
  assert.deepEqual(parseLedger(text), [{ ...event(), ledgerIndex: 0 }]);
});

test("ledger granularity distinguishes worker and file execution with six files", () => {
  const workerEvents = ["0", "1"].flatMap((file, pid) => [event({ pid: pid + 1, file }), event({ pid: pid + 1, file, phase: "end", epochMs: 5000, monotonicNs: "500" })]);
  assert.equal(summarizeLedger("sample", workerEvents, options).granularity, "per worker");
  const fileEvents = Array.from({ length: 6 }, (_, index) => event({ pid: index % 2 + 1, file: String(index) }));
  assert.equal(summarizeLedger("sample", fileEvents, options).granularity, "per file");
});

test("setup-file granularity requires a real test-file identity across worker lifecycles", () => {
  /*
  FNXC:PgSetupBoundaryProbe 2026-08-17-05:34:
  Persistent workers can execute several files; each setup callback must retain the active path.
  */
  const persistentWorkers = [event({ pid: 1, file: "a.test.mjs" }), event({ pid: 1, file: "b.test.mjs" }), event({ pid: 2, file: "c.test.mjs" })];
  assert.equal(summarizeLedger("sample", persistentWorkers, { ...options, files: 3 }).granularity, "per file");
  /*
  FNXC:PgSetupBoundaryProbe 2026-08-17-05:34:
  Recycled workers may produce as many PIDs as files. Empty setup-file paths must not fake per-file proof.
  */
  const recycledWorkers = [event({ pid: 11, file: "" }), event({ pid: 12, file: "" }), event({ pid: 13, file: "" })];
  assert.equal(summarizeLedger("sample", recycledWorkers, { ...options, files: 3 }).granularity, "indeterminate");
});

test("ordering uses same-process monotonic time and cross-process epoch margin", () => {
  const samePid = [event(), event({ type: "test", boundary: "test", pid: 1, phase: "start", monotonicNs: "200", epochMs: 900 })];
  assert.equal(summarizeLedger("sample", samePid, options).ordering, "before-first-test");
  const near = [event({ pid: 1, epochMs: 1000 }), event({ type: "test", boundary: "test", pid: 2, phase: "start", epochMs: 1020, monotonicNs: "1" })];
  assert.equal(summarizeLedger("sample", near, options).ordering, "indeterminate");
  const before = [event({ pid: 1, epochMs: 1000 }), event({ type: "test", boundary: "test", pid: 2, phase: "start", epochMs: 1100, monotonicNs: "1" })];
  assert.equal(summarizeLedger("sample", before, options).ordering, "before-first-test");
  assert.equal(summarizeLedger("sample", [event()], options).ordering, "not-observed");
});

test("unrecognized failures retain their diagnostic and never become off-budget", () => {
  const result = classifyArm({ exitCode: 1, output: "Error: unrelated fixture failure", events: [], boundary: "sample", delayMs: 4000 });
  assert.deepEqual(result, { outcome: "failed-unclassified", diagnostic: "Error: unrelated fixture failure" });
  assert.equal(resolveOwnership({ A: result, B: { outcome: "passed" }, C: { outcome: "passed" }, R: { outcome: "passed" } }), "failed-unclassified");
});

test("only a duration-verified both-small pass establishes falsifying off-budget evidence", () => {
  const passed = { outcome: "passed" };
  assert.equal(resolveOwnership({ A: { outcome: "timed-out-test" }, B: passed, C: passed, R: passed }), "failed-unclassified");
  assert.equal(resolveOwnership({ R: passed }), "completed-within-budget");
  assert.equal(resolveOwnership({ A: passed, B: passed, C: passed, R: passed }), "off-budget");
  const short = classifyArm({ exitCode: 0, events: [event(), event({ phase: "end", epochMs: 2000, monotonicNs: "200" })], boundary: "sample", delayMs: 4000 });
  assert.equal(short.outcome, "failed-unclassified");
  assert.equal(resolveOwnership({ A: passed, B: { outcome: "timed-out-test" }, C: passed, R: passed }), "failed-unclassified");
});

test("repeat disagreement, bad calibration, and indeterminate ordering force insufficient data", () => {
  const stable = {
    ownership: "off-budget",
    arms: { A: { outcome: "passed" }, B: { outcome: "passed" }, C: { outcome: "passed" }, R: { outcome: "passed" } },
    summaries: Object.fromEntries(["A", "B", "C", "R"].map((arm) => [arm, { ordering: "before-first-test", granularity: "per worker", durationMs: 4000 }])),
  };
  const flapping = summarizeRepeats("sample", [stable, { ...stable, ownership: "test-timeout" }]);
  assert.equal(flapping.deterministic, false);
  assert.equal(decideSurveyVerdict({ calibration: "passed", cells: [flapping] }), "insufficient-data");
  assert.equal(decideSurveyVerdict({ calibration: "failed", cells: [{ ...stable, deterministic: true, ordering: "before-first-test", ownership: "off-budget" }] }), "insufficient-data");
  assert.equal(decideSurveyVerdict({ calibration: "passed", cells: [{ ...stable, deterministic: true, ordering: "indeterminate", ownership: "off-budget" }] }), "insufficient-data");
  assert.equal(decideSurveyVerdict({ calibration: "passed", cells: [{ ...stable, deterministic: true, ordering: "after-first-test", ownership: "completed-within-budget" }] }), "prerequisite-not-established");
  assert.equal(decideSurveyVerdict({ calibration: "passed", cells: [{ ...stable, deterministic: true, ordering: "before-first-test", ownership: "off-budget" }] }), "prerequisite-established");
});

test("arm-level ordering and outcomes must agree across repeats", () => {
  const repeat = {
    ownership: "off-budget",
    arms: { A: { outcome: "passed" }, B: { outcome: "passed" }, C: { outcome: "passed" }, R: { outcome: "passed" } },
    summaries: Object.fromEntries(["A", "B", "C", "R"].map((arm) => [arm, { ordering: "before-first-test", granularity: "per invocation", durationMs: 4000 }])),
  };
  const aAfterTest = JSON.parse(JSON.stringify(repeat));
  aAfterTest.summaries.A.ordering = "after-first-test";
  const armFlap = JSON.parse(JSON.stringify(repeat));
  armFlap.arms.B.outcome = "timed-out-test";
  assert.equal(summarizeRepeats("sample", [repeat, aAfterTest]).deterministic, false);
  assert.equal(summarizeRepeats("sample", [repeat, armFlap]).deterministic, false);
});

test("fixture-local config contains derived budgets and survey remains repository-inert", () => {
  const fixture = fixtureFiles({ boundary: "setup-top-level-await", arm: "A", options, ledgerPath: "/tmp/ledger", vitestApiUrl: "vitest", control: undefined });
  assert.match(fixture["vitest.config.mjs"], /testTimeout:1000/);
  assert.match(fixture["vitest.config.mjs"], /hookTimeout:1000/);
  const perFileFixture = fixtureFiles({ boundary: "setup-before-all", arm: "A", options, ledgerPath: "/tmp/ledger", vitestApiUrl: "vitest", control: undefined });
  assert.match(perFileFixture["setup.mjs"], /expect\.getState\(\)\.testPath/);
  const source = readFileSync(new URL("../pg-setup-boundary-probe.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pg-test-harness|pg-preadmission-campaign|packages\/core\/src\/__test-utils__|FUSION_PG_TEST_/);
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\)/);
});

test("unresolvable Vitest becomes a retained insufficient-data report", async () => {
  const runner = resolveVitestRunner(() => { throw new Error("test runner unavailable"); });
  assert.equal(runner.vitestVersion, "unresolvable");
  const result = await runFixtureCell({ boundary: "global-setup", arm: "A", options, runner });
  assert.equal(result.arm.outcome, "failed-unclassified");
  assert.match(result.arm.diagnostic, /Vitest resolution failed: test runner unavailable/);
  const report = await runSurvey({ ...options, repeats: 1, isolate: "true" }, runner);
  assert.equal(report.calibration, "failed");
  assert.equal(report.calibrationFailureReason, "classifier-uncalibrated");
  assert.equal(report.verdict, "insufficient-data");
  assert.match(report.runnerResolutionError, /test runner unavailable/);
  assert.ok(report.cells.every((cell) => cell.ownership === "failed-unclassified"));
});

test("live fixture cells preserve setup-file identities on the installed runner", { skip: process.env.FUSION_BOUNDARY_SURVEY_LIVE !== "1" }, async () => {
  const liveOptions = { ...options, files: 3, workers: 2, delayMs: 100, runTimeoutMs: 60_000, isolate: false };
  const global = await runFixtureCell({ boundary: "global-setup", arm: "A", options: liveOptions });
  assert.ok(global.events.length > 0);
  assert.equal(global.arm.outcome, "passed");
  const setup = await runFixtureCell({ boundary: "setup-before-all", arm: "R", options: liveOptions });
  const summary = summarizeLedger("setup-before-all", setup.events, liveOptions);
  assert.equal(setup.arm.outcome, "passed");
  assert.equal(summary.granularity, "per file");
  assert.equal(summary.filesObserved, 3);
});
