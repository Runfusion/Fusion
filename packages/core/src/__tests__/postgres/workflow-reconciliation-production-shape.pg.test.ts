/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, R12):
The three U5 (R20) workflow-lifecycle reconciliation guards, exercised in the
PRODUCTION SHAPE — that is, with `experimentalFeatures.workflowColumns` NEVER
written by the test.

WHY THAT MATTERS, and why this file is separate from
`workflow-authoritative-reads.pg.test.ts`. Every one of these guards used to be
gated on `store.workflowColumnsFlagOn()`, which reads the RAW
`experimentalFeatures.workflowColumns` key. No production writer sets that key, so
all three were inert for every real project:

  - removing an OCCUPIED column from a workflow silently succeeded, stranding the
    cards in a column their workflow no longer declared;
  - deleting a workflow captured an EMPTY occupant list, so its cards were left in
    that workflow's columns until the next engine startup sweep;
  - switching a task's workflow never reconciled its column, and the
    `reconciliation` field the API promises was never populated.

The pre-existing coverage reached these guards by writing the flag ON itself, which
is precisely why the gap was invisible: the tests passed against a configuration no
operator has. Every case below therefore asserts through the PUBLIC store seams with
the flag ABSENT.

REVERT CHECK — each case fails if its flip is undone:
  - restore `flagOn &&` on the edit guard  -> "blocks a workflow edit ..." fails,
    because the update resolves instead of rejecting with OccupiedColumnsError, and
    "re-homes occupants ..." fails because the cards never move.
  - restore `flagOn ?  : []` on the delete capture -> "re-homes a deleted workflow's
    occupants ..." fails, because the card stays in `custom-hold`.
  - restore the `workflowColumnsFlagOn()` early return on switch -> both switch cases
    fail, because `reconciliation` comes back undefined and the card does not move.
I ran each of those three reverts individually against this file and confirmed the
matching failures. Note for anyone repeating it: `workflow-ops.ts` contains TWO
identical `const occupantTaskIds = await store.listWorkflowOccupantTaskIds(id, false)`
lines — one in the field-reconcile block, one in the delete path — so a first-match
edit reverts the wrong one and the delete case then passes against what looks like
reverted code. Anchor on surrounding context. Measured output is in the PR description.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";
import { resolveDefaultWorkflowIr } from "../../builtin-workflows.js";
import { resolveEntryColumnId } from "../../workflow-reconciliation.js";
import type { WorkflowIrV2 } from "../../workflow-ir-types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/** The built-in coding workflow plus one extra column, so a test can occupy a
 *  column that the DEFAULT workflow does not declare. */
function workflowWithCustomColumn(name: string): WorkflowIrV2 {
  const ir = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
  ir.name = name;
  ir.columns.push({ id: "custom-hold", name: "Custom hold", traits: [] });
  return ir;
}

