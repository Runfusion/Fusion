/*
FNXC:MergedPlanningColumn 2026-07-30-09:10 (U2b drift, found while proving a U11 caveat):

THE LIVE MOVE PATH LETS YOU MOVE A CARD INTO A COLUMN ITS WORKFLOW DOES NOT DECLARE.

`moves.ts` gates its workflow-adjacency block on `isWorkflowColumnsCompatibilityFlagEnabled`,
which reads the RAW `experimentalFeatures.workflowColumns` key. Nothing in production writes that
key — measured: it reads `null` on a fresh store — so that block, including its
`workflowHasColumn(workflowIr, toColumn)` rejection, does not execute. The legacy
`VALID_TRANSITIONS` table decides instead.

The legacy transition table once offered targets that a task's selected workflow did not declare. After U11 removed `triage`
from the default coding lineage, `triage` is still offered as a legal target — so an operator or
API caller can move a Planning card INTO the deleted column and re-create exactly the stranded
state `reconcileUndeclaredTaskColumns` exists to repair. Measured on a fresh store:

    moveTask(card in "todo" -> "triage")  ACCEPTED
    moveTask(card in "todo" -> "bogus")   REJECTED as an unknown workflow column

The second line is the tell: the rejection is real, but it is the LEGACY table talking, and the
legacy table does not know the card's workflow.

Scope note: U10 already fixed the dashboard move menu to offer only workflow-declared targets, so
the board does not present this. The exposure is the write path — API, CLI, plugins, and any stale
client — which is why the guard belongs here rather than only in the UI.

This is NOT the full U2b convergence. It hoists ONE check out of the dead branch: a move into a
column the task's own workflow does not declare is refused, when the workflow resolves and declares
columns. Recovery re-homes (`recoveryRehome`) still bypass it, because that is the path that
rescues cards already stranded in such a column — bypassing ADJACENCY on the way to the
workflow's declared rebound target, which is the only direction production actually moves
(see `reconcileUndeclaredTaskColumns`, self-healing.ts:6386).
*/
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { workflowHasColumn } from "../workflows/workflow-transitions.js";

