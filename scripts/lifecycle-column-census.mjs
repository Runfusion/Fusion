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
  node scripts/lifecycle-column-census.mjs --compare  # cross-check AST vs text classifier
  node scripts/lifecycle-column-census.mjs --strict   # fail if any file DIVERGES from baseline
  node scripts/lifecycle-column-census.mjs --strict --update-baseline   # re-record after lowering it

`--strict` fails on a RISE (a reintroduced guard) and equally on a DROP that was not recorded: a
stale allowance is a hole through which the same guards can return while the check stays green.

WIRED INTO THE MERGE GATE (`pnpm test:gate`) as of 2026-07-31. The original note here said the
opposite — "NOT wired into the merge gate" — on the reasoning that a thousand-site backlog cannot be
blocking on the day it is first measured. That reasoning was sound and its conclusion expired: the
baseline is per-file, so gating costs nothing for files nobody touches, and while it was unwired the
baseline drifted to 854 against a tree of 787. Sixty-seven guards of regression would have merged
green (PR #2661).

Consequence for conversion PRs, stated because it is a real cost: lowering a count now REQUIRES
re-recording the baseline in the same PR (`--strict --update-baseline`). That is deliberate — it puts
the new number in the diff, where a reviewer sees it, instead of in a hand-written claim.
*/
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:50: the AST classifier is the instrument. Three people
measured this backlog with three greps and got three answers, so the number is taken from a parse.
The text classifier stays beside it as an independent second implementation — `--compare` runs both
and fails if they disagree, which is the only evidence available that either is right.
*/
import { censusFiles, summarize } from "./lib/lifecycle-column-census-ast.mjs";
import {
  censusFiles as censusFilesText,
  summarize as summarizeText,
} from "./lib/lifecycle-column-census.mjs";

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
const compare = process.argv.includes("--compare");
const updateBaseline = process.argv.includes("--update-baseline");

if (json) {
  console.log(JSON.stringify({ scannedFiles: files.length, ...summary, byFile: summary.byFile }, null, 2));
} else {
  console.log(`lifecycle-column-census: scanned ${files.length} source files\n`);
  console.log(`  COLUMN guards (the backlog):   ${summary.totals.column}`);
  console.log(`  ROLE comparisons (not guards): ${summary.totals.role}`);
  console.log(`  STATUS comparisons (not guards): ${summary.totals.status}`);
  console.log(`  DELIBERATE-LITERAL (reviewed): ${summary.totals.deliberate}`);
  /*
  FNXC:LifecycleColumnCensus 2026-07-29-19:40:
  Reported BESIDE the backlog, never inside it. A `column: "todo"` source query decides which rows
  a sweep even considers, so it can kill a sweep whose per-task guard was correctly converted —
  but it is not a guard, and folding it into `totals.column` would move a number the program is
  actively driving to zero. Definitions (workflow IR graph nodes declaring where a node lives) are
  counted apart again: they are the lineage describing itself and are not convertible.
  */
  console.log(`  QUERY filters (column: "<legacy>"): ${summary.properties.query}`);
  console.log(`  IR node definitions (not convertible): ${summary.properties.definition}\n`);
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

if (compare) {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-23:05:
  THE CONTRACT IS SUPERSET, NOT EQUALITY. The text classifier is knowingly weaker — it matches per
  line, `===`/`!==` only, and literal-on-the-right only — so the parser legitimately finds MORE
  (measured: 6 more, all real; `data.to !== "archived"` and multi-line `||` chains in scheduler.ts).
  Demanding equality would just force the parser down to the regex's blind spots.

  What must NEVER happen is the other direction: a site the REGEX found and the parser missed means
  the parser has a hole, and then its number cannot be the bar. That is the failure this checks.
  */
  const text = summarizeText(censusFilesText(files));
  console.log(`\n  text classifier:  ${JSON.stringify(text.totals)}`);
  console.log(`  AST classifier:   ${JSON.stringify(summary.totals)}`);
  const regressions = ["column", "role", "status", "deliberate"].filter(
    (kind) => text.totals[kind] > summary.totals[kind],
  );
if (regressions.length > 0) {
    console.error(
      `\nlifecycle-column-census --compare: the regex found MORE than the parser for ${regressions.join(", ")}.\n` +
      "The parser has a blind spot; its count cannot be the bar until this is closed.",
    );
    process.exit(1);
  }
  const extra = summary.totals.column - text.totals.column;
  console.log(`  parser is a superset (+${extra} column guards the regex cannot see).`);
}

if (!strict) process.exit(0);

if (!existsSync(BASELINE_PATH)) {
  console.error(`lifecycle-column-census --strict: no baseline at ${BASELINE_PATH}`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const baselineByFile = new Map(Object.entries(baseline.byFile ?? {}));
const currentByFile = new Map(summary.byFile);
  /*
FNXC:WorkflowLifecycleColumns 2026-07-31-06:40 (PR #2661 review — greptile, narrowed and closed):
THE DELIBERATE TOTAL IS PINNED TOO, because a marker exempts the construct it is attached to and
everything INSIDE it — so a comparison appended to an already-marked expression inherits the
exemption and never reaches the byFile counts.

Measured rather than argued, on the marker in register-task-workflow-routes.ts:
  - a comparison added as a SIBLING statement inside the same `if`  -> COUNTED (21 -> 22, fails)
  - a comparison appended to the MARKED assignment itself           -> exempt, and byFile is unchanged
The review's stated mechanism (the marker attaching to the enclosing conditional) does not hold;
the narrower hole does, and it applies to every marker in the codebase rather than just this one.

Pinning it per FILE closes it. An earlier version of this check compared the repo-wide TOTAL, which a
REMOVAL in one marked construct offsets against an ADDITION in another — the total stays flat, the
check passes, and the new guard is invisible to `byFile` too because deliberate findings are excluded
from it (PR #2661 review, greptile P1). Same high-water failure this whole PR is about, one field
over. Per-file makes offsetting edits visible, because they land in different files.
*/

const regressions = [];
const stale = [];

/*
DELIBERATE-LITERAL counts, compared per file alongside the column counts above. A marker excuses the
construct it is attached to AND everything inside it (`hasDeliberateMarker` walks ancestors by
design), so a comparison appended to an already-marked expression inherits the exemption and never
reaches the column counts. Tracking the exemptions themselves is what makes that visible.
*/
/*
FIRST-RUN MIGRATION. A baseline recorded before this field existed has no `deliberateByFile` at all,
which is NOT the same as "every marked file had zero" — comparing against an absent map would report
every existing marker as a fresh rise and demand people convert literals that were already reviewed.
Seed it on the next `--update-baseline` instead, and start comparing once it is present.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-10:05:
The key SHAPE changed (file -> file\u0000columnId), and a shape change is the same migration hazard
as a missing field: comparing new keys against old ones reports every existing marker as a fresh
rise and demands people convert already-reviewed literals. I hit exactly that on the first run here
(`TaskCard (DELIBERATE-LITERAL: triage): 0 -> 2`), and hit the same wall one shape earlier in #2661.

Detect by the delimiter rather than by a version field: old keys have none. Re-seeds on the next
`--update-baseline`, then compares normally.
*/
const deliberateKeysAreCurrentShape = Object.keys(baseline.deliberateByFile ?? {}).every((k) => k.includes("\u0000"));
const deliberateTracked = baseline.deliberateByFile !== undefined && deliberateKeysAreCurrentShape;
const baselineDeliberateByFile = new Map(Object.entries(baseline.deliberateByFile ?? {}));
const currentDeliberateByFile = new Map(summary.deliberateByFile ?? []);
for (const [file, count] of deliberateTracked ? currentDeliberateByFile : []) {
  const allowed = baselineDeliberateByFile.get(file) ?? 0;
  // Keys are `file\u0000columnId`; render them readably in the report.
  const [f, columnId] = file.split("\u0000");
  const label = `${f} (DELIBERATE-LITERAL: ${columnId})`;
  if (count > allowed) regressions.push({ file: label, count, allowed });
  else if (count < allowed) stale.push({ file: label, count, allowed });
}
for (const [file, allowed] of deliberateTracked ? baselineDeliberateByFile : []) {
  if (!currentDeliberateByFile.has(file) && allowed > 0) {
    const [f, columnId] = file.split("\u0000");
    stale.push({ file: `${f} (DELIBERATE-LITERAL: ${columnId})`, count: 0, allowed });
  }
}

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

/*
FNXC:LifecycleColumnCensus 2026-07-31-06:10 (PR #2650 review — greptile):
MOVED OUT OF THE `--compare` BRANCH, where it could not work in either mode.

Inside `--compare` it read `baseline`, `regressions` and `stale` — all declared
BELOW, in the `--strict` section — so the documented `--compare` command died with
`ReferenceError: Cannot access 'baseline' before initialization` before printing
anything. And `--strict` on its own never reached the block at all, so the query
ratchet it adds was enforcing nothing in the one mode that gates.

Reproduced both halves before moving it: `--compare` threw, and `--strict` ran to
completion without a single query comparison.

It belongs here, after the strict guards are declared and beside the guard ratchet
whose both-directions rule it mirrors.
*/
/*
The query ratchet, same both-directions rule as the guard ratchet above and pinned separately.
Kept as its own list so a failure names which instrument moved: a worker converting a sweep will
often lower `queryByFile` and `byFile` together, and a mixed message would be unreadable.
*/
const baselineQueryByFile = new Map(Object.entries(baseline.queryByFile ?? {}));
const currentQueryByFile = new Map(summary.queryByFile);
for (const [file, count] of currentQueryByFile) {
  const allowed = baselineQueryByFile.get(file) ?? 0;
  if (count > allowed) regressions.push({ file, count, allowed, kind: "query" });
  else if (count < allowed) stale.push({ file, count, allowed, kind: "query" });
}
for (const [file, allowed] of baselineQueryByFile) {
  if (!currentQueryByFile.has(file) && allowed > 0) stale.push({ file, count: 0, allowed, kind: "query" });
}


/*
FNXC:LifecycleColumnCensus 2026-07-31-18:20:
`--update-baseline` MUST RUN EVEN WHEN A FILE ROSE, and it could not: the rise check exited first, so the
only supported way to re-record was unavailable in exactly the situation that needs it.

That is not hypothetical now that #2654 gates CI on this. A CONVERSION LEGITIMATELY ADDS A LITERAL: the
correct shape for a caller that may have no traits is `flags ? flags.x : columnId === "legacy"`, and every
one of those raises a file's count by one. So a worker doing the right thing hits a red gate whose only
escape is hand-editing the JSON — which is how a ratchet becomes something people route around instead of
run. Measured on current main: `columnRoles.ts` 0 -> 1 from exactly that shape.

The flag is an explicit operator action, so it re-records unconditionally and PRINTS what it accepted
under `ACCEPTED RISES`. Silently swallowing a rise is the real danger; refusing to let anyone re-record is
the same danger one step later, wearing a red check nobody trusts.
*/
if (updateBaseline) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({
      generatedFrom: "node scripts/lifecycle-column-census.mjs --strict --update-baseline",
      totals: summary.totals,
      byColumnId: summary.byColumnId,
      byFile: Object.fromEntries(summary.byFile),
      deliberateByFile: Object.fromEntries(summary.deliberateByFile ?? []),
      properties: summary.properties,
      queryByColumnId: summary.queryByColumnId,
      queryByFile: Object.fromEntries(summary.queryByFile),
    }, null, 2)}\n`,
  );
  if (regressions.length > 0) {
    console.log("\n  ACCEPTED RISES (a merge or a conversion added guards here — convert them or they stay in the bar):");
    for (const r of regressions) {
      console.log(`    ${r.file}${r.kind === "query" ? " (query filter)" : ""}: ${r.allowed} -> ${r.count}`);
    }
  }
  if (stale.length > 0) {
    console.log(`\n  TIGHTENED ${stale.length} entr${stale.length === 1 ? "y" : "ies"} whose counts dropped.`);
  }
  console.log("\nlifecycle-column-census: baseline re-recorded.");
  process.exit(0);
}

if (regressions.length > 0) {
  console.error("\nlifecycle-column-census --strict: column-guard count ROSE\n");
  for (const r of regressions) {
    console.error(`  ${r.file}${r.kind === "query" ? " (query filter)" : ""}: ${r.allowed} -> ${r.count}`);
  }
  console.error(
    "\nResolve a lifecycle column from the task's own workflow (resolveLifecycleColumns /\n" +
    "resolveTaskLifecycleColumns) instead of comparing its name. If the literal is genuinely\n" +
    `correct, record why at the site with a ${"DELIBERATE-LITERAL"} marker.\n`,
  );
  process.exit(1);
}

/*
FNXC:LifecycleColumnCensus 2026-07-31-18:25: the `--update-baseline` branch that lived here is GONE — it
now runs above, before the rise exit, so a risen file can be re-recorded. Keeping a second copy here would
be two writers for one artifact, and the one behind the rise exit was unreachable in the case that needed
it. The `!deliberateTracked && updateBaseline` condition went with it: the unconditional block covers the
legacy-shape migration too.
*/
if (stale.length > 0) {
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
