import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, MergeQueueInvalidColumnError, MergeQueueLeaseOwnershipError, MergeQueueTaskNotFoundError } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-merge-queue-test-"));
}

describe("TaskStore merge queue", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;
  const extraStores: TaskStore[] = [];

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const extraStore of extraStores.splice(0)) {
      extraStore.close();
    }
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTask(priority: "low" | "normal" | "high" | "urgent" = "normal"): Promise<string> {
    const task = await store.createTask({ description: `merge queue ${priority}`, priority });
    return task.id;
  }

  async function createInReviewTask(priority: "low" | "normal" | "high" | "urgent" = "normal"): Promise<string> {
    const taskId = await createTask(priority);
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.handoffToReview(taskId, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });
    return taskId;
  }

  function getTableNames(): string[] {
    return (store.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  }

  it("creates the mergeQueue table and indexes on fresh init", () => {
    expect(getTableNames()).toContain("mergeQueue");

    const indexes = store.getDatabase().prepare("PRAGMA index_list('mergeQueue')").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["idx_mergeQueue_lease_ready", "idx_mergeQueue_leaseExpiresAt"]),
    );

    expect(store.getDatabase().getSchemaVersion()).toBe(112);
  });

  it("migrates a legacy v88 database and preserves task rows", async () => {
    const existingTask = await store.createTask({ description: "legacy row survives", priority: "high" });
    const db = store.getDatabase();
    db.exec("DROP INDEX IF EXISTS idx_mergeQueue_lease_ready");
    db.exec("DROP INDEX IF EXISTS idx_mergeQueue_leaseExpiresAt");
    db.exec("DROP TABLE IF EXISTS mergeQueue");
    db.prepare("UPDATE __meta SET value = '88' WHERE key = 'schemaVersion'").run();
    store.close();

    const reopened = new TaskStore(rootDir, globalDir);
    extraStores.push(reopened);
    await reopened.init();

    const tables = reopened.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mergeQueue'").all() as Array<{ name: string }>;
    expect(tables).toEqual([{ name: "mergeQueue" }]);
    expect((await reopened.getTask(existingTask.id))?.description).toBe("legacy row survives");
  });

  it("enqueueMergeQueue is idempotent and preserves existing attempt state", async () => {
    const taskId = await createInReviewTask();

    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(taskId);
    const first = store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:00.000Z" });    const second = store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:05.000Z" });

    expect(first).toEqual(second);
    expect(store.peekMergeQueue()).toHaveLength(1);
    expect(store.peekMergeQueue()[0].attemptCount).toBe(0);

    const events = store.getRunAuditEvents({ taskId, mutationType: "mergeQueue:enqueue" }).filter((event) => event.metadata?.enqueuedAt === first.enqueuedAt).slice(0, 2);
    expect(events).toHaveLength(2);
    expect(events[0].metadata).toMatchObject({ alreadyEnqueued: true, taskId, enqueuedAt: first.enqueuedAt, priority: "normal" });
    expect(events[1].metadata).toMatchObject({ alreadyEnqueued: false, taskId, enqueuedAt: first.enqueuedAt, priority: "normal" });
  });

  it("throws MergeQueueTaskNotFoundError for unknown tasks", () => {
    expect(() => store.enqueueMergeQueue("FN-999999")).toThrow(MergeQueueTaskNotFoundError);
  });

  it("leases the requested target task when targetTaskId is provided", async () => {
    const taskA = await createTask("normal");
    const taskB = await createTask("normal");

    await store.moveTask(taskA, "todo");
    await store.moveTask(taskB, "todo");
    await store.moveTask(taskA, "in-progress");
    await store.moveTask(taskB, "in-progress");
    await store.handoffToReview(taskA, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });
    await store.handoffToReview(taskB, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:01.000Z",
    });
    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId IN (?, ?)").run(taskA, taskB);
    store.enqueueMergeQueue(taskA, { now: "2026-05-19T00:00:00.000Z" });
    store.enqueueMergeQueue(taskB, { now: "2026-05-19T00:00:01.000Z" });

    const headLease = store.acquireMergeQueueLease("merger-reuse-handoff", {
      leaseDurationMs: 60_000,
      now: "2026-05-19T00:01:00.000Z",
    });
    expect(headLease?.taskId).toBe(taskA);

    const targetLease = store.acquireMergeQueueLease("merger-reuse-handoff", {
      targetTaskId: taskB,
      leaseDurationMs: 60_000,
      now: "2026-05-19T00:01:01.000Z",
    });

    expect(targetLease?.taskId).toBe(taskB);
    expect(targetLease?.leasedBy).toBe("merger-reuse-handoff");
  });

  it("returns null and audits lease-target-unavailable without stealing queue head", async () => {
    const queuedTaskId = await createTask("normal");
    await store.moveTask(queuedTaskId, "todo");
    await store.moveTask(queuedTaskId, "in-progress");
    await store.handoffToReview(queuedTaskId, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });
    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(queuedTaskId);
    store.enqueueMergeQueue(queuedTaskId, { now: "2026-05-19T00:00:00.000Z" });

    const lease = store.acquireMergeQueueLease("merger-reuse-handoff", {
      targetTaskId: "FN-404040",
      leaseDurationMs: 60_000,
      now: "2026-05-19T00:01:00.000Z",
    });
    expect(lease).toBeNull();

    const queued = store.peekMergeQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ taskId: queuedTaskId, leasedBy: null });

    const auditEvents = store.getRunAuditEvents({ taskId: "FN-404040", mutationType: "mergeQueue:lease-target-unavailable" });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].metadata).toMatchObject({
      targetTaskId: "FN-404040",
      workerId: "merger-reuse-handoff",
      queueHeadTaskId: queuedTaskId,
      queueHeadLeasedBy: null,
      queueHeadColumn: "in-review",
    });
  });

  describe("acquireMergeQueueLease targetTaskId isolation (FN-5353)", () => {
    it("returns null when target is absent even if another task is queued", async () => {
      const taskA = await createInReviewTask();
      store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(taskA);
      store.enqueueMergeQueue(taskA, { now: "2026-05-19T00:00:00.000Z" });

      const before = store.getDatabase().prepare("SELECT leasedBy, leasedAt, leaseExpiresAt FROM mergeQueue WHERE taskId = ?").get(taskA) as {
        leasedBy: string | null;
        leasedAt: string | null;
        leaseExpiresAt: string | null;
      };

      const lease = store.acquireMergeQueueLease("worker-target-miss", {
        targetTaskId: "FN-5353-MISSING",
        leaseDurationMs: 60_000,
        now: "2026-05-19T00:01:00.000Z",
      });
      expect(lease).toBeNull();

      const after = store.getDatabase().prepare("SELECT leasedBy, leasedAt, leaseExpiresAt FROM mergeQueue WHERE taskId = ?").get(taskA);
      expect(after).toEqual(before);
    });

    it("returns null when target row is currently leased by another worker", async () => {
      const taskA = await createInReviewTask();
      store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
        "worker-one",
        "2026-05-19T00:01:00.000Z",
        "2099-05-19T00:10:00.000Z",
        taskA,
      );

      const lease = store.acquireMergeQueueLease("worker-two", {
        targetTaskId: taskA,
        leaseDurationMs: 60_000,
        now: "2026-05-19T00:01:30.000Z",
      });
      expect(lease).toBeNull();
    });

    it("leases the targeted row when available", async () => {
      const taskA = await createInReviewTask();
      const lease = store.acquireMergeQueueLease("worker-target-hit", {
        targetTaskId: taskA,
        leaseDurationMs: 60_000,
        now: "2026-05-19T00:02:00.000Z",
      });

      expect(lease?.taskId).toBe(taskA);
      expect(lease?.leasedBy).toBe("worker-target-hit");
    });

    it("preserves legacy queue-head selection when targetTaskId is omitted", async () => {
      const taskA = await createInReviewTask();
      const lease = store.acquireMergeQueueLease("worker-head", {
        leaseDurationMs: 60_000,
        now: "2026-05-19T00:03:00.000Z",
      });

      expect(lease?.taskId).toBe(taskA);
      expect(lease?.leasedBy).toBe("worker-head");
    });
  });

  it("rejects enqueue for tasks outside in-review", async () => {
    const todoTask = await createTask();
    await store.moveTask(todoTask, "todo");
    expect(() => store.enqueueMergeQueue(todoTask)).toThrow(MergeQueueInvalidColumnError);

    const inProgressTask = await createTask();
    await store.moveTask(inProgressTask, "todo");
    await store.moveTask(inProgressTask, "in-progress");
    expect(() => store.enqueueMergeQueue(inProgressTask)).toThrow(MergeQueueInvalidColumnError);

    const doneTask = await createInReviewTask();
    const doneLease = store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000 });
    expect(doneLease?.taskId).toBe(doneTask);
    store.releaseMergeQueueLease(doneTask, "worker-1", { kind: "success" });
    await store.moveTask(doneTask, "done", { skipMergeBlocker: true });
    expect(() => store.enqueueMergeQueue(doneTask)).toThrow(MergeQueueInvalidColumnError);

    const archivedTask = await createTask();
    await store.moveTask(archivedTask, "archived");
    expect(() => store.enqueueMergeQueue(archivedTask)).toThrow(MergeQueueInvalidColumnError);

    const rejected = store.getDatabase().prepare("SELECT COUNT(*) as c FROM runAuditEvents WHERE mutationType = 'mergeQueue:enqueue-rejected'").get() as { c: number };
    expect(rejected.c).toBeGreaterThanOrEqual(4);
  });

  it("removes merge queue rows when task exits in-review without a live lease", async () => {
    const taskId = await createInReviewTask();
    expect(store.peekMergeQueue().some((entry) => entry.taskId === taskId)).toBe(true);

    await store.moveTask(taskId, "todo");
    expect(store.peekMergeQueue().some((entry) => entry.taskId === taskId)).toBe(false);

    const cleanupEvents = store.getRunAuditEvents({ taskId, mutationType: "mergeQueue:auto-cleanup-stale-row" });
    expect(cleanupEvents.some((event) => event.metadata?.reason === "column-exit")).toBe(true);
  });

  it("keeps live leased rows on in-review column exit and audits contention", async () => {
    const taskId = await createInReviewTask();
    const lease = store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, now: "2099-05-19T00:00:10.000Z" });
    expect(lease?.taskId).toBe(taskId);

    await store.moveTask(taskId, "in-progress");
    expect(store.peekMergeQueue().some((entry) => entry.taskId === taskId)).toBe(true);

    const staleLeaseAudit = store.getRunAuditEvents({ taskId, mutationType: "mergeQueue:stale-lease-on-column-exit" });
    expect(staleLeaseAudit).toHaveLength(1);
  });

  it("removes expired leased rows on in-review column exit", async () => {
    const taskId = await createInReviewTask();
    const lease = store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 5, now: "2026-05-19T00:00:00.000Z" });
    expect(lease?.taskId).toBe(taskId);

    await store.moveTask(taskId, "in-progress", { moveSource: "engine" });
    expect(store.peekMergeQueue().some((entry) => entry.taskId === taskId)).toBe(false);
  });

  it("FN-5444: emits metadata-rich enqueue-rejected and stale-lease-on-column-exit audits", async () => {
    const todoTask = await createTask();
    await store.moveTask(todoTask, "todo");
    expect(() => store.enqueueMergeQueue(todoTask)).toThrow(MergeQueueInvalidColumnError);

    const rejected = store.getRunAuditEvents({ taskId: todoTask, mutationType: "mergeQueue:enqueue-rejected" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata).toMatchObject({
      taskId: todoTask,
      column: "todo",
      reason: "not-in-review",
    });

    const leasedTaskId = await createInReviewTask();
    const lease = store.acquireMergeQueueLease("worker-fn-5444", { leaseDurationMs: 60_000, now: "2099-05-19T00:00:10.000Z" });
    expect(lease?.taskId).toBe(leasedTaskId);
    await store.moveTask(leasedTaskId, "todo");

    const staleLeaseAudit = store.getRunAuditEvents({ taskId: leasedTaskId, mutationType: "mergeQueue:stale-lease-on-column-exit" });
    expect(staleLeaseAudit).toHaveLength(1);
    expect(staleLeaseAudit[0].metadata).toMatchObject({
      taskId: leasedTaskId,
      previousColumn: "in-review",
      nextColumn: "todo",
      leasedBy: "worker-fn-5444",
    });
    expect(typeof staleLeaseAudit[0].metadata?.leaseExpiresAt).toBe("string");
  });

  it("FN-5444: auto-cleanup-stale-row fires for targeted and untargeted acquisition", async () => {
    const staleTaskId = await createTask();
    await store.moveTask(staleTaskId, "todo");

    const targetTaskId = await createInReviewTask();
    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(targetTaskId);
    store.enqueueMergeQueue(targetTaskId, { now: "2026-05-19T00:00:00.100Z" });
    store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(
      staleTaskId,
      "2026-05-19T00:00:00.000Z",
      "normal",
    );

    const targetedLease = store.acquireMergeQueueLease("worker-targeted", {
      targetTaskId,
      leaseDurationMs: 60_000,
      now: "2026-05-19T00:01:00.000Z",
    });
    expect(targetedLease?.taskId).toBe(targetTaskId);
    store.releaseMergeQueueLease(targetTaskId, "worker-targeted", { kind: "failure", error: "retry" });

    const untargetedLease = store.acquireMergeQueueLease("worker-untargeted", {
      leaseDurationMs: 60_000,
      now: "2026-05-19T00:02:00.000Z",
    });
    expect(untargetedLease?.taskId).toBe(targetTaskId);

    const cleanupEvents = store.getRunAuditEvents({ taskId: staleTaskId, mutationType: "mergeQueue:auto-cleanup-stale-row" });
    expect(cleanupEvents).toHaveLength(1);
    expect(cleanupEvents[0].metadata).toMatchObject({
      taskId: staleTaskId,
      column: "todo",
      reason: "not-in-review",
    });
    expect(store.peekMergeQueue().some((entry) => entry.taskId === staleTaskId)).toBe(false);
  });

  it("auto-cleans polluted non-in-review rows before lease selection", async () => {
    const reviewTaskId = await createInReviewTask();
    const todoTaskId = await createTask();
    await store.moveTask(todoTaskId, "todo");
    store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(
      todoTaskId,
      "2026-05-19T00:00:00.000Z",
      "normal",
    );

    const lease = store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" });
    expect(lease?.taskId).toBe(reviewTaskId);
    expect(store.peekMergeQueue().some((entry) => entry.taskId === todoTaskId)).toBe(false);

    const cleanupEvents = store.getRunAuditEvents({ taskId: todoTaskId, mutationType: "mergeQueue:auto-cleanup-stale-row" });
    expect(cleanupEvents).toHaveLength(1);
  });

  it("leases in priority order regardless of enqueue order", async () => {
    const lowTaskId = await createInReviewTask("low");
    const urgentTaskId = await createInReviewTask("urgent");
    const normalTaskId = await createInReviewTask("normal");

    store.enqueueMergeQueue(lowTaskId, { now: "2026-05-19T00:00:00.000Z" });
    store.enqueueMergeQueue(urgentTaskId, { now: "2026-05-19T00:00:01.000Z" });
    store.enqueueMergeQueue(normalTaskId, { now: "2026-05-19T00:00:02.000Z" });

    expect(store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" })?.taskId).toBe(urgentTaskId);
    expect(store.acquireMergeQueueLease("worker-2", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:01.000Z" })?.taskId).toBe(normalTaskId);
    expect(store.acquireMergeQueueLease("worker-3", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:02.000Z" })?.taskId).toBe(lowTaskId);
  });

  it("uses FIFO ordering within the same priority", async () => {
    const firstTaskId = await createInReviewTask();
    const secondTaskId = await createInReviewTask();

    store.enqueueMergeQueue(firstTaskId, { now: "2026-05-19T00:00:00.000Z" });
    store.enqueueMergeQueue(secondTaskId, { now: "2026-05-19T00:00:00.005Z" });

    expect(store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" })?.taskId).toBe(firstTaskId);
    expect(store.acquireMergeQueueLease("worker-2", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:01.000Z" })?.taskId).toBe(secondTaskId);
  });

  it("allows exactly one worker to lease a single queued task across competing stores", async () => {
    const storeA = new TaskStore(rootDir, globalDir);
    const storeB = new TaskStore(rootDir, globalDir);
    extraStores.push(storeA, storeB);
    await storeA.init();
    await storeB.init();

    const taskId = await createInReviewTask();

    for (let index = 0; index < 20; index += 1) {
      store.enqueueMergeQueue(taskId, { now: `2026-05-19T00:00:${String(index).padStart(2, "0")}.000Z` });
      const [leaseA, leaseB] = await Promise.all([
        Promise.resolve().then(() => storeA.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000, now: `2026-05-19T00:10:${String(index).padStart(2, "0")}.000Z` })),
        Promise.resolve().then(() => storeB.acquireMergeQueueLease("worker-b", { leaseDurationMs: 60_000, now: `2026-05-19T00:10:${String(index).padStart(2, "0")}.000Z` })),
      ]);

      expect([Boolean(leaseA), Boolean(leaseB)].filter(Boolean)).toHaveLength(1);
      const leased = (leaseA ?? leaseB)!;
      expect(leased.taskId).toBe(taskId);
      store.releaseMergeQueueLease(taskId, leased.leasedBy!, { kind: "success" });
      expect(store.peekMergeQueue()).toHaveLength(0);
    }
  });

  it("recovers expired leases and makes the task leasable again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00.000Z"));

    const taskId = await createInReviewTask();
    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(taskId);
    store.enqueueMergeQueue(taskId);
    const firstLease = store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 50 });
    expect(firstLease?.leasedBy).toBe("worker-a");

    vi.setSystemTime(new Date("2026-05-19T00:00:01.000Z"));
    const recovered = store.recoverExpiredMergeQueueLeases();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ taskId, leasedBy: null, leasedAt: null, leaseExpiresAt: null });

    const expiredEvents = store.getRunAuditEvents({ taskId, mutationType: "mergeQueue:lease-expired" });
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].metadata).toMatchObject({
      taskId,
      previousLeasedBy: "worker-a",
      previousLeaseExpiresAt: firstLease?.leaseExpiresAt,
      recoveredAt: "2026-05-19T00:00:01.000Z",
    });

    const [workerBLease, workerASecondAttempt] = await Promise.all([
      Promise.resolve().then(() => store.acquireMergeQueueLease("worker-b", { leaseDurationMs: 60_000 })),
      Promise.resolve().then(() => store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000 })),
    ]);
    expect(workerBLease?.taskId).toBe(taskId);
    expect(workerASecondAttempt).toBeNull();
  });

  it("guards lease release by current owner", async () => {
    const taskId = await createInReviewTask();
    store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:00.000Z" });
    const lease = store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" });
    expect(lease?.taskId).toBe(taskId);

    expect(() => store.releaseMergeQueueLease(taskId, "worker-b", { kind: "success" })).toThrow(MergeQueueLeaseOwnershipError);
    expect(store.peekMergeQueue()[0]).toMatchObject({ taskId, leasedBy: "worker-a" });
  });

  it("releases failed work back to the queue and increments attemptCount", async () => {
    const taskId = await createInReviewTask();
    store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:00.000Z" });
    const lease = store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" });
    expect(lease?.taskId).toBe(taskId);

    store.releaseMergeQueueLease(taskId, "worker-a", { kind: "failure", error: "boom" });

    const queued = store.peekMergeQueue()[0];
    expect(queued).toMatchObject({
      taskId,
      leasedBy: null,
      leasedAt: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      lastError: "boom",
    });
    expect(store.acquireMergeQueueLease("worker-b", { leaseDurationMs: 60_000, now: "2026-05-19T00:02:00.000Z" })?.taskId).toBe(taskId);
  });

  it("emits one audit event for each merge queue mutation path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00.000Z"));

    const failureTaskId = await createInReviewTask();
    const expiryTaskId = await createInReviewTask("urgent");

    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId IN (?, ?)").run(failureTaskId, expiryTaskId);

    store.enqueueMergeQueue(failureTaskId, { now: "2026-05-19T00:00:00.000Z" });    const failureLease = store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000 });
    expect(failureLease?.taskId).toBe(failureTaskId);
    store.releaseMergeQueueLease(failureTaskId, "worker-a", { kind: "failure", error: "boom" });

    store.enqueueMergeQueue(expiryTaskId);
    const expiryLease = store.acquireMergeQueueLease("worker-b", { leaseDurationMs: 10 });
    expect(expiryLease?.taskId).toBe(expiryTaskId);
    vi.setSystemTime(new Date("2026-05-19T00:00:01.000Z"));
    store.recoverExpiredMergeQueueLeases();

    const auditRows = store.getDatabase().prepare(`
      SELECT taskId, mutationType, target, metadata
      FROM runAuditEvents
      WHERE mutationType LIKE 'mergeQueue:%'
      ORDER BY timestamp ASC, rowid ASC
    `).all() as Array<{
      taskId: string | null;
      mutationType: string;
      target: string;
      metadata: string | null;
    }>;
    const auditEvents = auditRows.map((row) => ({
      taskId: row.taskId,
      mutationType: row.mutationType,
      target: row.target,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    }));

    const enqueueEvents = auditEvents.filter(
      (event) => event.mutationType === "mergeQueue:enqueue" && event.target === failureTaskId && event.metadata?.enqueuedAt === "2026-05-19T00:00:00.000Z",
    );
    expect(enqueueEvents.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(enqueueEvents[0].metadata ?? {}).sort()).toEqual(["alreadyEnqueued", "enqueuedAt", "priority", "taskId"]);

    const acquiredEvents = auditEvents.filter(
      (event) => event.mutationType === "mergeQueue:lease-acquired" && event.target === failureTaskId && event.metadata?.workerId === "worker-a",
    );
    expect(acquiredEvents).toHaveLength(1);
    expect(Object.keys(acquiredEvents[0].metadata ?? {}).sort()).toEqual(["leaseExpiresAt", "priority", "taskId", "workerId"]);

    const releasedEvents = auditEvents.filter(
      (event) => event.mutationType === "mergeQueue:lease-released" && event.target === failureTaskId && event.metadata?.workerId === "worker-a",
    );
    expect(releasedEvents).toHaveLength(1);
    expect(Object.keys(releasedEvents[0].metadata ?? {}).sort()).toEqual(["attemptCount", "error", "outcome", "taskId", "workerId"]);

    const expiredEvents = auditEvents.filter(
      (event) => event.mutationType === "mergeQueue:lease-expired" && (event.target === expiryTaskId || event.metadata?.taskId === expiryTaskId),
    );
    expect(expiredEvents).toHaveLength(1);
    expect(Object.keys(expiredEvents[0].metadata ?? {}).sort()).toEqual(["previousLeaseExpiresAt", "previousLeasedBy", "recoveredAt", "taskId"]);
  });
});
