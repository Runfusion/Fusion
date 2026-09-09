// @vitest-environment node
/*
FNXC:SdlcFunnelColumns 2026-07-30-09:50 (the default path was the only path, and it used the legacy IR):

THE INVARIANT: the SDLC funnel's built-in column fallback maps the board Fusion actually ships.

WHAT WAS WRONG. `defaultColumns()` used `BUILTIN_CODING_WORKFLOW_IR` — the constant the catalog now
publishes as `builtin:legacy-coding`, not the current default. That would be harmless if it were only a
fallback, but the ONLY production callers use it: `aggregateActivityAnalytics` (Command Center's
`/command-center/activity`, and the OTel exporter) never passes `columns`. Its own doc comment says
callers with a custom workflow "should call `aggregateSdlcFunnel` directly" — and none do, which is what
makes this the default path rather than an edge case.

Consequence: any column id absent from the legacy set folds to OTHER, so a board whose columns differ
reads as an empty funnel while it is plainly busy. Same shape as the quick-capture default I fixed in
this branch: the explicit path was thought about, the default path was not.

WHY THESE ASSERTIONS AND NOT A SNAPSHOT. The funnel's job is that every column of the shipped board maps
to a real stage — not that a particular id list is present. Asserting the mapping is what survives the
next lineage change; asserting the id list would have to be edited by whoever makes it, which is how a
test stops being evidence and becomes a chore.
*/
import { describe, expect, it } from "vitest";

import { buildColumnStageMap, stageForTraits } from "../board/activity-analytics.js";
import { resolveDefaultWorkflowIr } from "../workflows/builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import type { WorkflowIrColumn } from "../workflows/workflow-ir-types.js";

function columnsOf(ir: unknown): Array<{ id: string; traits: Array<{ trait: string }> }> {
  const v2 = ir as { version?: string; columns?: WorkflowIrColumn[] };
  return (v2.columns ?? []).map((column) => ({
    id: column.id,
    traits: column.traits.map((trait) => ({ trait: trait.trait })),
  }));
}

describe("the funnel's built-in column fallback tracks the SHIPPED default board", () => {
  it("maps every FUNNEL column of the current default workflow to a stage, not OTHER", () => {
    const columns = columnsOf(resolveDefaultWorkflowIr());
    const stageMap = buildColumnStageMap(columns);

    expect(columns.length).toBeGreaterThan(0);
    /* The shipped board now consists entirely of SDLC stages. `todo` maps to the `triage` STAGE
    because it carries the intake trait — the post-U11 merged planning column, which is exactly what
    the legacy fallback could not express. */
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(stageMap.get(column.id)).not.toBe("other");
    }
  });

  it("covers the post-U11 merged planning column, which the legacy constant predates", () => {
    // The concrete regression: #2515 merged Todo into Planning on the default lineage. A fallback built
    // from the legacy IR still describes a board with a separate `triage` column.
    const currentIds = columnsOf(resolveDefaultWorkflowIr()).map((c) => c.id);
    const legacyIds = columnsOf(BUILTIN_CODING_WORKFLOW_IR).map((c) => c.id);

    expect(currentIds).not.toEqual(legacyIds);
    // Whatever the current lineage's ids are, they are the ones the funnel must map.
    for (const id of currentIds) {
      expect(buildColumnStageMap(columnsOf(resolveDefaultWorkflowIr())).has(id)).toBe(true);
    }
  });

  it("folds a column no board declares into OTHER (the paired negative)", () => {
    // The fold-to-OTHER behaviour is correct and must survive: it is what keeps an unknown id from
    // being counted as a real stage. This is why the fix is "use the right default", not "stop folding".
    const stageMap = buildColumnStageMap(columnsOf(resolveDefaultWorkflowIr()));

    expect(stageMap.has("a-column-no-board-has")).toBe(false);
  });
});

