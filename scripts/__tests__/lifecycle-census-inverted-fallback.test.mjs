/*
FNXC:LifecycleColumnCensus 2026-07-30-22:40:

THE CENSUS HEADER SAID "0 ARE TRAIT-FALLBACK BRANCHES" WHILE SITES OF THAT SHAPE EXISTED.

Only `cond ? trait : literal` was recognised. The other spelling — a NEGATIVE test with the literal on
the TRUE side — is what a caller writes once it hoists its resolved lanes:

  completeLanes === undefined ? columnId === "done" : completeLanes.includes(columnId)

That is a fully converted resolver whose degraded arms were reported as unconverted debt, so the
backlog read higher than the remaining work and a reader chasing it was sent to correct lines.

BOTH GUARDS BELOW EXIST BECAUSE I BROKE THEM WHILE WRITING THE FIX, and each failure ran in the
dangerous direction — marking a LIVE line "already converted":

  - widening the shared `testsTraitData` predicate fed the ancestor-walking rules too, which then
    excused a step-STATUS comparison in `register-task-workflow-routes.ts:941`;
  - letting the new rule walk ancestors excused any literal inside a block governed by a negative
    lane test.

So the rule is immediate-parent-only and its widened identifier match is local to it.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { findComparisons } from "../lib/lifecycle-column-census-ast.mjs";

const fallbacks = (src) =>
  findComparisons("t.ts", src).filter((f) => f.traitFallback).map((f) => f.columnId);

test("an inverted fallback — negative test, literal on the TRUE branch — is recognised", () => {
  const src = 'const c = completeLanes === undefined ? columnId === "done" : completeLanes.includes(columnId);';
  assert.deepEqual(fallbacks(src), ["done"]);
});

test("the classic form still counts", () => {
  const src = 'const c = columnFlags ? columnFlags.complete : columnId === "done";';
  assert.deepEqual(fallbacks(src), ["done"]);
});

test("a POSITIVE condition with the literal on the true branch is a LIVE guard, not a fallback", () => {
  /* The direction that must not be excused: nothing here says the trait data was absent. */
  const src = 'const c = columnFlags ? columnId === "done" : other;';
  assert.deepEqual(fallbacks(src), []);
});

test("a lane test does NOT excuse a literal elsewhere in the same block", () => {
  /*
  The ancestor-walk over-reach. `step.status === "done"` is not a column guard at all, and letting the
  new rule climb marked exactly this shape as converted.
  */
  const src = `
    function f() {
      if (completeLanes === undefined) {
        return steps.find((step) => step.status === "done" || step.status === "in-progress");
      }
      return null;
    }`;
  assert.deepEqual(fallbacks(src), []);
});

test("an identifier merely CONTAINING a lane word is not a lane test", () => {
  /* `\\bLanes\\b` cannot match inside `completeLanes`, which is why the suffix rule exists — but it
     must not over-reach onto unrelated names either. */
  const src = 'const c = airplanes === undefined ? columnId === "done" : other;';
  assert.deepEqual(fallbacks(src), []);
});

/*
FNXC:LifecycleColumnCensus 2026-07-30-23:20 (#2874 review — greptile P2):
A COMPOUND condition is not a simple absence test. `completeLanes === undefined || forceLegacy` has a
second disjunct that can select the true branch with lane data PRESENT, so the literal there is a live
guard. The unanchored check accepted it, which removes a real guard from the backlog — the direction
this rule exists to stop.
*/

test("a compound absence test is NOT treated as a fallback", () => {
  const src = 'const c = completeLanes === undefined || forceLegacy ? columnId === "done" : other;';
  assert.deepEqual(fallbacks(src), []);
});

test("a conjunction is refused too", () => {
  const src = 'const c = completeLanes === undefined && legacyMode ? columnId === "done" : other;';
  assert.deepEqual(fallbacks(src), []);
});

test("the simple negated form still counts", () => {
  const src = 'const c = !completeLanes ? columnId === "done" : completeLanes.includes(columnId);';
  assert.deepEqual(fallbacks(src), ["done"]);
});

test("a property-path absence test still counts", () => {
  const src = 'const c = lifecycle?.completeLanes === undefined ? columnId === "done" : other;';
  assert.deepEqual(fallbacks(src), ["done"]);
});
