/**
 * FNXC:FasterStartup 2026-07-14-23:55:
 * ProjectEngine.start returns before notifiers/OAuth/merge sweep finish, but
 * OAuth refresh must still start before the expiry monitor when deferred work runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const oauthRefreshStart = vi.fn(async () => undefined);
const oauthExpiryStart = vi.fn(async () => undefined);
const notificationStart = vi.fn(async () => undefined);
const notifierStart = vi.fn(async () => undefined);
const oauthValidityStart = vi.fn(async () => undefined);

vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () {
    return { start: notificationStart, stop: vi.fn() };
  }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () {
    return {};
  }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () {
    return { start: oauthExpiryStart, stop: vi.fn() };
  }),
  OAuthRefreshScheduler: vi.fn().mockImplementation(function () {
    return { start: oauthRefreshStart, stop: vi.fn() };
  }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () {
    return { start: oauthValidityStart, stop: vi.fn() };
  }),
}));

vi.mock("../notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(function () {
    return { start: notifierStart, stop: vi.fn(), notifyGridlock: vi.fn() };
  }),
}));

vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({})),
  getFusionOAuthAlertStatePath: () => "/tmp/fusion-oauth-alert-state-test",
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: vi.fn(() => ({
        getSettings: vi.fn(async () => ({})),
        getAsyncLayer: vi.fn(() => ({})),
        listTasks: vi.fn(async () => []),
        updateTask: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
      })),
      getMessageStore: vi.fn(() => undefined),
      getAgentStore: vi.fn(() => undefined),
      getPluginRunner: vi.fn(() => undefined),
      configurePrMonitoring: vi.fn(),
      getExecutor: vi.fn(() => undefined),
    };
  }),
}));

vi.mock("../gridlock-detector.js", () => ({
  GridlockDetector: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn() };
  }),
}));

vi.mock("../cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn() };
  }),
  createAiPromptExecutor: vi.fn(async () => undefined),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return { init: vi.fn(async () => undefined) };
    }),
  };
});

vi.mock("../pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(function () {
    return { onNewComments: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }),
}));

vi.mock("../pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(function () {
    return { handleNewComments: vi.fn(), createFollowUpTask: vi.fn() };
  }),
}));

vi.mock("../pr-reconcile.js", () => ({
  PrReconciler: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn() };
  }),
}));

vi.mock("../planner-overseer.js", () => ({
  PlannerOverseerMonitor: vi.fn().mockImplementation(function () {
    return {};
  }),
  resolveExecutorStuckAfterMs: vi.fn(() => 60_000),
}));

vi.mock("../planner-recovery-controller.js", () => ({
  PlannerRecoveryController: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../postgres-migration-notice.js", () => ({
  deliverPostgresMigrationNoticeIfNeeded: vi.fn(async () => undefined),
  deliverPostgresMigrationCompleteNoticeIfNeeded: vi.fn(async () => undefined),
}));

vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => 0),
  VerificationError: class VerificationError extends Error {},
}));

import { ProjectEngine } from "../project-engine.js";

describe("ProjectEngine deferred startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns from start before OAuth refresh completes, then runs refresh before expiry monitor", async () => {
    let resolveRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    oauthRefreshStart.mockImplementation(async () => {
      await refreshGate;
    });

    const engine = new ProjectEngine(
      {
        projectId: "proj_deferred",
        workingDirectory: "/tmp/proj_deferred",
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      },
      { on: vi.fn(), off: vi.fn() } as any,
      { skipNotifier: false, projectId: "proj_deferred" },
    );

    const startPromise = engine.start();
    await expect(startPromise).resolves.toBeUndefined();

    // Deferred work is scheduled after start resolves; wait for refresh to be entered.
    await vi.waitFor(() => {
      expect(oauthRefreshStart).toHaveBeenCalled();
    });

    // Expiry monitor must not start until refresh finishes
    expect(oauthExpiryStart).not.toHaveBeenCalled();

    resolveRefresh();
    await vi.waitFor(() => {
      expect(oauthExpiryStart).toHaveBeenCalledTimes(1);
    });

    expect(notificationStart).toHaveBeenCalled();
    expect(oauthRefreshStart.mock.invocationCallOrder[0]).toBeLessThan(
      oauthExpiryStart.mock.invocationCallOrder[0]!,
    );
  });
});
