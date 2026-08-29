import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  ROOTS,
  classifyFutureStamp,
  hoursAhead,
  runGate,
  walk,
} from "../check-fnxc-future-dates.mjs";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function fixture(t, { files = {}, baseline = {}, baselineText } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fnxc-future-dates-"));
  const baselinePath = join(root, "baseline.json");
  for (const scanRoot of ROOTS) mkdirSync(join(root, scanRoot), { recursive: true });
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  if (baselineText !== undefined) writeFileSync(baselinePath, baselineText);
  else writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, baselinePath };
}

function stamp(area, date, time = "12:00") {
  return `/* FNXC:${area} ${date}-${time}: fixture */`;
}

function run(root, baselinePath, mode = "check") {
  return runGate({ root, baselinePath, now: NOW, mode });
}

test("classifies future stamps at exact plausibility boundaries", () => {
  const reference = new Date("2026-08-01T04:00:00.000Z");
  assert.equal(classifyFutureStamp("2026-08-02", reference), "timezone-plausible"); // 20h
  assert.equal(classifyFutureStamp("2026-08-02", new Date("2026-07-31T22:00:00.000Z")), "timezone-plausible"); // 26h
  assert.equal(classifyFutureStamp("2026-08-02", new Date("2026-07-31T21:00:00.000Z")), "suspect"); // 27h
  assert.equal(classifyFutureStamp("2026-08-03", NOW), "suspect"); // 48h
  assert.equal(classifyFutureStamp("2026-08-04", new Date("2026-08-01T23:00:00.000Z")), "implausible"); // 49h
  assert.equal(classifyFutureStamp("2026-10-19", NOW), "implausible");
  assert.equal(hoursAhead("2026-10-19", NOW) / 24, 79);
  assert.equal(classifyFutureStamp("2026-08-01", NOW), "past-or-today");
  assert.equal(hoursAhead("not-a-date", NOW), null);
  assert.equal(classifyFutureStamp("not-a-date", NOW), "past-or-today");
});

test("tolerated population gets a non-blocking advisory and preserves baseline bytes", (t) => {
  const { root, baselinePath } = fixture(t, {
    files: { "packages/source.ts": `${stamp("Plausible", "2026-08-02")}\n${stamp("Extreme", "2026-10-19")}` },
    baseline: { "packages/source.ts": 2 },
  });
  const before = readFileSync(baselinePath, "utf8");
  const result = run(root, baselinePath);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.byBand, { timezonePlausible: 1, suspect: 0, implausible: 1 });
  assert.equal(result.baselineWritten, false);
  assert.equal(readFileSync(baselinePath, "utf8"), before);
  assert.match(result.lines.join("\n"), /informational only; does not fail the build/);
  const extremeOffender = ["packages/source.ts — ", ["FNXC", "Extreme 2026-10-19"].join(":"), " (79.0 days ahead)"].join("");
  assert(result.lines.includes(`    ${extremeOffender}`));
});

test("timezone-plausible-only and duplicate stamps retain their historical counts without an advisory", (t) => {
  const duplicate = stamp("Duplicate", "2026-08-02");
  const { root, baselinePath } = fixture(t, {
    files: { "packages/source.ts": `${duplicate}\n${duplicate}` },
    baseline: { "packages/source.ts": 2 },
  });
  const result = run(root, baselinePath);
  assert.equal(result.exitCode, 0);
  assert.equal(result.records.length, 2);
  assert.equal(result.byBand.timezonePlausible, 2);
  assert.equal(result.byBand.suspect, 0);
  assert.equal(result.byBand.implausible, 0);
  assert.doesNotMatch(result.lines.join("\n"), /advisory/);
});

