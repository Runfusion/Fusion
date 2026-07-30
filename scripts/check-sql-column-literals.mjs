#!/usr/bin/env node
/*
FNXC:LifecycleColumnCensus 2026-07-30-09:30:
FREEZE THE SQL SURFACE — a legacy column id inside a query string is invisible to every other check.

The lifecycle-column census parses TypeScript COMPARISONS. A legacy id inside a SQL string is not a
comparison, it is string data, so the census has never counted these. The inert-seam gate reasons
about parameters and call sites, so it cannot see them either. The surface was uninstrumented.

WHAT IT COST. `cleanupStaleMergeQueueRowsImpl` filtered on `t.column != 'in-review'`. On a board with
a renamed review lane every queued card looked stale, its merge_queue row was deleted, and the card
became unleaseable. Found by the operator reviewing #2819 — in SQL that had already been read past
during that same work, because nothing draws the eye to a literal inside a query.

The analytics group is the quieter half: five sites count `"column" = 'done'`, so on a renamed board
throughput, cycle time, and team dashboards report zero completed work. Nothing errors. Wrong-but-
plausible numbers are the least likely defect for anyone to file.

WHAT THIS DOES. It does NOT fix the existing sites — `resolveProjectColumnsForRoles`
(core/src/project-lane-vocabulary.ts) is the mechanism for that and its migration has an owner (see
issue #2839). This freezes the population so the surface cannot grow while that migration runs: the
baseline records per-file counts, a new file or a higher count fails, and a LOWER count fails too so
the baseline is ratcheted down as sites are migrated rather than silently drifting.

COMMENTS ARE NOT MATCHED, and that is the whole reason this is AST-based. A line-oriented grep for
the same pattern reports 37 hits, 25 of which are prose quoting `column === "done"` in an explanatory
note. A guard with a 68% false-positive rate teaches its readers to skip it, and this repo already
learned that lesson the expensive way. Comments are not AST nodes, so walking string and template
literals cannot match them at all.
*/
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(REPO, "packages");
const BASELINE = join(REPO, "scripts", "lib", "sql-column-literals-baseline.json");
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__", "e2e", ".gate-bundle", "coverage"]);

/** The pre-workflow column ids. A query comparing a column to one of these is board-vocabulary-bound. */
const LEGACY_IDS = ["todo", "in-progress", "in-review", "done", "archived", "triage"];
/*
GLOBAL, because the unit of measurement is the COMPARISON, not the literal — two legacy comparisons
in one query must count as two. No file currently has that shape (every matching literal holds
exactly one), so this is defensive rather than a recorded incident; it is the same class as the
one-supplier floor the inert-seam gate had to fix, and cheaper to get right now than to discover.
*/
export const COMPARISON = new RegExp(`(?:"column"|\\bcolumn)\\s*(?:=|!=|<>)\\s*'(?:${LEGACY_IDS.join("|")})'`, "gi");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full) && !/\.d\.ts$/.test(full)) yield full;
  }
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-19:10 (#2841 review — greptile x2 + coderabbit x2, one root cause):

THE PRE-FILTERS WERE THE HOLE, SO THEY ARE GONE.

Four findings arrived against three lines and all reduce to the same mistake: deciding whether to RUN
the comparison regex, using cheaper patterns that disagree with it.

  - A FILE-LEVEL `SQL_SHAPE.test(source)` short-circuit skipped whole files. A file holding only a
    clause fragment (`"column" = 'done'`) has no SELECT/WHERE anywhere, so a new forbidden site could
    be added to it and the gate passed. The exact shape the fragment carve-out below was added for,
    reintroduced one level up.
  - `BARE_CLAUSE` is anchored `^...$`, so a qualified or compound fragment — `t."column" = 'done'`,
    `("column" = 'done' OR active = 1)` — matched neither it nor `SQL_SHAPE`, and the comparison never
    ran.
  - `node.getText()` returns SOURCE text, so a double-quoted TypeScript string spells the identifier
    `\"column\"` with the backslashes intact, and every pattern here expects the decoded `"column"`.

A gate whose false-NEGATIVES are this easy to construct is worse than no gate, because the baseline it
prints reads as coverage. The fix is to stop pre-filtering: run `COMPARISON` — which is already
unanchored and already the definition of a forbidden site — over the DECODED text of every string and
template literal. One pattern, one answer, nothing to disagree with.

THE FALSE-POSITIVE ARGUMENT SURVIVES INTACT, because it never depended on the pre-filters: comments
are not AST nodes, so walking literals cannot match prose no matter how permissive the pattern is.
That is what makes dropping them safe.

`SQL_SHAPE` and `BARE_CLAUSE` are deleted rather than left unused — an unused pattern in a gate is an
invitation to re-add a filter that uses it.
*/

/**
 * The DECODED content of a string or template literal, or null for any other node.
 *
 * `.text` is decoded (`\"` becomes `"`); `.getText()` is not. For a template WITH interpolations the
 * decoded content lives in `head` plus each span's literal, so those are concatenated with a space —
 * the interpolated expression cannot be part of a matched comparison anyway, and joining with a space
 * rather than nothing prevents two fragments from being spliced into a false match across the hole.
 */
export function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return null;
}

/** Per-file counts of SQL literals comparing a task column to a legacy id. */
function scan() {
  const counts = {};
  for (const file of walk(PACKAGES)) {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let hits = 0;
    const visit = (node) => {
      const text = literalText(node);
      if (text !== null) {
        COMPARISON.lastIndex = 0;                         // a /g regex carries state between calls
        hits += (text.match(COMPARISON) ?? []).length;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (hits > 0) counts[relative(REPO, file).split("\\").join("/")] = hits;
  }
  return counts;
}

const found = scan();

if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  console.log(`[check-sql-column-literals] baseline written: ${total} site(s) in ${Object.keys(found).length} file(s)`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error("[check-sql-column-literals] missing baseline; run with --update-baseline");
  process.exit(1);
}

const problems = [];
for (const [file, count] of Object.entries(found)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    problems.push(`  ${file}: ${count} SQL column literal(s), baseline allows ${allowed}`);
  }
}
/*
A count that DROPPED is also a failure, deliberately. A migrated site that leaves its baseline entry
behind is a slot the surface can silently regrow into later — the same rot as an allow-list entry for
a deleted function, which this repo hit once already.
*/
for (const [file, allowed] of Object.entries(baseline)) {
  const count = found[file] ?? 0;
  if (count < allowed) {
    problems.push(`  ${file}: ${count} site(s) now, baseline still allows ${allowed} — re-record it (--update-baseline)`);
  }
}

if (problems.length > 0) {
  console.error("\n[check-sql-column-literals] SQL column-literal population changed:\n");
  for (const line of problems.sort()) console.error(line);
  console.error(
    "\nA legacy column id inside a query string is invisible to the lifecycle census and to the\n"
    + "inert-seam gate. Resolve the lane instead — `resolveProjectColumnsForRoles(store, roles)` in\n"
    + "core/src/project-lane-vocabulary.ts returns the column set for a role across all workflows.\n"
    + "If a count went DOWN, re-record the baseline in the same commit.\n",
  );
  process.exit(1);
}

const total = Object.values(found).reduce((a, b) => a + b, 0);
console.log(`[check-sql-column-literals] ${total} known SQL column literal(s), none added.`);
