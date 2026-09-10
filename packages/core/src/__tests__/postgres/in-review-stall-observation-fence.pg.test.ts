import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TaskStore } from "../../store.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore in-review stall observation fence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_in_review_stall_fence",
    poolMax: 4,
    projectId: "in-review-stall-fence",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const entry = (action = "In-review stall surfaced [merge-blocker]: blocked") => ({
    timestamp: new Date().toISOString(),
    action,
  });

  it("commits the observation log and disposition fields atomically", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "atomic stall disposition" });

    const outcome = await store.applyInReviewStallObservationFenced(task.id, () => ({
      logEntry: entry("In-review stall auto-disposed [merge-blocker]: threshold reached"),
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      status: "failed",
      error: "deadlock",
    }));

    expect(outcome).toMatchObject({ applied: true });
    const live = await store.getTask(task.id);
    expect(live).toMatchObject({
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      status: "failed",
      error: "deadlock",
    });
    expect(live?.log.some((item) => item.action.includes("auto-disposed"))).toBe(true);
  });

  it("re-reads workflow progress published before a stale observation applies", async () => {
    const store = h.store();
    const peer = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const task = await store.createTask({ description: "stale stall observation" });
    const selectedResults = task.workflowStepResults;

    await peer.updateWorkflowStepResultsFenced(task.id, () => ({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        startedAt: "2026-09-10T08:00:00.000Z",
      }],
    }));

    const outcome = await store.applyInReviewStallObservationFenced(task.id, (live) =>
      live.workflowStepResults === selectedResults ? { logEntry: entry() } : null);
    expect(outcome).toEqual({ applied: false, reason: "refused" });
    expect((await store.getTask(task.id))?.log.some((item) => item.action.startsWith("In-review stall"))).toBe(false);
  });

  it("preserves an observation that wins the lock before a workflow result writer", async () => {
    const store = h.store();
    const peer = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const task = await store.createTask({ description: "observation before workflow progress" });
    let workflowWrite: ReturnType<TaskStore["updateWorkflowStepResultsFenced"]> | undefined;
    let workflowWriterSawObservation = false;

    const observation = await store.applyInReviewStallObservationFenced(task.id, () => {
      workflowWrite = peer.updateWorkflowStepResultsFenced(task.id, (live) => {
        workflowWriterSawObservation = live.log.some((item) => item.action.startsWith("In-review stall surfaced"));
        return {
          workflowStepResults: [{
            workflowStepId: "code-review",
            workflowStepName: "Code Review",
            phase: "pre-merge",
            status: "failed",
            startedAt: "2026-09-10T08:01:00.000Z",
          }],
        };
      });
      return { logEntry: entry() };
    });

    expect(observation).toMatchObject({ applied: true });
    expect(workflowWrite).toBeDefined();
    await expect(workflowWrite!).resolves.toMatchObject({ applied: true });
    expect(workflowWriterSawObservation).toBe(true);
    const live = await store.getTask(task.id);
    expect(live?.log.filter((item) => item.action.startsWith("In-review stall surfaced"))).toHaveLength(1);
    expect(live?.workflowStepResults).toEqual([
      expect.objectContaining({ workflowStepId: "code-review", startedAt: "2026-09-10T08:01:00.000Z" }),
    ]);
  });

  it("serializes concurrent admissible sweeps without losing logs and disposes once", async () => {
    const store = h.store();
    const peer = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    const task = await store.createTask({ description: "concurrent stall observations" });
    await store.updateTask(task.id, { log: [entry()] });

    const compute = (live: Awaited<ReturnType<TaskStore["getTask"]>>) => {
      if (!live || live.paused) return null;
      const priorObservations = live.log.filter((item) => item.action.startsWith("In-review stall surfaced"));
      if (priorObservations.length < 2) return { logEntry: entry() };
      return {
        logEntry: entry("In-review stall auto-disposed [merge-blocker]: threshold reached"),
        paused: true,
        pausedReason: "in-review-stall-deadlock",
        status: "failed",
        error: "deadlock",
      };
    };
    const outcomes = await Promise.all([
      store.applyInReviewStallObservationFenced(task.id, compute),
      peer.applyInReviewStallObservationFenced(task.id, compute),
    ]);

    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(2);
    const live = await store.getTask(task.id);
    expect(live?.log.filter((item) => item.action.startsWith("In-review stall surfaced"))).toHaveLength(2);
    expect(live?.log.filter((item) => item.action.includes("auto-disposed"))).toHaveLength(1);
    expect(live).toMatchObject({ paused: true, pausedReason: "in-review-stall-deadlock", status: "failed" });
  });

  it("isolates colliding task ids by project for reads, locks, and updates", async () => {
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const storeA = new TaskStore(h.rootDir(), undefined, { asyncLayer: bind("stall-project-a") });
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: bind("stall-project-b") });
    const taskId = "FN-STALL-COLLISION";
    await storeA.createTaskWithReservedId(
      { description: "project A stall" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await storeB.createTaskWithReservedId(
      { description: "project B stall" },
      { taskId, applyDefaultWorkflowSteps: false },
    );

    const [outcomeA, outcomeB] = await Promise.all([
      storeA.applyInReviewStallObservationFenced(taskId, () => ({ logEntry: entry("project A observation") })),
      storeB.applyInReviewStallObservationFenced(taskId, () => ({ logEntry: entry("project B observation") })),
    ]);

    expect(outcomeA).toMatchObject({ applied: true, task: { description: "project A stall" } });
    expect(outcomeB).toMatchObject({ applied: true, task: { description: "project B stall" } });
    expect((await storeA.getTask(taskId))?.log.map((item) => item.action)).toContain("project A observation");
    expect((await storeA.getTask(taskId))?.log.map((item) => item.action)).not.toContain("project B observation");
    expect((await storeB.getTask(taskId))?.log.map((item) => item.action)).toContain("project B observation");
    expect((await storeB.getTask(taskId))?.log.map((item) => item.action)).not.toContain("project A observation");
  });

  it("does not write for refused, missing, or deleted rows", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "stall refusal" });
    await expect(store.applyInReviewStallObservationFenced(task.id, () => null))
      .resolves.toEqual({ applied: false, reason: "refused" });
    await expect(store.applyInReviewStallObservationFenced("FN-missing", () => ({ logEntry: entry() })))
      .resolves.toEqual({ applied: false, reason: "task-missing" });
    await h.layer().db.update(schema.project.tasks)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(schema.project.tasks.id, task.id));
    await expect(store.applyInReviewStallObservationFenced(task.id, () => ({ logEntry: entry() })))
      .resolves.toEqual({ applied: false, reason: "task-deleted" });
  });
});
