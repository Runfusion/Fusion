import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock, git: vi.fn(), filesystem: vi.fn(), sandbox: vi.fn() })),
  };
});

import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";

/*
FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident):
An engine restart killed an in-flight pre-merge Code Review session, leaving its
`pending` workflowStepResult with no live session behind it. The merge gate read that as
"incomplete pre-merge workflow steps" and after 3 identical 30-minute stalls the deadlock
disposer parked the task `failed`. These tests pin the sweep that recovers such orphans —
and the liveness veto that keeps it from eating a genuinely live session.

FNXC:OrphanedPendingSteps 2026-07-22-16:35 (review follow-up):
The sweep REWRITES orphans to status:"failed" — it must never delete them. Deleting a
pending review entry silently satisfied the merge gate (an enabled step with no result
does not block) and FN-8492 merged with Code Review skipped. The rewrite keeps the gate
closed and routes re-run/bypass through the failed-pre-merge-steps paths.
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
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[]): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    // Honors limit/offset so the >500-row pagination path is actually exercised.
    listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const all = [...tasksById.values()];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    }),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-8492: reconcile orphaned pending step results", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    executingTaskLock._clearForTest();
    for (const path of ["/wt/registry-live"]) activeSessionRegistry.unregisterPath(path);
  });

  it("rewrites a dead-session pending result to failed (never deletes) and audits ids/counts only", async () => {
    const stranded = task("FN-1", {
      workflowStepResults: [
        stepResult({ status: "passed", verdict: "APPROVE" }),
        stepResult({ status: "pending", workflowStepId: "code-review", workflowStepName: "Code Review" }),
      ],
    });
    const store = storeFor([stranded]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    const recovered = await store.getTask("FN-1");
    // Rewrite-to-failed: same length, gate stays closed via the failed entry.
    expect(recovered?.workflowStepResults).toHaveLength(2);
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("passed");
    expect(recovered?.workflowStepResults?.[1]?.status).toBe("failed");
    expect(recovered?.workflowStepResults?.[1]?.completedAt).toBeTruthy();
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-orphaned-pending-step-results",
      target: "FN-1",
      metadata: expect.objectContaining({ taskId: "FN-1", orphanedCount: 1, resultCount: 2 }),
    }));
  });

  it("vetoes on every leg of the liveness triple: isTaskActive, registry path, executing lock", async () => {
    const viaCallback = task("FN-CB", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaRegistry = task("FN-REG", { workflowStepResults: [stepResult({ status: "pending" })] });
    const viaLock = task("FN-LOCK", { workflowStepResults: [stepResult({ status: "pending" })] });
    activeSessionRegistry.registerPath("/wt/registry-live", { taskId: "FN-REG", kind: "workflow-step", ownerKey: "test" });
    expect(executingTaskLock.tryClaim("FN-LOCK")).toBe(true);
    const store = storeFor([viaCallback, viaRegistry, viaLock]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      isTaskActive: (id: string) => id === "FN-CB",
    });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    for (const id of ["FN-CB", "FN-REG", "FN-LOCK"]) {
      expect((await store.getTask(id))?.workflowStepResults?.[0]?.status).toBe("pending");
    }
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("skips user-paused and in-progress rows, and tasks with no pending results", async () => {
    const userPaused = task("FN-PAUSED", {
      userPaused: true,
      paused: true,
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    // Executor-owned: resumeOrphaned re-attaches its session on a deferred timer, so
    // startup liveness is unprovable — the sweep must never judge in-progress rows.
    const inProgress = task("FN-INPROG", {
      column: "in-progress",
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    const complete = task("FN-DONE-STEPS", {
      workflowStepResults: [stepResult({ status: "passed" }), stepResult({ status: "failed" })],
    });
    const noResults = task("FN-NONE");
    const store = storeFor([userPaused, inProgress, complete, noResults]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-PAUSED"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-INPROG"))?.workflowStepResults?.[0]?.status).toBe("pending");
    expect((await store.getTask("FN-DONE-STEPS"))?.workflowStepResults).toHaveLength(2);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("paginates past 500 rows and recovers orphans on every page", async () => {
    const many = Array.from({ length: 502 }, (_, i) =>
      task(`FN-P${i}`, { workflowStepResults: [stepResult({ status: "pending" })] }));
    const store = storeFor(many);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(502);
    expect((await store.getTask("FN-P501"))?.workflowStepResults?.[0]?.status).toBe("failed");
    // Two pages of 500 + the short page signalling the end.
    expect((store.listTasks as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates a per-task updateTask failure: the other orphan is still recovered and counted", async () => {
    const failing = task("FN-FAILS", { workflowStepResults: [stepResult({ status: "pending" })] });
    const healthy = task("FN-OK", { workflowStepResults: [stepResult({ status: "pending" })] });
    const store = storeFor([failing, healthy]);
    const passthrough = (store.updateTask as ReturnType<typeof vi.fn>).getMockImplementation()! as
      (id: string, patch: Partial<Task>) => Promise<Task>;
    (store.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, patch: Partial<Task>) => {
      if (id === "FN-FAILS") throw new Error("write refused");
      return passthrough(id, patch);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);
    expect((await store.getTask("FN-OK"))?.workflowStepResults?.[0]?.status).toBe("failed");
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ target: "FN-OK" }));
  });
});
