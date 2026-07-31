/*
FNXC:WorkflowLifecycleColumns 2026-08-02-19:25 (PR #2742 review — greptile P1, my third `?? legacy` slip):

THE INVARIANT: the unarchive destination is a column the board DECLARES, or the restore refuses.

`unarchiveTaskImpl` writes this destination DIRECTLY to the row — it bypasses `moveTask` on purpose, because
the transition graph only allows archived→done and a restore needs to reach any column. So unlike every
converted `moveTask` call site in this program, there is no unknown-column validation behind it: an invented
column is PERSISTED, the card renders nowhere, and no lifecycle guard can find it.

THE RULE THIS PINS, stated for the third time in one session because I keep needing it:
  `?? legacyId` is correct only when the resolver returned NOTHING.
  A resolved struct with a missing field is an ANSWER — "this board has no such lane" — and `??` discards it.

The two cases are asserted separately, because a fix that refuses in both would break every legacy board and a
fix that defaults in both is the bug.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "../types.js";

import { resolveUnarchiveTargetColumnImpl } from "../task-store/task-artifacts-ops.js";

function storeWith(ir: WorkflowIr | undefined): TaskStore {
  const selection = { workflowId: "wf", stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
  } as unknown as TaskStore;
}

const ir = (columns: Array<{ id: string; traits: Array<{ trait: string }> }>) => ({
  version: "v2", id: "wf", name: "wf", nodes: [{ id: "s", kind: "start", column: columns[0]!.id }], edges: [],
  columns,
} as unknown as WorkflowIr);

const FULL = ir([
  { id: "backlog", traits: [{ trait: "intake" }] },
  { id: "queued", traits: [{ trait: "hold" }] },
  { id: "building", traits: [{ trait: "wip" }] },
  { id: "signoff", traits: [{ trait: "merge" }] },
  { id: "shipped", traits: [{ trait: "complete" }] },
  { id: "filed", traits: [{ trait: "archived" }] },
]);

describe("the unarchive destination is a declared column or a refusal", () => {
  it("restores an unusable pre-archive column to the board's COMPLETE lane", async () => {
    expect(await resolveUnarchiveTargetColumnImpl(storeWith(FULL), "archived", "FN-1")).toBe("shipped");
  });

  it("restores a card archived from the WIP lane to the board's HOLD lane", async () => {
    /*
    The expensive case: with the literal this returned `todo`, and on a renamed board the card went straight
    back into the wip lane with no worktree — where the scheduler counts it as a live holder occupying a slot.
    */
    expect(await resolveUnarchiveTargetColumnImpl(storeWith(FULL), "building", "FN-1")).toBe("queued");
  });

  it("restores anything else exactly where it was", async () => {
    expect(await resolveUnarchiveTargetColumnImpl(storeWith(FULL), "backlog", "FN-1")).toBe("backlog");
  });

  it("REFUSES when the board declares no complete lane", async () => {
    // Pre-fix: returned `done`, which unarchiveTaskImpl then wrote directly to a board without that column.
    const noComplete = ir([
      { id: "backlog", traits: [{ trait: "intake" }] },
      { id: "queued", traits: [{ trait: "hold" }] },
    ]);

    await expect(resolveUnarchiveTargetColumnImpl(storeWith(noComplete), "archived", "FN-1"))
      .rejects.toThrow(/declares no complete column/);
  });

  it("REFUSES when the board declares no hold lane and the card was mid-flight", async () => {
    const noHold = ir([
      { id: "backlog", traits: [{ trait: "intake" }] },
      { id: "building", traits: [{ trait: "wip" }] },
      { id: "shipped", traits: [{ trait: "complete" }] },
    ]);

    await expect(resolveUnarchiveTargetColumnImpl(storeWith(noHold), "building", "FN-1"))
      .rejects.toThrow(/declares no hold column/);
  });

  it("keeps the LEGACY answers when there is no lane information at all", async () => {
    /*
    The other half of the rule: a v1 IR or an unresolvable store has told us nothing, so today's behaviour is
    correct. A blanket refusal would pass the two cases above and break every legacy board.
    */
    const legacy = storeWith(undefined);

    expect(await resolveUnarchiveTargetColumnImpl(legacy, "archived", "FN-1")).toBe("done");
    expect(await resolveUnarchiveTargetColumnImpl(legacy, "in-progress", "FN-1")).toBe("todo");
    expect(await resolveUnarchiveTargetColumnImpl(legacy, "in-review", "FN-1")).toBe("todo");
    expect(await resolveUnarchiveTargetColumnImpl(legacy, "todo", "FN-1")).toBe("todo");
  });

  it("keeps the legacy answers when no taskId is supplied, so an un-updated caller is unchanged", async () => {
    expect(await resolveUnarchiveTargetColumnImpl(storeWith(FULL), "in-progress")).toBe("todo");
  });
});
