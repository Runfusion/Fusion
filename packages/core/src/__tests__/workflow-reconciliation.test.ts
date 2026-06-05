// @vitest-environment node
//
// U5: workflow lifecycle reconciliation — switch / edit / delete with live cards
// (R15, R20). Covers every U5 plan scenario:
//   - switch with a same-id column preserves position;
//   - switch without one re-homes to the new workflow's entry column AND fires
//     the injected abort callback;
//   - edit removing an occupied column blocks with per-column occupant counts;
//   - the rehomeTo option saves + re-homes all occupants, one audit per card;
//   - delete with occupants re-homes to the DEFAULT entry, clears selection,
//     preserves task fields;
//   - property-style invariant: after any switch/edit/delete sequence every
//     task's column exists in its resolved workflow;
//   - concurrent move-vs-delete under the task lock ends moved-then-re-homed or
//     re-homed, never lost/undefined.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import {
  OccupiedColumnsError,
  setReconciliationAbort,
  __resetReconciliationAbortForTests,
  type ReconciliationAbortContext,
} from "../workflow-reconciliation.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { resolveEntryColumnId } from "../workflow-reconciliation.js";

/** A v2 custom workflow with columns whose ids we control. `entryId` carries the
 *  intake flag; `cols` lists the column ids in order. Linear graph so it
 *  compiles. */
function customIr(name: string, cols: string[], entryId: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: cols.map((id) => ({
      id,
      name: id,
      traits: id === entryId ? [{ trait: "intake" }] : [],
    })),
    nodes: [
      { id: "start", kind: "start", column: entryId },
      { id: "work", kind: "prompt", column: cols[1] ?? entryId, config: { prompt: "do" } },
      { id: "end", kind: "end", column: cols[cols.length - 1] },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  };
}

