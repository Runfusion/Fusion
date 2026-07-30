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

import { COMPARISON, literalText } from "../check-sql-column-literals.mjs";

/** Count forbidden comparisons the way the scanner does: over decoded literal text. */
function hits(source) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let total = 0;
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null) {
      COMPARISON.lastIndex = 0;
      total += (text.match(COMPARISON) ?? []).length;
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
