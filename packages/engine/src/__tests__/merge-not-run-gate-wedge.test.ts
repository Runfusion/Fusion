import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  buildPreMergeGateApprovalBlocker,
  deriveTaskStallReason,
  findUnrunRequiredPreMergeStepIds,
  findVerdictLessFailedRequiredGates,
  getBuiltinWorkflow,
  getTaskMergeBlocker,
  isPreMergeStepsNotRunBlocker,
  isPreMergeStepsNotRunRefusal,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  STALE_CONTENT_APPROVAL_BLOCKER,
  type Settings,
  type Task,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";

/*
FNXC:TaskWedgeNotifications 2026-09-22-21:42 (RUFU-276 Step 2 evidence):
The notification leg of the ownership map has to be observed, not theorized (RUFU-180's sweep is the
only production path for a standing review-lane refusal), so the notifier is intercepted the same way
`self-healing-review-stall-notification.test.ts` intercepts it.
*/
const { getActiveNotificationServiceMock } = vi.hoisted(() => ({ getActiveNotificationServiceMock: vi.fn() }));
vi.mock("../util/notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/notifier.js")>();
  return { ...actual, getActiveNotificationService: getActiveNotificationServiceMock };
});

import "./executor-test-helpers.js";
import { createMockStore } from "./executor-test-helpers.js";
import { SelfHealingManager } from "../self-healing.js";
import { NotificationService } from "../notification/notification-service.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX, classifyStaleContentPark } from "../merge/stale-content-park.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import {
  describeTaskRecoveryOwner,
  describeTaskWedge,
  shouldWithholdWedgeAlertForAutoRecovery,
} from "../notification/task-wedge-notification.js";

/*
FNXC:PreMergeApproval 2026-09-22-21:19 (RUFU-276):
The RUFU-225 wedge: a card in the review lane whose bounded auto-merge retry was refused by the
not-run gate door, terminalized as `status:"failed"` with the refusal embedded in
`AUTO_MERGE_RETRY_REJECTED: <Cannot merge … : <canonical not-run sentence>>`, unpaused, with zero
result rows for an enabled required pre-merge gate. Every owner that should have acted had an
exact-equality or status-shaped test that this composition misses:
 - `isPreMergeStepsNotRunBlocker` compares verbatim, so the wrapped sentence is invisible to the
   queue's in-place re-seed and to the visible recovery sweep (which only admits `status == null`);
 - the retry seam treats every requester rejection as a terminal failure, so the deferral class
   consumed a retry budget and wrote a terminal park;
 - `describeTaskWedge` has no arm for it, so it reads as a generic terminal failure and the wedge
   alert is withheld as "auto-recovery will retry it" — an owner that never came.
The pins below encode today's inertness (they must stay green so a future fix cannot silently
change a contract it did not set out to change); the target assertions name the repairs RUFU-276
owns: producer deferral, self-healing seed-and-clear, honest stall projection, and a named wedge.

Measured at the RUFU-276 baseline (main 8381b39bb2, before any production change): 2 pins green,
5 targets red — `merge-blocker` instead of `pre-merge-gate-pending`, `status:"failed"` written by
the retry seam, no seed from the sweep (including with the merge-retry budget already spent), and
`terminal-failed` as the wedge descriptor. The two operator/remediation-owned controls inside the
sweep test are green on purpose: the repair must not widen into those parks.
*/

const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;
const REQUIRED_PRE_MERGE_STEP_IDS = new Set(["plan-review", "code-review"]);
const REVIEW_COLUMNS = new Set(["in-review"]);

/** The merge door's rejection sentence for an unrun gate (as `PreMergeStepsNotRunError` throws it). */
function notRunRefusal(taskId: string): string {
  return `Cannot merge ${taskId}: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`;
}

