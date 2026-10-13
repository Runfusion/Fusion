import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  classifyStrandedGateRetry,
  resolveColumnFlags,
  type Settings, type Task, type TaskStore, type WorkflowIr, type WorkflowStepResult } from "@fusion/core";

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
    // The gate row a dispatched Plan Review actually carries; the orphan rewrite preserves it, and it
    // is what lets the shared classifier recognise the row as a plan-family gate.
    reviewKind: "plan",
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
    getTaskWorkflowSelection: vi.fn(() => undefined),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
    updateTaskAtomic: vi.fn(async (id: string, mutate: (current: Task) => Partial<Task> | null) => {
      const patch = await mutate(tasksById.get(id)!);
      if (!patch) return tasksById.get(id)!;
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
    logEntry: vi.fn(async (id: string, action: string) => {
      const next = { ...tasksById.get(id)!, log: [...tasksById.get(id)!.log, { action, timestamp: new Date().toISOString() }] } as Task;
      tasksById.set(id, next);
      return next;
    }),
    moveTask: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

function auditSink(store: TaskStore & EventEmitter) {
  return store.recordRunAuditEvent as ReturnType<typeof vi.fn>;
}

function updateSink(store: TaskStore & EventEmitter) {
  return store.updateTask as unknown as ReturnType<typeof vi.fn>;
}

import { SelfHealingManager } from "../self-healing.js";
import { evaluateStrandedHoldContinuation } from "../plan-review-continuation.js";
import { createTaskRetryTool } from "../agent-tools.js";
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

  it("parks once: a second sweep over the already-owned card writes nothing", async () => {
    const store = storeFor([task("FN-PARKED")]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    // The rewrite above removed the pending row, so the card is now owned by the retry contract: a
    // further sweep must neither re-stamp it nor re-audit it.
    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect(updateSink(store)).toHaveBeenCalledOnce();
    expect(auditSink(store)).toHaveBeenCalledOnce();
  });

  it("leaves no card in the forbidden terminal shape the defect produced", async () => {
    /*
    The standing invariant, stated as the classifier the retry surfaces use: after a sweep, a card
    that still reads as a stranded gate must ALSO carry the failure status that makes it retryable.
    Before STAS-299 the sweep created the opposite shape by itself — gate failed, checklist pending,
    no status — and every retry surface then refused the card it had just stranded.
    */
    const store = storeFor([task("FN-STANDING")]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await manager.reconcileOrphanedPendingStepResults();

    const repaired = (await store.getTask("FN-STANDING"))!;
    expect(classifyStrandedGateRetry({ task: repaired, ir: BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr }))
      .toEqual({ kind: "stranded-gate", gateStepIds: ["plan-review"] });
    expect(repaired.status).toBe("failed");
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

  /*
  FNXC:OrphanedPendingSteps 2026-10-13 (STAS-299 requirements 1-3, measured incident):
  STAS-281 as the engine actually held it: a P0 card in the hold lane, plan approved and already
  revised once (`7a73aaff`), 9/9 checklist steps still pending, Plan Review's row orphaned at
  `pending` with no session and no lease, and nothing dispatching it for 12.5 hours before it became
  2.2 days. The individual seams are covered above and beside this file; what was never asserted is
  the CHAIN — that the sweep's own fix hands the card to the retry contract, that the recovery sweep
  which would otherwise re-run the dead gate keeps off it while parked, and that one ordinary
  `fn_task_retry` call ends the park without touching the approved plan.
  */
  it("carries the incident card from the sweep through the park to the hatch and back to a re-armable gate", async () => {
    const stalledFor = 12.5 * 60 * 60_000;
    const stalledAt = new Date(Date.now() - stalledFor).toISOString();
    const incident = task("STAS-281", {
      status: undefined,
      agentId: "agent-9fffa4b1",
      columnMovedAt: stalledAt,
      createdAt: stalledAt,
      updatedAt: stalledAt,
      steps: Array.from({ length: 9 }, (_unused, index) => ({ name: `Step ${index + 1}`, status: "pending" as const })),
      currentStep: 0,
      worktree: "/repo/.fusion/worktrees/stas-281",
      branch: "fusion/stas-281-plan-review",
    });
    const store = storeFor([incident]);

    const holdFlags = resolveColumnFlags((BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr).columns!.find((column) => column.id === "todo")!);
    const continuationState = (card: Task) => evaluateStrandedHoldContinuation({
      task: card,
      columnFlags: holdFlags,
      ir: BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr,
      continuations: [],
      stepResults: card.workflowStepResults,
      effectiveSettings: { autoMerge: true },
      enginePaused: false,
      promptContent: "# Tier B recovery\n\nDischarge the plan-review gate without discarding the approved specification.",
      live: false,
      stalenessMs: 600_000,
      graceMs: 0,
    });

    // 1. Requirement 1's shape: no live session, no lease — the sweep declares the gate dead.
    expect(await new SelfHealingManager(store, { rootDir: "/repo" }).reconcileOrphanedPendingStepResults()).toBe(1);

    const parked = (await store.getTask("STAS-281"))!;
    expect(parked.workflowStepResults?.[0]).toMatchObject({ workflowStepId: "plan-review", status: "failed" });
    // 2. Requirement 2: the forbidden terminal state is gone — failure became a status, not a lane.
    expect(parked.status).toBe("failed");
    expect(parked.error).toContain("FN-8492");
    expect(parked.column).toBe("todo");
    expect(parked.steps).toHaveLength(9);

    // 3. The park is owned: the continuation sweep that would re-arm the dead gate names the hatch.
    expect(continuationState(parked)).toMatchObject({ stranded: false, reason: "retry-owned" });

    // 4. Requirement 3's escape hatch, called the way an in-session agent calls it.
    const retry = await createTaskRetryTool(store, {}).execute("retry", { id: "STAS-281" }, undefined as never, undefined as never, undefined as never);
    expect((retry as { isError?: boolean }).isError).not.toBe(true);

    const retried = (await store.getTask("STAS-281"))!;
    expect(retried.column).toBe("todo");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(retried.workflowStepResults).toEqual([]);
    expect(retried.status).toBeFalsy();
    expect(retried.error).toBeFalsy();
    // Invariant C: the plan an operator already approved, and the work built on it, survive the retry.
    expect(retried.approvedPlanFingerprint).toBe("7a73aaff");
    expect(retried.steps).toHaveLength(9);
    expect(retried.worktree).toBe("/repo/.fusion/worktrees/stas-281");
    expect(retried.branch).toBe("fusion/stas-281-plan-review");

    // 5. The other direction of ownership: with the failure discharged, the gate is re-armable again.
    expect(continuationState(retried)).toMatchObject({ stranded: true, reason: "ready" });
  });
});
