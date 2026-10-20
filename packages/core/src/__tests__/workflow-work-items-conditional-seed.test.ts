import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";
import { withTaskWorkflowSerialization } from "../task-store/async/async-workflow-workitems.js";

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

  /*
  FNXC:PlanningHandoffAtomicity 2026-08-13-03:49:
  THE INVARIANT: the normal planning handoff installs the successor continuation no
  matter which side of the race commits first — the runtime's specification-complete
  reaction or triage's finally-block terminal transition of the plan work item.
  Before `retirePredecessorId`, the reaction side lost that race constantly (the
  seeder saw its own still-running predecessor as an active continuation and bailed
  silently), stranding cards for FN-8592 self-healing to repair ~10 minutes later.
  */
  describe("planning handoff retires its own predecessor atomically", () => {
    function planPredecessor(taskId: string) {
      return {
        runId: `${taskId}:continuation:plan`,
        taskId,
        nodeId: "plan",
        kind: "task" as const,
        state: "running" as const,
        stableWorkflowRunId: `${taskId}:workflow`,
        continuationSequence: 0,
        waitReason: "planning" as const,
        sourceColumn: "todo",
        targetColumn: "todo",
        irHash: "ir-test",
      };
    }

    it("retires a still-running predecessor and installs the successor in one call (reaction wins the race)", async () => {
      const store = h.store();
      const task = await store.createTask({ description: "handoff race owner", column: "todo" });
      const pred = await store.upsertWorkflowWorkItem(planPredecessor(task.id));

      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "handoff"), {
        retirePredecessorId: pred.id,
      })).resolves.toMatchObject({ seeded: true });

      const rows = await store.listWorkflowWorkItemsForTask(task.id);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: pred.id, state: "succeeded" }),
        expect.objectContaining({ runId: continuation(task.id, "handoff").runId, state: "runnable" }),
      ]));
    });

    it("still seeds when the predecessor is already terminal (finally block won the race)", async () => {
      const store = h.store();
      const task = await store.createTask({ description: "handoff terminal owner", column: "todo" });
      const pred = await store.upsertWorkflowWorkItem(planPredecessor(task.id));
      await store.transitionWorkflowWorkItem(pred.id, "succeeded", { leaseOwner: null, leaseExpiresAt: null });

      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "handoff"), {
        retirePredecessorId: pred.id,
      })).resolves.toMatchObject({ seeded: true });
    });

    it("still seeds when the named predecessor row no longer exists", async () => {
      const store = h.store();
      const task = await store.createTask({ description: "handoff missing owner", column: "todo" });

      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "handoff"), {
        retirePredecessorId: "00000000-0000-0000-0000-000000000000",
      })).resolves.toMatchObject({ seeded: true });
    });

    it("retires ONLY the named predecessor: any other active row still blocks the seed", async () => {
      const store = h.store();
      const task = await store.createTask({ description: "handoff blocked owner", column: "todo" });
      const pred = await store.upsertWorkflowWorkItem(planPredecessor(task.id));
      const other = await store.upsertWorkflowWorkItem(continuation(task.id, "other", "workflow-step"));

      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "handoff"), {
        retirePredecessorId: pred.id,
      })).resolves.toEqual({ seeded: false, reason: "active-continuation" });

      const rows = await store.listWorkflowWorkItemsForTask(task.id);
      expect(rows.find((row) => row.id === other.id)?.state).toBe("runnable");
      expect(rows.some((row) => row.runId === continuation(task.id, "handoff").runId)).toBe(false);
      // FNXC:PlanningHandoffAtomicity 2026-08-13-04:20 (review finding):
      // A bailed seed must mutate NOTHING — the named predecessor stays running,
      // it is not laundered to succeeded on the way to a refusal.
      expect(rows.find((row) => row.id === pred.id)?.state).toBe("running");
    });

    it("never retires a predecessor belonging to a different task", async () => {
      const store = h.store();
      const taskA = await store.createTask({ description: "handoff owner a", column: "todo" });
      const taskB = await store.createTask({ description: "handoff owner b", column: "todo" });
      const foreign = await store.upsertWorkflowWorkItem(planPredecessor(taskB.id));

      await expect(store.seedStrandedPlanReviewContinuation(continuation(taskA.id, "handoff"), {
        retirePredecessorId: foreign.id,
      })).resolves.toMatchObject({ seeded: true });

      const foreignRows = await store.listWorkflowWorkItemsForTask(taskB.id);
      expect(foreignRows.find((row) => row.id === foreign.id)?.state).toBe("running");
    });
  });


  describe("identity refusal recovery transaction", () => {
    /** FNXC:CurrentPlanReviewIdentity 2026-10-20-10:30: Persist a genuine historical approval before exercising the real conditional writer. */
    async function refusedTask(refused = true) {
      const store = h.store();
      const task = await store.createTask({ description: "review identity recovery", column: "todo" });
      await store.updateTask(task.id, { workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", verdict: "APPROVE", phase: "pre-release", source: "optional-group", reviewKind: "plan", startedAt: "2026-10-19T00:00:00Z", completedAt: "2026-10-19T00:00:01Z", ...(refused ? { planReviewApprovalRefused: true } : {}) } as any] });
      const current = await store.getTask(task.id);
      return { store, task: current, options: { identityRecovery: { expectedTaskUpdatedAt: current.updatedAt, expectedWorkflowStepResults: current.workflowStepResults ?? [], expectedRetryCount: current.graphResumeRetryCount ?? 0, maxRetries: 2 } } };
    }
    it.each([true, false])("seeds a new review while preserving the refused/stale passed verdict (%s)", async (refused) => {
      const { store, task, options } = await refusedTask(refused);
      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "identity"), options)).resolves.toMatchObject({ seeded: true });
      const fresh = await store.getTask(task.id);
      expect(fresh.workflowStepResults).toEqual(task.workflowStepResults);
      expect(fresh.graphResumeRetryCount).toBe(1);
      expect((await store.listWorkflowWorkItemsForTask(task.id)).filter((row) => row.state === "runnable")).toHaveLength(1);
    });
    it("charges only the winner when two recovery attempts compete", async () => {
      const { store, task, options } = await refusedTask();
      const results = await Promise.all([store.seedStrandedPlanReviewContinuation(continuation(task.id, "first-identity"), options), store.seedStrandedPlanReviewContinuation(continuation(task.id, "second-identity"), options)]);
      expect(results.filter((result) => result.seeded)).toHaveLength(1);
      expect((await store.getTask(task.id)).graphResumeRetryCount).toBe(1);
    });
    it("refuses a newer review snapshot without mutating history or charging a retry", async () => {
      const { store, task, options } = await refusedTask();
      await store.updateTask(task.id, { workflowStepResults: [{ ...task.workflowStepResults![0], planReviewApprovalRefused: undefined, completedAt: "2026-10-20T00:00:01Z" }] });
      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "outdated-identity"), options)).resolves.toMatchObject({ seeded: false, reason: "task-state-changed" });
      expect((await store.getTask(task.id)).graphResumeRetryCount).toBe(0);
      expect(await store.listWorkflowWorkItemsForTask(task.id)).toHaveLength(0);
    });
    it.each(["paused", "exhausted", "active"] as const)("refuses %s recovery without charging a retry", async (hold) => {
      const { store, task, options } = await refusedTask();
      if (hold === "paused") await store.updateTask(task.id, { paused: true });
      if (hold === "exhausted") { await store.updateTask(task.id, { graphResumeRetryCount: 2 }); options.identityRecovery.expectedRetryCount = 2; options.identityRecovery.expectedTaskUpdatedAt = (await store.getTask(task.id)).updatedAt; }
      if (hold === "active") await store.upsertWorkflowWorkItem(continuation(task.id, "active-identity", "workflow-step"));
      await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "held-identity"), options)).resolves.toMatchObject({ seeded: false });
      expect((await store.getTask(task.id)).graphResumeRetryCount).toBe(hold === "exhausted" ? 2 : 0);
    });
    it("rolls back the retry charge if successor persistence fails", async () => {
      const { store, task, options } = await refusedTask();
      await h.layer().db.execute(sql.raw("CREATE FUNCTION project.reject_identity_recovery_seed() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'identity successor write rejected'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_identity_recovery_seed BEFORE INSERT ON project.workflow_work_items FOR EACH ROW EXECUTE FUNCTION project.reject_identity_recovery_seed();"));
      try {
        await expect(store.seedStrandedPlanReviewContinuation(continuation(task.id, "failing-identity"), options)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "identity successor write rejected" }) });
        expect((await store.getTask(task.id)).graphResumeRetryCount).toBe(0);
        expect((await store.getTask(task.id)).workflowStepResults).toEqual(task.workflowStepResults);
        expect(await store.listWorkflowWorkItemsForTask(task.id)).toHaveLength(0);
      } finally {
        await h.layer().db.execute(sql.raw("DROP TRIGGER IF EXISTS reject_identity_recovery_seed ON project.workflow_work_items; DROP FUNCTION IF EXISTS project.reject_identity_recovery_seed();"));
      }
    });
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
