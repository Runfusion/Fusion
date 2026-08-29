import { beforeEach, describe, expect, it, vi } from "vitest";

import { MergeGateRevokedError } from "../merge/merger-errors.js";

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  currentStore: null as Record<string, unknown> | null,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});
vi.mock("../merger.js", () => ({ aiMergeTask: vi.fn(), sweepStaleAutostashes: vi.fn(async () => undefined) }));
vi.mock("../merge/pr-monitor.js", () => ({ PrMonitor: vi.fn().mockImplementation(function () { return { onNewComments: vi.fn() }; }) }));
vi.mock("../merge/pr-comment-handler.js", () => ({ PrCommentHandler: vi.fn().mockImplementation(function () { return { handleNewComments: vi.fn() }; }) }));
vi.mock("../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({ reload: vi.fn(), getOAuthProviders: vi.fn(() => []), get: vi.fn(() => undefined) })),
  getFusionOAuthAlertStatePath: vi.fn(() => "/tmp/oauth-alert-state.json"),
}));
vi.mock("../util/notifier.js", () => ({ NtfyNotifier: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }) }));
vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () { return {}; }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
}));
vi.mock("../scheduling/cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () { return { start: vi.fn(), stop: vi.fn() }; }),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
}));
vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
      resumeAfterUnpause: vi.fn(async () => undefined),
      getTaskStore: () => mocks.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
    };
  }),
}));

const { ProjectEngine } = await import("../project-engine.js");
const { getTaskMergeBlocker } = await import("@fusion/core");

const ACTIVE_TASK_ID = "FN-MERGING-1";

function createMockStore() {
  return {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async (taskId: string) => ({ id: taskId, column: "in-review", paused: false, status: null })),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    emit: vi.fn(),
    getActiveMergingTask: vi.fn(() => null),
    on: vi.fn(),
    off: vi.fn(),
  };
}

/** A card sitting in the review lane with an open gate: nothing here is a blocker on its own. */
function reviewLaneTask(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVE_TASK_ID,
    column: "in-review",
    paused: false,
    status: null,
    mergeRetries: 0,
    steps: [],
    enabledWorkflowSteps: [],
    workflowStepResults: [],
    ...overrides,
  } as never;
}

async function startEngineOwningAMerge() {
  mocks.currentStore = createMockStore();
  const engine = new ProjectEngine(
    {
      projectId: "proj_fn184",
      workingDirectory: "/tmp/proj_fn184",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    } as never,
    {} as never,
    /*
    FNXC:MergeInFlightRevoke 2026-08-24-04:35:
    FN-184 wires the RAW core `getTaskMergeBlocker`, exactly as daemon.ts / dashboard.ts / serve.ts
    do. Substituting a hand-written blocker here would test the stub instead of the production
    predicate whose status branch caused the self-abort loop.
    */
    { skipNotifier: true, getTaskMergeBlocker } as never,
  );
  await engine.start();
  const privateEngine = engine as never as Record<string, any>;
  privateEngine.activeMergeTaskId = ACTIVE_TASK_ID;
  privateEngine.mergeAbortController = { abort: vi.fn() };
  privateEngine.mergeActive.add(ACTIVE_TASK_ID);
  const abortSpy = vi.spyOn(privateEngine as never, "abortActiveMerge").mockImplementation(() => {});
  return { engine, privateEngine, abortSpy };
}

/*
 * FNXC:MergeInFlightRevoke 2026-08-23-09:15:
 * FN-180 makes a changed review gate a deferral at the ref-advance fence. It must retain its own
 * error type so callers cannot convert a REVISE arriving mid-merge into a retry or failed park.
 */
describe("FN-180 merge in-flight revoke", () => {
  it("uses a dedicated non-merge-failure error for a revoked review gate", () => {
    const error = new MergeGateRevokedError("review changed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MergeGateRevokedError");
  });

  it("fences both singular and workspace ref advances with the current task read", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../merge/merger-ai.ts", import.meta.url), "utf8",
    );
    expect(source).toContain("async function assertMergeGateStillOpen");
    expect(source).toContain("throw new MergeGateRevokedError");
    expect((source.match(/assertMergeGateStillOpen\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("assertMergeGenerationOwned");
  });
});

/*
FNXC:MergeInFlightRevoke 2026-08-24-04:35:
FN-184 behavioral coverage. The FN-180 assertions above are source greps, which is precisely why the
self-abort regression shipped: nothing drove a `task:updated` event through the handler while a merge
was active. These tests do, against the real production blocker.
*/
describe("FN-184 in-flight merge does not abort on its own merge-active stamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `merging` and `merging-pr` are the two ACTIVE_MERGE_STATUSES that are also members of
  // HARD_BLOCKING_TASK_STATUSES, so they are the pair that actually fired the loop.
  for (const status of ["merging", "merging-pr"]) {
    it(`ignores the owned task's own '${status}' execution stamp`, async () => {
      const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

      await privateEngine.taskUpdatedHandler(reviewLaneTask({ status }));

      expect(abortSpy).not.toHaveBeenCalled();
      expect(privateEngine.activeMergeTaskId).toBe(ACTIVE_TASK_ID);
      expect(privateEngine.mergeQueue).not.toContain(ACTIVE_TASK_ID);
      await engine.stop();
    });
  }

  // Not blocking today. Asserted so a future addition to the blocking set cannot silently reopen
  // this regression through the same seam.
  for (const status of ["merging-fix", "reviewing", "landing"]) {
    it(`stays non-aborting for the merge-active status '${status}'`, async () => {
      const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

      await privateEngine.taskUpdatedHandler(reviewLaneTask({ status }));

      expect(abortSpy).not.toHaveBeenCalled();
      await engine.stop();
    });
  }

  it("still aborts on a genuine blocking non-merge status", async () => {
    const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

    await privateEngine.taskUpdatedHandler(reviewLaneTask({ status: "needs-replan" }));

    expect(abortSpy).toHaveBeenCalledWith(ACTIVE_TASK_ID, "blocking-pre-merge-verdict-during-merge");
    await engine.stop();
  });

  it("still aborts on the scheduler 'queued' status the neutralization must not swallow", async () => {
    const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

    await privateEngine.taskUpdatedHandler(reviewLaneTask({ status: "queued" }));

    expect(abortSpy).toHaveBeenCalledWith(ACTIVE_TASK_ID, "blocking-pre-merge-verdict-during-merge");
    await engine.stop();
  });

  it("still aborts on a failed pre-merge review result arriving mid-merge", async () => {
    const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

    await privateEngine.taskUpdatedHandler(reviewLaneTask({
      status: "merging",
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed", verdict: "REVISE" }],
    }));

    expect(abortSpy).toHaveBeenCalledWith(ACTIVE_TASK_ID, "blocking-pre-merge-verdict-during-merge");
    await engine.stop();
  });

  it("does not enter the blocker branch for a merge-active stamp on a different task", async () => {
    const { engine, privateEngine, abortSpy } = await startEngineOwningAMerge();

    await privateEngine.taskUpdatedHandler(reviewLaneTask({ id: "FN-OTHER", status: "merging" }));

    expect(abortSpy).not.toHaveBeenCalled();
    expect(privateEngine.activeMergeTaskId).toBe(ACTIVE_TASK_ID);
    await engine.stop();
  });
});
