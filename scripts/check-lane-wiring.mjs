#!/usr/bin/env node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:20:
Ratchet the population of call sites that do not pass a resolved-lane argument. See
scripts/lib/lane-wiring-census.mjs for why this is a census with a baseline and not a hard guard.

Usage:
  node scripts/check-lane-wiring.mjs                     # fail if any file's count ROSE
  node scripts/check-lane-wiring.mjs --update-baseline   # re-record (downward moves only)
*/
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findLaneAcceptingFunctions, findUnwiredCallSites } from "./lib/lane-wiring-census.mjs";

const ROOT = process.cwd();
const BASELINE = join(ROOT, "scripts/lib/lane-wiring-baseline.json");
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:00:
`packages/dashboard/app` and `plugins` are scanned, and `.tsx` counts — their absence was the
blind spot the OLDER guard already learned about and this one re-opened.

`unwired-lane-parameter-guard.test.ts` scans exactly six roots including these two, and its note
records why: an unwired `completeColumnsByTaskId` sat on `main` unreported because the glasses plugin
was not in the list. Plugins hold real lane logic — they resolve workflow IRs, filter by column, and
decide what "finished" means — and `dashboard/app` is where the board is actually rendered.

The extension is TWO changes, and either alone still misses most of it: those trees are overwhelmingly
`.tsx`, which the file filter below excluded, so adding the roots without the extension would have
scanned a handful of files and reported a reassuring near-zero.

Measured on the widened scan, re-measured after rebasing onto main: 15 further call sites, none of
which any gate could see before. They are recorded in the baseline rather than fixed here — they span
three other batches — and audited in the PR that widened this, because baselining a site nobody looked
at is how a ratchet becomes decoration.

FNXC:WorkflowLifecycleColumns 2026-07-30-23:55 (#2978 review — coderabbitai, "correct the audited
call-site count"): the note said 9 and the review said 10, from the pre-rebase baseline. BOTH are now
wrong: main gained sites in these very trees while the PR sat, so the widening currently uncovers 15.
A hand-written count beside a generated baseline dates the moment it is written — this one is stamped
so the next reader knows to re-measure rather than trust it.
*/
const ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "packages/cli/src",
  "plugins",
];

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      sources(p, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx"))
      && !entry.endsWith(".d.ts")
      && !entry.includes(".test.")
      && !entry.includes(".spec.")
    ) {
      out.push(p);
    }
  }
  return out;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:58 (#2978 review — coderabbitai, "fail closed when a
required root cannot be scanned"): AN UNREADABLE ROOT IS A GATE THAT LIES, NOT A GATE THAT PASSES.

`catch { return [] }` turned a missing or unreadable root into an empty file list, so a typo'd path or
a permissions failure produced a smaller scan and a confident `none added`. Every root here is part of
the coverage contract — `plugins` and `dashboard/app` were added BECAUSE they were unscanned — so
silently dropping one restores exactly the blindness this change exists to remove.

Fails closed with the root path in the message. A gate whose errors land on "nothing to report" is the
one failure mode a ratchet must not have.
*/
const files = ROOTS.flatMap((r) => {
  try {
    return sources(join(ROOT, r));
  } catch (error) {
    throw new Error(`[check-lane-wiring] required root "${r}" could not be scanned: ${error.message}`);
  }
});
const accepting = findLaneAcceptingFunctions(files);
const unwired = findUnwiredCallSites(files, accepting);

const counts = {};
for (const hit of unwired) {
  const key = relative(ROOT, hit.file);
  counts[key] = (counts[key] ?? 0) + 1;
}

if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify({ counts }, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[check-lane-wiring] baseline written: ${total} unwired call site(s) in ${Object.keys(counts).length} file(s)`);
  process.exit(0);
}

let baseline = { counts: {} };
try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { /* first run */ }

const rose = [];
const fell = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline.counts[file] ?? 0;
  if (count > allowed) rose.push(`  ${file}: ${count} unwired now, baseline allows ${allowed}`);
  else if (count < allowed) fell.push(`  ${file}: ${allowed} -> ${count}`);
}
for (const [file, allowed] of Object.entries(baseline.counts)) {
  if (!(file in counts) && allowed > 0) fell.push(`  ${file}: ${allowed} -> 0`);
}

if (rose.length > 0) {
  console.error("[check-lane-wiring] call sites not passing a resolved lane argument INCREASED:\n");
  console.error(rose.join("\n"));
  console.error(`
A function that accepts a lane answer was called without one. That is the shape behind #2956, #2963
and #2964: a fix adds an optional parameter, and a caller added later never passes it — so the callee
silently falls back to the legacy literal and the board's own lanes are ignored.

If the call site genuinely should not pass one (identity already proven by a stronger means, a
sentinel column, or a dead export), record it:

  node scripts/check-lane-wiring.mjs --update-baseline
`);
  process.exit(1);
}

if (fell.length > 0) {
  console.log("[check-lane-wiring] unwired call sites decreased:\n");
  console.log(fell.join("\n"));
  console.log("\nRe-record the baseline in the same commit so the allowance cannot be regrown into:\n");
  console.log("  node scripts/check-lane-wiring.mjs --update-baseline\n");
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`[check-lane-wiring] ${total} known unwired call site(s), none added.`);
