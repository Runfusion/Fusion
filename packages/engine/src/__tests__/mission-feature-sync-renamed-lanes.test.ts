/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:10 (Phase B conversion — mission-feature-sync):

"Has this task returned to a PLANNER LANE?" decided whether a mission feature drops from
`in-progress` back to `triaged`. It asked with the legacy `triage`/`todo` pair, so on a
renamed board a card sent back for re-planning left its feature stuck at `in-progress`
FOREVER — the mission board showed work in flight that nobody was doing, and nothing said so.

The conversion UNIONS the resolved lanes with the legacy pair rather than replacing it. That
is not caution for its own sake: replacing broke a real case, because post-U11 the default
lineage has no `triage` and a legacy row still sitting there stopped counting. The existing
suite caught that, which is why the union is here and why this file records the reason.
*/
import { describe, expect, it } from "vitest";
import "@fusion/core";
import { reconcileMissionFeatureState } from "../mission-feature-sync.js";

/** A store whose IR resolution yields a workflow with renamed planner lanes. */
function renamedStore() {
  return {
    getTask: async () => undefined,
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "custom:renamed", stepIds: [] }),
    getWorkflowDefinition: async () => ({
      id: "custom:renamed",
      ir: {
        version: "v2",
        id: "custom:renamed",
        nodes: [{ id: "start", kind: "start", column: "drafting" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "intake" }] },
          { id: "queued", label: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        ],
      },
    }),
  } as never;
}

describe("mission feature sync under a renamed planner vocabulary", () => {
  it("drops the feature back to `triaged` for a card in the RENAMED intake column", async () => {
    const decision = await reconcileMissionFeatureState(
      renamedStore(),
      { id: "FN-MR-1", column: "drafting" } as never,
      { id: "F-1", status: "in-progress" } as never,
    );
    expect(decision).toMatchObject({ kind: "update", status: "triaged" });
  });

  it("drops the feature back to `triaged` for a card in the RENAMED hold column", async () => {
    const decision = await reconcileMissionFeatureState(
      renamedStore(),
      { id: "FN-MR-2", column: "queued" } as never,
      { id: "F-1", status: "in-progress" } as never,
    );
    expect(decision).toMatchObject({ kind: "update", status: "triaged" });
  });

  it("does NOT drop the feature for a card in the renamed WIP column", async () => {
    /* The negative half: `building` is active work, and demoting its feature to `triaged`
       would report a running task as un-started. */
    const decision = await reconcileMissionFeatureState(
      renamedStore(),
      { id: "FN-MR-3", column: "building", status: "in-progress" } as never,
      { id: "F-1", status: "in-progress" } as never,
    );
    expect(decision).not.toMatchObject({ status: "triaged" });
  });

  it("still honours the LEGACY pair for a card left in `triage` (the union, not a replacement)", async () => {
    /* Post-U11 the default lineage has no `triage`, so a resolved-lanes-only check would
       leave a legacy row's feature stuck at `in-progress` forever. */
    const decision = await reconcileMissionFeatureState(
      renamedStore(),
      { id: "FN-MR-4", column: "triage" } as never,
      { id: "F-1", status: "in-progress" } as never,
    );
    expect(decision).toMatchObject({ kind: "update", status: "triaged" });
  });
});
