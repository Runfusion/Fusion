// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-10:40 (#2787 review — greptile P1, second round):

THE INVARIANT: the resolved load-lane set covers EVERY role the legacy literal covered.

The legacy set is `{todo, in-progress, in-review}`, and `todo` is the HOLD/INTAKE lane. My first
resolved union covered only wip and review — and because passing the argument OVERRIDES the
fallback rather than extending it, assigned backlog work stopped counting as load. A regression
against legacy behaviour, introduced by the argument meant to fix the renamed case.

That is the general trap with override-shaped options: the resolved answer must be a superset of what
the literal answered, or wiring the parameter is a downgrade for the roles it forgot. Cheap to get
wrong, invisible in a test that only checks the renamed lane.

This asserts the union the scheduler builds, driven by the real trait resolver, since the call site
sits inside a dispatch path a unit test has no business standing up.
*/
import { describe, expect, it } from "vitest";
import { columnsWithFlag } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** Mirrors the scheduler's union. Kept in step with `scheduler.ts` by the assertions below. */
function loadLanes(ir: WorkflowIr): Set<string> {
  return new Set<string>([
    ...columnsWithFlag(ir, "intake"),
    ...columnsWithFlag(ir, "hold"),
    ...columnsWithFlag(ir, "countsTowardWip"),
    ...columnsWithFlag(ir, "mergeOrchestration"),
    ...columnsWithFlag(ir, "mergeBlocker"),
    ...columnsWithFlag(ir, "humanReview"),
  ]);
}

describe("the scheduler's load-lane union covers every legacy role", () => {
  it("includes the hold and intake lanes — the roles `todo` filled", () => {
    const lanes = loadLanes(RENAMED_IR);

    expect(lanes.has("backlog")).toBe(true);
    expect(lanes.has("inbox")).toBe(true);
  });

  it("includes the wip and review lanes", () => {
    const lanes = loadLanes(RENAMED_IR);

    expect(lanes.has("building")).toBe(true);
    expect(lanes.has("signoff")).toBe(true);
  });

  it("excludes terminal lanes — finished work must not hold load against an agent", () => {
    expect(loadLanes(RENAMED_IR).has("shipped")).toBe(false);
  });

  it("the scheduler builds this same union", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-04:20:
    AST, NOT A SOURCE-TEXT MATCH — the previous form hardcoded a local VARIABLE NAME.

    It asserted `source.toContain('...columnsWithFlag(loadLaneIr, "<flag>")')`. #2796 resolves
    assignment load per task and renamed that local from `loadLaneIr` to `ir`; the union it builds is
    unchanged (scheduler.ts, the `columnsWithFlag(ir, ...)` spread), but the literal stopped matching
    and this failed. Neither PR's CI could see it — the test landed on main via #2787 after #2796 was
    cut, and #2796 does not touch this file, so it only breaks in the merged state.

    A guard that fails on a rename, a reformat, or a line wrap while the behaviour is untouched costs
    more than it protects: it reports drift that did not happen, and the reflex fix is to edit the
    string, which teaches nobody anything.

    So: parse `scheduler.ts` and collect the string literal passed as the SECOND argument to every
    `columnsWithFlag(...)` call, whatever the first argument is called. The invariant — every legacy
    role is unioned somewhere in the scheduler — is preserved and is what actually gets checked.

    Still a structural assertion rather than a behavioural one, for the reason the file header gives:
    the call site sits inside a dispatch path a unit test has no business standing up. The three
    cases above cover the resolver's behaviour; this one covers the wiring.
    */
    const ts = await import("typescript");
    const source = readFileSync(new URL("../scheduler.ts", import.meta.url), "utf8");
    const sf = ts.createSourceFile("scheduler.ts", source, ts.ScriptTarget.Latest, true);

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:45 (#2804 review — greptile):
    SCOPED TO `resolveLoadLanes`, not the whole file.

    The first version collected EVERY `columnsWithFlag` call in scheduler.ts. `resolveDependencySatisfactionColumns`
    in the same file passes `mergeBlocker` and `humanReview` for its own, unrelated question — so
    deleting either from the load-lane union left them in the set anyway and every assertion below
    still passed. The test could not fail for the regression it exists to catch.

    Scoping means two things have to be sanity-checked, not one: that the function was FOUND, and that
    it contained calls. Either being false is a silent pass, which is the failure mode this whole
    exercise keeps producing.
    */
    const flagsPassed = new Set<string>();
    let loadLaneFnFound = false;

    const collectWithin = (node: import("typescript").Node): void => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "columnsWithFlag"
        && node.arguments.length >= 2
        && ts.isStringLiteral(node.arguments[1])) {
        flagsPassed.add(node.arguments[1].text);
      }
      ts.forEachChild(node, collectWithin);
    };

    const findLoadLaneFn = (node: import("typescript").Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === "resolveLoadLanes"
        && node.initializer) {
        loadLaneFnFound = true;
        collectWithin(node.initializer);
        return;
      }
      ts.forEachChild(node, findLoadLaneFn);
    };
    findLoadLaneFn(sf);

    /*
    Both sanity checks are load-bearing. A rename of `resolveLoadLanes` would otherwise leave the set
    empty and the loop below would assert nothing — the exact vacuity this scoping was meant to remove.
    */
    expect(loadLaneFnFound, "scheduler.ts no longer declares resolveLoadLanes — this test is scoped to it").toBe(true);
    expect(flagsPassed.size).toBeGreaterThan(0);

    for (const flag of ["intake", "hold", "countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview"]) {
      expect(flagsPassed, `scheduler.ts no longer passes "${flag}" to columnsWithFlag`).toContain(flag);
    }
  });
});

import { readFileSync } from "node:fs";
