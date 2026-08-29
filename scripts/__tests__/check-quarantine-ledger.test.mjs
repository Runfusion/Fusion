/*
FNXC:QuarantineLockstep 2026-08-17-11:14:
Branch-B's real ledger is intentionally empty, so the real-tree assertion proves only that no dangling exclusion survives. Fixture negatives provide the non-vacuous proof that strict mode rejects each half of a broken quarantine decision.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeDeadlines, findLockstepViolations, main, readLedger, renderReport } from "../check-quarantine-ledger.mjs";

function captureStream() {
  let text = "";
  return { stream: { write(chunk) { text += chunk; } }, get text() { return text; } };
}

function tempRoot() { return mkdtempSync(path.join(tmpdir(), "fusion-quarantine-ledger-")); }
function writeLedger(rootDir, ledger) {
  const ledgerPath = path.join(rootDir, "scripts/lib/test-quarantine.json");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledgerPath;
}
function writeFile(rootDir, relativePath, content = "") {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}
function writeConfig(rootDir, packageName, content) { writeFile(rootDir, `packages/${packageName}/vitest.config.ts`, content); }
function healthyEntry(file = "packages/engine/src/healthy.test.ts") { return { file, reason: "fresh quarantine", quarantinedAt: "2026-07-12" }; }
function ledgerFixture(rootDir, entry = healthyEntry(), config = 'exclude: ["src/healthy.test.ts"]') {
  writeFile(rootDir, entry.file);
  writeConfig(rootDir, "engine", `export default { test: { ${config} } };`);
  return writeLedger(rootDir, { entries: [entry] });
}

const fixedNow = new Date("2026-07-12T12:00:00.000Z");
const fixtureLedger = { entries: [
  { file: "packages/engine/src/healthy.test.ts", reason: "fresh quarantine", quarantinedAt: "2026-07-12" },
  { file: "packages/engine/src/near.test.ts", reason: "approaching deletion deadline", quarantinedAt: "2026-07-04" },
  { file: "packages/engine/src/expired.test.ts", reason: "past deletion deadline", quarantinedAt: "2026-06-27" },
  { file: "packages/engine/src/unknown.test.ts", reason: "missing quarantine date" },
] };

function materializeDeadlineFixture(rootDir) {
  for (const entry of fixtureLedger.entries) writeFile(rootDir, entry.file);
  writeConfig(rootDir, "engine", 'export default { test: { exclude: ["src/healthy.test.ts", "src/near.test.ts", "src/expired.test.ts", "src/unknown.test.ts"] } };');
  return writeLedger(rootDir, fixtureLedger);
}

test("computeDeadlines buckets healthy, near, expired, and unknown entries", () => {
  const rows = computeDeadlines(fixtureLedger, { now: fixedNow, warnWithinDays: 6 });
  const byFile = Object.fromEntries(rows.map((row) => [path.basename(row.file), row]));
  assert.equal(byFile["healthy.test.ts"].status, "healthy");
  assert.equal(byFile["healthy.test.ts"].daysRemaining, 14);
  assert.equal(byFile["near.test.ts"].status, "near");
  assert.equal(byFile["expired.test.ts"].status, "expired");
  assert.equal(byFile["unknown.test.ts"].status, "unknown");
});

test("renderReport handles an empty ledger without throwing", () => {
  const report = renderReport(computeDeadlines({ entries: [] }, { now: fixedNow }));
  assert.match(report, /Ledger is empty; nothing quarantined\./);
  assert.match(report, /lockstep=0/);
});

test("readLedger tolerates a missing ledger and rejects non-array entries", () => {
  const rootDir = tempRoot();
  try {
    assert.deepEqual(readLedger(path.join(rootDir, "missing.json")), { entries: [] });
    assert.throws(() => readLedger(writeLedger(rootDir, { entries: {} })), /must have an "entries" array/);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("main is report-only by default but --strict fails on near or expired entries", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = materializeDeadlineFixture(rootDir);
    const stdout = captureStream();
    const stderr = captureStream();
    assert.equal(main([], { rootDir, ledgerPath, stdout: stdout.stream, stderr: stderr.stream, now: fixedNow }), 0);
    assert.match(stdout.text, /expired=1 near=0 healthy=2 unknown=1 lockstep=0/);
    assert.equal(main(["--strict", "--warn-within=6"], { rootDir, ledgerPath, stdout: captureStream().stream, stderr: stderr.stream, now: fixedNow }), 1);
    const healthyLedgerPath = ledgerFixture(rootDir);
    assert.equal(main(["--strict"], { rootDir, ledgerPath: healthyLedgerPath, stdout: captureStream().stream, stderr: stderr.stream, now: fixedNow }), 0);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("missing ledger file is a strict missing-file violation", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "engine", 'export default { test: { exclude: [] } };');
    const ledgerPath = writeLedger(rootDir, { entries: [healthyEntry("packages/engine/src/missing.test.ts")] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["missing-file"]);
    // A missing ledger file is enough to fail strict even when the deadline is healthy.
    assert.equal(main(["--strict"], { rootDir, ledgerPath, stdout: captureStream().stream, stderr: captureStream().stream, now: fixedNow }), 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("existing ledger file without an exclusion is missing-exclude", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = ledgerFixture(rootDir, healthyEntry(), 'exclude: []');
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["missing-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("existing ledger file with its exclusion has no violations", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = ledgerFixture(rootDir);
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
    assert.equal(main(["--strict"], { rootDir, ledgerPath, stdout: captureStream().stream, stderr: captureStream().stream, now: fixedNow }), 0);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("exclude array naming a nonexistent test is dangling-exclude", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "engine", 'export default { test: { exclude: ["src/deleted.test.ts"] } };');
    const ledgerPath = writeLedger(rootDir, { entries: [] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["dangling-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("include lists and non-array excludes are deliberately ignored", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "dashboard", 'const skipListDashboardGlobs = []; export default { test: { include: ["app/missing.test.ts"], exclude: skipListDashboardGlobs } };');
    const ledgerPath = writeLedger(rootDir, { entries: [] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("comment-only ledger file mention cannot satisfy an exclusion", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = ledgerFixture(rootDir, healthyEntry(), '/* FNXC: historical "src/healthy.test.ts" */ exclude: []');
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["missing-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("real repository has no lockstep violations", () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ledgerPath = path.join(rootDir, "scripts/lib/test-quarantine.json");
  assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
});

test("--json output includes lockstep violations", () => {
  const rootDir = tempRoot();
  try {
    const ledgerPath = ledgerFixture(rootDir);
    const stdout = captureStream();
    assert.equal(main(["--json"], { rootDir, ledgerPath, stdout: stdout.stream, stderr: captureStream().stream, now: fixedNow }), 0);
    assert.deepEqual(JSON.parse(stdout.text).lockstep, []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
