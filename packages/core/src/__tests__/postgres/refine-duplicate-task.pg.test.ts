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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRefinementSeedPrompt } from "../../mesh/mesh-task-replication.js";
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
      // FNXC:MergedPlanningColumn 2026-07-31-22:40: refine resolves the workflow intake lane; the
      // default coding workflow's intake is the merged `todo` Planning column ("triage" is deleted).
      expect(refined.column).toBe("todo");
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
  it("refineTask keeps automatic default Coding in its planning lane", async () => {
    const h = await makeHarness();
    try {
      await h.store.setDefaultWorkflowId("builtin:coding");
      const source = await h.store.createTask({
        title: "Automatic workflow source",
        description: "Completed automatic workflow work",
        column: "done",
      });

      const refined = await h.store.refineTask(source.id, "Keep automatic planning actionable");

      expect(refined.column).toBe("todo");
      expect(refined.column).not.toBe("triage");
      expect((await h.store.getTask(refined.id)).column).toBe("todo");
    } finally {
      await teardown();
    }
  });

  /*
  FNXC:RefinementPlanningRouting 2026-08-23-16:20:
  A refinement's workflow comes from the project's refinement ORIGIN selection (pinned
  `refinementTaskWorkflowId`, else the mirrored Board lane, else the project default) — never from
  the source card's workflow (FN-8188 / FNXC:OriginWorkflowSelection in `refineTaskImpl`). These
  cases used to set only the SOURCE's `workflowId`, so every child was actually a `builtin:coding`
  card and the routing they name was never exercised. Pin the origin so the child really belongs to
  the workflow under test. Same correction as `store-comments.pg.test.ts`.
  */
  it("routes Coding (Ideas) refinements to Planning and preserves selection and seed", async () => {
    const h = await makeHarness();
    try {
      await h.store.updateSettings({ refinementTaskWorkflowId: "builtin:coding-ideas-v2" } as never);
      const source = await h.store.createTask({
        title: "Ideas source",
        description: "Completed work selected in Coding (Ideas)",
        workflowId: "builtin:coding-ideas-v2",
        column: "done",
      } as never);

      const refined = await h.store.refineTask(source.id, "Make the empty state actionable");
      const fetched = await h.store.getTask(refined.id);
      const prompt = await readFile(join(h.store.taskDir(refined.id), "PROMPT.md"), "utf8");

      expect(refined.column).toBe("todo");
      expect(refined.column).not.toBe("ideas");
      expect(fetched.column).toBe("todo");
      expect(fetched.sourceParentTaskId).toBe(source.id);
      expect(fetched.dependencies).toEqual([source.id]);
      expect(await h.store.getTaskWorkflowSelectionAsync(refined.id)).toMatchObject({
        workflowId: "builtin:coding-ideas-v2",
      });
      expect(prompt).toBe(buildRefinementSeedPrompt(refined.title ?? refined.id, refined.description));
    } finally {
      await teardown();
    }
  });

  it("routes multiple refinements in a renamed manual workflow to its hold lane", async () => {
    const h = await makeHarness();
    try {
      const definition = await h.store.createWorkflowDefinition({
        name: "Renamed manual refinement workflow",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Renamed manual refinement workflow",
          columns: [
            { id: "capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: false } }] },
            { id: "ready", name: "Ready to plan", traits: [{ trait: "hold", config: { release: "capacity" } }] },
            /*
            FNXC:WorkflowValidation 2026-08-23-16:20: `validateV2` rejects a `release: "capacity"`
            hold with no downstream wip column — the scheduler would have nowhere to release it to.
            The fixture's hold lane is the point of this case, so it needs a real wip lane after it.
            */
            { id: "working", name: "Working", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "capture" },
            { id: "end", kind: "end", column: "shipped" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      await h.store.updateSettings({ refinementTaskWorkflowId: definition.id } as never);
      const source = await h.store.createTask({
        title: "Renamed workflow source",
        description: "Completed work in the renamed workflow",
        workflowId: definition.id,
        column: "shipped",
      } as never);

      const first = await h.store.refineTask(source.id, "Add the first follow-up");
      const second = await h.store.refineTask(source.id, "Add the second follow-up");

      for (const child of [first, second]) {
        const fetched = await h.store.getTask(child.id);
        expect(fetched.column).toBe("ready");
        expect(fetched.column).not.toBe("capture");
        expect(fetched.sourceParentTaskId).toBe(source.id);
        expect(fetched.dependencies).toEqual([source.id]);
        expect(await h.store.getTaskWorkflowSelectionAsync(fetched.id)).toMatchObject({ workflowId: definition.id });
      }
    } finally {
      await teardown();
    }
  });

  it("keeps the legacy fallback when a manual workflow has no Planning hold", async () => {
    const h = await makeHarness();
    try {
      const definition = await h.store.createWorkflowDefinition({
        name: "Manual workflow without hold",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Manual workflow without hold",
          columns: [
            { id: "capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: false } }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "capture" },
            { id: "end", kind: "end", column: "shipped" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      await h.store.updateSettings({ refinementTaskWorkflowId: definition.id } as never);
      const source = await h.store.createTask({
        description: "Completed source without a Planning hold",
        workflowId: definition.id,
        column: "shipped",
      } as never);

      const refined = await h.store.refineTask(source.id, "Keep the fallback behavior");

      expect(refined.column).toBe("triage");
    } finally {
      await teardown();
    }
  });

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

  /*
  FNXC:DisabledBuiltinWorkflows 2026-08-23-16:25:
  "No configured default workflow" is no longer a reachable state. `getDefaultWorkflowId` resolves
  through `resolveEffectiveDefaultWorkflowId`, which ALWAYS answers with a workflow — the configured
  id when it is enabled, otherwise the first enabled built-in (FNXC:DisabledBuiltinWorkflows
  2026-08-19-00:18 in `builtin-workflows.ts`). Clearing the setting therefore falls back to
  `builtin:coding` rather than producing an unseeded task, so this case now asserts the surviving
  invariant: refine and create agree on whatever the EFFECTIVE default seeds.
  */
  it("refineTask persists empty default workflow groups and falls back to the effective default", async () => {
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
      const effectiveDefault = await h.store.getDefaultWorkflowId();
      expect(effectiveDefault).toBe("builtin:coding");
      const noDefaultSource = await h.store.createTask({
        title: "Cleared-default source",
        description: "Completed work after the configured workflow was cleared",
        column: "done",
      });
      const noDefaultControl = await h.store.createTask({ description: "Fresh task after the configured workflow was cleared" });
      const noDefaultRefinement = await h.store.refineTask(noDefaultSource.id, "Tighten the final copy");

      // The invariant that survives the effective-default resolver: a refinement is seeded exactly
      // like a freshly created task, both in the returned object and in the persisted row.
      expect(noDefaultRefinement.enabledWorkflowSteps).toEqual(noDefaultControl.enabledWorkflowSteps);
      expect((await h.store.getTask(noDefaultRefinement.id)).enabledWorkflowSteps).toEqual(
        (await h.store.getTask(noDefaultControl.id)).enabledWorkflowSteps,
      );
      expect(await h.store.getTaskWorkflowSelectionAsync(noDefaultRefinement.id)).toEqual(
        await h.store.getTaskWorkflowSelectionAsync(noDefaultControl.id),
      );
      expect(await h.store.getTaskWorkflowSelectionAsync(noDefaultRefinement.id)).toMatchObject({
        workflowId: "builtin:coding",
      });
    } finally {
      await teardown();
    }
  });

  /*
  FNXC:RefinementTitle 2026-07-26-20:10:
  The refinement title comes from the operator's FEEDBACK, not "Refinement: <source title>".
  The invariant asserted here is the one that broke the board: SIBLING refinements of the SAME
  parent must be distinguishable by title. A single-refinement assertion would have passed
  against the old "Refinement: <parent>" shape too, since the bug only appears at N > 1.
  */
  it("titles a refinement from the operator's feedback, not the parent's title", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Source feature",
        description: "Original completed work",
        column: "done",
      });

      const refined = await h.store.refineTask(source.id, "Tighten the empty-state copy");

      expect(refined.title).toBe("Tighten the empty-state copy");
      expect(refined.title).not.toContain("Refinement:");
      expect(refined.title).not.toContain("Source feature");
      // Provenance survives on the fields that carry it, not on the title.
      expect(refined.sourceType).toBe("task_refine");
      expect(refined.sourceParentTaskId).toBe(source.id);
      expect(refined.description).toContain(`Refines: ${source.id}`);
    } finally {
      await teardown();
    }
  });

  it("gives sibling refinements of one parent distinct titles", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Source feature",
        description: "Original completed work",
        column: "done",
      });

      const first = await h.store.refineTask(source.id, "Add a loading skeleton");
      const second = await h.store.refineTask(source.id, "Fix the mobile overflow");
      const third = await h.store.refineTask(source.id, "Rename the confirm button");

      const titles = [first.title, second.title, third.title];
      expect(titles).toEqual([
        "Add a loading skeleton",
        "Fix the mobile overflow",
        "Rename the confirm button",
      ]);
      expect(new Set(titles).size).toBe(3);
    } finally {
      await teardown();
    }
  });

  // Multi-line and markdown feedback must title like any other card: first meaningful line,
  // markdown stripped — not the raw blob and not a bespoke refinement truncation rule.
  it("derives the title from the first meaningful line of multi-line feedback", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Source feature",
        description: "Original completed work",
        column: "done",
      });

      const refined = await h.store.refineTask(
        source.id,
        "- **Fix** the badge alignment\n\nIt overlaps the avatar on narrow screens.",
      );

      expect(refined.title).toBe("Fix the badge alignment");
      // The full feedback still lives in the description; only the TITLE is condensed.
      expect(refined.description).toContain("It overlaps the avatar on narrow screens.");
    } finally {
      await teardown();
    }
  });

  /*
  Free-typed feedback routinely names the task being refined, so the title-id-drift normalizer
  is now on this path in a way the old parent-derived title rarely exercised.
  Scope note: `TASK_ID_TOKEN_RE` in task-title-id-drift.ts matches the `FN-` prefix ONLY, so a
  project using a different `taskPrefix` keeps the typed id in the title. That is a pre-existing
  limitation of the shared normalizer, not of this path — asserted here with a literal FN- token
  so the test states what the code actually does rather than what the prefix setting suggests.
  */
  it("strips an FN- task-id token the operator typed into the feedback", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({
        title: "Source feature",
        description: "Original completed work",
        column: "done",
      });

      const refined = await h.store.refineTask(source.id, "FN-4847: still drops the badge");

      expect(refined.title).toBe("still drops the badge");
      expect(refined.title).not.toContain("FN-4847");
      // The untouched feedback is still recoverable from the description.
      expect(refined.description).toContain("FN-4847: still drops the badge");
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

  it("duplicateTask inherits the source workflow and its intake column", async () => {
    const h = await makeHarness();
    try {
      const workflow = await h.store.createWorkflowDefinition({
        name: "Duplicate source workflow",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Duplicate source workflow",
          columns: [
            { id: "source-capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: true } }] },
            { id: "source-done", name: "Done", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "source-capture" },
            { id: "end", kind: "end", column: "source-done" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      const source = await h.store.createTask({
        description: "Task pinned away from the project default",
        workflowId: workflow.id,
      });

      const duplicate = await h.store.duplicateTask(source.id);

      expect(duplicate.column).toBe("source-capture");
      expect(await h.store.getTaskWorkflowSelectionAsync(duplicate.id)).toEqual({
        workflowId: workflow.id,
        stepIds: [],
      });
    } finally {
      await teardown();
    }
  });

  it("duplicateTask honors an explicit workflow including intake and default-on groups", async () => {
    const h = await makeHarness();
    try {
      const target = await h.store.createWorkflowDefinition({
        name: "Explicit duplicate target",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Explicit duplicate target",
          columns: [
            { id: "target-capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: true } }] },
            { id: "target-done", name: "Done", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "target-capture" },
            {
              id: "target-review",
              kind: "optional-group",
              config: {
                name: "Target review",
                defaultOn: true,
                template: { nodes: [{ id: "review", kind: "prompt", config: { prompt: "Review" } }], edges: [] },
              },
            },
            { id: "end", kind: "end", column: "target-done" },
          ],
          edges: [
            { from: "start", to: "target-review" },
            { from: "target-review", to: "end" },
          ],
        },
      } as never);
      const source = await h.store.createTask({ description: "Source on the default workflow" });

      const duplicate = await h.store.duplicateTask(source.id, { workflowId: target.id });

      expect(duplicate.column).toBe("target-capture");
      expect(duplicate.enabledWorkflowSteps).toEqual(["target-review"]);
      expect(await h.store.getTaskWorkflowSelectionAsync(duplicate.id)).toEqual({
        workflowId: target.id,
        stepIds: ["target-review"],
      });
    } finally {
      await teardown();
    }
  });

  it("duplicateTask rejects an unknown explicit workflow before creating a row", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Do not duplicate onto a retired workflow" });
      const beforeIds = (await h.store.listTasks({ includeArchived: false })).map((task) => task.id);

      await expect(h.store.duplicateTask(source.id, { workflowId: "WF-UNKNOWN" })).rejects.toMatchObject({
        name: "DuplicateWorkflowSelectionError",
        requestedWorkflowId: "WF-UNKNOWN",
      });

      expect((await h.store.listTasks({ includeArchived: false })).map((task) => task.id)).toEqual(beforeIds);
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
