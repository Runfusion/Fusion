import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { NotificationService } from "../notification/notification-service.js";
import { SelfHealingManager } from "../self-healing.js";
import { NtfyNotifier } from "../util/notifier.js";

function reviewFailure(): Task {
  return {
    id: "FN-8908-review",
    column: "in-review",
    status: "failed",
    error: "opaque terminal failure",
    updatedAt: "2026-08-01T00:00:00.000Z",
    columnMovedAt: "2026-08-01T00:00:00.000Z",
    wedgeNotification: undefined,
  } as Task;
}

describe("SelfHealingManager terminal-failure auto recovery", () => {
  it("escalates a terminal failure discovered by the claim CAS", async () => {
    const task = {
      ...reviewFailure(),
      id: "FN-8908-cas-exhausted",
      column: "todo",
      wedgeNotification: {
        budgetRevision: 2,
        autoRecovery: {
          attempts: 2,
          lastAttemptAt: "2026-08-01T00:00:00.000Z",
          retryAppliedAt: "2026-08-01T00:00:01.000Z",
        },
      },
    } as Task;
    const store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        autoRecovery: { mode: "on" },
        maintenanceIntervalMs: 60_000,
      }),
      listTasks: vi.fn().mockResolvedValue([task]),
      getTask: vi.fn().mockResolvedValue(task),
      listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
      claimTerminalFailureAutoRecoveryAttempt: vi.fn().mockResolvedValue({ outcome: "exhausted", attempts: 3 }),
      applyTerminalFailureAutoRecoveryRetry: vi.fn(),
      markTerminalFailureAutoRecoveryBudgetExhausted: vi.fn().mockResolvedValue("stamped"),
      markTerminalFailureAutoRecoveryEscalationDelivered: vi.fn().mockResolvedValue("stamped"),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    const notifyTaskWedge = vi.fn().mockResolvedValue("delivered");
    // FNXC:TaskWedgeNotifications 2026-08-10-20:01: NtfyNotifier is the production owner of
    // the active-service registration that the sweep reads, so this verifies the real bridge.
    new NtfyNotifier(store as never, {}, { notifyTaskWedge } as never);

    await expect(new SelfHealingManager(store, { rootDir: process.cwd() }).autoRecoverTerminalFailures()).resolves.toBe(0);

    expect(store.claimTerminalFailureAutoRecoveryAttempt).toHaveBeenCalledOnce();
    expect(store.applyTerminalFailureAutoRecoveryRetry).not.toHaveBeenCalled();
    expect(store.markTerminalFailureAutoRecoveryBudgetExhausted).toHaveBeenCalledWith(task.id, {
      maxAttempts: 3,
    });
    expect(notifyTaskWedge).toHaveBeenCalledWith(task, expect.objectContaining({ reasonKey: "terminal-failed" }), {
      source: "auto-recovery-escalation",
    });
    expect(store.markTerminalFailureAutoRecoveryEscalationDelivered).toHaveBeenCalledWith(task.id, {
      dispatchOutcome: "delivered",
      escalationReason: "budget-exhausted",
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-terminal-failure-exhausted",
      target: task.id,
      metadata: expect.objectContaining({
        taskId: task.id,
        escalationReason: "budget-exhausted",
        markedExhausted: true,
        outcome: "notified",
      }),
    }));
    expect(JSON.stringify((store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("opaque terminal failure");
  });

  it("requires backward-move triple proof before retrying an in-review terminal failure", async () => {
    const task = reviewFailure();
    const store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        autoRecovery: { mode: "on" },
        maintenanceIntervalMs: 60_000,
        taskStuckTimeoutMs: 60_000,
      }),
      listTasks: vi.fn().mockResolvedValue([task]),
      getTask: vi.fn().mockResolvedValue(task),
      listWorkflowDefinitions: vi.fn().mockResolvedValue([]),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      claimTerminalFailureAutoRecoveryAttempt: vi.fn(),
      applyTerminalFailureAutoRecoveryRetry: vi.fn(),
      logEntry: vi.fn(),
    } as unknown as TaskStore;
    const manager = new SelfHealingManager(store, { rootDir: process.cwd() });
    const proof = vi.spyOn(manager as never, "evaluateBackwardMoveTripleProof" as never)
      .mockResolvedValue({
        ok: false,
        stalenessMs: 0,
        reason: "test-live-review-owner",
        metadata: {},
      } as never);

    await expect(manager.autoRecoverTerminalFailures()).resolves.toBe(0);

    expect(proof).toHaveBeenCalledWith(task, expect.objectContaining({
      stage: "auto-recover-terminal-failure",
      reason: "auto-recover-terminal-failure-review-candidate",
    }));
    expect(store.claimTerminalFailureAutoRecoveryAttempt).not.toHaveBeenCalled();
    expect(store.applyTerminalFailureAutoRecoveryRetry).not.toHaveBeenCalled();
  });
});

