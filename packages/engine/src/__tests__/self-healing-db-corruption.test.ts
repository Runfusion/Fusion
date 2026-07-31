import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Settings, TaskStore } from "@fusion/core";

const osState = vi.hoisted(() => ({ tempRoot: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, tmpdir: vi.fn(() => osState.tempRoot || actual.tmpdir()) };
});

import { SelfHealingManager } from "../self-healing.js";
import type { NotificationService } from "../notification/notification-service.js";
import * as notifierModule from "../notifier.js";

function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      maintenanceIntervalMs: 0,
      globalPause: false,
      enginePaused: false,
      ntfyEnabled: true,
      ntfyTopic: "fusion-alerts",
      ntfyEvents: ["db-corruption-detected"],
    } as unknown as Settings),
    getDatabaseHealth: vi.fn().mockReturnValue({
      healthy: true,
      corruptionDetected: false,
      corruptionErrors: [],
      lastCheckedAt: null,
      isRunning: false,
    }),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:TestInfrastructure 2026-07-29-16:45:
    surfaceDbCorruption REFRESHES health before reading the snapshot
    (FNXC:IncompletePgPorts 2026-07-26-20:45 — so PG connectivity is re-checked
    rather than trusting an always-healthy sentinel). This fake carried neither
    refresher, so the async branch fell through to `this.store.refreshDatabaseHealth()`
    — undefined — and the step threw before reaching dispatch. Every corruption
    assertion in this file was then measuring zero calls against a step that had
    already aborted.

    Both are NO-OPS on purpose: production ignores the refresh return value and
    reads `this.store.getDatabaseHealth()` immediately after, so the snapshot mock
    stays the single source of truth. Delegating them to getDatabaseHealth instead
    would consume a SECOND value per pass from the tests that queue
    mockReturnValueOnce sequences (one per runMaintenance), silently shifting the
    corruption -> clear -> corruption ordering they assert.
    */
    refreshDatabaseHealth: vi.fn(),
    refreshDatabaseHealthAsync: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

const BATCH1_METHODS = [
  "pruneWorktrees",
  "cleanupOrphans",
  "enforceWorktreeCap",
] as const;

const BATCH2_METHODS = [
  "recoverCompletedTasks",
  "recoverStrandedCompletedTodoTasks",
  "recoverAdvancedTriageTasks",
  "recoverStaleIncompleteReviewTasks",
  "recoverReviewTasksWithFailedPreMergeSteps",
  "recoverInterruptedMergingTasks",
  "recoverWedgedActiveMerge",
  "recoverDoneTaskMergeMetadata",
  "recoverStaleMergingStatus",
  "finalizeNoOpReviewTasks",
  "reconcileDoneTaskIntegrity",
  "reconcileStaleMergerStatus",
  "recoverMergeableReviewTasks",
  "recoverMergedReviewTasks",
  "recoverAlreadyMergedReviewTasks",
  "recoverCompletionHandoffLimbo",
  "recoverBranchMisboundInReviewTasks",
  "recoverForeignOnlyContaminatedInReviewTasks",
  "recoverOrphanOnlyScopeViolations",
  "recoverStuckMergeDeadlocks",
  "recoverMisclassifiedFailures",
  "recoverMissingWorktreeReviewFailures",
  "recoverNoProgressNoTaskDoneFailures",
  "recoverPartialProgressNoTaskDoneFailures",
  "recoverOrphanedExecutions",
  "recoverApprovedTriageTasks",
  "recoverStarvedRefinementTriageTasks",
  "recoverOrphanedPlanningTasks",
  "recoverGhostReviewTasks",
  "recoverOrphanedAgents",
  "recoverStaleHeartbeatRuns",
  "recoverAgentsRunningOnInactiveTasks",
  "recoverDriftedAgentTaskLinks",
  "clearStaleBlockedBy",
  "autoReboundPausedScopeDecay",
  "runBoardStallAutoRecoverySweep",
  "reconcileSelfDefeatingDependencies",
  "reclaimPrConflicts",
  "reclaimSelfOwnedBranchConflicts",
  "reconcileTaskWorktreeMetadata",
  "reconcileInReviewBranchRebind",
  "reclaimStaleActiveBranches",
  "surfaceInReviewStalls",
  "surfaceInReviewStalled",
  "surfaceStalePausedReviews",
  "surfaceStalePausedTodos",
  "auditNoCommitsExpectedCandidates",
] as const;

