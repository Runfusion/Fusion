#!/usr/bin/env node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-14:20 (Phase C convergence):
CLI wrapper. The rules, the measured numbers that motivated them, and the reason the three
classes are reported separately live in `scripts/lib/lifecycle-column-census.mjs`; the
regression suite that pins each form this census must catch lives in
`packages/engine/src/__tests__/lifecycle-column-census.test.ts`.

Report-only by default:
  node scripts/lifecycle-column-census.mjs            # human table
  node scripts/lifecycle-column-census.mjs --json     # machine-readable
  node scripts/lifecycle-column-census.mjs --strict   # fail if any file DIVERGES from baseline
  node scripts/lifecycle-column-census.mjs --strict --update-baseline   # re-record after lowering it

`--strict` fails on a RISE (a reintroduced guard) and equally on a DROP that was not recorded: a
stale allowance is a hole through which the same guards can return while the check stays green.

NOT wired into the merge gate. A thousand-site backlog cannot be a blocking check on the day it
is first measured; `--strict` exists so it can become one incrementally, per-file, once owners have
converted their areas.
*/
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { censusFiles, summarize } from "./lib/lifecycle-column-census.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "lib", "lifecycle-column-census-baseline.json");

let files;
try {
  files = execSync(
    "git ls-files 'packages/*/src/**/*.ts' 'packages/*/src/*.ts' 'packages/*/src/**/*.tsx' 'packages/*/app/**/*.ts' 'packages/*/app/**/*.tsx' 'plugins/*/src/**/*.ts' 'plugins/*/src/**/*.tsx'",
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__") && !/\.(test|spec)\.tsx?$/.test(f));
} catch (err) {
  // FAIL CLOSED: if the file list cannot be produced, nothing has been checked.
  console.error(`lifecycle-column-census: could not list files — ${err?.message ?? err}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error("lifecycle-column-census: file list is EMPTY — refusing to report on zero files.");
  process.exit(1);
}

const findings = censusFiles(files);
const summary = summarize(findings);
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const updateBaseline = process.argv.includes("--update-baseline");

if (json) {
  console.log(JSON.stringify({ scannedFiles: files.length, ...summary, byFile: summary.byFile }, null, 2));
} else {
  console.log(`lifecycle-column-census: scanned ${files.length} source files\n`);
  console.log(`  COLUMN guards (the backlog):   ${summary.totals.column}`);
  console.log(`  ROLE comparisons (not guards): ${summary.totals.role}`);
  console.log(`  STATUS comparisons (not guards): ${summary.totals.status}`);
  console.log(`  DELIBERATE-LITERAL (reviewed): ${summary.totals.deliberate}\n`);
  console.log("  by column id:");
  for (const [id, count] of Object.entries(summary.byColumnId).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${id}`);
  }
  console.log("\n  top files:");
  for (const [file, count] of summary.byFile.slice(0, 20)) {
    console.log(`    ${String(count).padStart(4)}  ${file}`);
  }
  if (summary.byFile.length > 20) {
    // Never let a truncated list read as "that is all of it".
    console.log(`    … and ${summary.byFile.length - 20} more files`);
  }
}

if (!strict) process.exit(0);

if (!existsSync(BASELINE_PATH)) {
  console.error(`lifecycle-column-census --strict: no baseline at ${BASELINE_PATH}`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const baselineByFile = new Map(Object.entries(baseline.byFile ?? {}));
const currentByFile = new Map(summary.byFile);
const regressions = [];
const stale = [];

for (const [file, count] of currentByFile) {
  const allowed = baselineByFile.get(file) ?? 0;
  if (count > allowed) regressions.push({ file, count, allowed });
  else if (count < allowed) stale.push({ file, count, allowed });
}
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:55 (PR #2633 review, greptile P1):
A file that has DROPPED below its baseline is also a failure, and this is the difference between
a ratchet and a high-water mark. Left alone, a conversion that takes a file from 10 guards to 3
leaves a stale allowance of 10 — so seven guards can be reintroduced later and `--strict` stays
green. That is exactly the rot this tool exists to prevent, wearing a passing check.

Files that disappear entirely are also stale entries; they are reported the same way, because a
deleted or renamed file leaving its allowance behind is the same hole.
*/
for (const [file, allowed] of baselineByFile) {
  if (!currentByFile.has(file) && allowed > 0) stale.push({ file, count: 0, allowed });
}

if (regressions.length > 0) {
  console.error("\nlifecycle-column-census --strict: column-guard count ROSE\n");
  for (const r of regressions) {
    console.error(`  ${r.file}: ${r.allowed} -> ${r.count}`);
  }
  console.error(
    "\nResolve a lifecycle column from the task's own workflow (resolveLifecycleColumns /\n" +
    "resolveTaskLifecycleColumns) instead of comparing its name. If the literal is genuinely\n" +
    `correct, record why at the site with a ${"DELIBERATE-LITERAL"} marker.\n`,
  );
  process.exit(1);
}

if (stale.length > 0) {
  if (updateBaseline) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({
        generatedFrom: "node scripts/lifecycle-column-census.mjs --strict --update-baseline",
        totals: summary.totals,
        byColumnId: summary.byColumnId,
        byFile: Object.fromEntries(summary.byFile),
      }, null, 2)}\n`,
    );
    console.log(`\nlifecycle-column-census --strict: baseline TIGHTENED for ${stale.length} file(s).`);
    process.exit(0);
  }
  console.error("\nlifecycle-column-census --strict: baseline is STALE — it allows more than the tree has\n");
  for (const s of stale) {
    console.error(`  ${s.file}: allows ${s.allowed}, tree has ${s.count}`);
  }
  console.error(
    "\nA stale allowance is a hole: those guards can be reintroduced later and this check stays\n" +
    "green. Re-record the baseline in the SAME PR that lowered the count:\n\n" +
    "  node scripts/lifecycle-column-census.mjs --strict --update-baseline\n",
  );
  process.exit(1);
}

console.log("\nlifecycle-column-census --strict: every file matches its baseline exactly.");
process.exit(0);
