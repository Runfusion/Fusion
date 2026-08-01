// Unit coverage for the lane-wiring census's "is this argument actually supplied?" rules.
/*
FNXC:LaneWiring 2026-07-30-23:55:
THESE TWO RULES DECIDE WHETHER A SEAM COUNTS AS WIRED, and until now nothing tested them.

Both census arms used to ask whether the lane argument was PRESENT rather than whether it carried
anything, so `{ reviewColumns: undefined }` and a trailing positional `undefined` both read as wired
while the callee received nothing. That is the one failure mode a ratchet must not have: it reports
coverage it does not have.

The NEGATIVES are the load-bearing half. Shorthand (`{ reviewColumns }`) forwards a variable whose
value is not knowable from syntax, and treating it as unwired would flag every correct forwarding
wrapper in the tree — a false-positive wave is how a gate trains its readers to skip it. Only a
literal `undefined` / `void 0` is provably empty.
*/
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suppliesAValue,
  effectiveArgCount,
  findLaneAcceptingFunctions,
  findUnwiredCallSites,
} from "../lib/lane-wiring-census.mjs";

/** One throwaway .ts file, so the census runs end-to-end rather than on a hand-built node. */
function fixture(source) {
  const file = join(mkdtempSync(join(tmpdir(), "lane-wiring-")), "f.ts");
  writeFileSync(file, source);
  return [file];
}

