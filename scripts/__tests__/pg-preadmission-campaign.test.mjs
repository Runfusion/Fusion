import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAMPAIGN_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  aggregate,
  campaignRunEnvironment,
  classifyLog,
  countProbeDegradations,
  decideVerdict,
  parseArgs,
  remainingRunTimeoutMs,
  terminateProcessGroup,
} from "../pg-preadmission-campaign.mjs";

test("parses campaign arguments", () => {
  assert.deepEqual(parseArgs(["--runs", "5", "--control", "a", "--candidate", "b"]), { runs: 5, scratchDir: undefined, control: "a", candidate: "b" });
});

test("classifies failed files and project identity timeout", () => {
  assert.deepEqual(classifyLog("Test Files 2 failed | 9 passed\nproject-identity.test.ts hook timed out"), { failingFiles: 2, projectIdentityTimedOut: true });
});

test("counts only degraded preadmission rows", () => {
  assert.equal(countProbeDegradations('{"event":"pg-preadmission-probe","outcome":"acquired-and-released"}\n{"event":"pg-preadmission-probe","outcome":"connect-failed"}\ninvalid'), 1);
});

test("enables diagnostics and addresses the run process group", () => {
  assert.deepEqual(campaignRunEnvironment("sample.jsonl"), {
    FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS: "1",
    FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "sample.jsonl",
  });
  const kills = [];
  terminateProcessGroup({ pid: 42, kill: assert.fail }, "SIGKILL", (...args) => kills.push(args));
  assert.deepEqual(kills, [[-42, "SIGKILL"]]);
});

test("caps each run by the remaining campaign deadline", () => {
  assert.equal(remainingRunTimeoutMs(1_000, 1_000), DEFAULT_RUN_TIMEOUT_MS);
  assert.equal(remainingRunTimeoutMs(1_000, 1_000 + DEFAULT_CAMPAIGN_TIMEOUT_MS - 25), 25);
  assert.equal(remainingRunTimeoutMs(1_000, 1_000 + DEFAULT_CAMPAIGN_TIMEOUT_MS), 0);
});

const control = Array.from({ length: 5 }, (_, i) => ({ arm: "control", valid: true, wallTimeMs: 100 + i, failingFiles: 2, peakBackends: 10, measurementAvailable: true, projectIdentityTimedOut: false, probeRecords: 0, probeDegradations: null }));
const candidate = Array.from({ length: 5 }, (_, i) => ({ arm: "candidate", valid: true, wallTimeMs: 100 + i, failingFiles: 2, peakBackends: 11, measurementAvailable: true, projectIdentityTimedOut: false, probeRecords: 1, probeDegradations: 0 }));
test("accepts affordable synthetic evidence", () => assert.equal(decideVerdict([...control, ...candidate]), "boundary-affordable"));
test("rejects taxing synthetic evidence", () => assert.equal(decideVerdict([...control, ...candidate.map((run) => ({ ...run, wallTimeMs: 999 }))]), "boundary-taxing"));

test("retains sampled peak backends and rejects a two-backend increase", () => {
  const elevatedCandidate = candidate.map((run) => ({ ...run, peakBackends: 12 }));
  const report = aggregate([...control, ...elevatedCandidate], false);
  assert.equal(report.candidate.peakBackends, 12);
  assert.equal(report.verdict, "boundary-taxing");
});

test("rejects incomplete evidence", () => assert.equal(decideVerdict([...control, ...candidate.slice(0, 4)]), "insufficient-data"));

test("rejects evidence when backend measurement is unavailable", () => {
  const unavailable = candidate.map((run, index) => index === 0
    ? { ...run, measurementAvailable: false, peakBackends: null }
    : run);
  assert.equal(decideVerdict([...control, ...unavailable]), "insufficient-data");
});