/** RUFU-225's exact persisted shape: retry-rejection park over a gate with zero rows. */
function notRunRetryRejectionTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-225FIX",
    title: "Wedged card whose auto-merge retry was refused by an unrun gate",
    description: "",
    column: "in-review",
    status: "failed",
    error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${notRunRefusal("RUFU-225FIX")}`,
    paused: false,
    userPaused: false,
    autoMerge: true,
    worktree: "/tmp/rufu-225fix",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    mergeRetries: 3,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    // Code Review is enabled and required, and has NEVER produced a row.
    workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan", verdict: "APPROVE" }],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function recoveryStore(task: Task) {
  const seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: true }));
  const updateTaskAtomic = vi.fn(async (
    id: string,
    updater: (current: Task) => Record<string, unknown> | null,
  ) => {
    const patch = updater(task);
    if (patch) Object.assign(task, patch);
    return task;
  });
  return {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: codingIr })),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: codingIr }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getBranchGroup: vi.fn(async () => null),
    seedWorkspaceCodeReviewContinuationIfIdle,
    updateTaskAtomic,
    updateTask: vi.fn(async () => task),
    listTasks: vi.fn(async (options?: { column?: string }) => options?.column === "in-review" ? [task] : []),
    listTasksByColumns: vi.fn(async () => []),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    /*
    FNXC:WorkflowPassCacheFixture 2026-11-02-03:37 (RUFU-318):
    RUFU-584 (`58d561b1c1`) made `SelfHealingManager.batchWorkflowIrCache()` read
    `store.workflowDefinitionEpoch()` unconditionally (self-healing.ts:1429). This hand-rolled fake did not
    implement it, so EVERY sweep threw on the first cache read and its outer catch collapsed the whole pass
    into one `log.warn` — this file lost both repair cases with no visible cause. The real `TaskStore` owns
    both counters (core/src/store.ts:754); a constant epoch is the correct fake because no case in this file
    writes a workflow selection or definition mid-pass, so cache invalidation is never the subject.
    Same drift class as `FNXC:StaleReviewWaiverFixture` below: a product store read lands, the fakes do not.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getAgentLogs: vi.fn(async () => []),
  } as any;
}

function mergeRetryDeps(store: ReturnType<typeof createMockStore>, live: TaskDetail, rejection: string) {
  return {
    store,
    getRunContextFor: () => undefined,
    mergeRequester: vi.fn(async () => { throw new Error(rejection); }),
    ensureWorkflowMergeBoundaryTask: vi.fn(async (task: TaskDetail) => ({ task })),
    persistTokenUsage: vi.fn(async () => undefined),
  } as any;
}

const mergeFailureResult = {
  disposition: "failed",
  outcome: "failure",
  reason: "merge-request-rejected",
  visitedNodeIds: ["code-review"],
  context: {},
} as any;

describe("not-run gate retry-rejection wedge (RUFU-225 shape)", () => {
  beforeEach(() => {
    getActiveNotificationServiceMock.mockReset();
  });

  it("composes the blocker through the failed-status arm while the exact-equality contract stays verbatim", () => {
    const task = notRunRetryRejectionTask();
    const blocker = getTaskMergeBlocker(task, {
      reviewColumns: REVIEW_COLUMNS,
      requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS,
    });

    // The blocking-status arm precedes the approval arm, so the card reports its wrapped park.
    expect(blocker).toContain(AUTO_MERGE_RETRY_REJECTED_PREFIX);
    expect(blocker).toContain(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    /*
    RUFU-276 must NOT widen this predicate: it is the classifier all four merge doors use to
    distinguish "gate pending" from "terminal failure", and the doors are fed the ALREADY-canonical
    sentence. Pinning non-membership keeps a future fix from quietly re-pointing the doors.
    */
    expect(isPreMergeStepsNotRunBlocker(blocker)).toBe(false);
    expect(isPreMergeStepsNotRunBlocker(PRE_MERGE_STEPS_NOT_RUN_BLOCKER)).toBe(true);
    // And the verdict-less lane cannot own it either: zero rows means no verdict-less row to name.
    expect(findVerdictLessFailedRequiredGates(task, { requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS })).toEqual([]);
    expect(classifyStaleContentPark(task)).toBeUndefined();
  });

  it("has no recovery owner, so nothing was ever scheduled to retry it", () => {
    expect(describeTaskRecoveryOwner(notRunRetryRejectionTask())).toBeNull();
  });

  /*
  FNXC:PreMergeApproval 2026-09-22-21:42 (RUFU-276):
  Step 2 evidence — the three predicates that refuse this shape, named instead of guessed at.
  Each is a legitimate rule about its own lane; together they left the card ownerless.
  */
  it("names the admission predicates that refuse the wedge today", () => {
    const task = notRunRetryRejectionTask();

    // (a) The wrap-aware classifier (added by this task) does recognize the composed refusal...
    expect(isPreMergeStepsNotRunRefusal(task.error)).toBe(true);
    // ...while the verbatim classifier the merge doors use — and must keep using — does not.
    expect(isPreMergeStepsNotRunBlocker(task.error)).toBe(false);

    // (b) The visible recovery sweep admits only `status == null` cards, so a failed park never
    //     reaches FN-9243's lane. Asserted through the sweep itself: no seed, no enqueue, no clear.

    // (c) The stale-content arm needs the stale-content suffix; the verdict-less arm needs a
    //     verdict-less FAILED row. A zero-row gate satisfies neither.
    expect(classifyStaleContentPark(task)).toBeUndefined();
    expect(findVerdictLessFailedRequiredGates(task, { requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS })).toEqual([]);
    // What IS true of the row: the required gate has never reported. That is the repair's subject.
    expect(findUnrunRequiredPreMergeStepIds(task, { requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS }))
      .toEqual(["code-review"]);
    // A gate whose row exists — pending, verdict-less, or authored — is not "unrun".
    for (const status of ["pending", "failed", "passed"] as const) {
      for (const gateId of ["plan-review", "code-review"]) {
        expect(findUnrunRequiredPreMergeStepIds(
          { workflowStepResults: [{ workflowStepId: gateId, status }] },
          { requiredPreMergeStepIds: new Set([gateId]) },
        )).toEqual([]);
      }
    }
    expect(findUnrunRequiredPreMergeStepIds(task, {})).toEqual([]);
  });

  it("projects the wedge as a pending pre-merge gate, not a generic merge blocker", async () => {
    const task = notRunRetryRejectionTask();
    const stall = await deriveTaskStallReason(task, {
      reviewColumns: REVIEW_COLUMNS,
      requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS,
      now: Date.parse("2026-09-22T00:00:00.000Z"),
    });

    expect(stall?.code).toBe("pre-merge-gate-pending");
    // The operator-facing sentence is the canonical gate sentence, not the composed park sentence.
    expect(stall?.reason).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
  });

  it("defers the merge retry instead of terminalizing an unrun-gate refusal", async () => {
    const task = notRunRetryRejectionTask({ status: null, error: null, mergeRetries: 0 });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => task as TaskDetail);
    // The shared executor mock has no audit sink; the deferral's telemetry must be observable here.
    (store as unknown as { recordRunAuditEvent: ReturnType<typeof vi.fn> }).recordRunAuditEvent = vi.fn(async () => undefined);
    const deps = mergeRetryDeps(store, task as TaskDetail, notRunRefusal(task.id));

    const handled = await routeGraphMergeFailureToRetry(deps, task as TaskDetail, mergeFailureResult, undefined);

    expect(handled).toBe(true);
    const live = await store.getTask(task.id) as Task;
    // A deferral class leaves no terminal park behind: the card keeps its review-lane status.
    expect(live.status).toBeNull();
    expect(live.error).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("deferred"), undefined, undefined);
    // Telemetry is the bounded FN-9175 seam with its own event name — the registered
    // `task:merge-unrun-pre-merge-gate-rerouted` key set describes a SEED, not a deferral.
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-unrun-gate-retry-deferred",
      metadata: expect.objectContaining({ taskId: task.id, source: "merge-retry", outcome: "deferred" }),
    }));
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("keeps every other refusal on the visible GDPR-053 park", async () => {
    const refusals: Array<[string, string]> = [
      ["stale-content wrap", `Cannot merge RUFU-225FIX: ${STALE_CONTENT_APPROVAL_BLOCKER}`],
      ["gate approval wrap", `Cannot merge RUFU-225FIX: ${buildPreMergeGateApprovalBlocker("code-review")}`],
      ["generic rejection", "merge refused: worktree is behind the default branch"],
    ];

    for (const [name, refusal] of refusals) {
      const task = notRunRetryRejectionTask({ status: null, error: null, mergeRetries: 0 });
      const store = createMockStore();
      store.getTask.mockImplementation(async () => task as TaskDetail);
      const deps = mergeRetryDeps(store, task as TaskDetail, refusal);

      await routeGraphMergeFailureToRetry(deps, task as TaskDetail, mergeFailureResult, undefined);

      const live = await store.getTask(task.id) as Task;
      expect(live.status, name).toBe("failed");
      expect(String(live.error), name).toContain(AUTO_MERGE_RETRY_REJECTED_PREFIX);
      expect(String(live.error), name).toContain(refusal);
    }
  });

  it("repairs an already-wedged card by seeding the gate and clearing the park", async () => {
    const task = notRunRetryRejectionTask();
    const store = recoveryStore(task);
    const enqueueMerge = vi.fn();

    await new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix", enqueueMerge } as any)
      .recoverMergeableReviewTasks();

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id, nodeId: "code-review", state: "runnable", sourceColumn: "in-review",
    }));
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.mergeRetries).toBe(0);
    // The merge itself stays deferred until the real gate reports.
    expect(enqueueMerge).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-unrun-pre-merge-gate-rerouted",
      metadata: expect.objectContaining({ taskId: task.id, source: "self-healing" }),
    }));
  });

  it("leaves an operator-held or genuinely-reviewed park to its own owner", async () => {
    const held = recoveryStore(notRunRetryRejectionTask({ paused: true, pausedReason: "manual" as Task["pausedReason"] }));
    const exhausted = recoveryStore(notRunRetryRejectionTask({
      // Same park, retry budget already spent: the repair must still be admitted, because the
      // re-seed (not a doomed merge retry) is the only owner this class has.
      mergeRetries: 9,
    }));
    const authored = recoveryStore(notRunRetryRejectionTask({
      // A real reviewer REVISE whose remediation was refused: remediation lane owns this park.
      error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} Cannot merge RUFU-225FIX: ${buildPreMergeGateApprovalBlocker("code-review")}`,
      workflowStepResults: [
        { workflowStepId: "plan-review", status: "passed", reviewKind: "plan", verdict: "APPROVE" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", reviewKind: "code", verdict: "REVISE", findings: [{ description: "real finding" }] },
      ],
    }));

    await new SelfHealingManager(held, { rootDir: "/tmp/rufu-225fix", enqueueMerge: vi.fn() } as any)
      .recoverMergeableReviewTasks();
    await new SelfHealingManager(authored, { rootDir: "/tmp/rufu-225fix", enqueueMerge: vi.fn() } as any)
      .recoverMergeableReviewTasks();
    await new SelfHealingManager(exhausted, { rootDir: "/tmp/rufu-225fix", enqueueMerge: vi.fn() } as any)
      .recoverMergeableReviewTasks();

    expect(held.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(held.updateTaskAtomic).not.toHaveBeenCalled();
    expect(authored.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    // Exhaustion of the MERGE retry budget does not exhaust the repair's own budget.
    expect(exhausted.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "RUFU-225FIX", nodeId: "code-review",
    }));
  });

  it("names the wedge so the operator is alerted rather than silently withheld", () => {
    const task = notRunRetryRejectionTask();
    const wedge = describeTaskWedge(task);

    /*
    The key deliberately equals the stall projection's key: once the repair clears the failed status,
    the same card is described by the stall arm, and one episode key across that transition is what
    keeps storm control intact (the per-reason cooldown cannot dedupe two names for one condition).
    */
    expect(wedge?.reasonKey).toBe("stall:pre-merge-gate-pending");
    expect(wedge?.reason).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    expect(wedge?.action).toContain("gate");
    // Today this is TRUE — the generic terminal-failed park makes auto-recovery claim ownership and
    // the alert is withheld. A named park is not generic, so the withhold must stop applying.
    expect(shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: true })).toBe(false);
  });

  /*
  FNXC:TaskWedgeNotifications 2026-09-22-21:42 (RUFU-276 Step 2 empirical evidence):
  The RUFU-180 discovery sweep is the only production path that can announce this standing refusal,
  because a retry-rejection park writes its row once and never again — no task-updated/task-moved
  event will ever wake the notifier. Measured against this fixture at main 8381b39bb2 the sweep DOES
  select the card (the mis-projected `merge-blocker` code is still a candidate) but the service
  returns `unavailable`: `describeTaskWedge` reads the card as a generic `terminal-failed` park, so
  `classifyTerminalFailureAutoRecovery` answers `retry` and the alert is withheld for a recovery that
  never comes. No NotificationService edit is needed — naming the wedge is what removes the withhold
  — and the operator then reads the gate-pending name and remedy instead of a generic failure.
  */
  it("announces the wedged card through the stall sweep under the gate-pending reason key", async () => {
    vi.useFakeTimers();
    const task = notRunRetryRejectionTask({
      stallReason: await deriveTaskStallReason(notRunRetryRejectionTask(), {
        reviewColumns: REVIEW_COLUMNS,
        requiredPreMergeStepIds: REQUIRED_PRE_MERGE_STEP_IDS,
        now: Date.now(),
      }) ?? undefined,
    });
    const h = wedgeNotificationHarness(task);
    await h.service.start();
    getActiveNotificationServiceMock.mockReturnValue(h.service);

    // Pass 1 arms the settle window; the sweep must treat the card as one candidate.
    await expect(new SelfHealingManager(h.store, { rootDir: "/tmp/rufu-225fix" } as any)
      .reconcileReviewStallWedgeNotifications()).resolves.toBe(1);
    /*
    Step 2 empirical evidence: today this row records `outcome: "unavailable"` — the NotificationService
    withheld the alert because `describeTaskWedge` calls the card a generic `terminal-failed` park, so
    `classifyTerminalFailureAutoRecovery` answered `retry` ("engine auto-recovery owns it"). No
    NotificationService edit is required: naming the wedge (Step 5) makes the classifier answer
    `not-generic-terminal-failure`, which is not a withhold, and the episode then delivers.
    */
    const firstPassRow = auditRows(h.store)[0];
    expect(firstPassRow?.metadata).toEqual(expect.objectContaining({ taskId: task.id }));
    expect(["delivered", "suppressed", "unavailable", "deferred", "failed"])
      .toContain((firstPassRow?.metadata as Record<string, unknown>).outcome);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const mail = (h.sendMessageOnce as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]![0];
    expect(mail.metadata).toEqual(expect.objectContaining({
      kind: "task-wedge",
      taskId: task.id,
      // Today this reads `stall:merge-blocker`; the fix names the pending gate.
      wedgeReason: "stall:pre-merge-gate-pending",
    }));
    expect(mail.content as string).toContain(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);

    // Storm bound: a second pass on the unchanged state never becomes a second alert.
    await new SelfHealingManager(h.store, { rootDir: "/tmp/rufu-225fix" } as any)
      .reconcileReviewStallWedgeNotifications();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.dispatch).toHaveBeenCalledTimes(1);

    await h.service.stop();
    vi.useRealTimers();
  });
});

