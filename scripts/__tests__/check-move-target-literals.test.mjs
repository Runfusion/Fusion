/*
FNXC:MoveTargetRatchet 2026-07-31-19:35 (u12 — five spellings, three rounds, zero regressions kept):

This gate has missed FIVE destination spellings across three rounds — direct/backtick (#3246),
ternary (#3250), and cast (here) — and every probe was run by hand against a throwaway file and then
thrown away, because the scanner executed on import and there was nowhere to put a test.

The root cause of the repeat is one sentence: the destination is a POSITION, and every fix so far has
enumerated NODE KINDS. A kind list is something the language extends faster than anyone guesses, so
the only durable defence is that each shape someone finds stays found. That is this file.

It pins BOTH directions deliberately. Widening a matcher is where false positives arrive: adding
`??`/`||` unwrapping flagged the fail-soft idiom
`moveTask(id, (await resolveTaskLifecycleColumns(...))?.complete ?? "done")` — the correct pattern the
whole conversion programme rests on — so the negative cases below are load-bearing, not padding.
*/
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import { countLegacyMoveTargetLiterals, destinationLiterals } from "../check-move-target-literals.mjs";

/** Parse `expr` as the second argument of a moveTask call and return the literals the gate sees. */
function literalsOf(expr) {
  const source = `declare const s: any; declare const id: string; s.moveTask(id, ${expr});`;
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;
  const walk = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && found === null) {
      found = destinationLiterals(node.arguments[1]);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  assert.notEqual(found, null, `probe did not parse: ${expr}`);
  return found;
}

test("catches a direct string destination", () => {
  assert.deepEqual(literalsOf('"in-review"'), ["in-review"]);
});

test("catches a no-substitution template destination", () => {
  assert.deepEqual(literalsOf("`archived`"), ["archived"]);
});

test("catches BOTH arms of a ternary destination", () => {
  assert.deepEqual(literalsOf('ok ? "done" : "in-review"'), ["done", "in-review"]);
});

test("catches a nested ternary", () => {
  assert.deepEqual(literalsOf('a ? (b ? "archived" : "todo") : "done"'), ["archived", "todo", "done"]);
});

test("catches through parentheses", () => {
  assert.deepEqual(literalsOf('("todo")'), ["todo"]);
});

test("catches an `as` cast — the idiomatic spelling where the parameter is typed ColumnId", () => {
  assert.deepEqual(literalsOf('"done" as ColumnId'), ["done"]);
});

test("catches a cast wrapping a ternary", () => {
  assert.deepEqual(literalsOf('(ok ? "done" : "todo") as ColumnId'), ["done", "todo"]);
});

/*
The negative half. Each of these was either a real false positive that shipped and was fixed, or one
that arrived while widening the matcher and had to be backed out.
*/
test("does NOT report a resolved destination", () => {
  assert.deepEqual(literalsOf("lanes.complete"), []);
});

test("does NOT report a `??` fallback — that is the fail-soft idiom, not a defect", () => {
  // Adding `??` unwrapping flagged branch-and-pr-entities.ts:653, which resolves first and falls back
  // to the legacy id exactly as the role helpers degrade. Flagging it would demand a marker on every
  // safe fallback, and a marker applied by habit is how the next real literal walks through.
  assert.deepEqual(literalsOf('resolved?.complete ?? "done"'), []);
});

test("does NOT report a `||` fallback", () => {
  assert.deepEqual(literalsOf('resolved || "todo"'), []);
});

test("does NOT report a template with substitution", () => {
  assert.deepEqual(literalsOf("`${prefix}-done`"), []);
});

/*
FNXC:MoveTargetRatchet 2026-08-01-04:24:
FN-8657's measured product population is zero, so these in-memory fixtures make the zero ratchet
non-vacuous: a renamed-board-breaking literal must remain observable without adding unsafe product code.
The audit found moveTaskInternal private to moves.ts; its positive case stays pinned because the scanner
intentionally provides stronger defense-in-depth than the public moveTask-only contract requires.
*/
test("counts legacy-literal move destinations in scanner fixtures", () => {
  const fixture = `
    store.moveTask(id, "done");
    store.moveTask(id, ok ? "todo" : "in-review");
    store.moveTask(id, ("archived"));
    store.moveTask(id, "triage" as ColumnId);
    store.moveTask(id, resolved?.complete ?? "done");
    store.moveTask(id, resolved || "todo");
  `;
  assert.equal(countLegacyMoveTargetLiterals(fixture), 4);
});

test("counts moveTaskInternal destinations as defense-in-depth", () => {
  assert.equal(countLegacyMoveTargetLiterals('store.moveTaskInternal(id, "done", {}, {});'), 1);
});

test("only a leading DELIBERATE-LITERAL comment exempts a destination", () => {
  assert.equal(countLegacyMoveTargetLiterals('/* DELIBERATE-LITERAL */\nstore.moveTask(id, "todo");'), 0);
  assert.equal(countLegacyMoveTargetLiterals('store.moveTask(id, "todo"); /* DELIBERATE-LITERAL */'), 1);
});

test("extracts a renamed lane too — legacy filtering is the CALLER's job, not this function's", () => {
  /*
  Written expecting `[]` and corrected after it returned `["drafting"]`. `destinationLiterals` answers
  "what literal strings could this destination be", and the call site then asks
  `LEGACY_COLUMN_IDS.has(...)`. Keeping the split matters: a future change that filters here would
  make the extractor silently vocabulary-aware, and the next shape added would need the legacy list
  threaded into it to work at all.
  */
  assert.deepEqual(literalsOf('"drafting"'), ["drafting"]);
});
