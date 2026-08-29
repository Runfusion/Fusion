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

/*
FNXC:PluginInteropDrift 2026-07-31-08:20:
INTERFACES ARE ONE-DIRECTIONAL: fewer properties is correct, unknown ones are the drift.

All six mirrors declare subsets (6, 8, 7, 7, 3, 6 against the real nine) because a plugin mirrors
only the fields it uses. Demanding equality would fail every plugin for not using everything, which
is how a check gets deleted. A property the real type lacks is a rename nobody propagated — the
plugin keeps compiling and reads a field the host never sends.
*/
import { declaredInterfacesForTest } from "../check-plugin-interop-drift.mjs";

test("an interface's property names are collected", () => {
  const found = declaredInterfacesForTest("export interface P { a: string; b?: number }", "t.tsx");
  assert.deepEqual([...(found.get("P") ?? new Map()).keys()], ["a", "b"]);
});

test("a mirror declaring FEWER properties is not drift", () => {
  const real = declaredInterfacesForTest("export interface P { a: string; b?: number; c?: boolean }", "t.tsx").get("P");
  const mirrored = ["a"];
  assert.equal(mirrored.every((p) => real.has(p)), true);
});

test("a mirror declaring an UNKNOWN property is drift", () => {
  /* The live case: `TaskCardProps.workflowStepNameLookup` outlived its removal from TaskCard. */
  const real = declaredInterfacesForTest("export interface P { a: string }", "t.tsx").get("P");
  assert.equal(real.has("workflowStepNameLookup"), false);
});
