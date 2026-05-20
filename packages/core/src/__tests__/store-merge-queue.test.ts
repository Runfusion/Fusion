import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, MergeQueueLeaseOwnershipError, MergeQueueTaskNotFoundError } from "../store.js";

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

  function getTableNames(): string[] {
    return (store.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  }

  it("creates the mergeQueue table and indexes on fresh init", () => {
    expect(getTableNames()).toContain("mergeQueue");

    const indexes = store.getDatabase().prepare("PRAGMA index_list('mergeQueue')").all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["idx_mergeQueue_lease_ready", "idx_mergeQueue_leaseExpiresAt"]),
    );

    expect(store.getDatabase().getSchemaVersion()).toBe(89);
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
    const taskId = await createTask();

    const first = store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:00.000Z" });
    const second = store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:05.000Z" });

    expect(first).toEqual(second);
    expect(store.peekMergeQueue()).toHaveLength(1);
    expect(store.peekMergeQueue()[0].attemptCount).toBe(0);

    const events = store.getRunAuditEvents({ taskId, mutationType: "mergeQueue:enqueue" });
    expect(events).toHaveLength(2);
    expect(events[0].metadata).toMatchObject({ alreadyEnqueued: true, taskId, enqueuedAt: first.enqueuedAt, priority: "normal" });
    expect(events[1].metadata).toMatchObject({ alreadyEnqueued: false, taskId, enqueuedAt: first.enqueuedAt, priority: "normal" });
  });

  it("throws MergeQueueTaskNotFoundError for unknown tasks", () => {
    expect(() => store.enqueueMergeQueue("FN-999999")).toThrow(MergeQueueTaskNotFoundError);
  });

  it("leases in priority order regardless of enqueue order", async () => {
    const lowTaskId = await createTask("low");
    const urgentTaskId = await createTask("urgent");
    const normalTaskId = await createTask("normal");

    store.enqueueMergeQueue(lowTaskId, { now: "2026-05-19T00:00:00.000Z" });
    store.enqueueMergeQueue(urgentTaskId, { now: "2026-05-19T00:00:01.000Z" });
    store.enqueueMergeQueue(normalTaskId, { now: "2026-05-19T00:00:02.000Z" });

    expect(store.acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" })?.taskId).toBe(urgentTaskId);
    expect(store.acquireMergeQueueLease("worker-2", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:01.000Z" })?.taskId).toBe(normalTaskId);
    expect(store.acquireMergeQueueLease("worker-3", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:02.000Z" })?.taskId).toBe(lowTaskId);
  });

  it("uses FIFO ordering within the same priority", async () => {
    const firstTaskId = await createTask();
    const secondTaskId = await createTask();

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

    const taskId = await createTask();

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

    const taskId = await createTask();
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
    const taskId = await createTask();
    store.enqueueMergeQueue(taskId, { now: "2026-05-19T00:00:00.000Z" });
    const lease = store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000, now: "2026-05-19T00:01:00.000Z" });
    expect(lease?.taskId).toBe(taskId);

    expect(() => store.releaseMergeQueueLease(taskId, "worker-b", { kind: "success" })).toThrow(MergeQueueLeaseOwnershipError);
    expect(store.peekMergeQueue()[0]).toMatchObject({ taskId, leasedBy: "worker-a" });
  });

  it("releases failed work back to the queue and increments attemptCount", async () => {
    const taskId = await createTask();
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

    const failureTaskId = await createTask();
    const expiryTaskId = await createTask("urgent");

    store.enqueueMergeQueue(failureTaskId);
    store.acquireMergeQueueLease("worker-a", { leaseDurationMs: 60_000 });
    store.releaseMergeQueueLease(failureTaskId, "worker-a", { kind: "failure", error: "boom" });

    store.enqueueMergeQueue(expiryTaskId);
    store.acquireMergeQueueLease("worker-b", { leaseDurationMs: 10 });
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

    const enqueueEvents = auditEvents.filter((event) => event.mutationType === "mergeQueue:enqueue" && event.target === failureTaskId);
    expect(enqueueEvents).toHaveLength(1);
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
