import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import {
  buildCensus,
  classifyFailureShape,
  classifyLifecyclePosition,
  extractFailingFiles,
  parseDiagnosticsJsonl,
  parseBoundaryObserverJsonl,
  classifyBoundaryAttribution,
  parseVitestJson,
  stripAnsi,
} from "../pg-loaded-failure-census.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/pg-loaded-failure-census/${name}`, import.meta.url), "utf8");

test("strips ANSI and classifies failure lifecycle positions and shapes", () => {
  assert.equal(stripAnsi("\u001b[31mFAIL\u001b[0m"), "FAIL");
  assert.equal(classifyLifecyclePosition("Error: beforeAll hook timed out"), "beforeAll hook");
  assert.equal(classifyLifecyclePosition("Error: afterEach hook failed"), "afterEach");
  assert.equal(classifyLifecyclePosition("global teardown failure"), "global setup-teardown");
  assert.equal(classifyFailureShape("beforeAll hook timed out in 15000ms"), "hook timeout");
  assert.equal(classifyFailureShape("Test timed out in 15000ms"), "test timeout");
  assert.equal(classifyFailureShape("AssertionError: expected 1 to be 2"), "assertion");
});

test("censuses every high-failure file and joins snapshot diagnostics", () => {
  const parsed = parseDiagnosticsJsonl(fixture("high.jsonl"));
  assert.equal(parsed.malformedLines, 1);
  const census = buildCensus({
    log: fixture("high-run.txt"),
    diagnostics: parsed.rows,
    ordinarySlotCeiling: 97,
    subjects: ["src/__tests__/postgres/case-00.test.ts"],
  });
  assert.equal(census.status, "measured");
  assert.equal(census.totalFiles, 176);
  assert.equal(census.failingFileCount, 25);
  assert.equal(census.failingFileBand, "high (>=25)");
  assert.equal(census.peakBackends, 73);
  assert.equal(census.backendHeadroom, 24);
  assert.equal(census.lifecyclePositionHistogram["beforeAll hook"], 5);
  assert.equal(census.failureShapeHistogram["hook timeout"], 1);
  assert.equal(census.failureShapeHistogram["test timeout"], 1);
  assert.equal(census.failureShapeHistogram.assertion, 1);
  assert.equal(census.waitEventHistogram["IPC/CheckpointDone"], 2);
  assert.equal(census.watchdogCount, 2);
  assert.equal(census.probeDegradationCount, 1);
  assert.equal(census.failingFiles[0].campaignSubject, true);
  assert.equal(extractFailingFiles(fixture("high-run.txt")).length, 25);
});

test("joins out-of-order watchdog payloads by file and boundary, not line order", () => {
  const failure = { file: "src/__tests__/postgres/body-case.test.ts", lifecyclePosition: "test body" };
  const parsed = parseBoundaryObserverJsonl(`${JSON.stringify({ testFile: failure.file, boundary: "body", trigger: "boundary-complete", timestamp: "2026-01-01T00:00:02Z", host: { loadavg1: 0, cpuCount: 8, eventLoopLagMs: 0 } })}\n${JSON.stringify({ testFile: failure.file, boundary: "body", trigger: "boundary-watchdog", timestamp: "2026-01-01T00:00:01Z", settledDuringProbe: true, host: { loadavg1: 0, cpuCount: 8, eventLoopLagMs: 0 }, cluster: { activity: [{ state: "active", blockingPids: [44] }], locks: [] }, template: { markerPresent: true } })}\nmalformed`);
  assert.equal(parsed.malformedLines, 1);
  assert.equal(classifyBoundaryAttribution(failure, parsed.rows).classification, "cluster-implicated");
});

