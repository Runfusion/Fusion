/**
 * FNXC:PostgresOnlyDataAccess 2026-07-16-11:10:
 * Regression: refineTask and duplicateTask create rows through the shared
 * atomicCreateTaskJson helper via createTaskWithId callbacks, bypassing
 * _createTaskInternal's backend routing. Before the fix, creating a refinement
 * (or duplicate) in backend mode threw "TaskStore.db: SQLite Database is not
 * available in backend mode". atomicCreateTaskJson now routes itself to the
 * async layer, so both surfaces must persist against PostgreSQL.
 */
import { describe, it, expect } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("refineTask / duplicateTask backend mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_refine_dup" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("refineTask creates a refinement of a done task in backend mode", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Source feature",
        description: "Original completed work",
        column: "done",
      });

      const refined = await h.store.refineTask(source.id, "Please tighten the empty-state copy");

      expect(refined.id).not.toBe(source.id);
      expect(refined.sourceType).toBe("task_refine");
      expect(refined.sourceParentTaskId).toBe(source.id);
      expect(refined.column).toBe("triage");
      expect(refined.dependencies).toEqual([source.id]);
      expect(refined.description).toContain("Please tighten the empty-state copy");

      // Round-trip through the async layer.
      const fetched = await h.store.getTask(refined.id);
      expect(fetched.id).toBe(refined.id);
      expect(fetched.sourceType).toBe("task_refine");
    } finally {
      await teardown();
    }
  });

  /*
   * FNXC:WorkflowOptionalSteps 2026-07-16-00:00:
   * FN-8188 requires refinements to use the same project-default optional-group
   * seed and persisted selection as createTask, including empty and absent defaults.
   */
  it("refineTask inherits default-on workflow groups and selection like createTask", async () => {
    const h = await makeHarness();
    try {
      await h.store.setDefaultWorkflowId("builtin:coding");
      const source = await h.store.createTask({
        title: "Completed source",
        description: "Original completed work",
        column: "done",
      });
      const control = await h.store.createTask({ description: "Fresh control task" });

      const refined = await h.store.refineTask(source.id, "Please add stronger review coverage");

      expect((await h.store.getTask(control.id)).enabledWorkflowSteps).toEqual(["plan-review", "code-review"]);
      expect((await h.store.getTask(refined.id)).enabledWorkflowSteps).toEqual(["plan-review", "code-review"]);
      expect(await h.store.getTaskWorkflowSelectionAsync(refined.id)).toEqual({
        workflowId: "builtin:coding",
        stepIds: ["plan-review", "code-review"],
      });
    } finally {
      await teardown();
    }
  });

  it("refineTask persists empty default workflow groups and tolerates no default workflow", async () => {
    const h = await makeHarness();
    try {
      await h.store.setDefaultWorkflowId("builtin:marketing");
      const marketingSource = await h.store.createTask({
        title: "Marketing source",
        description: "Completed marketing work",
        column: "done",
      });
      const marketingRefinement = await h.store.refineTask(marketingSource.id, "Update the campaign copy");

      expect((await h.store.getTask(marketingRefinement.id)).enabledWorkflowSteps).toEqual([]);
      expect(await h.store.getTaskWorkflowSelectionAsync(marketingRefinement.id)).toEqual({
        workflowId: "builtin:marketing",
        stepIds: [],
      });

      await h.store.setDefaultWorkflowId(null);
      const noDefaultSource = await h.store.createTask({
        title: "No-default source",
        description: "Completed work without a configured workflow",
        column: "done",
      });
      const noDefaultControl = await h.store.createTask({ description: "Fresh task without a configured workflow" });
      const noDefaultRefinement = await h.store.refineTask(noDefaultSource.id, "Tighten the final copy");

      // FNXC:WorkflowOptionalSteps 2026-07-16-00:00: PostgreSQL normalizes omitted
      // JSONB enabled_workflow_steps to [] for both creation paths, while the fresh
      // refinement object retains the unset field when no default is configured.
      expect(noDefaultRefinement.enabledWorkflowSteps).toBeUndefined();
      expect((await h.store.getTask(noDefaultRefinement.id)).enabledWorkflowSteps).toEqual(
        (await h.store.getTask(noDefaultControl.id)).enabledWorkflowSteps,
      );
      expect(await h.store.getTaskWorkflowSelectionAsync(noDefaultRefinement.id)).toBeUndefined();
    } finally {
      await teardown();
    }
  });

  it("refineTask works for an in-review source task in backend mode", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "In-review feature",
        description: "Work awaiting review",
        column: "in-review",
      });

      const refined = await h.store.refineTask(source.id, "Follow-up polish request");
      const fetched = await h.store.getTask(refined.id);
      expect(fetched.sourceParentTaskId).toBe(source.id);
    } finally {
      await teardown();
    }
  });

  it("refineTask rejects a source task that is not done or in-review", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Live task",
        description: "Still in progress",
        column: "in-progress",
      });
      await expect(h.store.refineTask(source.id, "too early")).rejects.toThrow(/must be in 'done' or 'in-review'/);
    } finally {
      await teardown();
    }
  });

  it("duplicateTask duplicates a task in backend mode", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Duplicable task",
        description: "Task to duplicate",
      });

      const dup = await h.store.duplicateTask(source.id);

      expect(dup.id).not.toBe(source.id);
      expect(dup.sourceType).toBe("task_duplicate");
      expect(dup.sourceParentTaskId).toBe(source.id);
      expect(dup.description).toContain(`(Duplicated from ${source.id})`);

      const fetched = await h.store.getTask(dup.id);
      expect(fetched.id).toBe(dup.id);
      expect(fetched.sourceType).toBe("task_duplicate");
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
