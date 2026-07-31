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

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-14:30 (PR #2733 review — greptile P1, and my comment had contradicted
my code):

A WORKFLOW WITH A REVIEW LANE AND NO COMPLETE LANE REFUSES, rather than moving to an undeclared `done`.

I wrote `?? "done"` under a comment claiming the transition refuses rather than inventing a column. The
reviewer read the code and was right: `moveTask` rejects an unknown column, so the merged card would have been
left in review — the exact failure the conversion exists to prevent, reintroduced by a two-character default.

The distinction this pins is the contract the whole program keeps re-learning:
  - NO lane information (v1 IR, unresolvable store) → the legacy ids ARE the answer.
  - Lanes resolved, complete ABSENT → the board has no completion column; substituting one invents a
    destination, so refuse and make it visible in the return value.

Both halves are asserted, because a fix that refuses in BOTH cases would pass a test written only for the
second and would break every legacy board.
*/
describe("a board with no complete column refuses rather than inventing one", () => {
  const NO_COMPLETE_IR = {
    version: "v2", id: "wf-no-complete", name: "no complete",
    nodes: [{ id: "start", kind: "start", column: "backlog" }],
    edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    ],
  } as unknown as WorkflowIr;

  it("skips with no-complete-column instead of moving to an undeclared `done`", async () => {
    const { store, moveTask } = harness("signoff", NO_COMPLETE_IR);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.skipped).toBe("no-complete-column");
    expect(result.moved).toBe(false);
    // The point: no move was attempted at all, so nothing was written for moveTask to reject.
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("STILL uses the legacy `done` when the workflow has no column vocabulary at all", async () => {
    /*
    The other half of the contract, and the case a blanket refusal would break: a v1 IR (or an unresolvable
    store) has told us nothing, so today's behaviour is correct and the legacy id is the answer.
    */
    const { store, moveTask } = harness("in-review", undefined);

    const result = await applyPrMergedTransitionImpl(store, "FN-1");

    expect(result.moved).toBe(true);
    expect(moveTask.mock.calls[0]?.[1]).toBe("done");
  });
});