test("attributes a progress-only observer key without inventing a cluster payload", () => {
  const failure = { file: "src/__tests__/postgres/abandoned.test.ts", lifecyclePosition: "test body" };
  const observer = [
    // Consecutive shared-harness bodies retain a common supersession identity,
    // but their emitted record join keys must remain per-window.
    { testFile: failure.file, boundary: "body", kind: "progress", joinKey: "body-1", supersessionKey: "shared-file", elapsedMs: 5000 },
    { testFile: failure.file, boundary: "body", kind: "progress", joinKey: "body-1", supersessionKey: "shared-file", elapsedMs: 10000 },
    { testFile: failure.file, boundary: "body", kind: "terminal", joinKey: "body-2", supersessionKey: "shared-file", elapsedMs: 10 },
  ];
  const attribution = classifyBoundaryAttribution(failure, observer);
  assert.equal(attribution.classification, "attributed-by-ladder");
  assert.equal(attribution.elapsedLowerBoundMs, 10000);
  const settledProgress = [
    { testFile: failure.file, boundary: "body", kind: "progress", joinKey: "settled-body", elapsedMs: 5000 },
    { testFile: failure.file, boundary: "body", kind: "terminal", joinKey: "settled-body", elapsedMs: 6000 },
  ];
  assert.equal(classifyBoundaryAttribution(failure, settledProgress).classification, "unjoined");
  const breachOnly = [{ testFile: failure.file, boundary: "body", kind: "breach", payloadFree: true, joinKey: "body-2", trigger: "boundary-watchdog", host: { loadavg1: 0, cpuCount: 8, eventLoopLagMs: 0 } }];
  assert.equal(classifyBoundaryAttribution(failure, breachOnly).classification, "joined");

  const reporter = parseVitestJson(JSON.stringify({ testResults: [{ name: `/repo/${failure.file}`, assertionResults: [{ fullName: "body timeout", duration: 15000, status: "failed", failureMessages: ["Test timed out in 15000ms"] }] }] }));
  assert.equal(reporter.malformed, false);
  assert.equal(reporter.rows[0].testFile, failure.file);
  assert.equal(reporter.rows[0].durationMs, 15000);
  assert.equal(parseVitestJson("truncated").malformed, true);
});

test("keeps explicit unobservable sets and suppressed watchdog failures distinct from joined attribution", () => {
  const body = { file: "src/__tests__/postgres/direct.test.ts", lifecyclePosition: "test body" };
  assert.equal(classifyBoundaryAttribution(body, [], [body.file]).classification, "body-unobservable");
  const suppressed = [{ testFile: body.file, boundary: "body", trigger: "boundary-watchdog", probeSuppressed: "single-flight", host: { loadavg1: 0, cpuCount: 8, eventLoopLagMs: 0 } }];
  assert.equal(classifyBoundaryAttribution(body, suppressed).classification, "unjoined");
  const fully = { file: "src/__tests__/postgres/no-harness.test.ts", lifecyclePosition: "afterEach" };
  const census = buildCensus({
    log: ` FAIL  ${fully.file} > leaves no harness boundary\nError: afterEach hook timed out in 15000ms.\n\n Test Files  1 failed (1)\n`,
    fullyUnobservableFiles: [fully.file],
  });
  assert.equal(census.fullyUnobservableFailingFileCount, 1);
  assert.deepEqual(census.fullyUnobservableFailingFiles, [fully.file]);
  assert.equal(census.attributions[0].boundaryAttribution.classification, "unjoined");
  const afterEach = { file: "src/__tests__/postgres/shared.test.ts", lifecyclePosition: "afterEach" };
  assert.equal(classifyBoundaryAttribution(afterEach, []).classification, "position-unobservable");
});

test("requires a golden advisory waiter, not a holder, for template convoy attribution", () => {
  const failure = { file: "src/__tests__/postgres/template.test.ts", lifecyclePosition: "beforeAll hook" };
  const base = { testFile: failure.file, boundary: "setup", trigger: "boundary-watchdog", host: { loadavg1: 0, cpuCount: 8, eventLoopLagMs: 0 }, cluster: { activity: [], locks: [] } };
  assert.notEqual(classifyBoundaryAttribution(failure, [{ ...base, template: { advisoryHolders: [10], advisoryWaiters: [], isOwner: false } }]).classification, "template-convoy");
  assert.equal(classifyBoundaryAttribution(failure, [{ ...base, template: { advisoryHolders: [10], advisoryWaiters: [11], isOwner: false } }]).classification, "template-convoy");
});

test("reports a complete healthy run as measured zero rather than insufficient data", () => {
  const census = buildCensus({ log: fixture("low-run.txt"), diagnostics: [], ordinarySlotCeiling: 97 });
  assert.equal(census.status, "measured");
  assert.equal(census.failingFileCount, 0);
  assert.equal(census.failingFileBand, "zero");
  assert.equal(census.peakBackends, null);
});

test("rejects a truncated runner log instead of manufacturing a zero-failure census", () => {
  const census = buildCensus({ log: fixture("truncated-run.txt") });
  assert.equal(census.status, "insufficient-data");
  assert.match(census.reason, /missing Test Files summary/);
  assert.notEqual(census.failingFileCount, 0);
});
