import { beforeEach, describe, expect, it, vi } from "vitest";
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

/*
FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident):
An engine restart killed an in-flight pre-merge Code Review session, leaving its
`pending` workflowStepResult with no live session behind it. The merge gate read that as
"incomplete pre-merge workflow steps" and after 3 identical 30-minute stalls the deadlock
disposer parked the task `failed`. These tests pin the startup sweep that clears such
orphans — and the liveness veto that keeps it from eating a genuinely live session.
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
    listTasks: vi.fn(async () => [...tasksById.values()]),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...tasksById.get(id)!, ...patch } as Task;
      tasksById.set(id, next);
      return next;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-8492: reconcile orphaned pending step results at startup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears a dead-session pending result, keeps completed ones, and audits ids/counts only", async () => {
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
    expect(recovered?.workflowStepResults).toHaveLength(1);
    expect(recovered?.workflowStepResults?.[0]?.status).toBe("passed");
    expect(recordRunAuditEventMock).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-orphaned-pending-step-results",
      target: "FN-1",
      metadata: expect.objectContaining({ taskId: "FN-1", clearedCount: 1, remainingCount: 1 }),
    }));
  });

  it("never clears a pending result while the task session is live (executor resumed it)", async () => {
    const live = task("FN-LIVE", {
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    const store = storeFor([live]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      isTaskActive: (id: string) => id === "FN-LIVE",
    });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-LIVE"))?.workflowStepResults).toHaveLength(1);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("leaves user-paused tasks and tasks with no pending results untouched", async () => {
    const userPaused = task("FN-PAUSED", {
      userPaused: true,
      paused: true,
      workflowStepResults: [stepResult({ status: "pending" })],
    });
    const complete = task("FN-DONE-STEPS", {
      workflowStepResults: [stepResult({ status: "passed" }), stepResult({ status: "failed" })],
    });
    const noResults = task("FN-NONE");
    const store = storeFor([userPaused, complete, noResults]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(0);
    expect((await store.getTask("FN-PAUSED"))?.workflowStepResults).toHaveLength(1);
    expect((await store.getTask("FN-DONE-STEPS"))?.workflowStepResults).toHaveLength(2);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });
});
