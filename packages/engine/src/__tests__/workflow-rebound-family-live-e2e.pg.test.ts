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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager, autoRecoverWorktreeSessionStartFailure } from "../self-healing.js";
import { DEFAULT_VOCAB, MERGED_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

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
  async function seedWorkflow(v: Vocabulary, key: string, opts: { mergedIntakeAndHold?: boolean } = {}): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Rebound ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, opts),
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
    /*
    FNXC:MergedPlanningColumn 2026-07-29-18:10 (PR #2597 review — greptile):
    REPRESENTATIVE progress, not a bare integer. The first cut set `current_step = 2` on a task
    seeded with `applyDefaultWorkflowSteps: false` — so there were no steps for the index to point
    at — and asserted `description` survived, which is an ordinary creation-time field rather than
    anything a re-home could plausibly reset. A regression that wiped REAL progress would have left
    that test green, which makes it the exact class of test this program keeps rejecting.

    Now seeds the three things a re-home could actually destroy: a real step array with one step
    already done, a recorded worktree, and a real PROMPT.md artifact on disk.
    */
    async function strandInTriageOnDefaultWorkflow(taskId: string): Promise<void> {
      const store = h.store();
      await seedTask(taskId, "todo", "builtin:coding");

      await store.updateTask(taskId, {
        steps: [
          { name: "Step one", status: "done" },
          { name: "Step two", status: "pending" },
        ],
        currentStep: 1,
        worktree: `/tmp/wt-${taskId}`,
      } as never);

      // A real plan artifact — the thing an operator would actually lose.
      const taskDir = join(store.getTasksDir(), taskId);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "PROMPT.md"), `# ${taskId}\n\n## Steps\n\n### Step 0: real spec\n`, "utf-8");

      // Direct write: `moveTask` refuses to take a card into an undeclared column, which is the
      // transition policy working. The corrupt post-upgrade state IS the fixture.
      await h.adminSql()`UPDATE project.tasks SET "column" = 'triage' WHERE id = ${taskId}`;
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

    it("preserves real step progress, the worktree, and the plan artifact across the re-home", async () => {
      await strandInTriageOnDefaultWorkflow("FN-MIG-3");
      const store = h.store();
      const before = await store.getTask("FN-MIG-3");
      const promptPath = join(store.getTasksDir(), "FN-MIG-3", "PROMPT.md");
      const promptBefore = await readFile(promptPath, "utf-8");
      // The fixture must actually carry progress, or the assertions below prove nothing.
      expect(before.steps).toHaveLength(2);
      expect(before.steps?.[0]?.status).toBe("done");
      expect(before.worktree).toBe("/tmp/wt-FN-MIG-3");

      await new SelfHealingManager(store, {} as never).reconcileUndeclaredTaskColumns();

      store.taskCache.delete("FN-MIG-3");
      const after = await store.getTask("FN-MIG-3");
      expect(after.column).toBe("todo");
      /*
      `preserveProgress: true` is passed by the sweep; assert what it must actually protect rather
      than trusting the option name. `reset-on-entry` rides on the merged Planning column, so a
      re-home landing there is precisely where step resets would fire if the flag were dropped.
      */
      expect(after.steps).toHaveLength(2);
      expect(after.steps?.[0]?.status).toBe("done");
      expect(after.currentStep).toBe(before.currentStep);
      expect(after.worktree).toBe(before.worktree);
      expect(await readFile(promptPath, "utf-8")).toBe(promptBefore);
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

    /*
    FNXC:MergedPlanningColumn 2026-07-29-18:20 (PR #2597 review — greptile):
    The skip test above proves only the skip. The "caveat, not a stall" CONCLUSION rests on the two
    escape paths actually working, and that was asserted in prose rather than in code — so the
    conclusion was unproven, which is worse than an untested behavior because it was reported as an
    answer. Both paths are now exercised.
    */
    it("ESCAPE 1: unpausing lets the next sweep re-home the card", async () => {
      await strandInTriageOnDefaultWorkflow("FN-MIG-5");
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = ${"FN-MIG-5"}`;
      h.store().taskCache.delete("FN-MIG-5");
      expect(await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns()).toBe(0);

      await h.adminSql()`UPDATE project.tasks SET user_paused = 0 WHERE id = ${"FN-MIG-5"}`;
      h.store().taskCache.delete("FN-MIG-5");

      expect(await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns()).toBe(1);
      expect(await persistedColumn("FN-MIG-5")).toBe("todo");
    });

    it("ESCAPE 2: an operator can move the card out by hand, with self-healing never running", async () => {
      /*
      FNXC:MergedPlanningColumn 2026-07-29-18:50 (PR #2597 review — greptile, and a CORRECTION):

      This passes, and my first explanation of WHY was wrong. I claimed the rescue came from U11's
      undeclared-source escape hatch in `resolveAllowedColumns`. Mutation-tested: stubbing that
      hatch back to `[]` leaves this test GREEN, so the hatch is not what saves the card.

      The real reason is narrower and worth knowing. `moves.ts` gates its entire workflow-adjacency
      block on `useWorkflow = isWorkflowColumnsCompatibilityFlagEnabled(...)`, which reads the RAW
      `experimentalFeatures.workflowColumns` key — and nothing in production writes that key, so it
      reads false. The block containing `resolveAllowedColumns` therefore does not execute on the
      live move path at all; the legacy `VALID_TRANSITIONS` path does, and `triage -> todo` is a
      legal legacy transition. That is what makes the card movable.

      So caveat 2 is survivable, but by the LEGACY table rather than by the trait-resolved hatch —
      and the hatch I added in #2515 only covers projects that have the compat flag on, which is
      approximately none. This is U2b ("converge the two move paths", never done) surfacing: a fix
      landed on the dead branch. Recorded here rather than silently relied upon, because the
      difference decides whether the hatch may be deleted as dead code later.

      The assertion is deliberately about the OUTCOME an operator sees, not about which branch
      produced it, so it stays true whichever path is authoritative after U2b converges them.
      */
      await strandInTriageOnDefaultWorkflow("FN-MIG-6");
      const store = h.store();

      // The operator-facing path, with no recovery flags — exactly what a board drag issues.
      await store.moveTask("FN-MIG-6", "todo" as never, { moveSource: "user" } as never);

      expect(await persistedColumn("FN-MIG-6")).toBe("todo");
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

    it("re-homes a stranded card on a MERGED board, where hold and intake are one column", async () => {
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-17:10 (merged-board evidence):
      `resolveReboundTarget` prefers hold -> intake -> first column. On the post-U11 default
      lineage those first two COLLAPSE onto one column, so the preference order stops being a
      preference at all — and a repair that reasoned "not hold, so try intake" would either pick
      the same column twice or fall through to "first column", which is not necessarily a lane a
      card may rest in.

      The renamed cases above cannot see this: they have hold and intake as distinct columns, so
      the preference order is still meaningful there. This is why the merged shape is a separate
      vocabulary rather than another set of ids.
      */
      const workflowId = await seedWorkflow(MERGED_VOCAB, "undeclared-merged", { mergedIntakeAndHold: true });
      await strandInUndeclaredColumn("FN-RB-M1", workflowId);
      expect(await persistedColumn("FN-RB-M1")).toBe("a-column-no-workflow-declares");

      const rehomed = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(rehomed).toBe(1);
      // The merged planning lane — reached as `hold`, which is also `intake`.
      expect(await persistedColumn("FN-RB-M1")).toBe(MERGED_VOCAB.hold);
    });

    it("does not re-home a MERGED-board card that is already in the merged lane", async () => {
      /* The self-move check. `resolveReboundTarget` returns the card's OWN column here, and the
         sweep skips when `target === task.column` — otherwise it would move a card onto itself
         and re-fire on every pass. A single-pass count cannot distinguish that from a no-op, so
         the sweep is run twice. */
      const workflowId = await seedWorkflow(MERGED_VOCAB, "merged-inplace", { mergedIntakeAndHold: true });
      await seedTask("FN-RB-M2", MERGED_VOCAB.hold, workflowId);

      const first = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();
      const second = await new SelfHealingManager(h.store(), {} as never).reconcileUndeclaredTaskColumns();

      expect(first).toBe(0);
      expect(second).toBe(0);
      expect(await persistedColumn("FN-RB-M2")).toBe(MERGED_VOCAB.hold);
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
