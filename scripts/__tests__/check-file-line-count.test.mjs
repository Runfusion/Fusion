/*
FNXC:CI 2026-06-21-00:04:
Tests for the line-count guardrail. Pin the behavior the guard promises: a new
file at exactly MAX_LINES passes but one line over fails; grandfathered files may
sit at or below their recorded ceiling but a single line of growth is a failure;
and shrunk, under-cap, or deleted baseline entries surface as tightenable so the
ratchet can only move down. Line counting must agree whether or not the file ends
in a trailing newline.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINES,
  countLines,
  evaluate,
  formatFailureMessage,
} from "../check-file-line-count.mjs";

test("countLines counts a trailing-newline file without an extra empty line", () => {
  assert.equal(countLines("a\nb\nc\n"), 3);
});

test("countLines counts a file with no trailing newline", () => {
  assert.equal(countLines("a\nb\nc"), 3);
});

test("countLines treats an empty file as zero lines", () => {
  assert.equal(countLines(""), 0);
});

test("evaluate flags a new file over the cap", () => {
  const { violations } = evaluate({ "packages/x/src/new.ts": MAX_LINES + 1 }, {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0].grandfathered, false);
  assert.equal(violations[0].ceiling, MAX_LINES);
});

test("evaluate passes a new file at exactly the cap", () => {
  const { violations } = evaluate({ "packages/x/src/new.ts": MAX_LINES }, {});
  assert.equal(violations.length, 0);
});

test("evaluate allows a grandfathered file at or below its recorded ceiling", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations } = evaluate({ "packages/x/src/big.ts": 4800 }, baseline);
  assert.equal(violations.length, 0);
});

test("evaluate flags a grandfathered file that grew past its ceiling", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations } = evaluate({ "packages/x/src/big.ts": 5001 }, baseline);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].grandfathered, true);
  assert.equal(violations[0].ceiling, 5000);
});

test("evaluate reports a grandfathered file that shrank as tightenable", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { staleBaseline } = evaluate({ "packages/x/src/big.ts": 4500 }, baseline);
  assert.equal(staleBaseline.some((s) => s.reason === "shrank"), true);
});

test("evaluate reports a grandfathered file that dropped under the cap as tightenable", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations, staleBaseline } = evaluate(
    { "packages/x/src/big.ts": MAX_LINES - 1 },
    baseline,
  );
  assert.equal(violations.length, 0);
  assert.equal(staleBaseline.some((s) => s.reason === "under-cap"), true);
});

test("evaluate reports a deleted baseline file as tightenable", () => {
  const baseline = { "packages/x/src/gone.ts": 5000 };
  const { staleBaseline } = evaluate({}, baseline);
  assert.equal(staleBaseline.some((s) => s.reason === "deleted"), true);
});

test("formatFailureMessage cites the file, count, and remediation", () => {
  const msg = formatFailureMessage([
    { filePath: "packages/x/src/new.ts", lines: 2500, ceiling: MAX_LINES, grandfathered: false },
  ]);
  assert.match(msg, /packages\/x\/src\/new\.ts: 2500 lines/);
  assert.match(msg, /focused modules/);
});
