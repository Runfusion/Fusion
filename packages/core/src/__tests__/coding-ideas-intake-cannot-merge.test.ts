import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../builtin-stepwise-final-review-coding-workflow-ir.js";
import { resolveLifecycleColumns } from "../workflow-lifecycle-traits.js";
import { validateColumnTraits } from "../trait-registry.js";
import type { WorkflowIrColumn, WorkflowIrV2 } from "../workflow-ir-types.js";
import "../builtin-traits.js";

/*
FNXC:CodingIdeasWorkflow 2026-07-30-19:10 (ENFORCES #2651's finding, which landed as prose only):

#2651 implemented the `ideas` + `todo` collapse, found it broken, and reverted — recording why in
`docs/solutions/.../u11-triage-literal-safety-audit.md`. It added no test, so nothing stops the next
person reaching the same dead end. This is that test. Its argument is #2651's, not a second one:

Triage's discovery keys on the COLUMN'S `autoTriage` config, not on the intake/hold roles. `ideas`
(`autoTriage: false`) is not scanned, `todo` is, and "promote" means moving the card from the unscanned
lane into the scanned one — that move IS the gate release. Merge them and one column must be both the
unscanned manual intake and the scanned planning lane, so one of two things happens:

  - `autoTriage: false` wins -> the column is never scanned, nothing is ever planned, and cards sit with
    a bootstrap-stub PROMPT.md until the CAPACITY HOLD releases them — sending UNPLANNED work into
    in-progress, which is worse than stalling;
  - scanning wins -> `autoTriage: false` means nothing, the manual gate is gone, and the preset is just
    the default workflow wearing a different name.

What the collapse actually requires is a release mechanism for a manual gate that is NOT a column
move. That does not exist, and inventing one is a product decision rather than an IR edit.

SCOPE, from #2651 and worth keeping straight: `autoTriage` is a general trait field, so a custom
workflow can still declare a manual intake with `intake !== hold`. Only THIS preset's collapse is
dead — the manual-intake concept is not.

The registry does NOT reject the merged shape (asserted below), so the breakage is silent, which is
exactly why prose was not enough.
*/describe("Coding (Ideas): the manual intake cannot be merged into the hold column", () => {
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
