/*
FNXC:LifecycleColumnCensus 2026-07-30-19:30 (#2841 review — four findings, one root cause):

EACH BLIND SPOT THE REVIEW FOUND, PINNED AS A CASE.

The gate's first version decided whether to RUN its comparison regex, using two cheaper patterns that
disagreed with it — a file-level SQL-keyword short-circuit and an anchored whole-string clause match.
Every finding was a false NEGATIVE constructible from that disagreement, which is the worst failure
mode a gate has: the baseline it prints reads as coverage while a new forbidden site walks past.

The fix was to delete the pre-filters and run one unanchored pattern over the DECODED text of every
string and template literal. These cases are the proof, and they are written as the four shapes rather
than as one generic case so a future "optimisation" that reintroduces a pre-filter fails on the
specific shape it breaks.

The last case is the paired negative. A pattern permissive enough to catch all four must still not
match a comparison against a column id that is not legacy — otherwise the gate would freeze converted
code too, and its baseline would stop meaning anything.
*/
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import { COMPARISON, comparisonWeight, literalText } from "../check-sql-column-literals.mjs";

/** Count forbidden comparisons the way the scanner does: over decoded literal text. */
function hits(source) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let total = 0;
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null) {
      COMPARISON.lastIndex = 0;
      /* Weighted exactly as the scanner counts: an IN list of two legacy ids is two sites. */
      for (const match of text.match(COMPARISON) ?? []) total += comparisonWeight(match);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return total;
}

test("a bare clause fragment in a file with NO SQL keyword anywhere is still caught", () => {
  /*
  coderabbit's finding. The old file-level `SQL_SHAPE.test(source)` skipped the whole file before the
  clause pattern could run, so a forbidden site could be added to any file holding only fragments.
  */
  assert.equal(hits("const clauses = [`\"column\" = 'done'`];"), 1);
});

test("a QUALIFIED fragment is caught", () => {
  /* greptile's finding, and the one that was live in the repo: `workflow-analytics.ts` builds
     `t."column" = 'done'`, which the anchored whole-string pattern could not match. */
  assert.equal(hits("const clauses = [`t.\"column\" = 'done'`];"), 1);
});

test("a COMPOUND fragment is caught", () => {
  assert.equal(hits("const c = [`(\"column\" = 'done' OR active = 1)`];"), 1);
});

test("an ESCAPED identifier in a double-quoted TypeScript string is caught", () => {
  /*
  greptile's second finding. `node.getText()` returns SOURCE text, where the identifier is spelled
  `\"column\"` with backslashes intact; every pattern expects the decoded `"column"`. Reading `.text`
  is what closes it — this case fails against a `getText()` implementation.
  */
  assert.equal(hits(`const q = "\\"column\\" = 'done'";`), 1);
});

test("two forbidden comparisons in one literal count as two", () => {
  /* The unit of measurement is the comparison, not the literal. */
  assert.equal(hits("const q = `WHERE \"column\" = 'done' OR \"column\" = 'archived'`;"), 2);
});

test("a comparison against a NON-legacy column id is NOT matched", () => {
  /* The paired negative: a converted board's own vocabulary must not be frozen by this gate. */
  assert.equal(hits("const q = `WHERE \"column\" = 'shipped'`;"), 0);
});

test("prose in a comment is never matched, whatever the pattern permits", () => {
  /*
  The property that made deleting the pre-filters safe. Comments are not AST nodes, so the walk cannot
  reach them — a line-oriented grep for the same pattern reported a 68% false-positive rate on this
  repo, which is what the AST approach exists to avoid.
  */
  assert.equal(hits(`// this note mentions "column" = 'done' in prose\nconst x = 1;`), 0);
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-20:50 (#2841 review, SECOND round — two more false negatives):

The first round removed pre-filters that disagreed with the pattern. These two are shapes the pattern
never described at all, and the second is the more serious: it was blind on the gate's own primary
target.
*/

test("an IN list is a comparison, and each legacy element counts", () => {
  /*
  greptile: the operator list was `=`, `!=`, `<>`, so `"column" IN ('in-progress', 'in-review')`
  contributed nothing and a second predicate in that form could be added with the baseline green.
  Two ids in one list is two vocabulary-bound sites — the same accounting the `=` arm uses for two
  comparisons in one query. `team-analytics.ts` and `workflow-analytics.ts` each held one, unseen.
  */
  assert.equal(hits("const q = `WHERE \"column\" IN ('in-progress', 'in-review')`;"), 2);
});

test("a NOT IN list is caught too", () => {
  assert.equal(hits("const q = `WHERE \"column\" NOT IN ('done')`;"), 1);
});

test("an IN list MIXING a legacy id with a resolved one still counts the legacy one", () => {
  /* The list body is matched loosely so a partially-migrated predicate is not silently exempted. */
  assert.equal(hits("const q = `WHERE \"column\" IN ('shipped', 'done')`;"), 1);
});

test("a Drizzle template whose COLUMN is interpolated is caught", () => {
  /*
  greptile, and the finding that mattered most: production writes
  `sql\`${schema.project.tasks.column} != 'archived'\``, putting the column in the interpolation hole
  and the legacy id in the static text. Joining only the static spans produced ` != 'archived'` — no
  column identifier, no match. The merge-queue and self-healing queries this gate was built to freeze
  are written exactly this way, so it was blind on its own primary target; enabling this shape
  revealed five previously-invisible files.
  */
  const src = "const q = sql`${schema.project.tasks.column} != 'archived'`;";
  assert.equal(hits(src), 1);
});

test("a NON-column interpolation does not splice two fragments into a false match", () => {
  /*
  The paired negative for the join. Non-column holes become a SPACE rather than nothing, so the text
  on either side cannot be glued into a comparison that is not in the source.
  */
  assert.equal(hits("const q = sql`WHERE \"column\" = ${someExpr}'done'`;"), 0);
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-22:30 (#2841 review, THIRD round — greptile P1):
The third false negative of the same family: a shape the pattern did not describe. `[^)]*` stops at
the first `)`, which any nested call supplies, so the legacy id after it was unreachable.
*/

test("an IN list with a NESTED call before the legacy id is caught", () => {
  assert.equal(hits("const q = `WHERE \"column\" IN (COALESCE(x, y), 'done')`;"), 1);
});

test("an IN list nested TWO levels deep is caught", () => {
  /* The realistic worst case in this codebase, and the documented bound of the pattern. */
  assert.equal(hits("const q = `WHERE \"column\" IN (LOWER(COALESCE(a, b)), 'archived')`;"), 1);
});

test("a nested IN list of only NON-legacy ids is still not matched", () => {
  /* The paired negative: tolerating nesting must not turn every IN predicate into a hit. */
  assert.equal(hits("const q = `WHERE \"column\" IN (COALESCE(x, y), 'shipped')`;"), 0);
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-17:30 (#2841 review, FOURTH round — greptile P1):
The same blindness as the static-span join, reachable by changing punctuation: a column reference
written with brackets rather than a dot fell through to the NUL sentinel and its predicate vanished.
*/

test("a bracket-access column reference in a Drizzle template is caught", () => {
  assert.equal(hits('const q = sql`${schema.project.tasks["column"]} != \'archived\'`;'), 1);
});

test("a backtick bracket-access reference is caught", () => {
  assert.equal(hits("const q = sql`${t[`column`]} = 'done'`;"), 1);
});

test("a bracket access to a DIFFERENT property is not treated as a column", () => {
  /* The paired negative: widening to any bracket access would make every interpolation a column. */
  assert.equal(hits('const q = sql`${schema.project.tasks["title"]} = \'done\'`;'), 0);
});
