#!/usr/bin/env node
/*
FNXC:LifecycleColumnCensus 2026-07-29-22:10:
The workflow-owned-lifecycle program's completion bar is a NUMBER: hard-coded lifecycle-column
comparisons in shipped source must reach zero. That number was being taken by ad-hoc `git grep`, and
ad-hoc greps of this shape fail SILENTLY LOW. Two independent false readings hit during one session:

  1. A `git grep -E` pattern using the Perl shorthand for whitespace matches NOTHING: that
     shorthand is not POSIX ERE, and git grep does not error on it — it reports 0 hits and exit 1,
     which reads exactly like "clean". Use a POSIX bracket class.
  2. A pathspec of the shape `packages/<star>/src/<doublestar>/<star>.ts` silently EXCLUDES every
     file sitting directly under `src/`, because wildmatch's doublestar requires a directory level to
     consume. That dropped self-healing.ts — the single largest holder of these guards — plus four
     more files, reporting 11 where the truth was 25. (Spelled out rather than written literally: the
     glob contains a comment-terminating sequence, which is its own small lesson.)

Both readings looked like progress. This script exists so the bar is measured once, correctly, by
something that fails loudly when it is measuring nothing:

  - Comments are STRIPPED before matching, so the FNXC notes that explain each conversion (which
    necessarily quote the literal they removed) do not inflate the count. Raw grep reports 30 today
    where only 25 are code.
  - The file list is SELF-CHECKED: scanning implausibly few files aborts with exit 2 rather than
    reporting a clean census.
  - Per-file counts are a CEILING, not a target. A file may only ever go DOWN. New violations in a
    file at 0 fail. This is what makes it a ratchet rather than a report: it cannot pass by
    accident, and `--update` has to be run deliberately to lower a ceiling.

Usage:
  node scripts/check-lifecycle-column-literals.mjs                  # enforce the ceiling (CI)
  node scripts/check-lifecycle-column-literals.mjs --report          # print counts, never fail
  node scripts/check-lifecycle-column-literals.mjs --update          # lower the ceiling after conversions
  node scripts/check-lifecycle-column-literals.mjs --files a.ts,b.ts # scan exactly these paths

`--files` exists so this script's own ratchet test can point it at fixtures without writing to the
repository's git index (the file list otherwise comes from `git ls-files`, so a probe file would have
to be staged to be seen — a mutation no test should make in a checkout someone else is using). Files
named this way are enforced against the ledger exactly as discovered ones are: an unknown path has a
ceiling of 0, so any literal in a fixture is a regression.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, "lib", "lifecycle-column-literals.json");
/*
The repo root is derived from THIS FILE's location, never from the caller's cwd: run from
`packages/core`, a cwd-relative `git ls-files -- packages` resolves to `packages/core/packages`,
finds nothing, and the census would report a clean tree. FUSION_CENSUS_ROOT overrides it so the
self-check's abort path stays provable against an empty repository.
*/
const REPO_ROOT = process.env.FUSION_CENSUS_ROOT ?? join(HERE, "..");

/*
The lifecycle columns whose ids the program is removing from source. `triage` is the U11 casualty
(its column is deleted from the default lineage while remaining a legal STORED id per KTD-8), so a
comparison against the literal is either dead or workflow-dependent.
*/
const LITERALS = ["triage"];

/** Minimum plausible non-test source file count. Below this the file list is broken, not the tree clean. */
const MIN_FILES = 500;

