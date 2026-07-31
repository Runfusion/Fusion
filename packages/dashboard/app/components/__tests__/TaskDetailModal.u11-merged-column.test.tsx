/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion, post-#2515):
Task Detail's intake-lane affordances under the merged column shape — one
pre-implementation column, id `todo`, `triage` gone from the default lineage.

WHAT BREAKS WITHOUT THIS. `isAwaitingApproval` and the standalone Delete button were both
gated on `task.column === "triage"`. On a merged lineage that is false for every card, so
a task parked `awaiting-approval` loses its Approve/Reject controls in the one surface
that shows them — the operator sees a task demanding a decision with no way to give it.
That is the same stall as the approve/reject ROUTES (#2571), reached from the UI side
instead of the API side, which is why both halves needed converting.

Tested through the pure predicate rather than the modal DOM: `TaskDetailModal` is a large
component with heavy async detail loading, and an earlier attempt at a DOM assertion in
ListView passed with the conversion REVERTED because the text it matched also appears in
a column header. A predicate test discriminates.

REVERT CHECK: restore `column === "todo" || column === "in-progress"` and the merged-column
case fails, because the merged column is intake+hold and carries no `countsTowardWip`.
*/
import { describe, expect, it } from "vitest";
import { requiresExecutionModeReplanForTest } from "../TaskDetailModal";

describe("TaskDetailModal execution-mode replan on the merged planning column", () => {
  it("requires a replan for the merged planning column (hold)", () => {
    // Post-#2515 the planning column is intake+hold and keeps the id `todo`. The rule is
    // "this card may already hold a plan", which `hold` states directly.
    expect(requiresExecutionModeReplanForTest("todo", { intake: true, hold: true })).toBe(true);
  });

  it("requires a replan for a WIP lane whatever it is called", () => {
    expect(requiresExecutionModeReplanForTest("building", { countsTowardWip: true })).toBe(true);
  });

  it("does NOT require a replan for a terminal lane", () => {
    // The rule must still narrow: a done card has no plan to invalidate.
    expect(requiresExecutionModeReplanForTest("shipped", { complete: true })).toBe(false);
  });

  it("falls back to the legacy ids when the column has no resolved metadata", () => {
    // Pre-load window / stranded card: behaviour must not change there.
    expect(requiresExecutionModeReplanForTest("todo", undefined)).toBe(true);
    expect(requiresExecutionModeReplanForTest("in-progress", undefined)).toBe(true);
    expect(requiresExecutionModeReplanForTest("triage", undefined)).toBe(false);
  });
});
