import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffInvariantViolationError, TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-handoff-to-review-test-"));
}

describe("TaskStore handoffToReview", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTask(priority: "low" | "normal" | "high" | "urgent" = "normal") {
    return store.createTask({ description: `handoff ${priority}`, priority });
  }

  async function createInProgressTask(priority: "low" | "normal" | "high" | "urgent" = "normal") {
    const task = await createTask(priority);
    await store.moveTask(task.id, "todo");
    return store.moveTask(task.id, "in-progress");
  }

  function getAuditEventsByInsertion(taskId: string): Array<{
    mutationType: string;
    metadata: Record<string, unknown> | undefined;
  }> {
    const rows = store.getDatabase().prepare(`
      SELECT mutationType, metadata
      FROM runAuditEvents
      WHERE taskId = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(taskId) as Array<{ mutationType: string; metadata: string | null }>;
    return rows.map((row) => ({
      mutationType: row.mutationType,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    }));
  }

  it("atomically moves an in-progress task to in-review and enqueues merge work", async () => {
    const task = await createInProgressTask("high");
    const beforeEvents = getAuditEventsByInsertion(task.id).length;

    const handedOff = await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });

    expect(handedOff.column).toBe("in-review");
    expect(await store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: "high" }),
    ]);

    const relevantEvents = getAuditEventsByInsertion(task.id)
      .slice(beforeEvents)
      .filter((event) =>
        ["task:move", "mergeQueue:enqueue", "task:handoff", "task:handoff-invariant-violation"].includes(event.mutationType)
      );
    expect(relevantEvents.map((event) => event.mutationType)).toEqual([
      "task:move",
      "mergeQueue:enqueue",
      "task:handoff",
    ]);
    expect(relevantEvents[0].metadata).toMatchObject({ from: "in-progress", to: "in-review" });
    expect(relevantEvents[1].metadata).toMatchObject({ taskId: task.id, priority: "high", alreadyEnqueued: false });
    expect(relevantEvents[2].metadata).toMatchObject({
      taskId: task.id,
      fromColumn: "in-progress",
      ownerAgentId: "agent-1",
      reason: "fn_task_done",
      runId: "run-1",
      agentId: "agent-1",
      alreadyEnqueued: false,
    });
  });

  it("is idempotent and reports alreadyEnqueued on a second handoff", async () => {
    const task = await createInProgressTask();

    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });
    const second = await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-2", agentId: "agent-1" },
      now: "2026-05-19T00:00:05.000Z",
    });

    expect(second.column).toBe("in-review");
    expect(await store.peekMergeQueue()).toHaveLength(1);

    const handoffEvents = getAuditEventsByInsertion(task.id).filter((event) => event.mutationType === "task:handoff");
    expect(handoffEvents).toHaveLength(2);
    expect(handoffEvents[1].metadata).toMatchObject({
      taskId: task.id,
      fromColumn: "in-review",
      alreadyEnqueued: true,
      runId: "run-2",
    });
  });

  it("rolls back the column move and audit trail when enqueueMergeQueue throws", async () => {
    const task = await createInProgressTask();
    const beforeEvents = getAuditEventsByInsertion(task.id).length;
    vi.spyOn(store as never, "enqueueMergeQueueSyncInternal").mockImplementationOnce((() => {
      throw new Error("boom");
    }) as never);

    await expect(store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    })).rejects.toThrow("boom");

    expect((await store.getTask(task.id))?.column).toBe("in-progress");
    expect(await store.peekMergeQueue()).toHaveLength(0);
    const newEvents = getAuditEventsByInsertion(task.id).slice(beforeEvents);
    expect(newEvents.filter((event) => event.mutationType === "task:move")).toHaveLength(0);
    expect(newEvents.filter((event) => event.mutationType === "task:handoff")).toHaveLength(0);
  });

  it("rejects archived or deleted tasks without changing queue state", async () => {
    const archived = await createTask();
    const deleted = await createInProgressTask();
    store.getDatabase().prepare('UPDATE tasks SET "column" = ?, "deletedAt" = ? WHERE id = ?').run(
      "archived",
      null,
      archived.id,
    );
    store.getDatabase().prepare('UPDATE tasks SET "deletedAt" = ? WHERE id = ?').run(
      "2026-05-19T00:00:00.000Z",
      deleted.id,
    );

    await expect(store.handoffToReview(archived.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "archived" },
      now: "2026-05-19T00:00:01.000Z",
    })).rejects.toBeInstanceOf(HandoffInvariantViolationError);
    await expect(store.handoffToReview(deleted.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "deleted" },
      now: "2026-05-19T00:00:02.000Z",
    })).rejects.toBeInstanceOf(HandoffInvariantViolationError);

    expect((await store.getTask(archived.id))?.column).toBe("archived");
    expect(await store.peekMergeQueue()).toHaveLength(0);
    expect(getAuditEventsByInsertion(archived.id).filter((event) => event.mutationType === "task:handoff")).toHaveLength(0);
    expect(getAuditEventsByInsertion(deleted.id).filter((event) => event.mutationType === "task:handoff")).toHaveLength(0);
  });

  it("audits direct moveTask in-review transitions as invariant violations", async () => {
    const task = await createInProgressTask();

    const moved = await store.moveTask(task.id, "in-review");

    expect(moved.column).toBe("in-review");
    const violations = getAuditEventsByInsertion(task.id).filter((event) => event.mutationType === "task:handoff-invariant-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0].metadata).toMatchObject({
      taskId: task.id,
      fromColumn: "in-progress",
      callerStack: expect.any(String),
    });
    expect(String(violations[0].metadata?.callerStack ?? "").split("\n").length).toBeLessThanOrEqual(8);
  });

  it("skips invariant-violation auditing when allowDirectInReviewMove is true", async () => {
    const task = await createInProgressTask();

    const moved = await store.moveTask(task.id, "in-review", { allowDirectInReviewMove: true });

    expect(moved.column).toBe("in-review");
    expect(getAuditEventsByInsertion(task.id).filter((event) => event.mutationType === "task:handoff-invariant-violation")).toHaveLength(0);
  });

  it("clears scheduler-state queued/blockedBy/overlapBlockedBy on handoff to in-review", async () => {
    // Regression for FN-5434: a task that picked up status='queued' or
    // overlapBlockedBy while waiting in todo would carry those todo-dispatch
    // markers into in-review, where the merge gate then refuses to merge it
    // with "task is marked 'queued'". Handoff must scrub those fields.
    const task = await createInProgressTask("high");
    await store.updateTask(task.id, {
      status: "queued",
      blockedBy: "FN-OTHER",
      overlapBlockedBy: "FN-OTHER",
    });

    const handedOff = await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      now: "2026-05-19T00:00:00.000Z",
    });

    expect(handedOff.column).toBe("in-review");
    expect(handedOff.status).toBeUndefined();
    expect(handedOff.blockedBy).toBeUndefined();
    expect(handedOff.overlapBlockedBy).toBeUndefined();
  });

  it("preserves failed status and error details during handoff", async () => {
    const task = await createInProgressTask();
    await store.updateTask(task.id, {
      status: "failed",
      error: "step session failed",
    });

    const handedOff = await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "execution-failed" },
      now: "2026-05-19T00:00:00.000Z",
    });

    expect(handedOff.column).toBe("in-review");
    expect(handedOff.status).toBe("failed");
    expect(handedOff.error).toBe("step session failed");
    expect(await store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id }),
    ]);
  });
});
