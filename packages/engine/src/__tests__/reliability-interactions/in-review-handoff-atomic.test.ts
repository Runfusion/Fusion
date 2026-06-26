import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandoffInvariantViolationError, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function taskTempDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-5241-reliability-"));
}

describe("FN-5241 reliability interactions: in-review handoff atomic", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = taskTempDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(() => {
    try {
      vi.restoreAllMocks();
      store.close();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  async function createInProgressTask(overrides: Record<string, unknown> = {}) {
    const task = await store.createTask({ description: "handoff reliability", priority: "high" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    if (Object.keys(overrides).length > 0) {
      await store.updateTask(task.id, overrides as any);
    }
    return (await store.getTask(task.id))!;
  }

  it("rolls back column move and queue insert when enqueueMergeQueue throws, then succeeds on retry", async () => {
    const task = await createInProgressTask();
    vi.spyOn(store as never, "enqueueMergeQueueSyncInternal").mockImplementationOnce((() => {
      throw new Error("boom");
    }) as never);

    await expect(store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    })).rejects.toThrow("boom");

    expect((await store.getTask(task.id))?.column).toBe("in-progress");
    expect(await store.peekMergeQueue()).toHaveLength(0);
    expect(store.getRunAuditEvents({ taskId: task.id, mutationType: "task:handoff", limit: 20 })).toHaveLength(0);

    await store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-2", agentId: "executor-agent" },
    });

    expect((await store.getTask(task.id))?.column).toBe("in-review");
    expect(await store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: task.priority }),
    ]);
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
    await store.updateSettings({ autoMerge: false } as any);
    const task = await createInProgressTask();
    await store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    });

    const manager = new SelfHealingManager(store, { rootDir });
    await manager.recoverCompletionHandoffLimbo();
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    const latest = await store.getTask(task.id);
    expect(latest?.column).toBe("in-review");
    expect(latest?.paused ?? false).toBe(false);
    expect(latest?.status ?? null).toBeNull();
    expect(await store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id }),
    ]);
    expect(store.getRunAuditEvents({ taskId: task.id, limit: 50 }).filter((event) => event.mutationType.startsWith("task:auto-recover"))).toEqual([]);
  });

  it("composes no-progress churn terminalization with atomic handoff + queue insertion", async () => {
    const task = await createInProgressTask({ stuckKillCount: 2, lineageId: "lin-5241" });
    const manager = new SelfHealingManager(store, { rootDir });

    const result = await manager.checkStuckBudget(task.id, "no-progress-churn", { ignoredStepUpdateCount: 25 });

    expect(result).toBe(false);
    const latest = await store.getTask(task.id);
    expect(latest?.column).toBe("in-review");
    expect(latest?.status).toBe("failed");
    expect(latest?.error).toMatch(/^STUCK_NO_PROGRESS_CHURN:/);
    expect(await store.peekMergeQueue()).toEqual([
      expect.objectContaining({ taskId: task.id, priority: task.priority }),
    ]);
    const handoff = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:handoff", limit: 10 })[0];
    expect(handoff?.metadata).toMatchObject({
      taskId: task.id,
      reason: "stuck-no-progress-churn",
      agentId: "self-healing",
      ownerAgentId: null,
      alreadyEnqueued: false,
    });
  });

  it("rejects soft-deleted tasks without creating mergeQueue state", async () => {
    const task = await createInProgressTask();
    store.getDatabase().prepare('UPDATE tasks SET "deletedAt" = ? WHERE id = ?').run(
      "2026-05-19T00:00:00.000Z",
      task.id,
    );

    await expect(store.handoffToReview(task.id, {
      ownerAgentId: "executor-agent",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "executor-agent" },
    })).rejects.toBeInstanceOf(HandoffInvariantViolationError);

    expect(await store.peekMergeQueue()).toHaveLength(0);
    expect(store.getRunAuditEvents({ taskId: task.id, mutationType: "task:handoff", limit: 10 })).toHaveLength(0);
  });
});
