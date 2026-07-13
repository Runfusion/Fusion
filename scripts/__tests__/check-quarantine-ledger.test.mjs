import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeDeadlines,
  main,
  readLedger,
  renderReport,
} from "../check-quarantine-ledger.mjs";

function captureStream() {
  let text = "";
  return {
    stream: { write(chunk) { text += chunk; } },
    get text() { return text; },
  };
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-quarantine-ledger-"));
}

function writeLedger(rootDir, ledger) {
  const ledgerPath = path.join(rootDir, "scripts/lib/test-quarantine.json");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledgerPath;
}

const fixedNow = new Date("2026-07-12T12:00:00.000Z");

const fixtureLedger = {
  entries: [
    {
      file: "healthy.test.ts",
      reason: "fresh quarantine",
      quarantinedAt: "2026-07-12",
    },
    {
      file: "near.test.ts",
      reason: "approaching deletion deadline",
      quarantinedAt: "2026-07-04",
    },
    {
      file: "expired.test.ts",
      reason: "past deletion deadline",
      quarantinedAt: "2026-06-27",
    },
    {
      file: "unknown.test.ts",
      reason: "missing quarantine date",
    },
  ],
};

test("computeDeadlines buckets healthy, near, expired, and unknown entries", () => {
  const rows = computeDeadlines(fixtureLedger, { now: fixedNow, warnWithinDays: 6 });
  const byFile = Object.fromEntries(rows.map((row) => [row.file, row]));

  assert.equal(byFile["healthy.test.ts"].status, "healthy");
  assert.equal(byFile["healthy.test.ts"].daysRemaining, 14);
  assert.equal(byFile["healthy.test.ts"].deadline, "2026-07-26");

  assert.equal(byFile["near.test.ts"].status, "near");
  assert.equal(byFile["near.test.ts"].daysRemaining, 6);

  assert.equal(byFile["expired.test.ts"].status, "expired");
  assert.ok(byFile["expired.test.ts"].daysRemaining <= 0);

  assert.equal(byFile["unknown.test.ts"].status, "unknown");
  assert.equal(byFile["unknown.test.ts"].daysRemaining, null);
  assert.equal(byFile["unknown.test.ts"].deadline, null);
});

test("computeDeadlines sorts soonest deadline first with unknown entries last", () => {
  const rows = computeDeadlines(fixtureLedger, { now: fixedNow, warnWithinDays: 6 });

  assert.deepEqual(rows.map((row) => row.file), [
    "expired.test.ts",
    "near.test.ts",
    "healthy.test.ts",
    "unknown.test.ts",
  ]);
});

test("renderReport handles an empty ledger without throwing", () => {
  const rows = computeDeadlines({ entries: [] }, { now: fixedNow });
  const report = renderReport(rows);

  assert.deepEqual(rows, []);
  assert.match(report, /Ledger is empty; nothing quarantined\./);
  assert.match(report, /Summary: total=0 expired=0 near=0 healthy=0 unknown=0/);
});

test("readLedger tolerates a missing ledger and rejects non-array entries", () => {
  const rootDir = tempRoot();
  try {
    assert.deepEqual(readLedger(path.join(rootDir, "missing.json")), { entries: [] });
    const ledgerPath = writeLedger(rootDir, { entries: {} });
    assert.throws(
      () => readLedger(ledgerPath),
      /quarantine ledger .* must have an "entries" array/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("main is report-only by default but --strict fails on near or expired entries", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = writeLedger(rootDir, fixtureLedger);
    const stdout = captureStream();
    const stderr = captureStream();

    assert.equal(main([], { rootDir, ledgerPath, stdout: stdout.stream, stderr: stderr.stream, now: fixedNow }), 0);
    assert.match(stdout.text, /expired=1 near=0 healthy=2 unknown=1/);
    assert.equal(stderr.text, "");

    const strictStdout = captureStream();
    assert.equal(main(["--strict", "--warn-within=6"], { rootDir, ledgerPath, stdout: strictStdout.stream, stderr: stderr.stream, now: fixedNow }), 1);

    const healthyLedgerPath = writeLedger(rootDir, { entries: [{ file: "healthy.test.ts", quarantinedAt: "2026-07-12" }] });
    const healthyStdout = captureStream();
    assert.equal(main(["--strict"], { rootDir, ledgerPath: healthyLedgerPath, stdout: healthyStdout.stream, stderr: stderr.stream, now: fixedNow }), 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("--json output parses and includes per-entry status and days remaining", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = writeLedger(rootDir, fixtureLedger);
    const stdout = captureStream();
    const stderr = captureStream();

    assert.equal(main(["--json", "--warn-within=6"], { rootDir, ledgerPath, stdout: stdout.stream, stderr: stderr.stream, now: fixedNow }), 0);

    const parsed = JSON.parse(stdout.text);
    assert.equal(parsed.summary.expired, 1);
    assert.equal(parsed.summary.near, 1);
    assert.deepEqual(
      parsed.rows.map((row) => ({ file: row.file, status: row.status, daysRemaining: row.daysRemaining })),
      [
        { file: "expired.test.ts", status: "expired", daysRemaining: -1 },
        { file: "near.test.ts", status: "near", daysRemaining: 6 },
        { file: "healthy.test.ts", status: "healthy", daysRemaining: 14 },
        { file: "unknown.test.ts", status: "unknown", daysRemaining: null },
      ],
    );
    assert.equal(stderr.text, "");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
