/*
FNXC:WorkflowLifecycleColumns 2026-07-31-00:20 (batch-core feed: task-merge.ts 6 → 0):

THE INVARIANT: the merge gate and the completion gate answer with the board's OWN columns.

Three failures, none of which raises anything:

  - `getTaskMergeBlocker` refused every card on a renamed board. `moves.ts` is the sharp case: its
    review → complete guard resolves BOTH columns from the workflow, then called this helper, which
    re-asked with the literal and refused — a legal transition rejected by its own guard.
  - `getTaskCompletionBlocker`'s `blockedBy` check never saw a finished blocker as terminal, so the
    marker never cleared and the blocked card waited forever.
  - the dependency loop never saw a dependency as satisfied, so the dependent never completed.

WHY TWO DEPENDENCY PREDICATES, NOT ONE. A hard `blockedBy` marker clears only on terminal
(complete/archived); a declared dependency also clears at REVIEW, because the work is done even
though the merge has not landed. The test below asserts a review-column dependency SATISFIES a
dependency but does NOT clear a `blockedBy` — collapsing the two would either strand every dependent
behind an unmerged dependency or release blocked cards too early, and neither shows up as an error.

WHY `reviewColumns` IS NOT `skipColumnIdentityCheck`. The existing option means "I proved lane
identity already, do not check"; the new one means "check, against THESE columns". The negative case
below asserts the check still refuses a non-review card when the lanes are supplied, so the new
parameter cannot be mistaken for a way to disable the gate.

REVERT PROOF, measured: restore the three literal comparisons and the renamed-board cases fail
(4 of 9). The default-board cases keep passing, so they do not pin the fix on their own.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import { getTaskCompletionBlocker, getTaskMergeBlocker } from "../task-merge.js";

/** A board whose review lane is `signoff`, complete is `shipped`, archived is `vault`. */
const RENAMED = {
  review: new Set(["signoff"]),
  terminal: new Set(["shipped", "vault"]),
};

function mergeCandidate(column: string): Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults"> {
  return { column, paused: false, status: null, error: null, steps: [], workflowStepResults: [] } as never;
}

describe("getTaskMergeBlocker resolves the board's own review lane", () => {
  it("clears a card in a RENAMED review lane", () => {
    // Pre-fix: "task is in 'signoff', must be in 'in-review'".
    expect(getTaskMergeBlocker(mergeCandidate("signoff"), { reviewColumns: RENAMED.review })).toBeUndefined();
  });

  it("still refuses a card outside the resolved lanes, naming them", () => {
    // The gate must remain a gate — the new option names the lane, it does not disable the check.
    const blocker = getTaskMergeBlocker(mergeCandidate("building"), { reviewColumns: RENAMED.review });

    expect(blocker).toBe("task is in 'building', must be in 'signoff'");
    expect(blocker).not.toContain("in-review");
  });

  it("keeps the legacy literal when no lanes are supplied", () => {
    expect(getTaskMergeBlocker(mergeCandidate("in-review"))).toBeUndefined();
    expect(getTaskMergeBlocker(mergeCandidate("signoff"))).toBe("task is in 'signoff', must be in 'in-review'");
  });

  it("still honours skipColumnIdentityCheck independently of the resolved lanes", () => {
    // The two options are different questions; supplying lanes must not imply skipping.
    expect(getTaskMergeBlocker(mergeCandidate("anything"), { skipColumnIdentityCheck: true })).toBeUndefined();
  });
});

describe("getTaskCompletionBlocker resolves each dependency's own lanes", () => {
  const resolveTask = (byId: Record<string, string>) =>
    async (id: string) => (byId[id] ? ({ id, column: byId[id] } as Pick<Task, "id" | "column">) : null);

  const lanes = (ids: string[]) =>
    new Map(ids.map((id) => [id, { terminal: RENAMED.terminal, review: RENAMED.review }] as const));

  it("clears a blockedBy marker whose blocker reached a RENAMED complete column", async () => {
    // Pre-fix: `shipped` is not "done"/"archived", so the marker never cleared and the card waited
    // forever — no error, no retry, just a task that never becomes eligible.
    const blocker = await getTaskCompletionBlocker(
      { blockedBy: "FN-BLOCKER", dependencies: [] } as never,
      { resolveTask: resolveTask({ "FN-BLOCKER": "shipped" }), satisfactionColumnsByTaskId: lanes(["FN-BLOCKER"]) },
    );

    expect(blocker).toBeUndefined();
  });

  it("does NOT clear a blockedBy marker whose blocker only reached REVIEW", async () => {
    // Pins the two predicates apart: review satisfies a dependency, never a hard blockedBy marker.
    const blocker = await getTaskCompletionBlocker(
      { blockedBy: "FN-BLOCKER", dependencies: [] } as never,
      { resolveTask: resolveTask({ "FN-BLOCKER": "signoff" }), satisfactionColumnsByTaskId: lanes(["FN-BLOCKER"]) },
    );

    expect(blocker).toBe("task is blocked by FN-BLOCKER");
  });

  it("treats a dependency in a RENAMED review lane as satisfied", async () => {
    const blocker = await getTaskCompletionBlocker(
      { blockedBy: null, dependencies: ["FN-DEP"] } as never,
      { resolveTask: resolveTask({ "FN-DEP": "signoff" }), satisfactionColumnsByTaskId: lanes(["FN-DEP"]) },
    );

    expect(blocker).toBeUndefined();
  });

  it("still reports a dependency that is genuinely unfinished", async () => {
    const blocker = await getTaskCompletionBlocker(
      { blockedBy: null, dependencies: ["FN-DEP"] } as never,
      { resolveTask: resolveTask({ "FN-DEP": "building" }), satisfactionColumnsByTaskId: lanes(["FN-DEP"]) },
    );

    expect(blocker).toBe("task has unresolved dependencies: FN-DEP");
  });

  it("keeps the legacy literals for a dependency absent from the map", async () => {
    // A board spanning workflows: the map covers FN-A only, so FN-B keeps today's behaviour rather
    // than inheriting FN-A's vocabulary.
    const blocker = await getTaskCompletionBlocker(
      { blockedBy: null, dependencies: ["FN-A", "FN-B"] } as never,
      {
        resolveTask: resolveTask({ "FN-A": "shipped", "FN-B": "done" }),
        satisfactionColumnsByTaskId: lanes(["FN-A"]),
      },
    );

    expect(blocker).toBeUndefined();
  });
});