/** Audit rows written to the store sink, in call order. */
function auditRows(store: TaskStore): Array<{ mutationType: string; metadata: Record<string, unknown> | undefined }> {
  const record = (store as unknown as { recordRunAuditEvent: { mock: { calls: Array<[Record<string, unknown>]> } } }).recordRunAuditEvent;
  return record.mock.calls.map(([row]) => ({ mutationType: String(row.mutationType), metadata: row.metadata as Record<string, unknown> | undefined }));
}

/** Store fake shaped for the wedge-notification path (pattern: self-healing-review-stall-notification.test.ts). */
function wedgeNotificationHarness(task: Task) {
  let current = task as Task;
  const dispatch = vi.fn(async () => ({ success: true, providerId: "test" }));
  const sendMessageOnce = vi.fn(async () => ({ message: {} as unknown, inserted: true }));
  let episodeSeq = 0;

  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({
      globalPause: false,
      enginePaused: false,
      autoMerge: true,
      ntfyEnabled: true,
      ntfyTopic: "test",
    } as Settings)),
    getTask: vi.fn(async () => current),
    listTasks: vi.fn(async () => [current]),
    recordRunAuditEvent: vi.fn(async () => undefined),
    claimTaskWedgeNotificationEpisode: vi.fn(async (taskId: string, reasonKey: string | null) => {
      const prior = current.wedgeNotification;
      if (reasonKey === null) {
        if (!prior || prior.status === "resolved") return { claimed: false };
        current = { ...current, wedgeNotification: { ...prior, status: "resolved", transitionedAt: new Date().toISOString() } };
        return { claimed: false };
      }
      if (prior?.status === "active" && prior.reasonKey === reasonKey) return { claimed: false };
      current = {
        ...current,
        wedgeNotification: { reasonKey, episodeId: `ep-${++episodeSeq}`, status: "active", transitionedAt: new Date().toISOString() },
      };
      return { claimed: true, episodeId: `ep-${episodeSeq}` };
    }),
    markTaskWedgeNotificationPending: vi.fn(async (
      taskId: string,
      descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string },
    ) => {
      const since = new Date().toISOString();
      const prior = current.wedgeNotification;
      if (prior?.status === "active" && prior.reasonKey === descriptor.reasonKey) return { since, armed: false, restamped: false };
      current = {
        ...current,
        wedgeNotification: prior
          ? { ...prior, pending: { since, ...descriptor } }
          : { reasonKey: descriptor.reasonKey, episodeId: "", status: "resolved", transitionedAt: since, pending: { since, ...descriptor } },
      };
      return { since, armed: true, restamped: prior?.pending != null };
    }),
    clearTaskWedgeNotificationPending: vi.fn(async () => {
      const prior = current.wedgeNotification;
      if (!prior?.pending) return false;
      const { pending: _pending, ...withoutPending } = prior;
      current = { ...current, wedgeNotification: withoutPending };
      return true;
    }),
    resolveColumnForRole: vi.fn(async (role: string) => (role === "complete" ? "done" : role === "review" ? "in-review" : undefined)),
    on: vi.fn(),
    off: vi.fn(),
  }) as unknown as TaskStore;

  const service = new NotificationService(store as never, {
    messageStore: { on: () => undefined, sendMessageOnce: sendMessageOnce as never } as never,
    wedgeNotificationSettleMs: 1_000,
  });
  service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: dispatch });

  return { service, store, dispatch, sendMessageOnce };
}
