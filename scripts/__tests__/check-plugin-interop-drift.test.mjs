/*
FNXC:PluginInteropDrift 2026-07-31-07:35:
THE NON-FUNCTION EXPORT RULE IS WHAT KEEPS THIS CHECK CREDIBLE.

Its first run reported `TaskCard` as a function the dashboard no longer exports. It exports it as
`export const TaskCard = memo(TaskCardComponent, ...)` — present, but with an arity that belongs to a
wrapped component rather than to the export. A check whose debut finding is a false positive does not
get a second reading, so the distinction between ABSENT and NOT-COMPARABLE is pinned here.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { exportedFunctions } from "../check-plugin-interop-drift.mjs";

const parse = (src) => exportedFunctions(src, "t.tsx");

test("an exported function declaration reports its arity", () => {
  const found = parse("export function f(a, b, c) { return a; }");
  assert.deepEqual(found.get("f"), { total: 3, required: 3 });
});

test("optional and defaulted parameters are not required", () => {
  const found = parse("export function f(a, b?, c = 1, ...rest) { return a; }");
  assert.deepEqual(found.get("f"), { total: 4, required: 1 });
});

test("an exported arrow function is comparable", () => {
  const found = parse("export const f = (a, b) => a + b;");
  assert.deepEqual(found.get("f"), { total: 2, required: 2 });
});

test("a memo()-wrapped export is PRESENT but not comparable", () => {
  /* The false positive the first run produced: reported as a rename. */
  const found = parse("export const TaskCard = memo(TaskCardComponent, areEqual);");
  assert.equal(found.has("TaskCard"), true);
  assert.equal(found.get("TaskCard"), null);
});

test("a non-exported function is invisible", () => {
  assert.equal(parse("function hidden(a) { return a; }").has("hidden"), false);
});
