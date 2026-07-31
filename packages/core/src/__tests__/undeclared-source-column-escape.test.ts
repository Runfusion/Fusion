/*
FNXC:MergedPlanningColumn 2026-07-29-10:15 (U11 migration):

A card can outlive the column it is stored in. U11 removes `triage` from the default coding
workflow, so on the first startup after upgrade every card still sitting there is in a column its
own workflow no longer declares — and `reconcileUndeclaredTaskColumns` re-homes those, but only
when it runs.

In between, the card was UNMOVABLE. `resolveAllowedColumns` derives targets from the workflow's
column adjacency, and an undeclared source column has no adjacency at all, so it returns `[]` and
every move is rejected with "Valid targets: none" — including the move that would rescue the card.
An operator dragging such a card got a hard rejection with nothing actionable in it.

The fix is an ESCAPE HATCH, not a relaxation: when — and only when — the card's CURRENT column is
one the workflow does not declare, the workflow's own rebound target (hold -> intake -> first
column) becomes a legal destination. Every other guard is untouched, because there is no adjacency
to violate from a column that is not in the graph.

Deliberately narrow: the rebound target ONLY, not "any declared column". A stranded card needs a
way back into the lifecycle, not a way to skip it — allowing any target would let a card jump
straight from a removed planning column into a review or complete column, which the ordinary
adjacency rules exist to prevent. An operator who wants it elsewhere moves it twice.
*/
import { describe, expect, it } from "vitest";
import { resolveAllowedColumns } from "../workflow-transitions.js";
import { getBuiltinWorkflow, parseWorkflowIr, type WorkflowIr } from "../index.js";

/** The real default workflow, post-merge: one Planning column (`todo`), no `triage`. */
const defaultIr: WorkflowIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

/** A workflow whose lifecycle roles carry non-legacy ids, so no literal can pass by luck. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: "wf-renamed",
    name: "Renamed",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "backlog" },
      { id: "build", kind: "prompt", column: "building" },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "build", condition: "success" },
      { from: "build", to: "end", condition: "success" },
    ],
  } as unknown as WorkflowIr;
}

describe("a card stored in a column its workflow no longer declares can still move", () => {
  it("premise: the default workflow really has dropped `triage`", () => {
    // Asserted separately so a future re-declaration names its own cause rather than
    // surfacing as a confusing empty-targets assertion below.
    expect((defaultIr as { columns: Array<{ id: string }> }).columns.map((c) => c.id)).not.toContain("triage");
  });

  it("offers the workflow's rebound target as an escape from an undeclared column", () => {
    const allowed = resolveAllowedColumns(defaultIr, "triage");

    // Before the escape hatch this was `[]` — the card could not be moved anywhere at all.
    expect(allowed.length).toBeGreaterThan(0);
    // `todo` is the merged Planning column: hold, and therefore the rebound target.
    expect(allowed).toContain("todo");
  });

  it("escapes to a RENAMED workflow's rebound target, never to a legacy literal", () => {
    const allowed = resolveAllowedColumns(renamedIr(), "triage");

    expect(allowed).toEqual(["backlog"]);
    expect(allowed).not.toContain("todo");
  });

  it("does NOT offer a free jump into review or complete columns", () => {
    /*
    The reason this is an escape hatch and not a relaxation. A stranded card needs a way back into
    the lifecycle, not a way to skip it — otherwise a card in a removed planning column could be
    moved straight to done, bypassing every gate the adjacency rules encode.
    */
    const allowed = resolveAllowedColumns(defaultIr, "triage");

    expect(allowed).not.toContain("in-review");
    expect(allowed).not.toContain("done");
    expect(allowed).not.toContain("archived");
  });

  it("leaves DECLARED columns' adjacency completely untouched", () => {
    /*
    The regression direction that matters. A change that made every column fall back to the rebound
    target would satisfy the assertions above while destroying the lifecycle. Every declared column
    must keep exactly the targets its graph gives it.
    */
    for (const columnId of ["todo", "in-progress", "in-review"]) {
      const allowed = resolveAllowedColumns(defaultIr, columnId);
      // Declared columns resolve from the real graph, so they must NOT collapse to a single
      // rebound target — and in particular a wip column must not suddenly offer only `todo`.
      expect(allowed).not.toEqual(["todo"]);
    }
  });

  it("returns no escape when the workflow declares no columns at all (v1 IR)", () => {
    // Nothing to rebound to; the caller keeps its conservative rejection rather than inventing one.
    const v1 = { version: "v1", id: "legacy", name: "legacy", nodes: [], edges: [] } as unknown as WorkflowIr;
    expect(resolveAllowedColumns(v1, "triage")).toEqual([]);
  });
});
