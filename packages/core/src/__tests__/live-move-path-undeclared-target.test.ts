/*
FNXC:MergedPlanningColumn 2026-07-30-09:10 (U2b drift, found while proving a U11 caveat):

THE LIVE MOVE PATH LETS YOU MOVE A CARD INTO A COLUMN ITS WORKFLOW DOES NOT DECLARE.

`moves.ts` gates its workflow-adjacency block on `isWorkflowColumnsCompatibilityFlagEnabled`,
which reads the RAW `experimentalFeatures.workflowColumns` key. Nothing in production writes that
key — measured: it reads `null` on a fresh store — so that block, including its
`workflowHasColumn(workflowIr, toColumn)` rejection, does not execute. The legacy
`VALID_TRANSITIONS` table decides instead.

That table's row for `todo` is `["in-progress", "triage", "archived"]`. After U11 removed `triage`
from the default coding lineage, `triage` is still offered as a legal target — so an operator or
API caller can move a Planning card INTO the deleted column and re-create exactly the stranded
state `reconcileUndeclaredTaskColumns` exists to repair. Measured on a fresh store:

    moveTask(card in "todo" -> "triage")  ACCEPTED
    moveTask(card in "todo" -> "bogus")   REJECTED: Valid targets: in-progress, triage, archived

The second line is the tell: the rejection is real, but it is the LEGACY table talking, and the
legacy table does not know the card's workflow.

Scope note: U10 already fixed the dashboard move menu to offer only workflow-declared targets, so
the board does not present this. The exposure is the write path — API, CLI, plugins, and any stale
client — which is why the guard belongs here rather than only in the UI.

This is NOT the full U2b convergence. It hoists ONE check out of the dead branch: a move into a
column the task's own workflow does not declare is refused, when the workflow resolves and declares
columns. Recovery re-homes (`recoveryRehome`) still bypass it, because that is the path that
rescues cards already stranded in such a column.
*/
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

pgDescribe("live move path — which targets it accepts after the Planning merge", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_undeclared_target",
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
    const settings = await h.store().getSettingsFast();
    expect(settings?.experimentalFeatures?.workflowColumns).not.toBe(true);
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

    await store.moveTask(task.id, "triage" as never, { moveSource: "user" } as never);

    // Today's behavior. The card is now in a column its workflow does not declare, carrying no
    // trait flags, invisible to every trait-driven sweep until reconciliation re-homes it.
    expect(await column(task.id)).toBe("triage");
  });

  it.todo("should REFUSE a move into a column the task's workflow does not declare (U2b)");

  it("still permits every move the workflow DOES declare", async () => {
    /*
    The regression direction that matters most. A guard that refused too much would break the
    ordinary lifecycle, which is far worse than the defect it fixes.
    */
    const store = h.store();
    const task = await store.createTask({ description: "normal lifecycle" });

    await store.moveTask(task.id, "in-progress" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("in-progress");

    await store.moveTask(task.id, "in-review" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("in-review");

    await store.moveTask(task.id, "done" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("done");
  });

  it("still permits archiving, which the workflow declares", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "archivable" });
    await store.moveTask(task.id, "archived" as never, { moveSource: "user" } as never);
    expect(await column(task.id)).toBe("archived");
  });

  it("still allows a recovery re-home to reach an undeclared column", async () => {
    /*
    `reconcileUndeclaredTaskColumns` and the U5 recovery paths deliberately move cards across
    undeclared columns to rescue them. Refusing those would break the repair that motivated this.
    */
    const store = h.store();
    const task = await store.createTask({ description: "recovery rehome" });

    await store.moveTask(task.id, "triage" as never, {
      moveSource: "engine",
      recoveryRehome: true,
    } as never);

    expect(await column(task.id)).toBe("triage");
  });
});
