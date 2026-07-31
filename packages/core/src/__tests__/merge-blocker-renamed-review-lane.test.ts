/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:45 (the unwired-parameter class, cf. #2803):

`getTaskMergeBlocker(task, { reviewColumns })` has taken a RESOLVED lane set since its own conversion.
`mergeTaskImpl` — the merge path itself — omitted it, so the identity check fell back to the literal
`in-review` and produced:

    Cannot merge FN-X: task is not in 'in-review'

for a card sitting correctly in ITS OWN board's review lane. A hard, operator-visible merge failure on
every renamed board. A resolved seam nobody wired is indistinguishable from no seam at all.

WHY THIS ASSERTS AN ABSENCE. The blocker check runs BEFORE any git or worktree work, so proving the fix
does not require a merge to succeed — it requires that this particular refusal is gone. The card has no
worktree here, so the call still fails; the assertion is that it no longer fails for the WRONG reason.
Asserting success instead would drag a git fixture into a test about a lane set.

REVERT CHECK, measured: dropping the `{ reviewColumns }` argument restores the
"task is not in 'in-review'" refusal on the renamed board.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgDescribe, createTaskStoreForTest, type PgTestHarness } from "../__test-utils__/pg-test-harness.js";
import type { TaskStore, WorkflowIr } from "../types.js";