/**
 * Remove comments while preserving line numbering and string literals.
 *
 * String literals are preserved on purpose: the thing being counted IS a string comparison. Only
 * commentary is removed, and only so explanatory FNXC notes quoting a removed literal do not read
 * as live violations.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // "code" | "block" | "line" | one of the quote characters
  let state = "code";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "/" && d === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue; }
      // Keep newlines so reported line numbers match the real file.
      out += c === "\n" ? "\n" : " ";
      i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    // Inside a string/template literal.
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    if (c === state) { state = "code"; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-02:45 (greptile #2623):
Accept BOTH quote styles and allow the comparison to span lines. The original pattern required a
single-line double-quoted form, so `column ===\n  'triage'` and `column === 'triage'` were invisible
and the reported count could fall without a literal being removed — a count that drops for the wrong
reason is worse than a count that is too high. `\s` spans newlines in JS regex, and the census scans
whole-file text (not line-by-line) so a split comparison is still found and still reported with the
line its `column` token sits on.
*/
function patternFor(literal) {
  return new RegExp(`column\\s*(===|!==)\\s*['"]${literal}['"]`, "g");
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-01:50:
MEMBERSHIP forms, tracked separately because the `===`/`!==` census is BLIND to them and that
blindness hid a live defect: the routine editor defaulted new tasks to `triage`, a column U11
deleted, and no count showed it. A hardcoded set of column ids gates behaviour exactly as a
comparison does — `new Set(["triage", "todo"])`, `[...].includes(col)`, `switch (col) case "triage"`,
and a plain `?? "triage"` default.

Reported and ratcheted SEPARATELY from the comparison count rather than folded into it: the tracked
bar is the comparison number, and silently inflating it would make the program's progress metric
jump for reasons unrelated to anyone's conversion work. This category exists to stop NEW ones
appearing, not to add work — most current entries are legitimate (explicitly-named LEGACY_* fallback
sets, i18n display keys, agent-role prose that merely contains the word).
*/
const MEMBERSHIP_PATTERNS = (literal) => [
  new RegExp(`new Set\\(\\[[^\\]]*"${literal}"`),
  new RegExp(`\\[[^\\]]*"${literal}"[^\\]]*\\]\\s*\\.\\s*(includes|indexOf|some)`),
  new RegExp(`(includes|has)\\(\\s*"${literal}"\\s*\\)`),
  new RegExp(`case\\s+"${literal}"`),
  new RegExp(`\\?\\?\\s*"${literal}"`),
];

export function membershipCensusFor(files, readFile = (f) => readFileSync(resolve(REPO_ROOT, f), "utf-8")) {
  const perFile = new Map();
  for (const file of files) {
    const stripped = stripComments(readFile(file));
    const hits = [];
    stripped.split("\n").forEach((line, index) => {
      for (const literal of LITERALS) {
        if (MEMBERSHIP_PATTERNS(literal).some((re) => re.test(line))) {
          hits.push({ line: index + 1, literal });
          break;
        }
      }
    });
    if (hits.length > 0) perFile.set(file, hits);
  }
  return perFile;
}

/*
Paths from `git ls-files` are REPO-RELATIVE, so they must be resolved against the repo root, not the
process cwd — a vitest worker (or any invocation from a subdirectory) has a different cwd and every
read would ENOENT. Reporting and ledger keys stay repo-relative so the ledger is stable.
*/
export function censusFor(files, readFile = (f) => readFileSync(resolve(REPO_ROOT, f), "utf-8")) {
  const perFile = new Map();
  for (const file of files) {
    const stripped = stripComments(readFile(file));
    const hits = [];
    for (const literal of LITERALS) {
      const pattern = patternFor(literal);
      let match;
      // Whole-file scan, so a comparison split across lines is not missed.
      while ((match = pattern.exec(stripped)) !== null) {
        const line = stripped.slice(0, match.index).split("\n").length;
        hits.push({ line, literal });
      }
    }
    hits.sort((a, b) => a.line - b.line);
    if (hits.length > 0) perFile.set(file, hits);
  }
  return perFile;
}

function listSourceFiles() {
  let listed;
  try {
    listed = execSync("git ls-files -- packages", {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // No git, or not a repository. Report NOTHING rather than an empty clean census; the
    // MIN_FILES self-check below turns this into a loud abort.
    return [];
  }
  return listed
    .split("\n")
    /*
    `packages/dashboard/app/` is SHIPPED SOURCE, not a scratch directory — the board components live
    there. An earlier revision of this filter matched only `/src/` and therefore missed ~18 guards in
    ListView/TaskCard/TaskDetailModal/Column, reporting 21 where the tracked total was 39. That is the
    same false-low this script exists to prevent, so the roots are named explicitly rather than
    inferred from a single path segment.
    */
    .filter((f) => f
      && (/\/src\//.test(f) || /^packages\/[^/]+\/app\//.test(f))
      && /\.tsx?$/.test(f)
      && !f.includes("__tests__")
      && !/\.d\.ts$/.test(f));
}

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf-8"));
  } catch {
    return { note: "", ceilings: {} };
  }
}

function main() {
  const mode = process.argv.includes("--update")
    ? "update"
    : process.argv.includes("--report") ? "report" : "enforce";

  const filesFlagIndex = process.argv.indexOf("--files");
  const explicitFiles = filesFlagIndex === -1
    ? undefined
    : (process.argv[filesFlagIndex + 1] ?? "").split(",").filter(Boolean);

  const files = explicitFiles ?? listSourceFiles();
  // The self-check applies only to the DISCOVERED list; an explicit list is deliberate by definition.
  if (!explicitFiles && files.length < MIN_FILES) {
    console.error(
      `CENSUS ABORTED: only ${files.length} non-test source files matched (expected >= ${MIN_FILES}).\n`
      + "The file list is broken — this is NOT evidence the tree is clean.",
    );
    process.exit(2);
  }

  const perFile = censusFor(files);
  const counts = Object.fromEntries([...perFile].map(([f, hits]) => [f, hits.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const sorted = [...perFile].sort((a, b) => b[1].length - a[1].length);
  for (const [file, hits] of sorted) {
    console.log(`${String(hits.length).padStart(3)}  ${file}  (lines ${hits.map((h) => h.line).join(", ")})`);
  }
  console.log(`\nscanned ${files.length} non-test source files`);
  console.log(`CODE-ONLY TOTAL: ${total}`);

  const membership = membershipCensusFor(files);
  const membershipCounts = Object.fromEntries([...membership].map(([f, hits]) => [f, hits.length]));
  const membershipTotal = Object.values(membershipCounts).reduce((a, b) => a + b, 0);
  console.log(`MEMBERSHIP-FORM TOTAL (tracked separately, not part of the bar): ${membershipTotal}`);

  if (mode === "report") return;

  if (mode === "update") {
    if (explicitFiles) {
      console.error("refusing to rewrite the ledger from an explicit --files list: it would drop every ceiling not named.");
      process.exit(2);
    }
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-02:40 (greptile #2623):
    `--update` may only ever LOWER a ceiling. It used to write the current counts verbatim, so a
    developer who ADDED a literal and then ran the documented update command locked the regression in
    as the new ceiling, and enforcement thereafter called the regressed tree clean. That is a ratchet
    that silently releases — the exact failure mode this file exists to prevent, in the file itself.
    */
    const existing = readLedger();
    const raised = [
      ...Object.entries(counts).filter(([f, c]) => c > ((existing.ceilings ?? {})[f] ?? 0))
        .map(([f, c]) => ({ f, c, was: (existing.ceilings ?? {})[f] ?? 0, kind: "comparison" })),
      ...Object.entries(membershipCounts).filter(([f, c]) => c > ((existing.membershipCeilings ?? {})[f] ?? 0))
        .map(([f, c]) => ({ f, c, was: (existing.membershipCeilings ?? {})[f] ?? 0, kind: "membership" })),
    ];
    if (raised.length > 0) {
      console.error("refusing to RAISE a ceiling — --update may only lower one. These files gained literals:");
      for (const r of raised) console.error(`  ${r.f}: ${r.c} > ${r.was} [${r.kind}]`);
      console.error("\nRemove the literals, or if one is genuinely load-bearing edit the ledger by hand\nwith the reason in the commit message so the raise is a reviewed decision.");
      process.exit(2);
    }
    writeFileSync(LEDGER_PATH, `${JSON.stringify({
      note: "Per-file CEILINGS for hard-coded lifecycle-column comparisons. A file may only go DOWN. "
        + "Regenerate with `node scripts/check-lifecycle-column-literals.mjs --update` in the same commit "
        + "as the conversions that lower it.",
      literals: LITERALS,
      total,
      ceilings: counts,
      membershipTotal,
      membershipCeilings: membershipCounts,
    }, null, 2)}\n`);
    console.log(`\nledger updated: ${LEDGER_PATH}`);
    return;
  }

  const ledger = readLedger();
  const ceilings = ledger.ceilings ?? {};
  const regressions = [];
  for (const [file, count] of Object.entries(counts)) {
    const ceiling = ceilings[file] ?? 0;
    if (count > ceiling) regressions.push({ file, count, ceiling });
  }

  for (const [file, count] of Object.entries(membershipCounts)) {
    const ceiling = (ledger.membershipCeilings ?? {})[file] ?? 0;
    if (count > ceiling) regressions.push({ file, count, ceiling, kind: "membership" });
  }

  if (regressions.length > 0) {
    console.error("\nLIFECYCLE-COLUMN CENSUS REGRESSION — these files gained hard-coded column comparisons:");
    for (const r of regressions) {
      console.error(`  ${r.file}: ${r.count} (ceiling ${r.ceiling})${r.kind === "membership" ? " [membership form: a hardcoded column-id set/case/default]" : ""}`);
    }
    console.error(
      "\nResolve the column from the task's workflow instead of comparing against a literal id.\n"
      + "If the literal is genuinely load-bearing (e.g. a KTD-8 legacy-row allowance), say why in a\n"
      + "comment and raise that file's ceiling deliberately with --update.",
    );
    process.exit(1);
  }

  const improved = Object.entries(ceilings).filter(([file, ceiling]) => (counts[file] ?? 0) < ceiling);
  if (improved.length > 0) {
    console.log("\nBelow ceiling (run --update in your conversion commit to lock the gain in):");
    for (const [file, ceiling] of improved) console.log(`  ${file}: ${counts[file] ?? 0} < ${ceiling}`);
  }
  console.log("\ncensus OK — no file exceeds its ceiling");
}

if (process.argv[1] && process.argv[1].endsWith("check-lifecycle-column-literals.mjs")) main();