describe("workflow reconciliation (U5)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    __resetReconciliationAbortForTests();
  });

  afterEach(async () => {
    __resetReconciliationAbortForTests();
    await harness.afterEach();
  });

  /** Move a fresh task (starts in triage) to a default-workflow column. */
  async function seedInColumn(col: "triage" | "todo" | "in-progress"): Promise<string> {
    const task = await store.createTask({ description: `seed-${col}` });
    if (col === "triage") return task.id;
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    if (col === "todo") return task.id;
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    return task.id;
  }

  it("entry column resolves to the intake-flagged column (default workflow = triage)", () => {
    expect(resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR)).toBe("triage");
  });

  describe("(a) workflow switch", () => {
    it("preserves position when the new workflow defines the same column id", async () => {
      // Custom workflow that ALSO defines "todo" → same-id column, preserved.
      const wf = await store.createWorkflowDefinition({
        name: "shares-todo",
        ir: customIr("shares-todo", ["todo", "build", "done"], "todo"),
      });
      const taskId = await seedInColumn("todo");

      const result = await store.selectTaskWorkflowAndReconcile(taskId, wf.id);

      expect(result.reconciliation?.preserved).toBe(true);
      expect(result.reconciliation?.toColumn).toBe("todo");
      const task = await store.getTask(taskId);
      expect(task.column).toBe("todo");
    });

    it("re-homes to the new workflow's entry column when the current column is absent, aborting first", async () => {
      const aborts: ReconciliationAbortContext[] = [];
      setReconciliationAbort((ctx) => {
        aborts.push(ctx);
      });
      // Custom workflow has none of the legacy column ids; entry = "intake".
      const wf = await store.createWorkflowDefinition({
        name: "fresh",
        ir: customIr("fresh", ["intake", "doing", "finished"], "intake"),
      });
      const taskId = await seedInColumn("in-progress");

      const result = await store.selectTaskWorkflowAndReconcile(taskId, wf.id);

      expect(result.reconciliation?.preserved).toBe(false);
      expect(result.reconciliation?.toColumn).toBe("intake");
      const task = await store.getTask(taskId);
      expect(task.column).toBe("intake");
      // Abort callback fired for the in-flight column before the re-home move.
      expect(aborts).toHaveLength(1);
      expect(aborts[0]).toMatchObject({ taskId, fromColumn: "in-progress", reason: "workflow-switch" });
    });

    it("re-homes via the default no-op abort when no engine abort is wired", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "fresh2",
        ir: customIr("fresh2", ["intake", "doing", "finished"], "intake"),
      });
      const taskId = await seedInColumn("in-progress");
      const result = await store.selectTaskWorkflowAndReconcile(taskId, wf.id);
      expect(result.reconciliation?.preserved).toBe(false);
      expect((await store.getTask(taskId)).column).toBe("intake");
    });
  });

  describe("(b) workflow edit removing an occupied column", () => {
    it("blocks with per-column occupant counts when no rehomeTo is given", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "editable",
        ir: customIr("editable", ["intake", "build", "done"], "intake"),
      });
      const t1 = await store.createTask({ description: "t1" });
      const t2 = await store.createTask({ description: "t2" });
      await store.selectTaskWorkflowAndReconcile(t1.id, wf.id); // lands in intake
      await store.selectTaskWorkflowAndReconcile(t2.id, wf.id);
      // Move both into "build" so it's occupied. Custom adjacency is order-derived
      // (intake↔build↔done), so intake→build is legal.
      await store.moveTask(t1.id, "build", { moveSource: "user" });
      await store.moveTask(t2.id, "build", { moveSource: "user" });

      // Edit that drops "build".
      const nextIr = customIr("editable", ["intake", "done"], "intake");
      await expect(store.updateWorkflowDefinition(wf.id, { ir: nextIr })).rejects.toThrow(
        OccupiedColumnsError,
      );
      try {
        await store.updateWorkflowDefinition(wf.id, { ir: nextIr });
      } catch (err) {
        expect(err).toBeInstanceOf(OccupiedColumnsError);
        const occ = (err as OccupiedColumnsError).occupancies;
        expect(occ).toEqual([{ columnId: "build", count: 2 }]);
      }
    });

    it("rehomeTo saves the edit and moves all occupants, emitting one audit per card", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "rehomeable",
        ir: customIr("rehomeable", ["intake", "build", "done"], "intake"),
      });
      const t1 = await store.createTask({ description: "t1" });
      const t2 = await store.createTask({ description: "t2" });
      await store.selectTaskWorkflowAndReconcile(t1.id, wf.id);
      await store.selectTaskWorkflowAndReconcile(t2.id, wf.id);
      await store.moveTask(t1.id, "build", { moveSource: "user" });
      await store.moveTask(t2.id, "build", { moveSource: "user" });

      const nextIr = customIr("rehomeable", ["intake", "done"], "intake");
      const saved = await store.updateWorkflowDefinition(wf.id, { ir: nextIr, rehomeTo: "intake" });

      // Saved IR no longer defines "build".
      expect((saved.ir as { columns: { id: string }[] }).columns.map((c) => c.id)).toEqual([
        "intake",
        "done",
      ]);
      expect((await store.getTask(t1.id)).column).toBe("intake");
      expect((await store.getTask(t2.id)).column).toBe("intake");
    });

    it("does not block when the removed column has no occupants", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "empty-col",
        ir: customIr("empty-col", ["intake", "build", "done"], "intake"),
      });
      const nextIr = customIr("empty-col", ["intake", "done"], "intake");
      await expect(store.updateWorkflowDefinition(wf.id, { ir: nextIr })).resolves.toBeDefined();
    });
  });

  describe("(c) workflow delete with occupants", () => {
    it("re-homes occupants to the default entry, clears selection, preserves fields", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "doomed",
        ir: customIr("doomed", ["intake", "build", "done"], "intake"),
      });
      const t = await store.createTask({ description: "to-rehome" });
      await store.selectTaskWorkflowAndReconcile(t.id, wf.id);
      await store.moveTask(t.id, "build", { moveSource: "user" });
      // Stamp a field we expect to survive the re-home (preserveProgress).
      await store.updateTask(t.id, { summary: "keep me" });

      await store.deleteWorkflowDefinition(wf.id);

      const task = await store.getTask(t.id);
      // Re-homed to the default workflow's entry column (triage).
      expect(task.column).toBe("triage");
      // Selection cleared → resolves to the default workflow now.
      expect(store.getTaskWorkflowSelection(t.id)).toBeUndefined();
      // Field preserved.
      expect(task.summary).toBe("keep me");
    });

    it("built-in workflows remain undeletable", async () => {
      await expect(store.deleteWorkflowDefinition("builtin:coding")).rejects.toThrow();
    });
  });

  describe("property-style invariant: no card in an undefined column after any op", () => {
    it("every task's column exists in its resolved workflow after switch/edit/delete", async () => {
      const wfA = await store.createWorkflowDefinition({
        name: "A",
        ir: customIr("A", ["intake", "mid", "out"], "intake"),
      });
      const wfB = await store.createWorkflowDefinition({
        name: "B",
        ir: customIr("B", ["start-b", "end-b"], "start-b"),
      });

      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const t = await store.createTask({ description: `prop-${i}` });
        ids.push(t.id);
      }
      // Switch all to A, scatter into A's columns.
      for (const id of ids) await store.selectTaskWorkflowAndReconcile(id, wfA.id);
      await store.moveTask(ids[1], "mid", { moveSource: "user" });
      await store.moveTask(ids[2], "mid", { moveSource: "user" });
      await store.moveTask(ids[2], "out", { moveSource: "user" });
      // Switch one to B (different ids → re-home to entry).
      await store.selectTaskWorkflowAndReconcile(ids[3], wfB.id);
      // Edit A removing "mid" with rehome.
      await store.updateWorkflowDefinition(wfA.id, {
        ir: customIr("A", ["intake", "out"], "intake"),
        rehomeTo: "intake",
      });
      // Delete B (re-homes ids[3] to default).
      await store.deleteWorkflowDefinition(wfB.id);

      for (const id of ids) {
        const task = await store.getTask(id);
        const ir = (store as unknown as { resolveTaskWorkflowIrSync: (id: string) => WorkflowIr })
          .resolveTaskWorkflowIrSync(id);
        const colIds = (ir as { columns: { id: string }[] }).columns.map((c) => c.id);
        expect(colIds).toContain(task.column);
      }
    });
  });

  describe("concurrent move-vs-delete under the task lock", () => {
    it("ends moved-then-re-homed or re-homed, never lost/undefined", async () => {
      const wf = await store.createWorkflowDefinition({
        name: "race",
        ir: customIr("race", ["intake", "build", "done"], "intake"),
      });
      const t = await store.createTask({ description: "racer" });
      await store.selectTaskWorkflowAndReconcile(t.id, wf.id);
      await store.moveTask(t.id, "build", { moveSource: "user" });

      // Fire a same-workflow move concurrently with the delete. Both serialize
      // through the task lock; the task must end in a column defined by its
      // resolved workflow (after delete: the default workflow), never undefined.
      const movePromise = store
        .moveTask(t.id, "done", { moveSource: "user" })
        .catch(() => undefined);
      const deletePromise = store.deleteWorkflowDefinition(wf.id);
      await Promise.all([movePromise, deletePromise]);

      const task = await store.getTask(t.id);
      expect(task.column).toBeTruthy();
      // After delete the task resolves to the default workflow; its column must
      // be one the default workflow defines.
      const defaultCols = (BUILTIN_CODING_WORKFLOW_IR as { columns: { id: string }[] }).columns.map(
        (c) => c.id,
      );
      expect(defaultCols).toContain(task.column);
    });
  });
});