test("check mode preserves new-stamp, impossible-time, tighten, update, and unavailable-baseline behavior", (t) => {
  const newStamp = fixture(t, { files: { "packages/new.ts": stamp("New", "2026-08-02") }, baseline: {} });
  const newBefore = readFileSync(newStamp.baselinePath, "utf8");
  const newResult = run(newStamp.root, newStamp.baselinePath);
  assert.equal(newResult.exitCode, 1);
  assert.equal(newResult.baselineWritten, false);
  assert.equal(readFileSync(newStamp.baselinePath, "utf8"), newBefore);

  const impossible = fixture(t, { files: { "packages/bad.ts": stamp("BadTime", "2026-08-01", "25:61") }, baseline: {} });
  const impossibleBefore = readFileSync(impossible.baselinePath, "utf8");
  const impossibleResult = run(impossible.root, impossible.baselinePath);
  assert.equal(impossibleResult.exitCode, 1);
  assert(impossibleResult.lines.some((line) => line.includes([["FNXC", "BadTime 2026-08-01-25:61"].join(":")])));
  assert.equal(readFileSync(impossible.baselinePath, "utf8"), impossibleBefore);

  const tighten = fixture(t, { files: { "packages/low.ts": stamp("Low", "2026-08-02") }, baseline: { "packages/low.ts": 2 } });
  const tightenBefore = readFileSync(tighten.baselinePath, "utf8");
  const tightenResult = run(tighten.root, tighten.baselinePath);
  assert.equal(tightenResult.exitCode, 0);
  assert.equal(tightenResult.baselineWritten, false);
  assert.equal(readFileSync(tighten.baselinePath, "utf8"), tightenBefore);
  assert.match(tightenResult.lines.join("\n"), /CAN BE TIGHTENED/);

  const update = fixture(t, { files: { "packages/update.ts": stamp("Update", "2026-08-02") }, baseline: {} });
  const updateResult = run(update.root, update.baselinePath, "update");
  assert.equal(updateResult.exitCode, 0);
  assert.equal(updateResult.baselineWritten, true);
  assert.deepEqual(JSON.parse(readFileSync(update.baselinePath, "utf8")), { "packages/update.ts": 1 });

  const missing = fixture(t, { files: { "packages/missing.ts": stamp("Missing", "2026-08-02") } });
  rmSync(missing.baselinePath);
  const missingResult = run(missing.root, missing.baselinePath);
  assert.equal(missingResult.exitCode, 1);
  assert.equal(missingResult.baselineWritten, false);
  assert.equal(existsSync(missing.baselinePath), false);

  const malformed = fixture(t, { files: { "packages/malformed.ts": stamp("Malformed", "2026-08-02") }, baselineText: "not json" });
  const malformedBefore = readFileSync(malformed.baselinePath, "utf8");
  const malformedResult = run(malformed.root, malformed.baselinePath);
  assert.equal(malformedResult.exitCode, 1);
  assert.equal(malformedResult.baselineWritten, false);
  assert.equal(readFileSync(malformed.baselinePath, "utf8"), malformedBefore);
});

test("report mode is a read-only census that bypasses all gate failures", (t) => {
  const files = {
    "packages/suspect.ts": stamp("SuspectArea", "2026-08-03"),
    "docs/extreme.md": stamp("ExtremeArea", "2026-10-19"),
  };
  const { root, baselinePath } = fixture(t, { files, baseline: {} });
  const before = readFileSync(baselinePath, "utf8");
  assert.equal(run(root, baselinePath).exitCode, 1);
  const report = run(root, baselinePath, "report");
  const output = report.lines.join("\n");
  assert.equal(report.exitCode, 0);
  assert.equal(report.baselineWritten, false);
  assert.equal(readFileSync(baselinePath, "utf8"), before);
  assert.match(output, /packages\/suspect\.ts[\s\S]*FNXC:SuspectArea/);
  assert.match(output, /docs\/extreme\.md[\s\S]*FNXC:ExtremeArea/);
  assert.match(output, /FNXC:SuspectArea: 1/);
  assert.match(output, /FNXC:ExtremeArea: 1/);
  assert.match(output, /band totals: timezone-plausible=0, suspect=1, implausible=1/);

  const missing = fixture(t, { files, baseline: {} });
  rmSync(missing.baselinePath);
  const missingReport = run(missing.root, missing.baselinePath, "report");
  assert.equal(missingReport.exitCode, 0);
  assert.equal(missingReport.baselineWritten, false);
  assert.match(missingReport.lines.join("\n"), /baseline unavailable — census only/);
  assert.equal(existsSync(missing.baselinePath), false);

  const malformed = fixture(t, { files: { "packages/time.ts": stamp("Clock", "2026-08-01", "24:00") }, baselineText: "broken" });
  const malformedBefore = readFileSync(malformed.baselinePath, "utf8");
  const malformedReport = run(malformed.root, malformed.baselinePath, "report");
  assert.equal(malformedReport.exitCode, 0);
  assert.equal(malformedReport.baselineWritten, false);
  assert.match(malformedReport.lines.join("\n"), /baseline unavailable — census only/);
  assert.match(malformedReport.lines.join("\n"), /impossible clock times/);
  assert.equal(readFileSync(malformed.baselinePath, "utf8"), malformedBefore);
});

test("discovery remains the ROOTS-scoped walk and excludes files outside it", (t) => {
  const { root, baselinePath } = fixture(t, {
    files: {
      "packages/schema.sql": stamp("Sql", "2026-10-19"),
      "packages/code.ts": stamp("Typescript", "2026-10-19"),
      "docs/guide.md": stamp("Docs", "2026-10-19"),
      "packages/ignored.txt": stamp("IgnoredExtension", "2026-10-19"),
      "outside.ts": stamp("Outside", "2026-10-19"),
    },
    baseline: { "packages/schema.sql": 1, "packages/code.ts": 1, "docs/guide.md": 1 },
  });
  const expected = ROOTS.flatMap((scanRoot) => [...walk(join(root, scanRoot))]
    .map((path) => relative(root, path).split("\\").join("/"))).sort();
  const result = run(root, baselinePath);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.scannedFiles, expected);
  assert(!result.scannedFiles.includes("outside.ts"));
  assert(!result.records.some((record) => record.file === "outside.ts"));
  assert.deepEqual(new Set(result.records.map((record) => record.file)), new Set(["packages/schema.sql", "packages/code.ts", "docs/guide.md"]));
});
