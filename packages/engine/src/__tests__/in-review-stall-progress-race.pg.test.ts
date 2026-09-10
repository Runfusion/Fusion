import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "@fusion/core";
import {
  countRecentIdenticalStallEntries,
  getInReviewStallReason,
  getLatestFailedPreMergeStepProgressAt,
  TaskStore,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

pgDescribe("in-review stall progress race", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_in_review_stall_progress_race",
    poolMax: 4,
    projectId: "in-review-stall-race",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("rejects a stale disposition after another store publishes a new gate attempt", async () => {
    const store = h.store();
    const peer = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await store.updateSettings({
      autoMerge: true,
      taskStuckTimeoutMs: 1,
      inReviewStallDeadlockThreshold: 3,
    });
    const task = await store.createTask({ description: "stall correction race" });
    const reason = "task has failed pre-merge workflow steps";
    await store.updateTask(task.id, {
      column: "in-review",
      status: undefined,
      paused: false,
      userPaused: false,
      steps: [{ name: "implementation", status: "done" }],
      worktree: "/tmp/fn-336-race",
      updatedAt: "2026-01-01T00:00:00.000Z",
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
      }],
      log: [
        { timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
        { timestamp: "2026-01-01T00:02:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      ],
    });
    await h.adminSql()`UPDATE project.tasks SET "column" = 'in-review', paused = 0, status = NULL, updated_at = ${"2026-01-01T00:00:00.000Z"} WHERE id = ${task.id}`;
    store.taskCache.delete(task.id);
    const seeded = await store.getTask(task.id);
    expect(seeded).toMatchObject({ column: "in-review", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(seeded?.paused).not.toBe(true);
    expect(getInReviewStallReason(seeded!, { now: Date.now(), autoMerge: true })?.reason).toBe(reason);

    const originalApply = store.applyInReviewStallObservationFenced.bind(store);
    let entered!: () => void;
    const selected = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "applyInReviewStallObservationFenced").mockImplementationOnce(async (...args) => {
      entered();
      await resume;
      return originalApply(...args);
    });
    const audit = vi.spyOn(store, "recordRunAuditEvent");
    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });

    const sweep = manager.surfaceInReviewStalls();
    await selected;
    await peer.updateWorkflowStepResultsFenced(task.id, () => ({
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        priorAttempts: [{ status: "failed", startedAt: "2026-01-01T00:00:00.000Z" }],
      }],
    }));
    release();

    expect(await sweep).toBe(0);
    store.taskCache.clear();
    const live = await store.getTask(task.id);
    expect(live?.paused).not.toBe(true);
    expect(live?.status).toBeUndefined();
    expect(live?.error).toBeUndefined();
    expect(live?.workflowStepResults?.[0]).toMatchObject({
      workflowStepId: "code-review",
      status: "failed",
      priorAttempts: [expect.objectContaining({ status: "failed" })],
    });
    expect(live?.log.some((entry) => entry.action.startsWith("In-review stall auto-disposed"))).toBe(false);
    expect(audit.mock.calls.some(([event]) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);

    await h.adminSql()`UPDATE project.tasks SET updated_at = ${"2026-01-01T00:00:00.000Z"} WHERE project_id = ${h.layer().projectId} AND id = ${task.id}`;
    store.taskCache.clear();
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    store.taskCache.clear();
    const next = await store.getTask(task.id);
    expect(next?.paused).not.toBe(true);
    expect(next?.log.filter((entry) => entry.action.startsWith("In-review stall surfaced"))).toHaveLength(3);
    expect(next?.log.some((entry) => entry.action.startsWith("In-review stall auto-disposed"))).toBe(false);
    const nextSignal = getInReviewStallReason(next!, { now: Date.now(), autoMerge: true });
    expect(nextSignal).toMatchObject({ code: "merge-blocker", reason });
    expect(countRecentIdenticalStallEntries(
      next!,
      nextSignal!,
      getLatestFailedPreMergeStepProgressAt(next!),
    )).toBe(1);
    expect(audit.mock.calls.some(([event]) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);
    manager.stop();
  });
});
