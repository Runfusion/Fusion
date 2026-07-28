/*
FNXC:WorkflowLifecycleColumns 2026-07-28-04:20 (PR #2470 review, P1):

End-to-end proof for the dashboard half of the stale-paused-todo fix.

`getStalePausedTodoSignal` gained a `holdColumn` parameter in B1, but BOTH
hydration sites in reads.ts omitted it — so the guard compared against the
literal "todo" and the badge was silent for a paused card resting in a renamed
hold column. Silent is the worst failure shape here: an operator cannot tell a
stalled board from a healthy one.

This is a real-store test rather than a mock because the defect lived in
hydration, not in the pure signal — the pure `stale-paused-todo` unit tests were
already green with the parameter in place.

Scope note, found while writing this file: `getTaskImpl` does NOT hydrate
`stalePausedTodo` at all — the two hydration sites live in `listTasksImpl` and
`listTasksModifiedSinceImpl`. So the task DETAIL view has never carried this
badge, with or without a renamed workflow. That is a pre-existing gap unrelated
to the column-vocabulary work, so it is reported rather than fixed here; do not
read the absence of a getTask case below as an oversight.

Fixture note worth keeping: `createWorkflowDefinition` ALLOCATES ITS OWN id
(`WF-001`) and ignores the `id` field in the input. Binding a task to the id we
passed in resolves to the default builtin IR instead, and every assertion here
then passes or fails for reasons having nothing to do with the code under test.
Always bind to the returned id.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

const THRESHOLD_MS = 24 * 60 * 60_000;

pgDescribe("TaskStore stalePausedTodo hydration under a renamed hold column (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stale_paused_renamed",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * A workflow whose hold column is `drafting` — it has NO `todo` column.
   * Returns the id the STORE assigned: `createWorkflowDefinition` allocates its
   * own (`WF-001`) and ignores the `id` field, so binding a task to the id we
   * passed in silently resolves to the default builtin IR instead.
   */
  async function seedRenamedWorkflow(): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      id: "custom:renamed-hold",
      name: "Renamed Hold",
      kind: "workflow",
      ir: {
        version: "v2",
        id: "custom:renamed-hold",
        // A valid IR needs exactly one start and one end node.
        nodes: [
          { id: "start", kind: "start", column: "drafting" },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "end" }],
        columns: [
          { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        ],
      },
    } as never);
    return (created as { id: string }).id;
  }

  /** Seed a paused card, aged past the threshold, bound to `workflowId`. */
  async function seedPausedTask(id: string, column: string, workflowId?: string) {
    const store = h.store();
    const movedAt = new Date(Date.now() - (THRESHOLD_MS + 60_000)).toISOString();
    await store.createTaskWithReservedId(
      { description: id, column } as never,
      { taskId: id, createdAt: movedAt, updatedAt: movedAt, applyDefaultWorkflowSteps: false } as never,
    );
    if (workflowId) await store.writeTaskWorkflowSelection(id, workflowId, []);
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({ paused: 1, columnMovedAt: movedAt, updatedAt: movedAt })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
  }

  it("hydrates the badge via listTasks for a paused card in a RENAMED hold column", async () => {
    const wf = await seedRenamedWorkflow();
    await seedPausedTask("FN-RH-1", "drafting", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RH-1");

    expect(task?.stalePausedTodo?.code).toBe("stale-paused-todo");
  });

  it("does NOT badge a paused card resting in a non-hold column of that workflow", async () => {
    /* The negative half: threading the hold column must not turn the badge into
       "any paused card anywhere", which would be a noisier bug than the silence
       it replaces. */
    const wf = await seedRenamedWorkflow();
    await seedPausedTask("FN-RH-3", "building", wf);

    const task = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RH-3");

    expect(task?.stalePausedTodo).toBeUndefined();
  });

  it("still badges a builtin todo card with no custom workflow (regression floor)", async () => {
    await seedPausedTask("FN-RH-4", "todo");

    const listed = (await h.store().listTasks({ slim: true })).find((t) => t.id === "FN-RH-4");

    expect(listed?.stalePausedTodo?.code).toBe("stale-paused-todo");
  });
});