/** A board whose review lane is not the legacy id, and which declares a merge-class node for it. */
const RENAMED_IR = {
  version: "v2",
  id: "merge-lifecycle",
  name: "renamed",
  columns: [
    { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
  ],
  /*
  A real lifecycle spine, not a stub. Column ADJACENCY is derived from the graph
  (`resolveAllowedColumns`), so an IR with no node in a column cannot be moved into it — my first
  version's two-node graph made every setup move illegal and the failure looked like the subject.
  */
  nodes: [
    { id: "start", kind: "start", column: "backlog" },
    { id: "exec", kind: "prompt", column: "building", config: { seam: "execute" } },
    { id: "merge-gate", kind: "merge-gate", column: "checking", config: { gate: "auto-merge" } },
    { id: "end", kind: "end", column: "shipped" },
  ],
  edges: [
    { from: "start", to: "exec" },
    { from: "exec", to: "merge-gate", condition: "success" },
    { from: "merge-gate", to: "end", condition: "success" },
  ],
} as unknown as WorkflowIr;

pgDescribe("mergeTask resolves the review lane from the task's own workflow", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_merge_blocker_lane" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it("does not refuse a card sitting in a RENAMED review lane", async () => {
    /*
    The REAL API. My first version called `saveWorkflowDefinition?.()` and `setTaskWorkflowSelection?.()`
    — neither exists on TaskStore, and the optional-call `?.` swallowed both silently, so the task kept
    resolving the BUILTIN workflow and every assertion was about the wrong board. That is what made the
    first version pass with the fix reverted.
    */
    const created = await store.createWorkflowDefinition({ name: "renamed merge lanes", ir: RENAMED_IR as never });
    const task = await store.createTask({ description: "renamed review lane" });
    await store.selectTaskWorkflow(task.id, created.id);
    /*
    moveTask, NOT updateTask. My first version used `updateTask({ column })`, which does not move a
    card — so it sat in `todo` and the whole case was vacuous: the refusal it asserted about never
    concerned the renamed lane at all. The premise is asserted below rather than assumed, which is the
    rule `live-move-path-undeclared-target.test.ts` exists to enforce.
    */
    /* The card is created in the builtin intake, so it enters the custom board through `backlog`. */
    for (const lane of ["backlog", "building", "checking"]) {
      await store.moveTask(task.id, lane as never, { moveSource: "user" } as never);
    }
    expect((await store.getTask(task.id)).column).toBe("checking");

    let message = "";
    try {
      await store.mergeTask(task.id);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // It still fails — there is no worktree — but NOT because of the lane.
    expect(message).not.toContain("must be in 'in-review'");
  });

  it("still refuses a card that is in no review lane at all on the RENAMED board", async () => {
    /*
    Non-vacuous companion: without it, a merge path that had simply stopped checking lane identity would
    satisfy the case above. Same board, same workflow — only the card's column changes.
    */
    const created = await store.createWorkflowDefinition({ name: "renamed merge lanes", ir: RENAMED_IR as never });
    const task = await store.createTask({ description: "not in review" });
    await store.selectTaskWorkflow(task.id, created.id);
    for (const lane of ["backlog", "building"]) {
      await store.moveTask(task.id, lane as never, { moveSource: "user" } as never);
    }
    expect((await store.getTask(task.id)).column).toBe("building");

    let message = "";
    try {
      await store.mergeTask(task.id);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("must be in");
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-14:10 (#2820 review — coderabbit, Major):
  THE REPURPOSED-COLUMN DIRECTION. My first version pre-seeded `in-review` into the resolved set, which
  admits a board that declares `in-review` as its WIP lane — a card mid-implementation would pass the
  merge-identity check and merge prematurely.

  This is the converse direction the optional-flags doc names: not "the lane was renamed" but "the lane
  still CARRIES a lifecycle name while its traits say otherwise", which is what a project gets by
  repurposing a default column. A rename-only test cannot see it.

  REVERT CHECK, measured: pre-seeding the legacy id back into the set makes this fail — the card merges
  from a WIP lane.
  */
  it("still refuses a card in a column NAMED in-review that its workflow declares as WIP", async () => {
    const repurposed = {
      ...RENAMED_IR,
      columns: [
        { id: "backlog", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        /* The trap: legacy NAME, wip TRAITS. */
        { id: "in-review", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "signoff", name: "Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "merge" }] },
        { id: "shipped", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "backlog" },
        { id: "exec", kind: "prompt", column: "in-review", config: { seam: "execute" } },
        { id: "merge-gate", kind: "merge-gate", column: "signoff", config: { gate: "auto-merge" } },
        { id: "end", kind: "end", column: "shipped" },
      ],
      edges: [
        { from: "start", to: "exec" },
        { from: "exec", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
      ],
    } as unknown as WorkflowIr;

    const created = await store.createWorkflowDefinition({ name: "repurposed in-review", ir: repurposed as never });
    const task = await store.createTask({ description: "mid-implementation" });
    await store.selectTaskWorkflow(task.id, created.id);
    for (const lane of ["backlog", "in-review"]) {
      await store.moveTask(task.id, lane as never, { moveSource: "user" } as never);
    }
    expect((await store.getTask(task.id)).column).toBe("in-review");

    let message = "";
    try {
      await store.mergeTask(task.id);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The board's review lane is `signoff`; a card in the WIP lane must not merge.
    /*
    NAMES THE SITE, deliberately. A looser `toContain("must be in")` passes when EITHER guard refuses —
    and it did: with merge-queue-ops reverted, the completion guard in task-artifacts-ops caught the card
    instead and the assertion still held. `Cannot merge` is merge-queue-ops' wording; `Cannot move … to
    done` is the other. Asserting the prefix is what makes the two sites independently provable.
    */
    expect(message).toContain("Cannot merge");
    expect(message).toContain("must be in");
    expect(message).toContain("signoff");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-15:45:
THE MERGE RESULT ASSERTED A COLUMN IT DID NOT SET.

`moveToDoneImpl` resolves the board's completion lane and WRITES it onto the task object
(`task.column = completeColumn`). `mergeTaskImpl` then did

    result.task = { ...task, column: "done" };

putting the literal back over what the writer had just set. Every `task:merged` listener — GitHub
tracking, the auto-merge handoff — was therefore told the card landed in `done` while the persisted
row said `shipped`. The row was right and the event was wrong, which is the worse direction: the
listeners act on the event.

The companion defect is the already-complete short-circuit at the top of the same function, which
asked `task.column === "done"` while the finaliser it guards asks the RESOLVED question. On a renamed
board they disagreed, so a card already resting in the completion lane fell through and the merge ran
again against a branch that was already landed and deleted.

Reached without any git fixture: with no branch present, `git rev-parse --verify` fails and the
function takes its documented "branch not found — moving to done without merge" path, which is the
one that calls `moveToDone` and then builds the result.
*/
pgDescribe("the merge result reports the column the finaliser actually wrote", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ prefix: "fusion_merge_result_lane" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  async function cardInReviewLane(description: string) {
    const created = await store.createWorkflowDefinition({ name: "renamed merge lanes", ir: RENAMED_IR as never });
    const task = await store.createTask({ description });
    await store.selectTaskWorkflow(task.id, created.id);
    for (const lane of ["backlog", "building", "checking"]) {
      await store.moveTask(task.id, lane as never, { moveSource: "user" } as never);
    }
    expect((await store.getTask(task.id)).column).toBe("checking");
    return task.id;
  }

  it("reports the board's completion lane, not the `done` literal", async () => {
    const id = await cardInReviewLane("merge result column");

    const result = await store.mergeTask(id);

    /* The persisted row and the emitted result must agree. Before the fix the row said `shipped`
       and this said `done`. */
    expect((await store.getTask(id)).column).toBe("shipped");
    expect(result.task.column).toBe("shipped");
  });

  it("short-circuits a card already resting in the renamed completion lane", async () => {
    const id = await cardInReviewLane("already complete");
    await store.mergeTask(id);
    expect((await store.getTask(id)).column).toBe("shipped");

    /*
    Second call. Keyed on the `done` literal this guard did not fire on a renamed board, so the card
    fell through to the merge-blocker check and the operator saw a refusal for a card that had
    already merged.
    */
    const second = await store.mergeTask(id);

    expect(second.merged).toBe(false);
    expect(second.task.column).toBe("shipped");
  });
});
