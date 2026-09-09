/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:45 (Phase C convergence — E2E evidence):

THE STORE PATH, not the hook in isolation. `default-workflow-hooks.ts`'s reopen effects
are unit-covered in `reopen-semantics-by-role.test.ts`, but that proves nothing about
whether `moves.ts` actually HANDS the hooks the moving task's resolved lifecycle columns.
If it passes `undefined`, every one of those unit cases still passes (the no-basis
fallback) while the real board silently keeps the old behavior. So this drives a real
PostgreSQL store, a real `moveTask`, and a workflow whose columns carry the standard
traits under NON-default names.

WHAT IT WOULD HAVE CAUGHT: a card bounced out of the renamed review lane kept its
`passed` review result, because the clear was gated on the literal `in-review`/`todo`.
`getTaskMergeBlocker` reads that array, so the card could re-enter review and merge with
its re-review never run.

The flag-ON path is the one under test — `isWorkflowColumnsCompatibilityFlagEnabled`
reads the RAW experimental flag, so without enabling it this suite would exercise the
legacy inline branch (which is deliberately left name-based as the parity reference) and
prove nothing.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { WorkflowIr } from "../../workflows/workflow-ir-types.js";

/** Standard lifecycle traits under non-default column names, with a reopen edge. */
function renamedBoardIr(): WorkflowIr {
  return {
    version: "v2",
    name: "test:renamed-board",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      {
        id: "queued",
        name: "Queued",
        traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
      },
      {
        id: "building",
        name: "Building",
        traits: [
          { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
          { trait: "abort-on-exit" },
          { trait: "timing" },
        ],
      },
      {
        id: "checking",
        name: "Checking",
        traits: [{ trait: "merge" }, { trait: "merge-blocker" }],
      },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "backlog" },
      /*
      THIRD FIXTURE FINDING: a rework edge is legal only INTO a node marked
      `config.reworkRegion: true` (or inside a foreach template). So a workflow that wants
      a review bounce must declare its bounce TARGETS as rework-region heads — the shape is
      opt-in per node, not a property of the edge alone.
      */
      { id: "plan", kind: "prompt", column: "queued", config: { name: "Plan", prompt: "Specify.", reworkRegion: true } },
      { id: "build", kind: "prompt", column: "building", config: { name: "Build", prompt: "Do it.", reworkRegion: true } },
      { id: "check", kind: "prompt", column: "checking", config: { name: "Check", prompt: "Review it." } },
      /*
      FIXTURE NOTE, and it is the finding of a real rule rather than boilerplate: a column
      declaring `merge-blocker` must have a reachable merge-class node or `parseWorkflowIr`
      rejects the whole workflow ("the merge-blocker gate can never clear without one"). My
      first fixture omitted it and all three cases failed at workflow CREATION, not at the
      move — a failure that looks like the code under test and is not.
      */
      { id: "merge", kind: "merge-attempt", column: "checking", config: { capability: "task-merge" } },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "build", condition: "success" },
      { from: "build", to: "check", condition: "success" },
      { from: "check", to: "merge", condition: "success" },
      { from: "merge", to: "end", condition: "success" },
      /*
      The reopen edges under test: a rejected check goes back to planning, and a renamed
      board is entitled to the same bounce the default lineage has.

      SECOND FIXTURE FINDING: these MUST be `kind: "rework"`. `validateNoIllegalCycles`
      exempts only rework edges from the acyclicity rule, so a plain back-edge rejects the
      whole workflow. Worth knowing before writing any reopen fixture — a bounce edge in
      this IR is a rework edge by definition, not an ordinary conditional one.
      */
      { from: "check", to: "plan", kind: "rework", condition: "failure" },
      { from: "check", to: "build", kind: "rework", condition: "retry" },
    ],
  } as WorkflowIr;
}

pgDescribe("a renamed board gets the same reopen effects as the default lineage", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_renamed_reopen" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  beforeEach(async () => {
    await harness.store().updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  /** Force a column directly so one move edge can be exercised in isolation. */
  async function forceColumn(taskId: string, column: string): Promise<void> {
    const store = harness.store();
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("expected async layer in backend mode");
    const { project } = await import("../../postgres/schema/index.js");
    await layer.db.update(project.tasks).set({ column }).where(eq(project.tasks.id, taskId));
  }

  async function seedCardInCheck(): Promise<{ store: ReturnType<typeof harness.store>; taskId: string }> {
    const store = harness.store();
    const def = await store.createWorkflowDefinition({ name: "Renamed Board", ir: renamedBoardIr() });
    const task = await store.createTask({ description: "renamed board card", workflowId: def.id });
    await store.updateTask(task.id, {
      status: "failed",
      error: "review rejected",
      branch: "fusion/renamed",
      // FNXC:BranchWriteProvenance 2026-08-23-15:55: a branch write requires an explicit origin
      // (normalizeCreateBranchProvenance / updateTaskUnlockedImpl). This fixture stands in for the
      // engine's own execution-time branch assignment, so it declares "engine".
      branchWriteOrigin: "engine",
      summary: "a summary from the failed attempt",
      workflowStepResults: [
        { workflowStepId: "code-review", status: "passed", completedAt: "2026-07-30T00:00:00.000Z" },
      ] as never,
    });
    await forceColumn(task.id, "checking");
    return { store, taskId: task.id };
  }

  it("clears the stale review result when the renamed review lane bounces to renamed WIP", async () => {
    const { store, taskId } = await seedCardInCheck();

    const moved = await store.moveTask(taskId, "building", {
      moveSource: "engine",
      lifecycleReason: "code-review-revise-remediation",
    });

    expect(moved.column).toBe("building");
    // The safety assertion: a surviving `passed` result satisfies getTaskMergeBlocker.
    expect(moved.workflowStepResults ?? []).toHaveLength(0);
    expect(moved.branch).toBe("fusion/renamed");
  });

  it("parks a user-source bounce into the renamed hold lane", async () => {
    const { store, taskId } = await seedCardInCheck();

    const moved = await store.moveTask(taskId, "queued", { moveSource: "user" });

    expect(moved.userPaused).toBe(true);
  });

  it("does NOT strip results on a forward move within the renamed board", async () => {
    // The paired negative: "clears on every move" must not pass for "resolves the roles".
    const store = harness.store();
    const def = await store.createWorkflowDefinition({ name: "Renamed Fwd", ir: renamedBoardIr() });
    const task = await store.createTask({ description: "forward card", workflowId: def.id });
    await store.updateTask(task.id, {
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] as never,
    });
    await forceColumn(task.id, "queued");

    const moved = await store.moveTask(task.id, "building", { moveSource: "engine" });

    expect(moved.column).toBe("building");
    expect(moved.workflowStepResults ?? []).toHaveLength(1);
  });
});