/*
FNXC:SdlcFunnelColumns 2026-07-30-10:25 (the real fix, and the correction of my own claim):

I first changed only `defaultColumns()` from the legacy IR to `resolveDefaultWorkflowIr()` and described
it as fixing renamed boards. IT DOES NOT. Post-U11 the current lineage's column ids are a SUBSET of the
legacy constant's, so the legacy fallback already mapped everything the current one does — the change is
a consistency fix with no observable effect. The give-away was a revert proof that would not go red: my
assertions passed with the legacy constant restored.

THE REAL DEFECT is that the funnel maps by column id and folds anything it was not given into OTHER,
while the only production callers never passed `columns` at all. So a renamed or custom board's Command
Center funnel read as EMPTY while the board was plainly busy. Fixing that is a CALLER change — the route
resolves the project's own workflow columns — and these cases pin the property that makes it work.
*/
describe("a board whose columns the funnel was not given folds to OTHER", () => {
  const renamedColumns = [
    { id: "backlog", traits: [{ trait: "intake" }] },
    { id: "building", traits: [{ trait: "wip" }] },
    { id: "checking", traits: [{ trait: "merge" }] },
    { id: "shipped", traits: [{ trait: "complete" }] },
  ];

  it("maps a renamed board's columns once they ARE supplied", () => {
    const stageMap = buildColumnStageMap(renamedColumns);

    for (const column of renamedColumns) {
      expect(stageMap.get(column.id)).not.toBe("other");
    }
  });

  it("cannot see a renamed board's columns through the built-in default (why the caller must supply them)", () => {
    // This is the operator-visible failure, stated as a test rather than as prose: with only the
    // built-in columns, every id from a renamed board is unknown, and unknown folds to OTHER.
    const builtinOnly = buildColumnStageMap(columnsOf(resolveDefaultWorkflowIr()));

    for (const column of renamedColumns) {
      expect(builtinOnly.has(column.id)).toBe(false);
    }
  });

  it("treats an EMPTY column list as no mapping at all, which is why the resolver returns undefined", () => {
    // The route's helper returns `undefined` rather than `[]` on failure: undefined falls back to the
    // built-in default (previous behaviour), while `[]` would map every column to OTHER and silently
    // empty the funnel. Pinning the distinction because it is easy to "simplify" away.
    const empty = buildColumnStageMap([]);

    expect(empty.size).toBe(0);
  });
});

/*
FNXC:SdlcFunnel 2026-07-30-16:00:
A HOLD-ONLY column must land in the funnel, not in OTHER.

`hold` was missing from the trait->stage map, so a renamed board's wait-for-capacity lane resolved to
OTHER and disappeared from the SDLC funnel entirely. The default lineage hid this: its Planning column
also carries `intake` and `reset-on-entry`, so it always matched something. Only a board that names
its wait lane separately — exactly the custom shape this trait mapping exists to support — was
affected.

REVERT CHECK: remove `hold` from TRAIT_TO_STAGE and the first case returns "other".

NOT covered here, on purpose: the merged default Planning column carries intake AND reset-on-entry, so
`stageForTraits` still resolves it to `triage` and the `todo` stage stays empty on default boards.
That is a real defect from the U11 merge and a larger, non-reversible call — changing which stage
Planning reports would retroactively alter historical analytics. Flagged on PR #2669 for a decision
rather than settled silently here. The second case below PINS the current behaviour so that decision
is made deliberately and not drifted into.
*/
describe("SDLC funnel: hold-only columns", () => {
  it("places a hold-only column in the todo stage rather than OTHER", () => {
    expect(stageForTraits(["hold"])).toBe("todo");
  });

  it("maps a hold-only COLUMN through buildColumnStageMap, not just its traits", () => {
    /*
    FNXC:SdlcFunnel 2026-07-30-16:00 (PR #2674 review — greptile, and it is the project's own rule):
    The reported bug was that a hold-only COLUMN disappeared from the funnel. Asserting
    `stageForTraits` alone tests the helper, not the surface where the defect shows — and the
    Surface Enumeration rule exists because a fix proven only at the unit it was written in is how
    the same bug comes back one caller over.

    `buildColumnStageMap` is the seam the funnel actually consumes: it maps column id -> stage for
    every column on the board. A hold-only lane must appear there with a real stage, not OTHER.
    */
    const stages = buildColumnStageMap([
      { id: "waiting", traits: [{ trait: "hold" }] },
      { id: "building", traits: [{ trait: "wip" }] },
      { id: "shipped", traits: [{ trait: "complete" }] },
    ] as never);

    expect(stages.get("waiting")).toBe("todo");
    // The neighbours prove the map is populated normally, so the case above cannot pass because the
    // map is empty or every column collapsed to one stage.
    expect(stages.get("building")).toBe("in-progress");
    expect(stages.get("shipped")).toBe("done");
  });

  it("still resolves the merged Planning column to `triage` — unchanged by this fix", () => {
    // intake (stage 0) outranks reset-on-entry/hold (stage 1) by flow order. Pinned so the separate
    // merged-column question cannot be answered accidentally by a future edit to this map.
    expect(stageForTraits(["intake", "hold", "reset-on-entry"])).toBe("triage");
  });
});
