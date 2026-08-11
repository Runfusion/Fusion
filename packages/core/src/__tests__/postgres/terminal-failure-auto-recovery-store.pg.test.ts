/*
FNXC:TaskWedgeNotifications 2026-08-10-20:40:
The terminal-failure apply must use the real PostgreSQL move transaction. A mock can prove the
fence branch was selected while still missing the transaction boundary that keeps the failure clear,
column move, and fence consumption atomic.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("terminal failure auto-recovery apply", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_terminal_failure_apply" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  it("consumes the matching fence in the same persisted move as the failure clear", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "fenced terminal failure" } as never);
    const token = "terminal-apply-token";
    await store.updateTask(task.id, {
      status: "failed",
      error: "opaque terminal failure",
      wedgeNotification: {
        reasonKey: "terminal-failed",
        episodeId: "episode",
        status: "resolved",
        transitionedAt: new Date().toISOString(),
        budgetRevision: 1,
        autoRecovery: {
          attempts: 1,
          lastAttemptAt: new Date().toISOString(),
          lastApplyStartedAt: new Date().toISOString(),
          applyToken: token,
          lastBudgetWriteAt: new Date().toISOString(),
        },
      },
    } as never);

    const result = await store.applyTerminalFailureAutoRecoveryRetry(task.id, {
      applyToken: token,
      patch: { status: null, error: null, recoveryRetryCount: 1, nextRecoveryAt: new Date(Date.now() + 60_000).toISOString() },
      targetColumn: "todo",
      moveOptions: { preserveProgress: true, moveSource: "engine" },
    });

    expect(result.outcome).toBe("applied");
    const applied = await store.getTask(task.id);
    expect(applied.column).toBe("todo");
    expect(applied.status).toBeUndefined();
    expect(applied.error).toBeUndefined();
    expect(applied.wedgeNotification?.autoRecovery?.retryAppliedAt).toBeTruthy();
    expect(applied.wedgeNotification?.autoRecovery?.applyToken).toBeUndefined();
    expect(applied.wedgeNotification?.autoRecovery?.lastApplyStartedAt).toBeUndefined();

    const stale = await store.applyTerminalFailureAutoRecoveryRetry(task.id, {
      applyToken: token,
      patch: { status: null, error: null },
      targetColumn: "todo",
      moveOptions: { preserveProgress: true, moveSource: "engine" },
    });
    expect(stale.outcome).toBe("not-failed");
  });

  it("does not spend a recovery attempt when the row moved on before the atomic claim", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "already recovered" } as never);

    const claim = await store.claimTerminalFailureAutoRecoveryAttempt(task.id, {
      maxAttempts: 3,
      maxResumes: 1,
      minAttemptSpacingMs: 0,
      claimApplyGraceMs: 60_000,
    });

    expect(claim).toEqual({ outcome: "already-claimed", attempt: 0 });
    expect((await store.getTask(task.id))?.wedgeNotification?.autoRecovery).toBeUndefined();
  });

  it("clears the budget only after a backend delete wins its soft-delete claim", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "delete terminal failure budget" } as never);
    await store.updateTask(task.id, {
      wedgeNotification: {
        reasonKey: "terminal-failed",
        episodeId: "delete-episode",
        status: "active",
        transitionedAt: "2026-08-10T00:00:00.000Z",
        lastNotifiedAtByReason: { "terminal-failed": "2026-08-10T00:00:00.000Z", other: "2026-08-10T00:00:00.000Z" },
        budgetRevision: 4,
        autoRecovery: { attempts: 3, lastAttemptAt: "2026-08-10T00:00:00.000Z", escalationNotifiedAt: "2026-08-10T00:00:00.000Z" },
      },
    } as never);

    const declined = await store.deleteTaskIf(task.id, async () => false);
    expect(declined.deleted).toBe(false);
    expect((await store.getTask(task.id))?.wedgeNotification?.autoRecovery?.attempts).toBe(3);

    await store.deleteTaskIf(task.id, async () => true);
    const deleted = await store.getTask(task.id, { includeDeleted: true });
    expect(deleted?.wedgeNotification?.autoRecovery).toBeUndefined();
    expect(deleted?.wedgeNotification?.budgetRevision).toBe(5);
    expect(deleted?.wedgeNotification?.lastNotifiedAtByReason).toEqual({ other: "2026-08-10T00:00:00.000Z" });
    expect(deleted?.wedgeNotification?.status).toBe("resolved");
  });
});
