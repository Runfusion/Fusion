// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-08-01-09:20 (fleet):

THE INVARIANT: the worktree-capacity read excludes terminal lanes by ROLE, on any board.

The capacity gate counts every non-terminal task holding a worktree. Terminal cards are excluded
because their retained worktrees are cleanup-owned, not capacity. That exclusion arrived hand-rolled,
with `flags.complete === true || flags.archived === true` and a `"done" | "archived"` literal fallback
— the same shape the FNXC on `isWipColumnTask` records as already removed once from this file.

Getting it wrong is not symmetric. Under-counting admits work over the cap: the commit that added the
gate reports maxWorktrees=4 with four planning sessions and a fifth worktree admitted. Over-counting
merely starves dispatch. So the risk of a renamed board silently failing the exclusion is the
dangerous direction.

WHY THIS TESTS THE PREDICATE AND NOT THE DISPATCH PATH: same reason as
`scheduler-load-lane-union.test.ts` — the call site sits inside `schedule()`, which a unit test has no
business standing up. The predicate is the whole of the decision.

NOTE ON COVERAGE, recorded rather than implied: blinding this predicate to `false` leaves all 22
scheduler suites green (365 tests). The capacity logic it feeds has no behavioural coverage at all.
This pins the lane vocabulary; it does NOT pin the capacity arithmetic, which is still unguarded.
*/
import { describe, expect, it } from "vitest";
import { isTerminalColumnRole, resolveColumnFlags } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
} as unknown as WorkflowIr;

const flagsFor = (columnId: string) => resolveColumnFlags(
  RENAMED_IR.columns.find((c) => c.id === columnId) as never,
);

describe("worktree capacity excludes terminal lanes by role", () => {
  it("excludes BOTH renamed terminal lanes, not just the complete one", () => {
    expect(isTerminalColumnRole(flagsFor("shipped"), "shipped")).toBe(true);
    expect(isTerminalColumnRole(flagsFor("attic"), "attic")).toBe(true);
  });

  it("counts renamed working and hold lanes toward capacity", () => {
    expect(isTerminalColumnRole(flagsFor("building"), "building")).toBe(false);
    expect(isTerminalColumnRole(flagsFor("backlog"), "backlog")).toBe(false);
  });

  /*
  The degraded arm is why the shared helper is used rather than the hand-rolled version: an
  unresolvable column must keep answering for the legacy ids, or a board mid-migration starts counting
  its own done cards against the worktree cap.
  */
  it("still recognises the legacy terminal ids when flags cannot be resolved", () => {
    expect(isTerminalColumnRole(undefined, "done")).toBe(true);
    expect(isTerminalColumnRole(undefined, "archived")).toBe(true);
    expect(isTerminalColumnRole(undefined, "in-progress")).toBe(false);
  });
});
