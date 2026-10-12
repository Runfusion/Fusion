import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";

/*
FNXC:OrphanedPendingSteps 2026-10-07 (STAS-299):
FN-8492's sweep rewrote a dead `pending` step result to `failed` and stopped there. On a
plan-in-place board the card then sits in the HOLD lane (`todo`) with a failed gate row, a
still-`pending` step list, and NO card-level failure status. That is the forbidden terminal
state: the merge door is closed by the failed gate row, the graph will not re-dispatch a
failed gate, and every retry surface admits only a card-level failure — so the card has no
recovery owner at all (STAS-281 stalled 2.2 days this way).

The fix owns the lifecycle instead of leaving it orphaned: when the sweep flips the gate row
and the card sits in a trait-resolved HOLD-role lane, it stamps the card `failed` with the
reason, so `fn_task_retry` / `fn task retry` / dashboard Retry all recognize it. It must NOT
move the card — a failed task lives in a lane plus a status, there is no `failed` lane.
*/

function stepResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    phase: "pre-merge",
    source: "optional-group",
    status: "passed",
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    ...overrides,
  } as WorkflowStepResult;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: ["Draft the plan", "Await plan-review verdict"],
    currentStep: 1,
    log: [],
    approvedPlanFingerprint: "7a73aaff",
    workflowStepResults: [stepResult({ status: "pending", startedAt: new Date(Date.now() - 20 * 60_000).toISOString() })],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[]): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const all = [...tasksById.values()];
      return all.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? all.length));
    }),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

function auditSink(store: TaskStore & EventEmitter) {
  return store.recordRunAuditEvent as ReturnType<typeof vi.fn>;
}

import { SelfHealingManager } from "../self-healing.js";
import { executingTaskLock } from "../agents/active-session-registry.js";

describe("STAS-299: self-heal owns the card lifecycle after failing an orphaned gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps the stranded hold-lane card failed so a retry surface can own it, without moving it", async () => {
    const stranded = task("FN-STRANDED");
    const store = storeFor([stranded]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);

    const recovered = await store.getTask("FN-STRANDED");
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("failed");
    // The forbidden state's other two legs must now be gone: a card-level failure status and reason.
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBeTruthy();
    // The card is NOT moved: failure is a status, the board has no `failed` lane.
    expect(recovered?.column).toBe("todo");
    // Steps are untouched: the approved plan and its step list survive for a non-destructive retry.
    expect(recovered?.steps).toEqual(["Draft the plan", "Await plan-review verdict"]);
    expect(recovered?.currentStep).toBe(1);
    expect(recovered?.approvedPlanFingerprint).toBe("7a73aaff");

    expect(auditSink(store)).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:reconcile-orphaned-pending-step-results",
        target: "FN-STRANDED",
        metadata: expect.objectContaining({ taskId: "FN-STRANDED", lifecycleStatus: "failed" }),
      }),
    );
  });

  it("leaves the card status alone when the card already carries one", async () => {
    const alreadyFailed = task("FN-WITH-STATUS", { status: "failed", error: "an earlier real failure" });
    const store = storeFor([alreadyFailed]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcileOrphanedPendingStepResults();

    const recovered = await store.getTask("FN-WITH-STATUS");
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("failed");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe("an earlier real failure");
  });

  it("stays rewrite-only outside the hold-role lane set", async () => {
    /* A review-lane card is already owned by the in-review no-verdict recovery route, and a
       complete-lane card is done; stamping either one failed would be a false failure. */
    const inReview = task("FN-REVIEW", { column: "in-review" });
    const done = task("FN-DONE", { column: "done", status: "done" });
    const store = storeFor([inReview, done]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(2);

    expect((await store.getTask("FN-REVIEW"))?.status).toBeUndefined();
    expect((await store.getTask("FN-DONE"))?.status).toBe("done");
  });

  it("resolves the hold lane by trait role, not by the literal `todo`", async () => {
    const renamedHold = task("FN-RENAMED", { column: "queue" });
    const store = storeFor([renamedHold]);
    Object.assign(store, {
      listWorkflowDefinitions: vi.fn(async () => [
        {
          ir: {
            version: "v2",
            id: "wf-renamed-board",
            name: "renamed board",
            nodes: [],
            edges: [],
            columns: [{ id: "queue", name: "Queue", traits: [{ trait: "hold", config: { release: "capacity" } }] }],
          },
        },
      ]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcileOrphanedPendingStepResults();

    expect((await store.getTask("FN-RENAMED"))?.status).toBe("failed");
    expect((await store.getTask("FN-RENAMED"))?.column).toBe("queue");
  });

  it("never touches a card whose step result is genuinely live", async () => {
    const live = task("FN-LIVE");
    const store = storeFor([live]);
    expect(executingTaskLock.tryClaim("FN-LIVE")).toBe(true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-LIVE"))?.status).toBeUndefined();
    expect((await store.getTask("FN-LIVE"))?.workflowStepResults?.[0]?.status).toBe("pending");
    executingTaskLock._clearForTest();
  });
});