function firstObjectProperty(source) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = null;
  const visit = (node) => {
    if (!found && ts.isObjectLiteralExpression(node) && node.properties.length > 0) found = node.properties[0];
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function callArgs(source) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = null;
  const visit = (node) => {
    if (!found && ts.isCallExpression(node)) found = node.arguments;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Run the whole census over one throwaway source and return its unwired sites. */
function findUnwiredCallSitesIn(source) {
  const files = fixture(source);
  return findUnwiredCallSites(files, findLaneAcceptingFunctions(files));
}

test("a property spelled `undefined` supplies nothing", () => {
  assert.equal(suppliesAValue(firstObjectProperty("f({ reviewColumns: undefined });")), false);
});

test("`void 0` is the same omission spelled differently", () => {
  assert.equal(suppliesAValue(firstObjectProperty("f({ reviewColumns: void 0 });")), false);
});

test("a real value supplies", () => {
  assert.equal(suppliesAValue(firstObjectProperty("f({ reviewColumns: resolved });")), true);
});

test("SHORTHAND forwards a variable and must still count as supplied", () => {
  /* Treating this as unwired would flag every correct forwarding wrapper in the tree. */
  assert.equal(suppliesAValue(firstObjectProperty("f({ reviewColumns });")), true);
});

test("a call expression value supplies", () => {
  assert.equal(suppliesAValue(firstObjectProperty("f({ reviewColumns: resolve(store) });")), true);
});

test("a trailing positional `undefined` supplies nothing", () => {
  assert.equal(effectiveArgCount(callArgs("f(task, undefined);")), 1);
});

test("a real trailing positional argument counts", () => {
  assert.equal(effectiveArgCount(callArgs("f(task, resolved);")), 2);
});

test("a MIDDLE undefined positions the argument after it, which is real", () => {
  assert.equal(effectiveArgCount(callArgs("f(task, undefined, resolved);")), 3);
});

/*
FNXC:LaneWiring 2026-07-30-23:50 (rebase onto main): THE HELPERS ARE TESTED, THE WIRING WAS NOT.

Every case above calls `suppliesAValue` / `effectiveArgCount` directly. Deleting `&& suppliesAValue(p)`
from `findUnwiredCallSites` therefore left all of them GREEN while the fix did nothing — I found that
by mutating during the conflict resolution, not by reading.

That is the exact defect this gate exists to catch, one level up: a correct helper that nothing calls.
These two run the census END TO END so the call itself is covered.
*/
test("the census reports a call whose lane property is spelled `undefined`", () => {
  const files = fixture(`
    export function needsLanes(task: string, opts: { reviewColumns?: ReadonlySet<string> }): string { return task; }
    export function caller(): string { return needsLanes("x", { reviewColumns: undefined }); }
  `);

  const unwired = findUnwiredCallSites(files, findLaneAcceptingFunctions(files));

  assert.deepEqual(unwired.map((u) => u.fn), ["needsLanes"]);
});

test("the census does NOT report the same call once the property carries a value", () => {
  /* Paired positive: the guard must not report every options-bag call as unwired. */
  const files = fixture(`
    export function needsLanes(task: string, opts: { reviewColumns?: ReadonlySet<string> }): string { return task; }
    export function caller(): string { return needsLanes("x", { reviewColumns: new Set() }); }
  `);

  const unwired = findUnwiredCallSites(files, findLaneAcceptingFunctions(files));

  assert.deepEqual(unwired.map((u) => u.fn), []);
});

/*
FNXC:LaneWiring 2026-07-31-01:15:
CONDITIONAL shapes and NAME COLLISIONS — the third and fourth ways a wired call site stayed invisible.

Both were found the same way the earlier holes were: by using the gate and noticing it disagreed with
what the code plainly said. Three call sites wired in #2990/#3004 still counted as unwired, and a
correctly-wired call in task-priority.ts started being reported as unwired the moment a second
same-named function entered the vocabulary.

Every positive below is paired with its NEGATIVE. A shape the census merely stops flagging is not
progress — the question is whether deleting the argument still fails.
*/
const LANE_FN = "export function f(t: unknown, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, o]; }";

test("a lane passed only in a ternary's true branch counts as wired", () => {
  const unwired = findUnwiredCallSitesIn(`${LANE_FN}\nf(1, cond ? { reviewColumns: r } : {});`);
  assert.equal(unwired.length, 0);
});

test("...and a ternary supplying it in NEITHER branch is still unwired", () => {
  const unwired = findUnwiredCallSitesIn(`${LANE_FN}\nf(1, cond ? { nowMs: 1 } : {});`);
  assert.equal(unwired.length, 1);
});

test("a lane passed through a conditional spread counts as wired", () => {
  const unwired = findUnwiredCallSitesIn(`${LANE_FN}\nf(1, { ...(cond ? { reviewColumns: r } : {}) });`);
  assert.equal(unwired.length, 0);
});

test("...and a conditional spread carrying no lane is still unwired", () => {
  const unwired = findUnwiredCallSitesIn(`${LANE_FN}\nf(1, { ...(cond ? { nowMs: 1 } : {}) });`);
  assert.equal(unwired.length, 1);
});

test("two same-named lane functions MERGE rather than clobber", () => {
  /*
  The real pair: core's `computeBlockerFanoutMap(tasks, n, opts)` and the dashboard wrapper
  `computeBlockerFanoutMap(tasks, opts)`. Their lane options sit at different indices, so the last
  declaration parsed used to replace the first and every caller of the other shape was misreported.
  */
  const source = [
    "export function g(t: unknown, n: number, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, n, o]; }",
    "export function g(t: unknown, o?: { columnFlagsByTaskId?: ReadonlyMap<string, unknown> }) { return [t, o]; }",
    "g(1, 2, { reviewColumns: r });",
    "g(1, { columnFlagsByTaskId: m });",
  ].join("\n");
  assert.equal(findUnwiredCallSitesIn(source).length, 0);
});

test("...and the merge does not excuse a call passing neither shape", () => {
  const source = [
    "export function g(t: unknown, n: number, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, n, o]; }",
    "export function g(t: unknown, o?: { columnFlagsByTaskId?: ReadonlyMap<string, unknown> }) { return [t, o]; }",
    "g(1, 2, { nowMs: 1 });",
  ].join("\n");
  assert.equal(findUnwiredCallSitesIn(source).length, 1);
});

/*
FNXC:LaneWiring 2026-07-31-09:35:
SHADOWING — a call means the declaration it can actually see.

Merging same-named declarations fixed a false negative and introduced a false positive: two unrelated
functions named `resolveEffectiveExecutor` exist, one of which takes a lane answer, so every call to
the OTHER was reported unwired against a signature it never had.

The negatives matter more than the positive here. Shadowing must not become a way to disappear a
genuine unwired call: a file that declares its own EXPORTED lane-accepting function is not shadowed
by itself, and a file that declares nothing is judged normally.
*/
function unwiredAcross(sources) {
  const dir = mkdtempSync(join(tmpdir(), "lane-wiring-multi-"));
  const files = sources.map((source, index) => {
    const file = join(dir, `f${index}.ts`);
    writeFileSync(file, source);
    return file;
  });
  return findUnwiredCallSites(files, findLaneAcceptingFunctions(files));
}

test("a local declaration shadows an unrelated exported function of the same name", () => {
  const unwired = unwiredAcross([
    "export function resolveThing(t: unknown, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, o]; }",
    [
      "function resolveThing(t: unknown, s?: { quiet?: boolean }) { return [t, s]; }",
      "export function use() { return resolveThing(1, { quiet: true }); }",
    ].join("\n"),
  ]);
  assert.equal(unwired.length, 0);
});

test("...but a file declaring its OWN exported lane function is not shadowed by itself", () => {
  const unwired = unwiredAcross([
    [
      "export function resolveThing(t: unknown, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, o]; }",
      "export function use() { return resolveThing(1, { quiet: true }); }",
    ].join("\n"),
  ]);
  assert.equal(unwired.length, 1);
});

test("...and a file declaring nothing is judged against the exported signature", () => {
  const unwired = unwiredAcross([
    "export function resolveThing(t: unknown, o?: { reviewColumns?: ReadonlySet<string> }) { return [t, o]; }",
    "export function use() { return resolveThing(1, { quiet: true }); }",
  ]);
  assert.equal(unwired.length, 1);
});
