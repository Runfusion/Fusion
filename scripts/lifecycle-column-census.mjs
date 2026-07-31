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
  node scripts/lifecycle-column-census.mjs --triage   # split the backlog into flagged vs unexamined
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

/** Repo root, for reading a finding's source back when `--triage` classifies it. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import {
  censusFiles as censusFilesText,
  summarize as summarizeText,
  mixedVocabularyFiles,
} from "./lib/lifecycle-column-census.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/*
FNXC:LifecycleColumnCensus 2026-07-31-18:20 (PR #2668 review — greptile):
BASELINE PATH IS OVERRIDABLE so the CLI can be driven END TO END in a test.

The suite could only assert this file's SOURCE TEXT — substrings, marker ordering,
`writeFileSync` call counts — because a test that actually ran the CLI would rewrite
the repo's real baseline. Source assertions cannot see control flow: move the exit,
reorder the branches, or return before the write, and every one of them still passes.

An env override is the smallest seam that makes the real contract testable: exit
code, what lands in the baseline file, and what is printed. Production never sets it,
so the default is unchanged.
*/
const BASELINE_PATH = process.env.FUSION_CENSUS_BASELINE_PATH
  ?? join(HERE, "lib", "lifecycle-column-census-baseline.json");

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
/* `--exact` keeps hard failure on a DROP, for the end state where the count is pinned. */
const exact = process.argv.includes("--exact");
const triage = process.argv.includes("--triage");

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:30 (the headline number stopped tracking work):
`--triage` splits the backlog into sites that carry a DOCUMENTED reason for staying a literal and
sites nobody has examined. Opt-in, printed BESIDE the totals, and it changes no count and no exit
code — same discipline as `traitFallbackCount` above.

