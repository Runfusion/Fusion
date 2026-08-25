/*
FNXC:QuarantineLockstep 2026-08-17-11:14:
Branch-B's real ledger is intentionally empty, so the real-tree assertion proves only that no dangling exclusion survives. Fixture negatives provide the non-vacuous proof that strict mode rejects each half of a broken quarantine decision.

FNXC:QuarantineLockstep 2026-08-20-21:20:
String-aware comment stripping regression: a glob literal containing `/*` (e.g. `"node_modules/**"`) must not open a phantom block comment that hides a real `exclude:` entry. The fixture reproduces the exact shape of packages/engine/vitest.config.ts that triggered the false positive on the RUFU-072 task-wedge quarantine.

FNXC:QuarantineLedgerConstArray 2026-08-23-00:31:
RUFU-157 const-array fixtures: the scanner must also read `const <name>: string[] = [...]` quarantine arrays (the cli/core/dashboard/desktop vitest config shape, spread into `test.exclude` through a filtered identifier) so the RUFU-128 bin.test.ts const-array quarantine verifies with zero violations. The negative fixtures pin the conservative contract: a non-matching const array, an untyped const array, and a commented-out declaration keep reporting `missing-exclude`; a stale const-array entry surfaces as `dangling-exclude`; and a path present in both an inline `exclude:` literal and a const array verifies exactly once (deduped across declaration shapes).
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

test("glob strings containing /* do not mask a real exclusion (string-aware comment stripping)", () => {
  const rootDir = tempRoot();
  try {
    const config = [
      'export default {',
      '  test: {',
      '    name: "engine-default",',
      '    include: ["src/**/*.test.ts"],',
      '    exclude: [',
      '      "node_modules/**",',
      '      "dist/**",',
      '      /*',
      '      FNXC:EngineTests 2026-08-11-21:50:',
      '      quarantine rationale that mentions "src/healthy.test.ts" in prose',
      '      */',
      '      "src/healthy.test.ts",',
      '    ],',
      '  },',
      '};',
    ].join("\n");
    writeConfig(rootDir, "engine", config);
    writeFile(rootDir, "packages/engine/src/healthy.test.ts");
    const ledgerPath = writeLedger(rootDir, { entries: [healthyEntry()] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

// CLI-shaped vitest config: the concrete path appears ONLY in the documented const-array quarantine
// declaration (with an interior FNXC block comment, like the real packages/cli config) and reaches
// test.exclude through a filtered identifier spread — never as an inline exclude literal.
function cliConstArrayConfig(entries) {
  return [
    "const quarantinedCliTests: string[] = [",
    "  /*",
    "  FNXC:CliTests 2026-08-20-15:35:",
    "  quarantine rationale block comment that must not break extraction",
    "  */",
    ...entries.map((file) => `  "${file}",`),
    "];",
    "const activeQuarantinedCliTests = quarantinedCliTests.filter((testFile) => true);",
    'export default { test: { include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", "**/dist/**", ...activeQuarantinedCliTests] } };',
  ].join("\n");
}

test("const-array quarantine satisfies a ledger entry", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "cli", cliConstArrayConfig(["src/__tests__/bin.test.ts"]));
    writeFile(rootDir, "packages/cli/src/__tests__/bin.test.ts");
    const ledgerPath = writeLedger(rootDir, { entries: [{ file: "packages/cli/src/__tests__/bin.test.ts", reason: "loaded-host timeout (RUFU-128 shape)", quarantinedAt: "2026-08-20" }] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("const array not containing the ledger file still reports missing-exclude", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "cli", cliConstArrayConfig(["src/other.test.ts"]));
    writeFile(rootDir, "packages/cli/src/other.test.ts");
    writeFile(rootDir, "packages/cli/src/ledgered.test.ts");
    const ledgerPath = writeLedger(rootDir, { entries: [{ file: "packages/cli/src/ledgered.test.ts", reason: "path absent from the const array", quarantinedAt: "2026-07-12" }] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["missing-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("untyped const array is not scanned", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "cli", [
      'const quarantineList = ["src/foo.test.ts"];',
      "export default { test: { exclude: quarantineList } };",
    ].join("\n"));
    writeFile(rootDir, "packages/cli/src/foo.test.ts");
    const ledgerPath = writeLedger(rootDir, { entries: [{ file: "packages/cli/src/foo.test.ts", reason: "untyped const array must not satisfy lockstep", quarantinedAt: "2026-07-12" }] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => row.kind), ["missing-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("stale const-array entry is a dangling-exclude", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "cli", cliConstArrayConfig(["src/deleted.test.ts"]));
    const ledgerPath = writeLedger(rootDir, { entries: [] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }).map((row) => [row.kind, row.file]), [["dangling-exclude", "packages/cli/src/deleted.test.ts"]]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("path in both inline exclude and const array verifies without duplicate violations", () => {
  const rootDir = tempRoot();
  try {
    // Dashboard double-coverage shape: concrete coverage.exclude no-op plus the const-array entry.
    const config = [
      'const quarantinedDashboardTests: string[] = ["app/components/__tests__/dup.test.tsx"];',
      "export default {",
      "  test: { exclude: [...quarantinedDashboardTests] },",
      '  coverage: { exclude: ["**/*.test.{ts,tsx}", "app/components/__tests__/dup.test.tsx"] },',
      "};",
    ].join("\n");
    writeConfig(rootDir, "dashboard", config);
    writeFile(rootDir, "packages/dashboard/app/components/__tests__/dup.test.tsx");
    const ledgerPath = writeLedger(rootDir, { entries: [{ file: "packages/dashboard/app/components/__tests__/dup.test.tsx", reason: "double-covered entry", quarantinedAt: "2026-07-12" }] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(ledgerPath) }), []);
    // Dedup proof: deleting the file must surface exactly ONE dangling-exclude, not one per declaration shape.
    rmSync(path.join(rootDir, "packages/dashboard/app/components/__tests__/dup.test.tsx"));
    const emptyLedgerPath = writeLedger(rootDir, { entries: [] });
    assert.deepEqual(findLockstepViolations({ rootDir, ledger: readLedger(emptyLedgerPath) }).map((row) => row.kind), ["dangling-exclude"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("commented-out const array is not scanned", () => {
  const rootDir = tempRoot();
  try {
    writeConfig(rootDir, "cli", [
      '// const y: string[] = ["src/z.test.ts"];',
      "const quarantinedCliTests: string[] = [];",
      "export default { test: { exclude: [...quarantinedCliTests] } };",
    ].join("\n"));
    writeFile(rootDir, "packages/cli/src/z.test.ts");
    const ledgerPath = writeLedger(rootDir, { entries: [{ file: "packages/cli/src/z.test.ts", reason: "commented-out array must not satisfy lockstep", quarantinedAt: "2026-07-12" }] });
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