/*
FNXC:TaskWedgeNotifications 2026-08-10-20:30:
This exercises the production TaskStore, NotificationService, and SelfHealingManager together.
Mock-only branch tests cannot prove that durable claim, fenced apply, re-failure, and the
service-first exhaustion dispatch share one persisted budget.
*/
pgDescribe("terminal-failure auto recovery production lifecycle", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_terminal_failure_lifecycle" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  it("withholds a generic failure, retries it durably, then escalates once", async () => {
    const store = harness.store();
    await store.updateSettings({ autoRecovery: { mode: "on" }, maintenanceIntervalMs: 60_000 } as never);
    const sendMessageOnce = vi.fn().mockResolvedValue({ message: {}, inserted: true });
    const service = new NotificationService(store, { messageStore: { on: () => undefined, sendMessageOnce } as never });
    const notifier = new NtfyNotifier(store, {}, service);
    await notifier.start();
    const notify = vi.spyOn(service, "notifyTaskWedge");
    const manager = new SelfHealingManager(store, { rootDir: process.cwd() });
    const task = await store.createTask({ description: "production generic terminal failure" } as never);

    await store.updateTask(task.id, { status: "failed", error: "opaque terminal failure" } as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendMessageOnce).not.toHaveBeenCalled();

    await manager.autoRecoverTerminalFailures();
    let current = await store.getTask(task.id);
    expect(current.status).toBeUndefined();
    expect(current.error).toBeUndefined();
    expect(current.wedgeNotification?.autoRecovery?.attempts).toBe(1);
    expect(current.wedgeNotification?.autoRecovery?.retryAppliedAt).toBeTruthy();
    expect(current.wedgeNotification?.autoRecovery?.applyToken).toBeUndefined();
    expect(current.nextRecoveryAt && Date.parse(current.nextRecoveryAt)).toBeGreaterThan(Date.now());
    expect(notify).not.toHaveBeenCalled();

    // Retain a past display mirror across re-failure; only the durable budget owns attempts.
    for (const expectedAttempts of [2, 3]) {
      await store.updateTask(task.id, {
        status: "failed",
        error: "opaque terminal failure",
        nextRecoveryAt: new Date(Date.now() - 1).toISOString(),
        wedgeNotification: {
          ...current.wedgeNotification!,
          autoRecovery: {
            ...current.wedgeNotification!.autoRecovery!,
            lastAttemptAt: new Date(Date.now() - 3_600_000).toISOString(),
            retryAppliedAt: new Date(Date.now() - 3_599_000).toISOString(),
          },
        },
      } as never);
      await manager.autoRecoverTerminalFailures();
      current = await store.getTask(task.id);
      expect(current.wedgeNotification?.autoRecovery?.attempts).toBe(expectedAttempts);
      expect(current.status).toBeUndefined();
    }

    await store.updateTask(task.id, { status: "failed", error: "opaque terminal failure" } as never);
    await new Promise((resolve) => setImmediate(resolve));
    await manager.autoRecoverTerminalFailures();
    current = await store.getTask(task.id);
    expect(current.wedgeNotification?.autoRecovery?.exhaustedAt).toBeTruthy();
    expect(current.wedgeNotification?.autoRecovery?.escalationNotifiedAt).toBeTruthy();
    expect(current.wedgeNotification?.autoRecovery?.escalationReason).toBe("budget-exhausted");
    // The task-update listener is the service-first ordering: it dispatches through the shared
    // private seam before the sweep sees the at-budget row, then the durable stamp suppresses it.
    expect(notify).not.toHaveBeenCalled();
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);

    await manager.autoRecoverTerminalFailures();
    expect(notify).not.toHaveBeenCalled();
    notifier.stop();
    manager.stop();
  });
});