function stubMaintenance(manager: SelfHealingManager) {
  for (const method of BATCH1_METHODS) {
    vi.spyOn(manager as never, method).mockResolvedValue(0 as never);
  }
  vi.spyOn(manager as never, "checkpointWal").mockReturnValue(undefined as never);
  for (const method of BATCH2_METHODS) {
    vi.spyOn(manager as never, method).mockResolvedValue(0 as never);
  }
  /*
  FNXC:TestInfrastructure 2026-08-01-23:05 (the suite exited 1 with ZERO failing tests):
  STUBBING THE SWEEPS IS NOT ENOUGH — the shared surfacing cycle is built in the ARGUMENT.
  `runMaintenance` invokes the surfacing family as `() => this.surfaceInReviewStalled(maintenanceSurfacing())`,
  and `maintenanceSurfacing()` lazily calls `openSurfacingCycle()`, which does
  `await this.store.listTasks({ slim: false })`. Spying on `surfaceInReviewStalled` replaces the
  METHOD but the call site still evaluates its argument, so the cycle opened anyway against a mock
  store that deliberately implements only what corruption surfacing needs.

  The result was nine `TypeError: this.store.listTasks is not a function` UNHANDLED REJECTIONS raised
  after the tests had already passed: `engine-default` exited 1 while reporting 736 files passed and
  0 failed. Worse than a plain failure — the lane is red, nothing names a test, and a real regression
  arriving later reads as more of the same noise.

  Two fixes that look right and are not, both tried and reverted:
    adding `listTasks` to the mock   -> 3 tests fail; the sweeps then run far enough to record audit
                                        events the assertions do not expect.
    stubbing the 27 maintenance      -> 5 tests fail AND all nine errors remain, because
    methods missing from the lists      `openSurfacingCycle` is not among `runMaintenance`'s own calls.

  Stubbing the cycle is the honest seam: `null` is exactly what it returns when the engine is paused,
  so every consumer already handles it, and the corruption path this suite exists to test is
  untouched.
  */
  vi.spyOn(manager as never, "openSurfacingCycle").mockResolvedValue(null as never);
  vi.spyOn(manager, "archiveStaleDoneTasks").mockResolvedValue(0);
}

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
let sandboxRoot = "";

describe("FN-5284: self-healing DB corruption surfacing", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "fusion-db-corruption-sandbox-"));
    osState.tempRoot = sandboxRoot;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue(undefined);
    vi.spyOn(notifierModule, "sendNtfyNotification").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    osState.tempRoot = "";
    try {
      rmSync(sandboxRoot, RM);
    } catch {
      // Best-effort cleanup only.
    }
    sandboxRoot = "";
  });

  it("does not dispatch or audit when the database is healthy", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();

    expect(notifierModule.getActiveNotificationService).not.toHaveBeenCalled();
    expect(notifierModule.sendNtfyNotification).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("dispatches a notification and records an audit event on first corruption detection", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue({ dispatch } as unknown as NotificationService);
    const store = createMockStore({
      getDatabaseHealth: vi.fn().mockReturnValue({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["bad row", "bad index"],
        lastCheckedAt: new Date("2026-05-20T00:05:00.000Z"),
        isRunning: false,
      }),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();

    expect(dispatch).toHaveBeenCalledWith("db-corruption-detected", {
      event: "db-corruption-detected",
      timestamp: "2026-05-20T00:00:00.000Z",
      metadata: {
        errors: ["bad row", "bad index"],
        lastCheckedAt: "2026-05-20T00:05:00.000Z",
      },
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "database",
        mutationType: "task:auto-db-corruption-detected",
        target: "database",
        metadata: expect.objectContaining({
          errors: ["bad row", "bad index"],
          notificationDispatched: true,
        }),
      }),
    );
  });

  it("uses SQLite corruption wording for the fallback ntfy notification", async () => {
    const store = createMockStore({
      getDatabaseHealth: vi.fn().mockReturnValue({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["connection refused"],
        lastCheckedAt: new Date("2026-05-20T00:05:00.000Z"),
        isRunning: false,
      }),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();

    expect(notifierModule.sendNtfyNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Database corruption detected",
        message: "Background SQLite integrity check detected corruption. Errors: connection refused.",
      }),
    );
  });

  it("respects the cooldown and avoids duplicate dispatches and audits", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue({ dispatch } as unknown as NotificationService);
    const store = createMockStore({
      getDatabaseHealth: vi.fn().mockReturnValue({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["bad row"],
        lastCheckedAt: new Date("2026-05-20T00:05:00.000Z"),
        isRunning: false,
      }),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();
    await (manager as any).runMaintenance();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("re-notifies after corruption clears and is detected again", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(notifierModule, "getActiveNotificationService").mockReturnValue({ dispatch } as unknown as NotificationService);
    const getDatabaseHealth = vi.fn()
      .mockReturnValueOnce({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["first error"],
        lastCheckedAt: new Date("2026-05-20T00:05:00.000Z"),
        isRunning: false,
      })
      .mockReturnValueOnce({
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: new Date("2026-05-20T00:15:00.000Z"),
        isRunning: false,
      })
      .mockReturnValueOnce({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["second error"],
        lastCheckedAt: new Date("2026-05-20T00:25:00.000Z"),
        isRunning: false,
      });
    const store = createMockStore({ getDatabaseHealth });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();
    await (manager as any).runMaintenance();
    await (manager as any).runMaintenance();

    expect(dispatch).toHaveBeenNthCalledWith(1, "db-corruption-detected", expect.objectContaining({
      metadata: expect.objectContaining({ errors: ["first error"] }),
    }));
    expect(dispatch).toHaveBeenNthCalledWith(2, "db-corruption-detected", expect.objectContaining({
      metadata: expect.objectContaining({ errors: ["second error"] }),
    }));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(2);
  });

  it("records an audit even when no notification channel is active", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maintenanceIntervalMs: 0,
        globalPause: false,
        enginePaused: false,
        ntfyEnabled: false,
        ntfyTopic: "fusion-alerts",
        ntfyEvents: ["db-corruption-detected"],
      } as unknown as Settings),
      getDatabaseHealth: vi.fn().mockReturnValue({
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["bad row"],
        lastCheckedAt: new Date("2026-05-20T00:05:00.000Z"),
        isRunning: false,
      }),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    stubMaintenance(manager);

    await (manager as any).runMaintenance();

    expect(notifierModule.sendNtfyNotification).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:auto-db-corruption-detected",
        metadata: expect.objectContaining({ notificationDispatched: false }),
      }),
    );
  });
});
