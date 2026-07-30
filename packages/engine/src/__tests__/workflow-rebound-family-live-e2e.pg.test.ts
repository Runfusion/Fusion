/*
FNXC:WorkflowLifecycleColumns 2026-07-28-12:40 (E2E — closing rebound-family ledger entries):

`resolveReboundTarget` answers ONE question — "where does a recovered card go back
to?" — and the ledger listed four unproven callers of it. Re-checked with the lens
the previous slice corrected ("what does the function actually touch?", not "what
family does it sit in"): the self-healing pair needs NO git, so it is covered here.

WHAT A WRONG ANSWER COSTS. Keyed on the literal `todo`, a recovered card on a
renamed board is requeued to a column that board does not declare. That is not a
cosmetic mismatch — an undeclared column carries NO trait flags, so
`findColumn` returns undefined and the card is invisible to every trait-driven
sweep: nothing schedules it, nothing releases it, and the board does not draw the
column. The "recovery" strands the card more thoroughly than the failure it was
recovering from. `reconcileUndeclaredTaskColumns` exists precisely to repair that
state, which makes it the worst possible place for the bug to live.

Covered here:
  self-healing.ts  reconcileUndeclaredTaskColumns      — the undeclared-column repair
  self-healing.ts  autoRecoverWorktreeSessionStartFailure — the session-start requeue

Assertions read the PERSISTED row back through `getTask`; the audit rows are read
back through the store's own reader.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager, autoRecoverWorktreeSessionStartFailure } from "../self-healing.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live rebound E2E: where a recovered card goes back to", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rebound_family_e2e",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /** Persist the workflow and return the id the STORE assigned — it allocates its own
   *  `WF-###` and ignores the one in the input; binding to the id we passed in would
   *  silently resolve to the DEFAULT builtin IR instead. */
  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Rebound ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    return (created as { id: string }).id;
  }

  async function persistedColumn(taskId: string): Promise<string> {
    const store = h.store();
    store.taskCache.delete(taskId);
    return (await store.getTask(taskId)).column as string;
  }

  async function seedTask(taskId: string, column: string, workflowId: string): Promise<Task> {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: `rebound ${taskId}`, column } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    store.taskCache.delete(taskId);
    return task as Task;
  }

  describe("reconcileUndeclaredTaskColumns — the undeclared-column repair", () => {
    /** Park a card in a column NO workflow declares. `moveTask` will not take it there
     *  (that is the point of the transition policy), so the row is written directly —
     *  this is a corrupt-state repair test, and the corrupt state is the fixture. */
    async function strandInUndeclaredColumn(taskId: string, workflowId: string): Promise<void> {
      const store = h.store();
      await seedTask(taskId, "todo", workflowId);
      await h.adminSql()`UPDATE project.tasks SET "column" = 'a-column-no-workflow-declares' WHERE id = ${taskId}`;
      store.taskCache.delete(taskId);
    }

    it("re-homes a stranded card to the RENAMED workflow's own rebound column", async () => {
      const workflowId = await seedWorkflow(RENAMED_VOCAB, "undeclared-renamed");
      await strandInUndeclaredColumn("FN-RB-1", workflowId);
      expect(await persistedColumn("FN-RB-1")).toBe("a-column-no-workflow-declares");

      const rehomed = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(rehomed).toBe(1);
      // `backlog` — the renamed board's hold column — NOT the legacy `todo`, which
      // this workflow does not declare and which would leave the card stranded again.
      expect(await persistedColumn("FN-RB-1")).toBe(RENAMED_VOCAB.hold);
    });

    it("records the repair with the resolved target, not a legacy literal", async () => {
      const workflowId = await seedWorkflow(RENAMED_VOCAB, "undeclared-audit");
      await strandInUndeclaredColumn("FN-RB-2", workflowId);

      await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      const audit = await h.store().getRunAuditEventsAsync({ taskId: "FN-RB-2" });
      const repair = audit.find((e) => e.mutationType === "task:reconcile-undeclared-column");
      const metadata = (typeof repair?.metadata === "string" ? JSON.parse(repair.metadata) : repair?.metadata) as
        | Record<string, unknown>
        | undefined;
      expect(metadata?.toColumn).toBe(RENAMED_VOCAB.hold);
      expect(metadata?.priorColumn).toBe("a-column-no-workflow-declares");
    });

    /*
    FNXC:MergedPlanningColumn 2026-07-29-16:20 (U11 migration proof):
    THE PATH AN OPERATOR ACTUALLY HITS, which the cases above do not cover. They strand a card in a
    synthetic `a-column-no-workflow-declares`; the real upgrade leaves cards in `triage` — a column
    that WAS declared until U11 removed it from the default lineage, on the REAL `builtin:coding`
    workflow rather than a fixture vocabulary.

    That difference matters: `triage` is still a legal `ColumnId` and is still declared by
    legacy-coding, Ideas and every linear built-in (R11), so nothing rejects it and nothing throws.
    The card simply sits in a column its OWN workflow no longer declares, where — per the file
    header — it carries no trait flags and is invisible to every trait-driven sweep.

    Proven below with progress and plan artifacts, because re-homing targets the HOLD column and a
    repair that loses the spec would be worse than the strand.
    */
    async function strandInTriageOnDefaultWorkflow(taskId: string): Promise<void> {
      const store = h.store();
      await seedTask(taskId, "todo", "builtin:coding");
      // Direct write: `moveTask` refuses to take a card into an undeclared column, which is the
      // transition policy working. The corrupt post-upgrade state IS the fixture.
      await h.adminSql()`UPDATE project.tasks SET "column" = 'triage', current_step = 2 WHERE id = ${taskId}`;
      store.taskCache.delete(taskId);
    }

    it("re-homes a card left in the deleted `triage` column on a DEFAULT-workflow board", async () => {
      await strandInTriageOnDefaultWorkflow("FN-MIG-1");
      expect(await persistedColumn("FN-MIG-1")).toBe("triage");

      const rehomed = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(rehomed).toBe(1);
      // The merged Planning column — the default workflow's hold column, id `todo`.
      expect(await persistedColumn("FN-MIG-1")).toBe("todo");
    });

    it("FAILS to move the card when the sweep does not run (proves the sweep is the mover)", async () => {
      /*
      The revert check, in-suite: without this the test above could pass because some OTHER sweep
      or a store-open reconcile moved the card, and it would keep passing if
      `reconcileUndeclaredTaskColumns` were deleted outright.
      */
      await strandInTriageOnDefaultWorkflow("FN-MIG-2");

      // Deliberately do NOT call the sweep.
      expect(await persistedColumn("FN-MIG-2")).toBe("triage");
    });

    it("preserves step progress and the plan artifact across the re-home", async () => {
      await strandInTriageOnDefaultWorkflow("FN-MIG-3");
      const before = await h.store().getTask("FN-MIG-3");

      await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      h.store().taskCache.delete("FN-MIG-3");
      const after = await h.store().getTask("FN-MIG-3");
      expect(after.column).toBe("todo");
      // `preserveProgress: true` is passed by the sweep; assert it actually holds end-to-end
      // rather than trusting the option name.
      expect(after.currentStep).toBe(before.currentStep);
      expect(after.description).toBe(before.description);
    });

    it("SKIPS a userPaused card, leaving it in the deleted column (documented caveat)", async () => {
      /*
      Confirmed behavior, recorded as a test so it is a decision rather than an accident: an
      operator park is authoritative and the sweep will not override it. The consequence is real —
      a paused card stays in a column its workflow no longer declares, invisible to trait-driven
      sweeps, until someone unpauses it.

      It is a caveat rather than a stall because the card is reachable: unpausing it makes the next
      sweep re-home it, and the U11 undeclared-source escape hatch in `resolveAllowedColumns` lets
      an operator move it by hand in the meantime.
      */
      await strandInTriageOnDefaultWorkflow("FN-MIG-4");
      // `user_paused` is an integer flag in the PG schema, not a boolean.
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = ${"FN-MIG-4"}`;
      h.store().taskCache.delete("FN-MIG-4");

      const rehomed = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(rehomed).toBe(0);
      expect(await persistedColumn("FN-MIG-4")).toBe("triage");
    });

    it("still re-homes a default-vocabulary card to `todo` (regression floor)", async () => {
      const workflowId = await seedWorkflow(DEFAULT_VOCAB, "undeclared-default");
      await strandInUndeclaredColumn("FN-RB-3", workflowId);

      await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(await persistedColumn("FN-RB-3")).toBe(DEFAULT_VOCAB.hold);
    });

    it("leaves a card alone when its column IS declared by its workflow", async () => {
      /* The negative half. "Re-home anything whose column looks wrong" would drag
         every healthy card on a renamed board back to its hold column — a far louder
         failure than the strand it repairs. */
      const workflowId = await seedWorkflow(RENAMED_VOCAB, "declared-renamed");
      await seedTask("FN-RB-4", RENAMED_VOCAB.wip, workflowId);

      const rehomed = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(rehomed).toBe(0);
      expect(await persistedColumn("FN-RB-4")).toBe(RENAMED_VOCAB.wip);
    });

    it("leaves an operator-paused card stranded rather than moving it", async () => {
      /* `userPaused` is an operator park; the sweep must not undo it even to repair a
         genuinely broken column. */
      const workflowId = await seedWorkflow(RENAMED_VOCAB, "undeclared-paused");
      await strandInUndeclaredColumn("FN-RB-5", workflowId);
      /* Written directly rather than through `updateTask`: a probe showed
         `updateTask({ userPaused: true })` leaves the field `undefined` on both `getTask`
         and `listTasks({slim:true})`, so seeding it that way produced a card the sweep
         correctly saw as unpaused — a broken fixture that would have read as a broken
         guard. `user_paused` is an integer column. */
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = 'FN-RB-5'`;
      h.store().taskCache.delete("FN-RB-5");
      expect((await h.store().getTask("FN-RB-5")).userPaused).toBe(true);

      await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(await persistedColumn("FN-RB-5")).toBe("a-column-no-workflow-declares");
    });
  });

  describe("autoRecoverWorktreeSessionStartFailure — the session-start requeue", () => {
    async function recover(taskId: string, v: Vocabulary, key: string) {
      const workflowId = await seedWorkflow(v, key);
      const task = await seedTask(taskId, v.wip, workflowId);
      return autoRecoverWorktreeSessionStartFailure(h.store() as TaskStore, task, {
        failure: new Error("worktree path does not exist"),
        source: "executor-session-start",
        auditor: null,
      } as never);
    }

    it("requeues a recovered card to the RENAMED workflow's rebound column", async () => {
      const result = await recover("FN-RB-6", RENAMED_VOCAB, "session-renamed");

      expect(result.outcome).toBe("requeue-todo"); // the outcome NAME is legacy; the column is not
      expect(await persistedColumn("FN-RB-6")).toBe(RENAMED_VOCAB.hold);
    });

    it("still requeues a default-vocabulary card to `todo` (regression floor)", async () => {
      await recover("FN-RB-7", DEFAULT_VOCAB, "session-default");

      expect(await persistedColumn("FN-RB-7")).toBe(DEFAULT_VOCAB.hold);
    });
  });
});
