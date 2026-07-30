/*
FNXC:WorkflowLifecycleColumns 2026-08-02-11:20 (fleet: the merge path on a renamed board):

THE INVARIANT: the PR-merged transition recognises the board's review and complete lanes, and moves the
card to the complete lane the board declares.

WHY THIS ONE MATTERS MOST IN THE CLUSTER. `applyPrMergedTransition` is what advances a card when a PR is
merged on GitHub. Every one of its guards was a default-lineage literal, and they failed in the SAME
direction: `column === "done"` never matched (so an already-complete card was not skipped) and
`column !== "in-review"` always matched (so a card sitting in review bailed with `wrong-column`). Net
effect on a renamed board: **a PR merged on GitHub never advances its Fusion task.** The operator sees a
merged PR whose card sits in review forever, which reads as a broken webhook rather than a column problem —
so it gets debugged in the wrong place.

The MOVE TARGET is asserted alongside the guards on purpose: converting guards alone would admit the card
and then move it to a column the board does not declare, which is the half-conversion this program keeps
finding. The function reads the row TWICE by design (a merge can land between checks), and both reads plus
the move now share one snapshot.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "../types.js";

import { applyPrMergedTransitionImpl } from "../task-store/merge-queue-ops-2.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed",
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(column: string, ir: WorkflowIr | undefined) {
  const task = {
    id: "FN-1", column, prInfo: { status: "merged", number: 3 }, dependencies: [], steps: [],
  } as unknown as Task;
  const moveTask = vi.fn(async (_id: string, to: string) => ({ ...task, column: to }));
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };

  const store = {
    getTask: vi.fn(async () => task),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
    moveTask,
    emit: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  return { store, moveTask };
}

describe("the PR-merged transition follows the board's own lanes", () => {
  it("advances a renamed board's review card to its COMPLETE column", async () => {
    // Pre-fix: bailed with skipped:"wrong-column" because `signoff` !== "in-review".
    const { store, moveTask } = harness("signoff", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBeUndefined();
    expect(result.moved).toBe(true);
    // The destination, not just the admission: a literal `done` would be a column this board lacks.
    expect(moveTask.mock.calls[0]?.[1]).toBe("shipped");
  });

  it("skips a card already in the board's complete column as already-done", async () => {
    // Pre-fix: `shipped` !== "done", so this was NOT skipped and the transition ran again.
    const { store, moveTask } = harness("shipped", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("already-done");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("still refuses a card that is in neither lane", async () => {
    // The paired negative: a card mid-implementation must not be advanced by a merged PR.
    const { store, moveTask } = harness("building", RENAMED_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("wrong-column");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("behaves identically on the DEFAULT board", async () => {
    // Passes either way by design — the legacy ids ARE this board's lanes. No-change evidence.
    const { store, moveTask } = harness("in-review", undefined);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.moved).toBe(true);
    expect(moveTask.mock.calls[0]?.[1]).toBe("done");
  });
});
