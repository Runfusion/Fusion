import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../builtin-stepwise-final-review-coding-workflow-ir.js";
import { resolveLifecycleColumns } from "../workflow-lifecycle-traits.js";
import { validateColumnTraits } from "../trait-registry.js";
import type { WorkflowIrColumn, WorkflowIrV2 } from "../workflow-ir-types.js";
import "../builtin-traits.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-30-16:10 (why `ideas` + `todo` is NOT the default-lineage merge):

The default lineage merged its two pre-implementation columns into one (`triage` folded into `todo`,
keeping the id). The obvious next step reads as "do the same to Coding (Ideas)". IT IS NOT THE SAME,
and this file exists so the difference is checkable rather than remembered.

The default lineage's intake was AUTOMATIC: `triage` auto-planned, `todo` held for capacity, and the
graph's plan nodes run in place, so folding one into the other changes nothing about who advances a
card — the engine does, before and after.

Coding (Ideas)'s intake is MANUAL by definition. `ideas` carries `intake` with `autoTriage: false`,
which is the entire reason the workflow exists: operators park work without the engine planning it.
`todo` carries `hold` with `release: "capacity"` — the engine releases from it automatically.

Merge them and one column must be both "wait for a human to promote this" and "auto-release this on
capacity". The concrete failure is not a philosophical one:

  - `resolveCreateIntakeLanes` (task-creation.ts) reports `manual: intakeTrait.config.autoTriage ===
    false`, derived from the INTAKE column. After a merge, intake and hold are the SAME column, so
    every created card is `manual` — never auto-planned.
  - The operator's remedy for a manual card is to promote it forward. After a merge there is nowhere
    to promote it TO: it is already in the only pre-implementation column, and the next column is
    `in-progress`, which is gated on implementation capacity and expects a spec that was never written.

So a merged Coding (Ideas) parks every card in a lane nothing advances. That is not a vocabulary
regression that reconciliation repairs — it is the workflow's purpose deleted.

The registry does NOT stop this (asserted below): the trait combination is structurally legal, so
authoring it produces no error and the breakage is silent. That is precisely why this is a test and
not a comment.

If the goal is genuinely "Coding (Ideas) should have one Planning column", the honest routes are a
PRODUCT decision, not an IR edit: either make its intake automatic (at which point it is the default
workflow and the variant has no reason to exist), or drop the variant. Both are operator-visible
choices about a shipped workflow.
*/
describe("Coding (Ideas): the manual intake cannot be merged into the hold column", () => {
  it("has a MANUAL intake, which is the fact that blocks the merge", () => {
    const columns = (BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2).columns;
    const ideas = columns.find((c) => c.id === "ideas");
    expect(ideas, "the ideas intake column").toBeDefined();

    const intakeTrait = ideas!.traits.find((t) => t.trait === "intake");
    expect(intakeTrait?.config?.autoTriage, "autoTriage:false IS the workflow's purpose").toBe(false);

    // And the hold column releases AUTOMATICALLY — the direct contradiction.
    const todo = columns.find((c) => c.id === "todo");
    const holdTrait = todo!.traits.find((t) => t.trait === "hold");
    expect(holdTrait?.config?.release).toBe("capacity");
  });

  it("keeps intake and hold as DISTINCT columns, unlike the default lineage", () => {
    const ideasLanes = resolveLifecycleColumns(BUILTIN_CODING_IDEAS_WORKFLOW_IR)!;
    expect(ideasLanes.intake).toBe("ideas");
    expect(ideasLanes.hold).toBe("todo");
    expect(ideasLanes.intake).not.toBe(ideasLanes.hold);

    // The default lineage IS merged — same roles, one column. The contrast is the point: this test
    // fails if someone "aligns" Coding (Ideas) with it.
    const defaultLanes = resolveLifecycleColumns(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR)!;
    expect(defaultLanes.intake).toBe("todo");
    expect(defaultLanes.hold).toBe("todo");
  });

  it("both plan in `todo`, so the merge would buy NOTHING for the planning lane", () => {
    // Plan-in-place already holds for Coding (Ideas): specification runs in `todo`, not in `ideas`.
    // Whatever the merge is meant to achieve for the planning lane is already true.
    for (const ir of [BUILTIN_CODING_IDEAS_WORKFLOW_IR, BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR]) {
      const nodes = (ir as WorkflowIrV2 & { nodes: Array<{ id: string; column?: string }> }).nodes;
      const planColumns = new Set(nodes.filter((n) => /^plan/.test(n.id)).map((n) => n.column));
      expect([...planColumns]).toEqual(["todo"]);
    }
  });

  /*
  THE SILENCE IS THE HAZARD. If the registry rejected the merged shape, this file would be
  unnecessary — the attempt would fail loudly at authoring time. It does not, so the merged column is
  authorable, ships, and strands every card.
  */
  it("the trait registry does NOT reject the merged shape — the breakage would be silent", () => {
    const mergedColumns: WorkflowIrColumn[] = [
      {
        id: "todo",
        name: "Planning",
        traits: [
          { trait: "intake", config: { autoTriage: false } },
          { trait: "hold", config: { release: "capacity" } },
          { trait: "reset-on-entry" },
        ],
      },
      ...(BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2).columns.filter(
        (c) => c.id !== "ideas" && c.id !== "todo",
      ),
    ] as WorkflowIrColumn[];

    const errors = validateColumnTraits(mergedColumns, "save").filter((v) => v.severity === "error");
    expect(
      errors,
      "no error means an author gets no warning: 'promote me by hand' and 'release me on capacity' "
      + "coexist in one column and the cards simply stop moving",
    ).toEqual([]);
  });
});