pgDescribe("live move path — which targets it accepts after the Planning merge", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_undeclared_target",
    projectId: "project-live-move-targets",
  });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  async function column(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  it("premise: the compatibility flag really is unset, so the legacy path decides", async () => {
    /*
    FNXC:MergedPlanningColumn 2026-07-30-12:05 (PR #2601 review — coderabbit):
    `not.toBe(true)` also passes when the key is explicitly `false`, which is a
    DIFFERENT state from the documented fresh-store `null` and would hide a change
    to it. The premise this file rests on is that NOTHING WRITES the key, so assert
    the unset representation itself.
    */
    const settings = await h.store().getSettingsFast();
    expect(settings?.experimentalFeatures?.workflowColumns ?? null).toBeNull();
  });

  /*
  THE DEFECT, characterized rather than asserted-as-correct.

  A default-workflow card in Planning can be moved into `triage` — a column its workflow no longer
  declares — re-creating the stranded state `reconcileUndeclaredTaskColumns` exists to repair. This
  test pins TODAY'S behavior so the defect is visible and measurable; it deliberately does NOT
  assert the move is correct, and the `it.todo` below states the intended behavior.

  Not fixed here on purpose. The obvious fix is to un-gate `workflowHasColumn` from the
  compatibility-flag block, and PR #2499 explicitly scoped that out: "only the CAPACITY check is
  un-gated. `workflowIr` stays flag-gated so transition VALIDATION keeps its current behavior — the
  inline path's bare-Error/'Valid targets:' contract is unchanged, and none of the Phase A2
  divergences are flipped here." That was a considered decision by the owner of this function, and
  overriding it from outside would flip an error contract several suites pin.

  What CHANGED since that decision is U11: the legacy table now offers a target the default
  workflow does not declare, which it never did before. That is new information for the scoping
  call, not a reason to ignore it — so this lands as a reproduction and a guard-rail set for
  whoever converges the paths (U2b), with the four cases below pinning the moves a fix must NOT
  break.
  */
  it("CHARACTERIZATION: accepts a move into `triage`, which the default workflow does not declare", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "re-strandable today" });
    expect(task.column).toBe("todo");

    /*
    FNXC:MergedPlanningColumn 2026-07-30-12:05 (PR #2601 review — coderabbit):
    Prove the PREMISE before reproducing the defect. Checking only the start column
    left this test green if the default workflow ever declared `triage` again — it
    would still pass while reproducing nothing, which is the failure mode this whole
    exercise keeps hitting. The defect is "moves into an UNDECLARED column are
    accepted", so undeclaredness has to be asserted, not assumed.
    */
    const ir = await resolveWorkflowIrForTask(store, task.id);
    expect(workflowHasColumn(ir, "triage")).toBe(false);
    expect(workflowHasColumn(ir, "todo")).toBe(true);

    /*
    FNXC:WorkflowColumns 2026-07-30-04:30 (U12 — the move-path flag is RESOLVED; this is the fix):
    THE DEFECT IS GONE, so this case now asserts the refusal instead of the acceptance, and the
    `it.todo` below it — "should REFUSE a move into a column the task's workflow does not declare
    (U2b)" — is fulfilled rather than left dangling.

    Before: the move was ACCEPTED and the card landed in a column carrying no trait flags, invisible
    to every trait-driven sweep until reconciliation re-homed it. Now the move path resolves the
    target against the task's own workflow unconditionally, so it is refused at the boundary.

    The premise assertions above are deliberately kept: they prove `triage` really is undeclared, so
    this cannot pass for the wrong reason if the default lineage ever declares it again.
    */
    await expect(
      store.moveTask(task.id, "triage" as never, { moveSource: "user" } as never),
    ).rejects.toThrow(/Unknown column for this workflow/);

    // And the card never moved.
    expect(await column(task.id)).toBe("todo");
  });

  it("still permits every move the workflow DOES declare", async () => {
    /*
    The regression direction that matters most. A guard that refused too much would break the
    ordinary lifecycle, which is far worse than the defect it fixes.
    */
    const store = h.store();
    /*
    FNXC:WorkflowColumns 2026-08-23-23:15:
    This case is about COLUMN declaration, not merge gating. FN-9191 (`PRE_MERGE_STEPS_NOT_RUN_BLOCKER`,
    task-merge.ts) made an enabled-but-unrun pre-merge gate refuse in-review -> done, and the default
    workflow enables Code Review, so a bare `createTask` can no longer walk the lifecycle here. Declare
    no pre-merge steps so the move path — the thing under test — is what decides.
    */
    const task = await store.createTask({ description: "normal lifecycle", enabledWorkflowSteps: [] });

    await store.moveTask(task.id, "in-progress" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("in-progress");

    await store.moveTask(task.id, "in-review" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("in-review");

    await store.moveTask(task.id, "done" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("done");
  });

  it("lets an undeclared source re-enter only at the workflow's rebound target", async () => {
    /*
    FNXC:MergedPlanningColumn 2026-07-30-10:20 (PR #2601 review — greptile P2):

    REWRITTEN, and the direction is the whole point. This asserted that a recovery
    move could reach an UNDECLARED column (`todo` -> `triage`), which is the inverse
    of what recovery does. `reconcileUndeclaredTaskColumns` reads
    `resolveReboundTarget(ir)` and moves a card OUT of an undeclared column INTO a
    declared one — verified at `self-healing.ts:6386`. Nothing in production moves a
    card deliberately INTO an undeclared column.

    Keeping the old assertion would have been actively harmful: it pins the ability
    to CREATE the stranded state that the sweep exists to repair, so the destination
    validation this PR is a step toward would have to carve out an exception for it.

    The capability is not entirely unexercised — the ~15 hard-coded
    `moveTask(id, "todo", { recoveryRehome })` calls in self-healing DO land in an
    undeclared column for any workflow that does not declare `todo`. But those are
    the literals on the conversion backlog, so that is bug-compatibility, not an
    invariant, and pinning it would cement the bug.

    An undeclared source has no lifecycle adjacency to violate, so its only legal target is the
    workflow's resolved rebound column. This permits repair without granting a jump directly into
    WIP, review, or Complete.
    */
    const store = h.store();
    /*
    FNXC:WorkflowColumns 2026-08-23-23:15:
    This case is about COLUMN declaration, not merge gating. FN-9191 (`PRE_MERGE_STEPS_NOT_RUN_BLOCKER`,
    task-merge.ts) made an enabled-but-unrun pre-merge gate refuse in-review -> done, and the default
    workflow enables Code Review, so a bare `createTask` can no longer walk the lifecycle here. Declare
    no pre-merge steps so the move path — the thing under test — is what decides.
    */
    const task = await store.createTask({ description: "recovery rehome", enabledWorkflowSteps: [] });

    /* Simulate the historical stranded state directly: production moves must not create an
       undeclared source, while recovery still has to repair rows persisted by old versions. */
    const schema = await import("../postgres/schema/index.js");
    const { eq } = await import("drizzle-orm");
    await h.layer().db.update(schema.project.tasks).set({ column: "stranded" })
      .where(eq(schema.project.tasks.id, task.id));
    store.taskCache.delete(task.id);
    expect(await column(task.id)).toBe("stranded");

    await expect(
      store.moveTask(task.id, "in-progress" as never, { moveSource: "engine" } as never),
    ).rejects.toThrow(/Valid targets: todo/);
    expect(await column(task.id)).toBe("stranded");

    await store.moveTask(task.id, "todo" as never, { moveSource: "engine" } as never);
    expect(await column(task.id)).toBe("todo");
  });
});
