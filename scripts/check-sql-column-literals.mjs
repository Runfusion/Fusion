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
const COLUMN_REF = `(?:"column"|\\bcolumn)`;
const LEGACY_ID = `'(?:${LEGACY_IDS.join("|")})'`;
/*
FNXC:LifecycleColumnCensus 2026-07-30-20:20 (#2841 review, second round — greptile P1 "IN predicates
bypass the gate"):

`IN (...)` IS A COMPARISON, AND EACH ELEMENT IS ONE.

The operator list was `=`, `!=`, `<>`, so `"column" IN ('in-progress', 'in-review')` contributed
nothing and a second predicate in that form could be added while the baseline stayed green. It is the
same false-negative class as the pre-filters removed in the first round — a shape the pattern simply
did not describe.

The IN arm counts its LEGACY ELEMENTS, not the predicate: two ids in one list is two vocabulary-bound
sites, the same accounting the `=` arm uses when a query holds two comparisons. The list body is
matched loosely (`[^)]*`) so a mixed list — a legacy id beside a resolved one — is still caught, and
the per-element count is taken from the matched text afterwards.
*/
/*
FNXC:LifecycleColumnCensus 2026-07-30-22:20 (#2841 review, third round — greptile P1 "nested IN
expressions evade scanning"):

`[^)]*` STOPS AT THE FIRST `)`, WHICH A NESTED CALL SUPPLIES.

`"column" IN (COALESCE(x, y), 'done')` never reached its legacy id: the leading `[^)]*` halted at
`COALESCE(x, y)`'s closing paren, the id after it was unreachable, and the predicate contributed
nothing. A third false negative of the same family as the first two rounds — a shape the pattern did
not describe — and the reviewer is right that another one could be added with the baseline green.

The IN body now tolerates nested groups TWO levels deep (`LOWER(COALESCE(a, b))` is the realistic
worst case in this codebase). A regex cannot balance arbitrary nesting, and the alternative — matching
the predicate head and extracting the balanced region programmatically — buys a depth nobody writes at
the cost of a second scanner to keep correct. The bound is stated here rather than hidden: at three
levels the gate under-counts again, which is a known limit, not an unknown one.
*/
const IN_BODY = `(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*`;
export const COMPARISON = new RegExp(
  `${COLUMN_REF}\\s*(?:(?:=|!=|<>)\\s*${LEGACY_ID}|(?:NOT\\s+)?IN\\s*\\(${IN_BODY}${LEGACY_ID}${IN_BODY}\\))`,
  "gi",
);
/** Legacy ids inside one matched predicate — an `IN` list can hold several. */
const LEGACY_ID_GLOBAL = new RegExp(LEGACY_ID, "gi");

/** How many vocabulary-bound sites one matched predicate represents. */
export function comparisonWeight(match) {
  LEGACY_ID_GLOBAL.lastIndex = 0;
  return (match.match(LEGACY_ID_GLOBAL) ?? []).length;
}

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
 * `.text` is decoded (`\"` becomes `"`); `.getText()` is not.
 *
 * FNXC:LifecycleColumnCensus 2026-07-30-20:35 (#2841 review, second round — greptile P1
 * "interpolated columns disappear during scanning"):
 *
 * A DRIZZLE COLUMN REFERENCE IS AN INTERPOLATION, AND DROPPING IT DROPPED THE WHOLE PREDICATE.
 *
 * The first version joined only the STATIC spans, on the reasoning that an interpolated expression
 * cannot be part of a matched comparison. That is exactly backwards for the dominant production
 * shape: a Drizzle template puts the COLUMN in the hole and the legacy id in the static text, so
 * `${schema.project.tasks.column} != VALUE` joined to text with no column identifier in it and
 * matched nothing. The merge-queue and self-healing queries this gate exists to freeze are written
 * this way, so it was blind on its primary target.
 *
 * An interpolation that NAMES a column is therefore rendered as the literal token `"column"` — the
 * spelling the pattern already looks for — and every other interpolation becomes a NUL sentinel.
 * A space would not do: `\`"column" = ${expr}'done'\`` joins to `"column" =  'done'`, a comparison
 * that is not in the source. NUL cannot appear inside any pattern here, so it breaks the splice.
 *
 * The test is the expression's TRAILING property, not a resolved type: this is a standalone script
 * with no type-checker, and an AST gate earns its place by staying cheap. A false positive costs one
 * baseline entry; the false NEGATIVE it replaces cost the gate its meaning on its own target files.
 */
const COLUMN_PROPERTY = /(?:^|\.)column$/;

export function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = span.expression.getText().trim();
      parts.push(COLUMN_PROPERTY.test(expression) ? '"column"' : "\u0000");
      parts.push(span.literal.text);
    }
    return parts.join("");
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
        for (const match of text.match(COMPARISON) ?? []) hits += comparisonWeight(match);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (hits > 0) counts[relative(REPO, file).split("\\").join("/")] = hits;
  }
  return counts;
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-21:00 (#2841 review, second round):
GUARDED ENTRY POINT, so importing this module does not RUN the gate.

`check-sql-column-literals.test.mjs` imports `COMPARISON` and `literalText` to test the matcher
directly. Without this guard the import executed the whole scan, printed the gate's report, and called
`process.exit(1)` — so the test file failed for the gate's reasons rather than its own, and while the
gate happened to be green it passed for reasons unrelated to what it asserts. A test that can be made
to pass or fail by unrelated repo state is not a test.
*/
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
}