Why it exists. A guard deferred on purpose, with the reason written next to it, is not the same work
item as an unexamined literal, and the headline conflates them. Measured by hand across the fleet
phase, repeatedly: of 88 guards at one point, 53 were already inside an open PR, 13 carried an
explicit flag note, 11 were fallback arms, and 11 were genuinely unexamined. A worker told to "claim
the largest cluster" reads 88 and finds 11, then reaches for whatever moves the number — which is how
three PRs converted guards to a synchronous resolver that is inert under PostgreSQL (#3051, refuted
live in #3058; #3062/#3068/#3079 now fail the build on it).

HEURISTIC, AND SAID SO. Classification is comment proximity: an FNXC note within 40 lines above the
guard whose text marks a deliberate deferral. It cannot tell a good reason from a bad one, and a note
far above its guard reads as unflagged. It is a triage aid for choosing work, never a gate — which is
why it is opt-in and why nothing downstream consumes it.
*/
/*
FNXC:LifecycleColumnCensus 2026-08-01-04:20 (the marker set under-reported, which is the harmful direction):
Measured after shipping: of nine sites `--triage` listed as unexamined, FOUR carried a full deferral
note my markers simply did not match — `moves.ts` ("THIS ARM STAYS INLINE, deliberately"),
`ResearchTaskActionModal.tsx` ("sized here rather than faked"), `audit-ops.ts` ("Not converted
here because ..."), `mission-store.ts` ("do not convert"). A 44% false-positive rate on a list
headed "this is the list to pick work from".

Under-reporting is worse than over-reporting for this tool: it sends a worker at a site whose owner
already wrote down why it must not move, which is exactly the sequence that produced #3114 (converting
an arm #3108 had flagged hours earlier). Over-reporting would hide real work, so the added phrases are
specific to declining a conversion rather than generic words like "deliberately" on its own.
*/
const FLAG_MARKERS = /FLAGGED|LEFT COUNTED|left counted|deliberately NOT converted|Recorded instead|Recorded rather than|Left as a literal|DELIBERATE-LITERAL|accurate debt|blocked on|STAYS INLINE|[Nn]ot converted|do NOT convert|do not convert|sized here|in dead code/;

/** Split the column guards into documented-deferral vs unexamined, by comment proximity. */
function triageFindings() {
  const sourceCache = new Map();
  const flagged = [];
  const open = [];
  for (const f of findings.filter((x) => x.kind === "column")) {
    let lines = sourceCache.get(f.file);
    if (!lines) {
      /* `f.file` is already repo-relative and this script runs from the repo root, so read it
         directly. NOT wrapped in a silent catch: the first draft did, and a ReferenceError on an
         undefined path constant was swallowed into an empty file list, which reported "0 documented
         deferrals" for a tree that visibly has them. A triage aid that fails to zero is worse than
         one that throws — it reads as a clean answer. */
      lines = readFileSync(join(REPO_ROOT, f.file), "utf8").split("\n");
      sourceCache.set(f.file, lines);
    }
    const window = lines.slice(Math.max(0, f.line - 41), f.line).join(" ");
    (FLAG_MARKERS.test(window) ? flagged : open).push(f);
  }
  return { flagged, open };
}

if (json) {
  console.log(JSON.stringify({ scannedFiles: files.length, ...summary, byFile: summary.byFile }, null, 2));
} else {
  console.log(`lifecycle-column-census: scanned ${files.length} source files\n`);
  console.log(`  COLUMN guards (the backlog):   ${summary.totals.column}`);
  console.log(`  ROLE comparisons (not guards): ${summary.totals.role}`);
  console.log(`  STATUS comparisons (not guards): ${summary.totals.status}`);
  console.log(`  DELIBERATE-LITERAL (reviewed): ${summary.totals.deliberate}`);
  /*
  FNXC:LifecycleColumnCensus 2026-08-01-01:40:
  Reported BESIDE the backlog, not subtracted from it. A fallback literal is still a literal and should go
  when the trait path becomes unconditional — but it is an ALREADY-CONVERTED site's documented degradation,
  not unconverted work, and a batch worker told to convert it would delete the only answer available to a
  caller without traits. Measured: 19 of 19 dashboard proximity hits were this shape and none was a defect,
  while both engine defects (#2670, #2672) were literals in a separate statement instead.
  */
  console.log(`  of the column guards, ${summary.traitFallbackCount ?? 0} are trait-fallback branches (already converted)`);
  if (triage) {
    const { flagged, open } = triageFindings();
    console.log(`\n  TRIAGE (heuristic, opt-in; changes no count and no exit code)`);
    console.log(`    documented deferral (flag note within 40 lines): ${flagged.length}`);
    console.log(`    unexamined:                                      ${open.length}`);
    const byFile = {};
    for (const f of open) byFile[f.file] = (byFile[f.file] ?? 0) + 1;
    const rows = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (rows.length > 0) {
      console.log(`\n    unexamined, by file — this is the list to pick work from:`);
      for (const [file, n] of rows) console.log(`      ${String(n).padStart(3)}  ${file}`);
    }
  }
  /*
  FNXC:LifecycleColumnCensus 2026-07-29-19:40:
  Reported BESIDE the backlog, never inside it. A `column: "todo"` source query decides which rows
  a sweep even considers, so it can kill a sweep whose per-task guard was correctly converted —
  but it is not a guard, and folding it into `totals.column` would move a number the program is
  actively driving to zero. Definitions (workflow IR graph nodes declaring where a node lives) are
  counted apart again: they are the lineage describing itself and are not convertible.
  */
  console.log(`  QUERY filters (column: "<legacy>"): ${summary.properties.query}`);
  /*
  FNXC:LifecycleColumnCensus 2026-08-01-04:00:
  The split, because the single number reads as "dead reads to convert" and most of it is not.
  Measured while converting this class: outside `self-healing.ts` the read-shaped sites are
  convertible; the rest are soft-delete TOMBSTONE writes and synthetic in-memory literals, and
  converting a tombstone write is HARMFUL — `getLiveTaskColumn` returns "archived" as a sentinel for
  any soft-deleted row, so the write and the sentinel have to agree.

  Reported only. The pinned total above and `queryByFile` are unchanged, so the ratchet does not move.
  */
  if (summary.queryRoles) {
    const { read = 0, write = 0, other = 0 } = summary.queryRoles;
    console.log(`    of those: ${read} read-shaped (convertible), ${write} writes (do NOT convert), ${other} other`);
  }
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

/*
FNXC:LifecycleColumnCensus 2026-07-30-21:00 (the half-conversion detector):
MIXED VOCABULARY IS THE FLEET'S DOMINANT DEFECT. Four review findings in one day were the same
shape: a guard converted to role resolution while the function it FEEDS still filters on the
literal. The resolved guard admits a custom column, the literal collaborator then rejects it, and
nothing errors — the endpoint just returns "repaired: 0" and looks converted.

A file where both vocabularies are live is where that can happen, so this reports them. It is a
REVIEW SIGNAL, not a verdict: a partially-converted file is the expected state during a conversion
phase, and this is deliberately report-only for that reason. What it buys is that a reviewer of a
file on this list knows to check the collaborators of anything converted, which is what the repo's
Surface Enumeration rule already asks for and what these four PRs each missed.

MEASURED when added: 23 of 134 guard-bearing files, holding 311 of 686 guards — and the top of the
list is exactly where the four findings landed (self-healing.ts, executor.ts,
register-task-workflow-routes.ts, TaskContextMenu.tsx).
*/
if (!json) {
  const mixed = mixedVocabularyFiles(summary.byFile, (f) => readFileSync(f, "utf8"));
  if (mixed.length > 0) {
    const guardsInMixed = mixed.reduce((sum, entry) => sum + entry.count, 0);
    console.log(`\n  MIXED-VOCABULARY files (a role resolver AND legacy literals): ${mixed.length}, holding ${guardsInMixed} guards`);
    console.log("  Converting in these needs the collaborators checked too — a resolved guard feeding a literal one fails silently.");
    for (const entry of mixed.slice(0, 10)) {
      console.log(`    ${String(entry.count).padStart(4)}  ${entry.file}`);
    }
    if (mixed.length > 10) console.log(`    … and ${mixed.length - 10} more`);
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-20:10 (fleet — the census could not see an INERT conversion):

`resolveTaskWorkflowIrSync` returns the DEFAULT workflow IR for every task in production (PostgreSQL
mode's sync selection reader answers `undefined` unconditionally; see
`sync-workflow-ir-callsite-allowlist.test.ts` and `postgres/sync-workflow-ir-is-always-default.pg.test.ts`).

A guard whose lane comes from that resolver behaves EXACTLY as the literal it replaced — but this
census scored it as converted, so the backlog fell while nothing changed in production. The call-site
allow-list stops that class GROWING; it does not stop it COUNTING, because an allow-listed site still
looks converted from here.

MEASURED when added: `scheduler.ts` holds 10 guards fed by its allow-listed sync resolver, all already
subtracted from the backlog by earlier PRs. Two conversions of mine were in this class and only one was
caught — by the ratchet, not by this tool.

A WARNING, not a subtraction: attributing individual guards to the resolver needs dataflow this parser
does not do, so the honest output is "this file contains a sync call site, so conversions in it may be
inert" rather than a precise number that would be wrong the other way.
*/
if (!json) {
  const SYNC_RESOLVER = "resolveTaskWorkflowIrSync";
  const syncCall = new RegExp(SYNC_RESOLVER + "\\s*\\??\\.?\\s*\\(");
  const remainingByFile = new Map(summary.byFile);
  const suspect = [];
  /* Every censused file, not only those with remaining guards: a file converted ENTIRELY through the
     sync resolver has zero remaining literals and would otherwise be invisible — the case most worth
     surfacing, because it reads as 100% done and is inert. */
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!syncCall.test(source)) continue;
    suspect.push({ file, count: remainingByFile.get(file) ?? 0 });
  }
  if (suspect.length > 0) {
    suspect.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
    console.log("\n  SYNC-RESOLVED files (conversions here may be INERT): " + suspect.length);
    console.log("  `" + SYNC_RESOLVER + "` answers with the DEFAULT workflow in production, so a guard");
    console.log("  resolved through it behaves exactly as the literal did. Counts are REMAINING literals;");
    console.log("  a count of 0 is the WORST case, not the best — the file reads as fully converted.");
    for (const entry of suspect.slice(0, 10)) {
      console.log("    " + String(entry.count).padStart(4) + "  " + entry.file);
    }
    if (suspect.length > 10) console.log("    … and " + (suspect.length - 10) + " more");
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
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-11:30:
  COMPARE SITES, NOT BUCKET TOTALS. This check used to compare the per-bucket counts and fail when
  the regex's `column` total exceeded the parser's. That conflates the two things it most needs to
  tell apart:

    - the parser MISSED a site entirely            -> a real blind spot, the failure worth having;
    - the parser saw it and classified it better   -> role, status, or deliberate instead of column.

  The second is the parser's entire reason for existing, so the old form fired MORE the better the
  parser got. It had been failing on `main` while reporting "the parser has a blind spot; its count
  cannot be the bar" — and that message was false. MEASURED at the time of this change: 13 sites
  diverged, and all 13 were seen by the parser (4 deliberate, 5 role, 4 status). Zero were missed.

  The check now fails only on a site the regex found and the parser did not, which is what the note
  above it always said the contract was.
  */
  const textFindings = censusFilesText(files);
  const text = summarizeText(textFindings);
  console.log(`\n  text classifier:  ${JSON.stringify(text.totals)}`);
  console.log(`  AST classifier:   ${JSON.stringify(summary.totals)}`);

  /*
  FNXC:LifecycleColumnCensus 2026-07-30-13:05 (PR #2682 review — greptile):
  A SITE KEY CAN REPEAT ON ONE LINE, so this counts occurrences instead of testing set membership.
  `from === "todo" || to === "todo"` yields TWO findings sharing file:line:columnId; keyed by a Set,
  one parser match would satisfy both regex findings and hide a genuine miss of the other. Receiver
  is deliberately NOT part of the key — `c === "todo" || c === "todo"` would collapse again — so the
  comparison is per-key COUNTS, which cannot be fooled by either shape.
  */
  const siteKey = (f) => `${f.file}:${f.line}:${f.columnId}`;
  const astByKey = new Map();
  for (const f of findings) {
    const list = astByKey.get(siteKey(f)) ?? [];
    list.push(f);
    astByKey.set(siteKey(f), list);
  }
  const textByKey = new Map();
  for (const f of textFindings) {
    const list = textByKey.get(siteKey(f)) ?? [];
    list.push(f);
    textByKey.set(siteKey(f), list);
  }

  const missed = [];
  for (const [key, list] of textByKey) {
    const shortfall = list.length - (astByKey.get(key)?.length ?? 0);
    for (let i = 0; i < shortfall; i += 1) missed.push(list[i]);
  }

  if (missed.length > 0) {
    console.error(
      `\nlifecycle-column-census --compare: the regex found ${missed.length} site(s) the parser did not.\n` +
      "The parser has a blind spot; its count cannot be the bar until this is closed.\n" +
      missed.slice(0, 10).map((f) => `  ${f.file}:${f.line} (${f.columnId})`).join("\n"),
    );
    process.exit(1);
  }

  /* Reclassifications are expected and are the parser's value-add, so they are reported, not failed. */
  const byKind = {};
  let reclassifiedCount = 0;
  for (const [key, list] of textByKey) {
    /* Pair occurrences positionally within a key; equal counts are guaranteed by the miss check above. */
    const astList = astByKey.get(key) ?? [];
    list.forEach((f, i) => {
      const kind = astList[i]?.kind;
      if (f.kind === "column" && kind !== undefined && kind !== "column") {
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        reclassifiedCount += 1;
      }
    });
  }
  let parserOnly = 0;
  for (const [key, list] of astByKey) parserOnly += Math.max(0, list.length - (textByKey.get(key)?.length ?? 0));
  console.log(`  parser sees every site the regex does (+${parserOnly} sites the regex cannot see).`);
  if (reclassifiedCount > 0) {
    console.log(`  ${reclassifiedCount} the regex calls a column guard, the parser classifies as ${JSON.stringify(byKind)}.`);
  }
}

if (!strict) process.exit(0);

if (!existsSync(BASELINE_PATH)) {
  console.error(`lifecycle-column-census --strict: no baseline at ${BASELINE_PATH}`);
  process.exit(1);
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-15:10:
FAIL WITH A DIAGNOSIS, not a stack trace, when the baseline is not valid JSON.

Measured cause, twice in one program: a rebase or cherry-pick leaves CONFLICT MARKERS in the baseline,
the operator runs `--update-baseline` to "fix" it, THIS parse throws first, the run dies before
writing, and the still-conflicted file gets staged. `--strict` then fails in CI with a raw
`SyntaxError` that names a byte offset and nothing about what to do.

Both halves are covered: `--strict` explains the real cause and the fix, and `--update-baseline`
REFUSES to run against an unparseable baseline rather than reading it and dying midway. Regenerating
is safe (the file is derived), but it must be a deliberate act with the corruption named, not a side
effect of a command that appears to have worked.
*/
function readBaselineOrExplain() {
  const raw = readFileSync(BASELINE_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const conflicted = /^(<{7}|={7}|>{7})/m.test(raw);
    console.error(`lifecycle-column-census: ${BASELINE_PATH} is not valid JSON (${err.message}).`);
    if (conflicted) {
      console.error("  It still contains MERGE CONFLICT MARKERS — a rebase or cherry-pick left them behind.");
    }
    console.error("  The baseline is derived, so regenerate it from the target branch rather than hand-editing:");
    console.error("    git show origin/main:scripts/lib/lifecycle-column-census-baseline.json > scripts/lib/lifecycle-column-census-baseline.json");
    console.error("    node scripts/lifecycle-column-census.mjs --strict --update-baseline");
    process.exit(1);
  }
}

const baseline = readBaselineOrExplain();
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
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-21:40:
  A deliberate rise is tagged as a RECLASSIFICATION when the same file+column's guard count fell by
  at least as much. Adding a `DELIBERATE-LITERAL` marker moves a site from `byFile` to
  `deliberateByFile`, so the totals shift even though unconverted debt went DOWN.

  It still fails — the baseline has to be re-recorded either way — but the message must not call it
  "column-guard count ROSE", which is the opposite of what happened and sends the reader looking for
  a regression they will not find. Main went red on exactly this twice in one day, from two different
  PRs, and both times the failure text pointed away from the fix.
  */
  if (count > allowed) {
    /*
    Two bugs my own test caught before this shipped, both worth recording because each made the guard
    silently never fire — the failure mode this whole program is about:

    1. `deliberateByFile` is keyed `file\u0000columnId` while `byFile` is keyed by PLAIN PATH, so my
       first lookup used the suffixed key against the plain map and always read 0.
    2. Then I compared "did the guard count FALL by at least the marker rise". It usually cannot: a
       file taken to zero guards loses its `byFile` entry entirely, so both sides read 0 and no fall
       is observable at strict-check time — the fall happened in an earlier re-record.

    The honest condition is the weaker one: markers rose and guards did NOT. That is exactly the
    shape of a marker-only change, and it cannot mask real regrowth because a file whose guard count
    also rose is reported as a rise.
    */
    const guardsNow = currentByFile.get(f) ?? 0;
    const guardsBefore = baselineByFile.get(f) ?? 0;
    regressions.push({ file: label, count, allowed, reclassified: guardsNow <= guardsBefore });
  }
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
/*
FNXC:LifecycleColumnCensus 2026-07-30-19:10 (fleet — the baseline was serialising the fleet):
NO DERIVED AGGREGATES IN THE PIN. `totals`, `byColumnId`, `properties` and `queryByColumnId` are all
recomputable from the per-file maps, and `--strict` never read any of them — it compares `byFile`,
`deliberateByFile` and `queryByFile` and nothing else.

They were not free. Every conversion PR changes at least one aggregate line, so EVERY fleet PR
conflicted with EVERY other fleet PR in this file even when they converted different files. Six of my
own branches were rebased for nothing but this, and the resolution was always "take main's, re-run
--update-baseline" — never a real merge. Two PRs converting different files now touch disjoint lines.

TRADE-OFF, stated because it undoes a deliberate choice: an earlier note kept the totals here so the
new number would appear in the diff where a reviewer sees it. That signal is preserved elsewhere —
the CLI prints the totals on every run, `--update-baseline` prints each tightened entry, and the
fleet rules already require a census before/after in the PR body. Reversible if the diff-visible
number turns out to matter more than the conflicts.
*/
function writeBaseline() {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({
      generatedFrom: "node scripts/lifecycle-column-census.mjs --strict --update-baseline",
      byFile: Object.fromEntries(summary.byFile),
      deliberateByFile: Object.fromEntries(summary.deliberateByFile ?? []),
      queryByFile: Object.fromEntries(summary.queryByFile),
    }, null, 2)}\n`,
  );
}

if (updateBaseline) {
  /* Refuse to regenerate ON TOP of a corrupt file: the run would die inside the strict comparison
     below and leave the corruption staged, which is exactly how it reached CI twice. */
  if (existsSync(BASELINE_PATH)) readBaselineOrExplain();
  writeBaseline();
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
  const reclassifiedOnly = regressions.every((r) => r.reclassified === true);
  console.error(
    reclassifiedOnly
      ? "\nlifecycle-column-census --strict: sites were RECLASSIFIED as DELIBERATE-LITERAL\n"
      : "\nlifecycle-column-census --strict: column-guard count ROSE\n",
  );
  for (const r of regressions) {
    const tag = r.kind === "query" ? " (query filter)" : r.reclassified ? " (reclassified, not new debt)" : "";
    console.error(`  ${r.file}${tag}: ${r.allowed} -> ${r.count}`);
  }
  console.error(
    reclassifiedOnly
      /*
      The whole failure here is a bookkeeping step, and the original message actively misdirected: it
      announced a RISE for a change that does not raise unconverted debt, so the reader went hunting
      for a regression that does not exist.

      FNXC:LifecycleColumnCensus 2026-07-30-20:30 (#2811 review — coderabbit):
      "did NOT increase", not "went DOWN". `reclassified` is `guardsNow <= guardsBefore`, so it is TRUE
      when the guard count is UNCHANGED — which is exactly what adding a DELIBERATE-LITERAL marker to a
      site the parser already excluded produces. Claiming a decrease there is a second wrong number in
      a message whose whole purpose is to stop the reader chasing one.
      */
      ? "\nUnconverted debt did NOT increase — a marker moved these sites out of the guard count.\n" +
        "The baseline records both totals, so it must be re-recorded in the same change:\n\n" +
        "  node scripts/lifecycle-column-census.mjs --strict --update-baseline\n"
      : "\nResolve a lifecycle column from the task's own workflow (resolveLifecycleColumns /\n" +
        "resolveTaskLifecycleColumns) instead of comparing its name. If the literal is genuinely\n" +
        `correct, record why at the site with a ${"DELIBERATE-LITERAL"} marker.\n` +
        /*
        FNXC:LifecycleColumnCensus 2026-07-31-09:10 (placement is the failure nobody sees):
        A marker in the wrong POSITION is indistinguishable from no marker, and the miss is silent until
        CI. Measured on #2883: the marker sat inline in the middle of a conditional expression, attached
        to the wrong node, and three reviewed literals scored as new debt (self-healing.ts 86 -> 89).

        The second line is here because `pnpm lint` does NOT run this script — CI's Lint job does — so
        the usual "lint passed locally" loop cannot catch either mistake.
        */
        `\nPut the ${"DELIBERATE-LITERAL"} marker in the DECLARATION's leading comments, not inline in an\n` +
        "expression: markers are read from a node's leading comments, so a mid-expression one attaches to\n" +
        "the wrong node and is silently ignored. Hoist the literal into a named helper if you need to.\n" +
        "Note that `pnpm lint` does NOT run this census — run it explicitly before pushing.\n",
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
  /*
  FNXC:LifecycleColumnCensus 2026-08-01-02-30 (coordinator item 2 — the ratchet must FOLLOW THE COUNT DOWN):
  A DROP TIGHTENS THE BASELINE INSTEAD OF FAILING. The old behaviour failed hard, and the reasoning was sound
  in isolation — a stale allowance is a hole, since those guards can return up to the old count while the
  check stays green. What it missed is that the drop is almost never the author's to fix: eleven files dropped
  during one merge wave, none of those PRs re-recorded, and none of their authors did anything wrong. Measured
  three separate times since CI began gating this (`columnRoles.ts` 0->1, then `executor.ts` twice).

  A PERMANENTLY-RED GATE IS A BIGGER HOLE THAN A STALE ALLOWANCE, because it gets ignored and then nothing is
  guarded at all. So the ceiling now follows the count down automatically and says so, while the RISE check —
  the actual purpose, "no new guards" — still fails hard and untouched.

  THE RESIDUAL, named rather than glossed: in CI the write is discarded with the runner, so the committed
  baseline stays stale until someone commits a tightened one. The exposure is bounded (regrowth only up to the
  old count) and printed on every run, and it is strictly smaller than the exposure from a check people route
  around. `--exact` keeps hard failure for the end state, when the count is meant to be pinned and any
  divergence is a real event.
  */
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-12:10 (PR #2679 review — greptile P1):
  A TOUCHED FILE MUST BE RE-RECORDED; AN UNTOUCHED ONE IS AUTO-TIGHTENED.

  The residual named below is real: in CI the tightening write is discarded with the runner, so the
  committed allowance stays stale and a later change can regrow guards up to it while the gate is
  green. Naming that is not closing it.

  This closes it where the regrowth would have to happen. Regrowing a guard means EDITING the file,
  so requiring an exact baseline only for files the change TOUCHES makes the hole unreachable — while
  the case this PR exists for stays green, because those authors did not touch the files that dropped
  (eleven files dropped in one merge wave; none of those authors did anything wrong).

  Falls back to the lenient path when no base ref resolves, so a detached or shallow checkout
  degrades to the previous behaviour rather than failing closed on a git detail.
  */
  let touched = new Set();
  /*
  The touched set is overridable for the same reason BASELINE_PATH is: otherwise this branch can only
  be tested against whatever the CURRENT branch happens to have changed, so the test's outcome would
  depend on the diff of the PR running it. Production never sets it.
  */
  if (process.env.FUSION_CENSUS_TOUCHED_PATHS !== undefined) {
    touched = new Set(process.env.FUSION_CENSUS_TOUCHED_PATHS.split(",").map((f) => f.trim()).filter(Boolean));
  } else {
    try {
      const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main";
      touched = new Set(
        execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .split("\n").map((f) => f.trim()).filter(Boolean),
      );
    } catch {
      /* No usable base ref — leave `touched` empty so every entry takes the lenient path. */
    }
  }

  const staleTouched = stale.filter((entry) => touched.has(entry.file));
  if (staleTouched.length > 0) {
    console.error(
      "\nlifecycle-column-census --strict: this change TOUCHES files whose guard count dropped, so the\n"
      + "baseline must be re-recorded in this change — otherwise the allowance stays open for regrowth.\n",
    );
    for (const entry of staleTouched) {
      console.error(`  ${entry.file}: allows ${entry.allowed}, tree has ${entry.count}`);
    }
    console.error("\nRe-record it:\n\n  node scripts/lifecycle-column-census.mjs --strict --update-baseline\n");
    process.exit(1);
  }

  const lines = stale.map((entry) => `  ${entry.file}: allows ${entry.allowed}, tree has ${entry.count}`);
  if (exact) {
    console.error("\nlifecycle-column-census --strict --exact: baseline is STALE — it allows more than the tree has\n");
    for (const line of lines) console.error(line);
    console.error("\nRe-record it:\n\n  node scripts/lifecycle-column-census.mjs --strict --update-baseline\n");
    process.exit(1);
  }
  writeBaseline();
  console.log("\nlifecycle-column-census --strict: baseline TIGHTENED — the tree has fewer guards than it allowed\n");
  for (const line of lines) console.log(line);
  console.log(
    "\nThe baseline file has been rewritten downward. COMMIT IT so the allowance cannot be regrown into;\n"
    + "in CI this write is discarded with the runner, which is why the gate is green and not silent.\n",
  );
  process.exit(0);
}

console.log("\nlifecycle-column-census --strict: every file matches its baseline exactly.");
process.exit(0);