pgDescribe("U5 workflow reconciliation guards — production shape (no workflowColumns flag)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_u5_prod_shape",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Create a workflow with a custom column and park one task in it. */
  async function seedOccupiedCustomColumn(workflowName: string) {
    const store = h.store();
    const ir = workflowWithCustomColumn(workflowName);
    const workflow = await store.createWorkflowDefinition({ name: workflowName, ir, layout: {} });
    const task = await store.createTask({ description: `occupies ${workflowName}` });
    await store.selectTaskWorkflow(task.id, workflow.id);
    await store.moveTask(task.id, "custom-hold", {
      moveSource: "engine",
      bypassGuards: true,
      recoveryRehome: true,
    });
    expect((await store.getTask(task.id)).column).toBe("custom-hold");
    return { store, ir, workflow, task };
  }

  // ── Guard 1: workflow edit that removes an occupied column ────────────────

  it("blocks a workflow edit that removes an occupied column, with no flag set", async () => {
    const { store, ir, workflow } = await seedOccupiedCustomColumn("Edit guard");

    const nextIr = structuredClone(ir);
    nextIr.columns = nextIr.columns.filter((column) => column.id !== "custom-hold");

    await expect(store.updateWorkflowDefinition(workflow.id, { ir: nextIr })).rejects.toMatchObject({
      name: "OccupiedColumnsError",
      workflowId: workflow.id,
    });

    // The rejection must be a real abort: the IR is unchanged, so a failed save
    // cannot half-apply and leave the column gone with the cards still in it.
    const after = await store.getWorkflowDefinition(workflow.id);
    expect((after!.ir as WorkflowIrV2).columns.map((c) => c.id)).toContain("custom-hold");
  });

  it("re-homes occupants into rehomeTo when the edit supplies one, with no flag set", async () => {
    const { store, ir, workflow, task } = await seedOccupiedCustomColumn("Edit rehome");

    const nextIr = structuredClone(ir);
    nextIr.columns = nextIr.columns.filter((column) => column.id !== "custom-hold");

    await store.updateWorkflowDefinition(workflow.id, { ir: nextIr, rehomeTo: "todo" });

    // The card lands in the column the editor chose, not wherever it happened to sit.
    expect((await store.getTask(task.id)).column).toBe("todo");
    const after = await store.getWorkflowDefinition(workflow.id);
    expect((after!.ir as WorkflowIrV2).columns.map((c) => c.id)).not.toContain("custom-hold");
  });

  it("allows an edit that removes an UNOCCUPIED column, with no flag set", async () => {
    const store = h.store();
    const ir = workflowWithCustomColumn("Unoccupied");
    const workflow = await store.createWorkflowDefinition({ name: "Unoccupied", ir, layout: {} });

    const nextIr = structuredClone(ir);
    nextIr.columns = nextIr.columns.filter((column) => column.id !== "custom-hold");

    // No occupants -> no rejection, no rehomeTo required. This is the case that must
    // NOT regress into a blanket "you may never remove a column" error.
    await store.updateWorkflowDefinition(workflow.id, { ir: nextIr });
    const after = await store.getWorkflowDefinition(workflow.id);
    expect((after!.ir as WorkflowIrV2).columns.map((c) => c.id)).not.toContain("custom-hold");
  });

  // ── Guard 2: workflow delete ──────────────────────────────────────────────

  it("re-homes a deleted workflow's occupants to the default entry column, with no flag set", async () => {
    const { store, workflow, task } = await seedOccupiedCustomColumn("Delete guard");

    await store.deleteWorkflowDefinition(workflow.id);

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-21:30:
    ASSERTED AGAINST THE RESOLVER, NOT A LITERAL. This expectation was `"triage"` and had been
    failing on main: the delete path was fixed to re-home occupants using
    `resolveEntryColumnId(resolveDefaultWorkflowIr())` instead of `BUILTIN_CODING_WORKFLOW_IR`, and
    this assertion was not updated with it.

    The two IRs are not the same board. `BUILTIN_CODING_WORKFLOW_IR` is `builtin:legacy-coding` and
    declares `triage`; the catalog's actual default does not. Re-homing into `triage` put cards in a
    column the default board never declares — it slipped past `moveTask`'s undeclared-target guard
    only because `triage` is a legacy id and the recovery-rehome path exempts those.

    So `todo` is the CORRECT answer and the literal was the stale half. It is now derived from the
    same two functions the product path calls, which is the only form of this assertion that cannot
    drift out of sync with them again — a hardcoded `"todo"` would be the identical trap one rename
    later.
    */
    const defaultEntry = resolveEntryColumnId(resolveDefaultWorkflowIr());
    expect(defaultEntry).toBeDefined();
    expect((await store.getTask(task.id)).column).toBe(defaultEntry);

    /* The card must genuinely have left the vanished column, not merely match a resolver. */
    expect((await store.getTask(task.id)).column).not.toBe("custom-hold");
  });

  // ── Guard 3: workflow switch ──────────────────────────────────────────────

  it("reconciles a task's column when switching to a workflow that lacks it, with no flag set", async () => {
    const { store, task } = await seedOccupiedCustomColumn("Switch source");

    // The built-in coding workflow does not declare `custom-hold`, so switching to it
    // must move the card rather than leave it in a lane the target cannot draw.
    const target = await store.createWorkflowDefinition({
      name: "Switch target",
      ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2,
      layout: {},
    });

    const result = await store.selectTaskWorkflowAndReconcile(task.id, target.id);

    expect(result.reconciliation).toBeDefined();
    expect(result.reconciliation!.preserved).toBe(false);
    expect(result.reconciliation!.fromColumn).toBe("custom-hold");
    expect((await store.getTask(task.id)).column).toBe(result.reconciliation!.toColumn);
    expect((await store.getTask(task.id)).column).not.toBe("custom-hold");
  });

  it("refuses the switch BEFORE committing the selection when the destination is full (PR #2512 review)", async () => {
    const store = h.store();

    /*
    `rehomeOccupant` deliberately swallows a rejected move ("a full target column
    rejects, which we audit and skip"), so the switch used to report the column it
    ASKED for. Induce that: give the target workflow's entry column a WIP limit of 1
    and fill it, so the re-home is rejected and the card stays put.
    */
    const targetIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    targetIr.name = "capped-target";
    const entry = targetIr.columns.find((c) => c.id === "triage")!;
    entry.traits = [...entry.traits, { trait: "wip", config: { limit: 1 } }];
    const target = await store.createWorkflowDefinition({ name: "Capped target", ir: targetIr, layout: {} });

    /*
    Occupy the single slot in the TARGET workflow's entry column.

    FNXC:MergedPlanningColumn 2026-07-29-15:40 (U11 post-merge audit):
    The filler's column must be explicit. It is created before the workflow switch, so it lands in
    the PROJECT DEFAULT's intake column — which U11 merged to `todo`. The cap under test is on the
    TARGET workflow's `triage` entry column (the target clones legacy-coding, which keeps the split
    shape), so a filler in `todo` occupies nothing and the switch is no longer refused. Naming the
    column here makes the fixture independent of whatever the project default's intake happens to
    be, which is what let this drift in the first place.
    */
    const filler = await store.createTask({ description: "fills the cap", column: "triage" });
    await store.selectTaskWorkflow(filler.id, target.id);
    expect((await store.getTask(filler.id)).column).toBe("triage");

    // A card parked in a column the target workflow does not declare.
    const { task } = await seedOccupiedCustomColumn("Capacity source");

    const before = await store.getTaskWorkflowSelectionAsync(task.id);

    /*
    The ORDERING is the fix (PR #2512 review). The destination is full, so the switch
    must be refused BEFORE the selection commits — leaving a consistent card — rather
    than committing the selection and then discovering the re-home cannot happen.
    */
    await expect(store.selectTaskWorkflowAndReconcile(task.id, target.id)).rejects.toMatchObject({
      name: "WorkflowSwitchRehomeFailedError",
      taskId: task.id,
      workflowId: target.id,
      fromColumn: "custom-hold",
      intendedColumn: "triage",
      committed: false,
    });

    // NOTHING was written: same column AND same workflow selection as before. This is
    // the assertion that distinguishes the ordering fix from a louder error message —
    // it fails if the selection is committed before the capacity pre-flight.
    expect((await store.getTask(task.id)).column).toBe("custom-hold");
    expect((await store.getTaskWorkflowSelectionAsync(task.id))?.workflowId).toBe(before?.workflowId);
    expect((await store.getTaskWorkflowSelectionAsync(task.id))?.workflowId).not.toBe(target.id);
  });

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review):
  The soft-delete-mid-switch case is NOT here. `selectTaskWorkflow` rejects an
  already-deleted task up front with `TaskDeletedError`, so the window between the
  switch's first read and its final one cannot be driven from outside the call. It is
  covered directly against the pure seam in
  `__tests__/workflow-switch-reconciliation-report.test.ts`.
  */
  it("preserves a task's column when the new workflow DOES declare it, with no flag set", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "stays put" });
    await store.moveTask(task.id, "todo", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });

    const target = await store.createWorkflowDefinition({
      name: "Declares todo",
      ir: structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2,
      layout: {},
    });

    const result = await store.selectTaskWorkflowAndReconcile(task.id, target.id);

    // Reconciliation is not a licence to move every switched card — a declared column
    // is left exactly where it is.
    expect(result.reconciliation).toBeDefined();
    expect(result.reconciliation!.preserved).toBe(true);
    expect((await store.getTask(task.id)).column).toBe("todo");
  });
});
