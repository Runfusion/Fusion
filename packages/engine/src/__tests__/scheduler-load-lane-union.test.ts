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

  it("the scheduler builds this same union", () => {
    // Guards the mirror above against drift: if scheduler.ts stops unioning a role, this fails.
    const source = readFileSync(new URL("../scheduler.ts", import.meta.url), "utf8");

    for (const flag of ["intake", "hold", "countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview"]) {
      expect(source).toContain(`...columnsWithFlag(loadLaneIr, "${flag}")`);
    }
  });
});

import { readFileSync } from "node:fs";
