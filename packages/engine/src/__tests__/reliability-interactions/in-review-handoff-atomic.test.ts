import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffInvariantViolationError, drizzleEq, postgresSchema } from "@fusion/core";
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;
const handoffMutationTypes = ["task:move", "mergeQueue:enqueue", "task:handoff"] as const;

describeIfGit("FN-5241 reliability interactions: in-review handoff atomic", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  async function createInProgressTask(store: Awaited<ReturnType<typeof makeReliabilityFixture>>["store"], overrides: Record<string, unknown> = {}) {
    const task = await store.createTask({ description: "handoff reliability", priority: "high" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    if (Object.keys(overrides).length > 0) {
      await store.updateTask(task.id, overrides as any);
    }
    return (await store.getTask(task.id))!;
  }

  async function handoffAudits(store: Awaited<ReturnType<typeof makeReliabilityFixture>>["store"], taskId: string) {
    const events = await store.getRunAuditEventsAsync({ taskId, limit: 50 });
    return events.filter((event) => handoffMutationTypes.includes(event.mutationType as typeof handoffMutationTypes[number]));
  }

  /*
  FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205):
  The review-entry event is written in the same transaction as the handoff's column change, so it
  belongs in this rollback inventory. An event that outlived a rolled-back handoff would make the
  dispatch sweep chase a review that never started, and an event missing after a committed handoff
  would leave the card permanently invisible to that sweep.
  */
  async function reviewEntryEvents(layer: Awaited<ReturnType<typeof makeReliabilityFixture>>["layer"], taskId: string): Promise<number> {
    const rows = await layer.db
      .select({ eventType: postgresSchema.project.taskLifecycleEvents.eventType })
      .from(postgresSchema.project.taskLifecycleEvents)
      .where(drizzleEq(postgresSchema.project.taskLifecycleEvents.taskId, taskId));
    return rows.filter((row) => row.eventType === "task:entered-review").length;
  }

  it("rolls back every column-change handoff write when the PG seam throws, then succeeds on retry", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5241-column-change" });
    fixtures.push(fx);
    const task = await createInProgressTask(fx.store);
    const auditsBefore = await handoffAudits(fx.store, task.id);
    let injectorCallCount = 0;
    fx.store.__setHandoffMergeQueueFailureInjectorForTesting((taskId) => {
      injectorCallCount += 1;
      expect(taskId).toBe(task.id);
      throw new Error("boom");
    });

    await expect(fx.store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    })).rejects.toThrow("boom");

    expect(injectorCallCount).toBe(1);
    expect((await fx.store.getTask(task.id))?.column).toBe("in-progress");
    expect(await fx.store.peekMergeQueue()).toHaveLength(0);
    expect(await fx.store.listWorkflowWorkItemsForTask(task.id)).toEqual([]);
    expect(await handoffAudits(fx.store, task.id)).toEqual(auditsBefore);
    expect(await reviewEntryEvents(fx.layer, task.id), "a rolled-back handoff must not leave a review-entry event behind").toBe(0);

    fx.store.__setHandoffMergeQueueFailureInjectorForTesting(null);
    await fx.store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-2", agentId: "executor-agent" },
    });

    expect((await fx.store.getTask(task.id))?.column).toBe("in-review");
    expect(await fx.store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: task.priority }),
    ]);
    expect(await fx.store.listWorkflowWorkItemsForTask(task.id)).toHaveLength(1);
    expect(await reviewEntryEvents(fx.layer, task.id), "the retried handoff must record exactly one review entry").toBe(1);
  });

  it("rolls back every same-column retry write when the PG seam throws, then retries idempotently", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5241-same-column" });
    fixtures.push(fx);
    const task = await createInProgressTask(fx.store);
    const handoff = {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    };
    await fx.store.handoffToReview(task.id, handoff);

    const queueBefore = await fx.store.peekMergeQueue();
    const workBefore = await fx.store.listWorkflowWorkItemsForTask(task.id);
    const auditsBefore = await handoffAudits(fx.store, task.id);
    const entryEventsBefore = await reviewEntryEvents(fx.layer, task.id);
    expect(entryEventsBefore, "the first handoff is a real lane entry").toBe(1);
    let injectorCallCount = 0;
    fx.store.__setHandoffMergeQueueFailureInjectorForTesting((taskId) => {
      injectorCallCount += 1;
      expect(taskId).toBe(task.id);
      throw new Error("boom");
    });

    await expect(fx.store.handoffToReview(task.id, {
      ...handoff,
      evidence: { reason: "fn_task_done", runId: "run-2", agentId: "executor-agent" },
    })).rejects.toThrow("boom");

    expect(injectorCallCount).toBe(1);
    expect((await fx.store.getTask(task.id))?.column).toBe("in-review");
    expect(await fx.store.peekMergeQueue()).toEqual(queueBefore);
    expect(await fx.store.listWorkflowWorkItemsForTask(task.id)).toEqual(workBefore);
    expect(await handoffAudits(fx.store, task.id)).toEqual(auditsBefore);
    expect(await reviewEntryEvents(fx.layer, task.id)).toBe(entryEventsBefore);

    fx.store.__setHandoffMergeQueueFailureInjectorForTesting(null);
    await fx.store.handoffToReview(task.id, {
      ...handoff,
      evidence: { reason: "fn_task_done", runId: "run-3", agentId: "executor-agent" },
    });

    expect((await fx.store.getTask(task.id))?.column).toBe("in-review");
    expect(await fx.store.peekMergeQueue()).toEqual(queueBefore);
    const workAfterRetry = await fx.store.listWorkflowWorkItemsForTask(task.id);
    expect(workAfterRetry.filter((item) => item.state === "runnable")).toHaveLength(1);
    expect(await reviewEntryEvents(fx.layer, task.id), "a same-column retry is not a new review entry").toBe(entryEventsBefore);
  });

  it("contains no direct moveTask(..., \"in-review\") writes outside allowlisted same-line comments", () => {
    const regex = /moveTask\([^\n]+,\s*"in-review"\)/g;
    for (const path of [
      new URL("../../executor.ts", import.meta.url),
      new URL("../../self-healing.ts", import.meta.url),
    ]) {
      const source = readFileSync(path, "utf8");
      const offenders = source
        .split("\n")
        .filter((line) => regex.test(line) && !/\/\/ handoff-invariant-violation-allowlist: .+/.test(line));
      expect(offenders).toEqual([]);
      regex.lastIndex = 0;
    }
  });

  it("keeps autoMerge-false handoffs parked in in-review with queue state intact across self-healing sweeps", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5241-auto-merge", settings: { autoMerge: false } });
    fixtures.push(fx);
    const task = await createInProgressTask(fx.store);
    await fx.store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    });

    await fx.manager.recoverCompletionHandoffLimbo();
    expect(await fx.manager.surfaceInReviewStalls()).toBe(0);
    expect(await fx.manager.surfaceInReviewStalled()).toBe(0);

    const latest = await fx.store.getTask(task.id);
    expect(latest?.column).toBe("in-review");
    expect(latest?.paused ?? false).toBe(false);
    expect(latest?.status ?? null).toBeNull();
    expect(await fx.store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id }),
    ]);
    expect((await fx.store.getRunAuditEventsAsync({ taskId: task.id, limit: 50 }))
      .filter((event) => event.mutationType.startsWith("task:auto-recover"))).toEqual([]);
  });

  it("rejects soft-deleted tasks without creating mergeQueue state", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-5241-deleted" });
    fixtures.push(fx);
    const task = await createInProgressTask(fx.store);
    await fx.store.deleteTask(task.id);

    await expect(fx.store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    })).rejects.toBeInstanceOf(HandoffInvariantViolationError);

    expect(await fx.store.peekMergeQueue()).toHaveLength(0);
    expect(await fx.store.getRunAuditEventsAsync({ taskId: task.id, mutationType: "task:handoff", limit: 10 })).toHaveLength(0);
  });
});
