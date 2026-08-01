/*
FNXC:LifecycleColumnCensus 2026-07-31-21:30:

THE CENSUS PRINTED "A NEW GUARD CANNOT LAND SILENTLY" NEXT TO A ZERO, AND TWO GUARD FORMS COULD.

The comparison walk only visits BinaryExpression, so these were invisible:

  ["done", "archived"].includes(task.column)
  switch (task.column) { case "todo": ... }

Both are lifecycle-column guards by any reading. Measured with a staged probe file: of five guard
forms injected, only the two `===`/`!==` ones moved the count. A worker converting a `===` chain into
an array membership would have scored the conversion and kept the guard.

WHY THE NEW WALKS DEMAND A POSITIVE COLUMN SIGNAL, unlike the `===` walk which counts unless the
receiver looks like a role or status: switch statements over event and state enums routinely carry
`case "done"` / `case "archived"`. A count-unless-excluded rule reported SEVEN guards in the tree, of
which six were `switch (eventName)`, `switch (state)` and `switch (event)` — phantom debt injected
into a backlog the ratchet treats as zero, and `--strict` would then have failed every other worker's
PR. The last case below is that regression, pinned.

KNOWN LIMIT, stated rather than discovered later: the positive signal is the receiver NAME, so
`switch (column.id)` — a Column object rather than a task's column — is not counted. That is a real
guard shape and it is deliberately out of scope here; widening to it is what produced the six false
positives, so it needs its own discrimination rather than a looser regex.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { findComparisons } from "../lib/lifecycle-column-census-ast.mjs";

const columnGuards = (src) =>
  findComparisons("t.ts", src).filter((f) => f.kind === "column").map((f) => f.columnId);

const kinds = (src) => findComparisons("t.ts", src).map((f) => f.kind);

test("array membership over legacy column ids counts as one column guard", () => {
  assert.deepEqual(
    columnGuards('const f = (t) => ["done", "archived"].includes(t.column);'),
    ["done"],
    "one .includes site is ONE guard — emitting one finding per legacy id would inflate the backlog",
  );
});

test("indexOf spelling counts the same as includes", () => {
  assert.deepEqual(columnGuards('const f = (t) => ["in-review"].indexOf(t.column) >= 0;'), ["in-review"]);
});

test("a switch over the column with a legacy case counts as one column guard", () => {
  assert.deepEqual(
    columnGuards('const f = (t) => { switch (t.column) { case "todo": return 1; case "done": return 2; default: return 0; } };'),
    ["todo"],
    "one switch is ONE guard however many legacy cases it lists",
  );
});

test("membership over STATUS values is not a column guard", () => {
  const src = 'const f = (t) => ["queued", "pending"].includes(t.status ?? "");';
  assert.deepEqual(columnGuards(src), [], "status vocabulary must not enter the column backlog");
  assert.ok(kinds(src).every((kind) => kind !== "column"));
});

test("switch over an event or state enum is NOT a column guard, even with overlapping case ids", () => {
  /*
  The regression that made the positive-signal rule necessary. These three shapes exist in the tree
  today and every one of them carries a legacy column id as a case label.
  */
  for (const receiver of ["eventName", "state", "event"]) {
    const src = `const f = (x) => { switch (x.${receiver}) { case "done": return 1; case "archived": return 2; default: return 0; } };`;
    assert.deepEqual(columnGuards(src), [], `switch (x.${receiver}) must not be counted as a column guard`);
  }
});

test("a DELIBERATE-LITERAL marker still excuses the new forms", () => {
  const src = [
    "const f = (t) => {",
    "  /* DELIBERATE-LITERAL: legacy board only. */",
    '  return ["done"].includes(t.column);',
    "};",
  ].join("\n");
  assert.deepEqual(columnGuards(src), [], "the new walks must honour the same escape hatch as the comparison walk");
});
