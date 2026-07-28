import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";
import { withTaskWorkflowSerialization } from "../task-store/async-workflow-workitems.js";

const pgTest = pgDescribe;

function continuation(taskId: string, suffix: string, kind: "task" | "workflow-step" = "task") {
  return {
    runId: `${taskId}:continuation:${suffix}`,
    taskId,
    nodeId: "plan-review",
    kind,
    state: "runnable" as const,
    stableWorkflowRunId: `${taskId}:workflow`,
    continuationSequence: 0,
    waitReason: "planning" as const,
    sourceColumn: "todo",
    targetColumn: "todo",
    irHash: "ir-test",
  };
}

/*
FNXC:WorkflowSerialization 2026-07-26-16:55:
FN-8592's repair is insert-only when a task has neither an active continuation
of any kind nor a passed Plan Review. These integration cases exercise the
public store operation, rather than raw rows, so its transaction protocol stays
observable as the async store implementation evolves.
*/
pgTest("FN-8592 conditional stranded Plan Review seed", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_conditional_seed" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("seeds an idle task and lets exactly one concurrent repair win", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "idle continuation owner", column: "todo" });
    const [first, second] = await Promise.all([
      store.seedStrandedPlanReviewContinuation(continuation(task.id, "first")),
      store.seedStrandedPlanReviewContinuation(continuation(task.id, "second")),
    ]);

    expect([first.seeded, second.seeded].filter(Boolean)).toHaveLength(1);
    expect([first.reason, second.reason]).toContain("active-continuation");
    expect((await store.listWorkflowWorkItemsForTask(task.id)).filter((item) => item.state === "runnable")).toHaveLength(1);
  });

  it("treats task and non-task active continuations as blocking", async () => {
    const store = h.store();
    for (const kind of ["task", "workflow-step"] as const) {
      const task = await store.createTask({ description: `${kind} continuation owner`, column: "todo" });
      await store.upsertWorkflowWorkItem(continuation(task.id, "active", kind));

      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"))).resolves.toEqual({
        seeded: false,
        reason: "active-continuation",
      });
    }
  });

  it("does not seed after the real generic Plan Review pass writer commits first", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "review owner", column: "todo" });
    // This is the production persistence path that publishes plan-review:passed.
    await store.updateTask(task.id, {
      workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", phase: "pre-release", source: "optional-group" } as any],
    });

    await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"))).resolves.toEqual({
      seeded: false,
      reason: "plan-review-passed",
    });
  });

  it("observes a real continuation writer that commits before repair", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "continuation race owner", column: "todo" });
    // Explicit ordering barrier: await the protected production writer's commit.
    await store.upsertWorkflowWorkItem(continuation(task.id, "competing"));

    await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"))).resolves.toEqual({
      seeded: false,
      reason: "active-continuation",
    });
    expect(await store.listWorkflowWorkItemsForTask(task.id)).toHaveLength(1);
  });

  async function installSeedInsertBarrier(taskId: string) {
    const layer = h.layer();
    const gateProjectId = `${layer.projectId}:fn8592-seed-gate`;
    await layer.db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION project.fn8592_pause_seed_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.task_id = '${taskId}' THEN
          PERFORM pg_advisory_xact_lock(hashtext('${gateProjectId}'), hashtext(NEW.task_id));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fn8592_pause_seed_insert BEFORE INSERT ON project.workflow_work_items
      FOR EACH ROW EXECUTE FUNCTION project.fn8592_pause_seed_insert();
    `));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    const holder = layer.transactionImmediate((tx) => withTaskWorkflowSerialization(tx, gateProjectId, taskId, async () => {
      entered();
      await held;
    }));
    await enteredGate;
    return {
      // The trigger waits on this advisory lock after the repair has completed
      // its in-transaction predicate reads. pg_locks is an explicit entered
      // barrier, unlike a timing guess that can let the competing writer win.
      waitForRepairToReachTrigger: async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await layer.db.execute(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
            ) AS waiting
          `);
          if ((result as unknown as Array<{ waiting: boolean }>)[0]?.waiting) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("conditional repair did not reach the trigger barrier");
      },
      release: async () => {
        release();
        await holder;
        await layer.db.execute(sql.raw("DROP TRIGGER IF EXISTS fn8592_pause_seed_insert ON project.workflow_work_items; DROP FUNCTION IF EXISTS project.fn8592_pause_seed_insert();"));
      },
    };
  }

  it("runs the real repair first and blocks a real replacement writer until its insert commits", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "repair-first continuation owner", column: "todo" });
    const barrier = await installSeedInsertBarrier(task.id);
    const repair = store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"));
    // Await the post-read trigger barrier before the real competing writer
    // starts, deterministically pinning repair-first lock ordering.
    await barrier.waitForRepairToReachTrigger();
    let finished = false;
    const competing = store.replaceActiveTaskWorkflowContinuation(continuation(task.id, "competing"))
      .finally(() => { finished = true; });
    expect(finished).toBe(false);
    await barrier.release();
    await expect(repair).resolves.toMatchObject({ seeded: true });
    await competing;
    const rows = await store.listWorkflowWorkItemsForTask(task.id);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: continuation(task.id, "repair").runId, state: "succeeded" }),
      expect.objectContaining({ runId: continuation(task.id, "competing").runId, state: "runnable" }),
    ]));
  });

  it("runs the real repair first and blocks the real Plan Review pass writer until commit", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "repair-first review owner", column: "todo" });
    const barrier = await installSeedInsertBarrier(task.id);
    const repair = store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"));
    await barrier.waitForRepairToReachTrigger();
    let finished = false;
    const competing = store.updateTask(task.id, {
      workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", phase: "pre-release", source: "optional-group" } as any],
    }).finally(() => { finished = true; });
    expect(finished).toBe(false);
    await barrier.release();
    await expect(repair).resolves.toMatchObject({ seeded: true });
    await competing;
    expect((await store.getTask(task.id)).workflowStepResults?.[0]?.status).toBe("passed");
  });

  it("allows terminal continuations and non-passed Plan Review results", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "terminal continuation owner", column: "todo" });
    for (const [suffix, state] of [["completed", "succeeded"], ["failed", "failed"]] as const) {
      await store.upsertWorkflowWorkItem({ ...continuation(task.id, suffix), state });
    }
    await store.updateTask(task.id, {
      workflowStepResults: [{ workflowStepId: "plan-review", status: "failed", phase: "pre-release", source: "optional-group" } as any],
    });

    await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "repair"))).resolves.toMatchObject({ seeded: true });
  });
});
