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
