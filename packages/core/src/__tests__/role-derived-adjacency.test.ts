/*
FNXC:MergedPlanningColumn 2026-07-29-11:15 (U11):
Column adjacency derived from lifecycle ROLES rather than column ids.

`VALID_TRANSITIONS` is a role-level statement wearing legacy-id clothing, and it was reachable
only by matching the legacy lifecycle ids as a set. U11's merged default changed that shape, so the match
stopped firing and the default board fell through to neighbor-only adjacency — which both drops
legal moves and invents an illegal one.

The critical assertion in this file is the FIRST one: the built-in lifecycle must still produce
`VALID_TRANSITIONS` verbatim. Everything else is worthless if that regressed.
*/
import { describe, expect, it } from "vitest";
import { resolveAllowedColumns, resolveColumnAdjacency } from "../workflows/workflow-transitions.js";
import { VALID_TRANSITIONS } from "../types/board/board-config.js";
import { getBuiltinWorkflow, parseWorkflowIr, type WorkflowIr } from "../index.js";

const defaultIr: WorkflowIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);
const legacyIr: WorkflowIr = parseWorkflowIr(getBuiltinWorkflow("builtin:legacy-coding")!.ir as never);

describe("column adjacency survives the Todo→Planning merge", () => {
  it("reproduces VALID_TRANSITIONS verbatim for the built-in lifecycle shape", () => {
    const adjacency = resolveColumnAdjacency(legacyIr);
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect(adjacency.get(from)?.slice().sort()).toEqual([...targets].sort());
    }
  });

  it("keeps the in-progress → done mission-validation cross edge on the merged default", () => {
    // The edge `custom-review-lane-merge-blocker` covers. Neighbor adjacency dropped it.
    expect(resolveAllowedColumns(defaultIr, "in-progress")).toContain("done");
  });

  it("keeps the review → planning revision edge on the merged default", () => {
    expect(resolveAllowedColumns(defaultIr, "in-review")).toContain("todo");
  });

  it("does NOT invent a backward done → in-review edge", () => {
    // Neighbor adjacency produced this purely from declaration order; no rule ever allowed it.
    expect(resolveAllowedColumns(defaultIr, "done")).not.toContain("in-review");
  });

  it("emits no self-edge for the merged planning column", () => {
    // intake and hold resolve to the same column here; the collapse must not leave todo → todo.
    expect(resolveAllowedColumns(defaultIr, "todo")).not.toContain("todo");
  });

  it("leaves a genuinely custom workflow on neighbor adjacency", () => {
    /*
    Regression direction: role-derived adjacency must apply ONLY to workflows declaring the full
    lifecycle role set. A shape missing roles is custom, and silently imposing a lifecycle on it
    would change every custom board's legal moves.
    */
    const custom = {
      version: "v2",
      id: "wf-custom",
      name: "Custom",
      columns: [
        { id: "a", name: "A", traits: [{ trait: "intake" }] },
        { id: "b", name: "B", traits: [] },
        { id: "c", name: "C", traits: [] },
      ],
      nodes: [{ id: "start", kind: "start", column: "a" }],
      edges: [],
    } as unknown as WorkflowIr;

    expect(resolveAllowedColumns(custom, "b")).toEqual(["a", "c"]);
  });
});
