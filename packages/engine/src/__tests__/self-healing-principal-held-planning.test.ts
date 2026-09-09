import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { recordRunAuditEventMock, resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

/** The card's lane decides candidacy, so every harness needs a real column with its traits. */
const HOLD_IR = {
  version: "v2", name: "principal-held-test",
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-review", name: "Review", traits: [{ trait: "mergeOrchestration" }] },
  ],
  nodes: [],
};

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";

/*
FNXC:PrincipalHeldPlanning 2026-08-10-08:20:
FN-8923's shape: a `held` PLAN continuation written for a principal-routing refusal, with no live session and
no other active continuation. Nothing in the engine re-drove that row — triage re-admits a hold-column card
only on `status === "needs-replan"`, and the card's own replan flag had been cleared by an unrelated writer.
The card then produced no run-audit rows at all for 7+ hours: unowned by both lanes, not looping.

Invariant: a lone principal-routing planning hold past the grace window is always re-queued for planning.
*/

const HOLD_REASON = "workflow-principal-role-pool-exhausted:triage";
const stale = (ms: number) => new Date(Date.now() - ms).toISOString();

function heldPlanItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-plan", runId: "triage-FN-8923-1", taskId: "FN-8923", nodeId: "plan", kind: "task",
    state: "held", blockedReason: HOLD_REASON, workflowRole: "triage",
    createdAt: stale(600_000), updatedAt: stale(600_000), ...overrides,
  } as WorkflowWorkItem;
}

function harness(
  taskOverrides: Partial<Task> = {},
  items: WorkflowWorkItem[] = [heldPlanItem()],
  settings: Partial<Settings> = {},
  managerOptions: Partial<SelfHealingOptions> = {},
) {
  const task = {
    id: "FN-8923", title: "Investigate merge body cancellation fences", description: "",
    column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: stale(900_000), updatedAt: stale(900_000), columnMovedAt: stale(900_000),
    workflowStepResults: [], ...taskOverrides,
  } as unknown as Task;
  const logged: string[] = [];
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async (id: string) => id === task.id ? task : undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    getRootDir: vi.fn(() => "principal-held-project"),
    getTasksDir: vi.fn(() => ""),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
  } as unknown as TaskStore;
  resolveWorkflowIrForTaskMock.mockResolvedValue(HOLD_IR);
  return {
    task,
    store,
    logged,
    manager: new SelfHealingManager(store, { rootDir: "/repo", ...managerOptions }),
  };
}

describe("reconcilePrincipalHeldPlanningContinuations", () => {
  it("defers a principal hold while planning owns the card, then repairs it after release", async () => {
    const planningIds = new Set(["FN-8923"]);
    const { task, store, manager } = harness({}, [heldPlanItem()], {}, {
      getPlanningTaskIds: () => planningIds,
    });

    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(task.status).toBeUndefined();

    planningIds.clear();
    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(1);
    expect(task.status).toBe("needs-replan");
  });

  it("re-queues planning for a card stranded on a principal-routing hold", async () => {
    recordRunAuditEventMock.mockClear();
    const { task, manager, logged } = harness();

    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(1);

    expect(task.status).toBe("needs-replan");
    expect(logged.join(" ")).toContain(HOLD_REASON);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-principal-held-planning",
      metadata: expect.objectContaining({ taskId: "FN-8923", nodeId: "plan", blockedReason: HOLD_REASON }),
    }));
  });

  /*
  FNXC:PrincipalHeldPlanning 2026-08-10-08:35:
  `status` is shared, and `needs-replan` additionally blocks auto-merge — so the sweep may only overwrite a
  status it owns, and only inside the planning lane. Every status another lane can legitimately be holding is
  asserted here, not just the reported one: a repro-only matrix passed while `queued`, `failed`, and
  `stuck-killed` were all being laundered into a replan.
  */
  it("never overwrites a status another lane owns", async () => {
    for (const status of ["queued", "failed", "stuck-killed", "plan-review-unavailable", "planning", "awaiting-approval", "needs-replan"]) {
      const { task, manager } = harness({ status } as Partial<Task>);
      await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
      expect(task.status).toBe(status);
    }
  });

  it("only acts inside the planning lane", async () => {
    // Same stranded continuation, but the card has moved on to a review lane.
    const { task, manager } = harness({ column: "in-review" } as Partial<Task>);
    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    expect(task.status).toBeUndefined();

    // An undeclared column carries no traits at all and must not be treated as a planning lane.
    const undeclared = harness({ column: "somewhere-else" } as Partial<Task>);
    await expect(undeclared.manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
  });

  it("defers to a human-review contract when auto-merge is off for the card", async () => {
    const { task, manager } = harness({ autoMerge: false } as Partial<Task>, [heldPlanItem()], { autoMerge: false });
    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    expect(task.status).toBeUndefined();
  });

  /*
  FNXC:PrincipalHeldPlanning 2026-08-10-08:35:
  Triage claims a card by writing `status: "planning"`. The repair therefore re-reads and writes under the same
  planning lifecycle lock the sibling sweep takes; a bare re-read let a claim land in the gap and get clobbered.
  */
  it("re-reads under the planning lifecycle lock and yields to a claim that lands first", async () => {
    const { task, store, manager } = harness();
    (store.withPlanningLifecycleLock as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, callback: () => Promise<unknown>) => {
        // A triage cycle claims the card after the scan but before the guarded write.
        Object.assign(task, { status: "planning" });
        return callback();
      },
    );

    await expect(manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);

    expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith("FN-8923", expect.any(Function));
    expect(task.status).toBe("planning");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-principal-held-planning-no-action",
      metadata: expect.objectContaining({ reason: "raced" }),
    }));
  });

  it("leaves every non-candidate alone", async () => {
    // Inside the grace window — an active planning cycle resolves its own routing hold.
    await expect(harness({}, [heldPlanItem({ updatedAt: stale(10_000) })]).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    // Operator pauses are never disturbed.
    await expect(harness({ userPaused: true } as Partial<Task>).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    await expect(harness({ paused: true } as Partial<Task>).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    // The signal is already set, or a planner already owns the card.
    await expect(harness({ status: "needs-replan" } as Partial<Task>).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    await expect(harness({ status: "planning" } as Partial<Task>).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    // Global/engine pause defers to the operator.
    await expect(harness({}, [heldPlanItem()], { globalPause: true }).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    await expect(harness({}, [heldPlanItem()], { enginePaused: true }).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    // A hold for a different reason, or a different role, is not this sweep's case.
    await expect(harness({}, [heldPlanItem({ blockedReason: "capacity" })]).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    await expect(harness({}, [heldPlanItem({ workflowRole: "executor" })]).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
    // Another active continuation means the graph still owns the card.
    await expect(harness({}, [
      heldPlanItem(),
      heldPlanItem({ id: "wi-other", nodeId: "step-execute", state: "running", blockedReason: null as unknown as string }),
    ]).manager.reconcilePrincipalHeldPlanningContinuations()).resolves.toBe(0);
  });
});
