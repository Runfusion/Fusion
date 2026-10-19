import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computePlanApprovalFingerprint, computeWorkflowIrPin, getTaskMergeBlocker, resolveWorkflowIrForTask, UnavailablePlanLockError, type Task, type WorkflowStepResult } from "@fusion/core";
import {
  attemptStillPresent,
  discardWorkflowStepLease,
  persistWorkflowStepResult,
  persistWorkflowStepResultWithOutcome,
} from "../executor/execute-workflow-graph.js";
import { __setResetPublicationFailureForTesting } from "../../../core/src/task-store/reset-lifecycle.js";
import { rerouteFailedNoVerdictPreMergeGateToReview } from "../merge/pre-merge-gate-reseed.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-17:05:
Plan Review R4 (review validation) — genuine positive fixtures. The Plan Review anchor branch now validates REAL
attempt data: parseable strictly-ordered original times and a proof run/attempt identity equal to
the CURRENT persisted pending lease's genuine `leaseOwner` (the identity the real claim writer
stamps). A plan-review positive therefore carries a consistent lease/run identity
(LEASE_OWNER === proof.runAttemptId) and real ISO attempt times; the code-review fence-only
cases keep their plain attempt tokens because they never reach Plan Review proof validation.
*/
const LEASE_OWNER = "run-under-test";
/** Genuine ISO attempt start for the three non-PG Plan Review fence cases (R4: real times only). */
const PLAN_ATTEMPT_START = "2026-08-29T02:10:00.000Z";

const pending = (workflowStepId: string, startedAt: string, leaseOwner?: string): WorkflowStepResult => ({
  workflowStepId,
  workflowStepName: workflowStepId,
  phase: "pre-merge",
  source: "optional-group",
  status: "pending",
  startedAt,
  ...(leaseOwner !== undefined ? { leaseOwner } : {}),
});

const terminal = (workflowStepId: string, startedAt: string): WorkflowStepResult => ({
  ...pending(workflowStepId, startedAt),
  status: "failed",
  completedAt: "2026-08-29T02:18:00.000Z",
});

function createStore(task: Task, tier: "core" | "atomic" | "direct" = "atomic") {
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(task, patch);
    return task;
  });
  const updateTaskAtomic = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
    const patch = compute(task);
    if (patch) Object.assign(task, patch);
    return task;
  });
  const updateWorkflowStepResultsFenced = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
    const patch = compute(task);
    if (!patch) return { applied: false, reason: "refused" } as const;
    Object.assign(task, patch);
    return { applied: true, task } as const;
  });
  const store = {
    getTask: vi.fn(async () => task),
    updateTask,
    ...(tier === "direct" ? {} : { updateTaskAtomic }),
    ...(tier === "core" ? { updateWorkflowStepResultsFenced } : {}),
    isBackendMode: vi.fn(() => false),
    recordAgentActivity: vi.fn(async () => undefined),
  };
  return { store, updateTask, updateTaskAtomic, updateWorkflowStepResultsFenced };
}

function result(startedAt = "attempt-a"): WorkflowStepResult {
  return {
    ...terminal("code-review", startedAt),
    status: "passed",
  };
}

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-17:05:
Plan Review fixture adaptation (review validation bounded scope decision + R4 repair). Plan Review anchor application
now requires a complete dispatch-captured identity — plan fingerprint, the workflow pin resolved
through the SAME production resolver the validator uses, run/attempt identity equal to the row's own
startedAt AND to the current persisted pending lease's genuine leaseOwner, and parseable strictly
ordered original times. These cases exercise the reset/abort/lock fences, not identity refusal, so
the fixtures carry a VALID proof derived at runtime (never mocked away, never a hard-coded
shortcut): completion is derived FROM the attempt start (+5s, never before it — a fixture that
finished before it started would be an impossible history the validator must refuse), while every
original behavioral assertion stays intact.
*/
async function planReviewProof(store: unknown, taskId: string, planContent: string, attemptStartedAt: string) {
  const resolvedIr = await resolveWorkflowIrForTask(store as never, taskId);
  return {
    planFingerprint: computePlanApprovalFingerprint(planContent),
    workflowPin: computeWorkflowIrPin(resolvedIr, "plan-review"),
    runAttemptId: LEASE_OWNER,
    attemptStartedAt,
  };
}

async function planReviewAcceptedResult(
  store: unknown,
  taskId: string,
  planContent: string,
  startedAt: string,
): Promise<WorkflowStepResult> {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) throw new Error(`plan-review fixture attempt startedAt must be a real ISO time, got ${startedAt}`);
  return {
    ...result(startedAt),
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    verdict: "APPROVE",
    completedAt: new Date(startedMs + 5_000).toISOString(),
    reviewedInputIdentity: await planReviewProof(store, taskId, planContent, startedAt),
  };
}

describe("persistWorkflowStepResult abort and reset fence", () => {
  it("uses startedAt as an exact attempt identity", () => {
    const results = [pending("code-review", "attempt-b")];
    expect(attemptStillPresent(results, "code-review", "attempt-a")).toBe(false);
    expect(attemptStillPresent(results, "code-review", "attempt-b")).toBe(true);
  });

  it("refuses an abort that fires after the caller entered the sink without activity emission", async () => {
    const controller = new AbortController();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask } = createStore(task, "direct");
    store.getTask.mockImplementationOnce(async () => {
      await readGate;
      return task;
    });

    const persisted = persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { signal: controller.signal, requireAttemptStartedAt: "attempt-a" },
    );
    controller.abort();
    releaseRead();

    await expect(persisted).resolves.toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-a")]);
  });

  it("recomputes the default-branch patch from the latest matching attempt", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask } = createStore(task, "direct");

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(updateTask).toHaveBeenCalledOnce();
    expect(task.workflowStepResults).toEqual([
      expect.objectContaining({ workflowStepId: "code-review", status: "passed", startedAt: "attempt-a" }),
    ]);
  });

  it("does not overwrite a later attempt and emits no terminal activity for the refusal", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-b")] } as Task;
    const { store, updateTaskAtomic } = createStore(task, "atomic");

    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result("attempt-a"),
      { requireAttemptStartedAt: "attempt-a" },
    )).resolves.toBe(true);

    expect(updateTaskAtomic).toHaveBeenCalledOnce();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-b")]);
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
  });

  it("refuses unconfirmed-lease recovery when a later attempt owns the same workflow step", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-b")] } as Task;
    const { store, updateTask } = createStore(task, "direct");

    await expect(persistWorkflowStepResultWithOutcome(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result("attempt-a"),
      { requireAttemptStartedAtOrAbsent: "attempt-a" },
    )).resolves.toEqual({ scopeCurrent: true, persisted: false, disposition: "fence-refused" });

    expect(updateTask).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("code-review", "attempt-b")]);
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
  });

  it("uses the core fenced tier before degraded writer tiers", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("code-review", "attempt-a")] } as Task;
    const { store, updateTask, updateTaskAtomic, updateWorkflowStepResultsFenced } = createStore(task, "core");

    await persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => undefined } as never,
      task.id,
      result(),
      { requireAttemptStartedAt: "attempt-a" },
    );

    expect(updateWorkflowStepResultsFenced).toHaveBeenCalledOnce();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("refuses an accepted Plan Review when cancellation fires after its fresh read and plan lock", async () => {
    const controller = new AbortController();
    const task = { id: "FN-249", workflowStepResults: [pending("plan-review", PLAN_ATTEMPT_START, LEASE_OWNER)] } as Task;
    const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    });
    const lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      controller.abort();
    });
    const reconcileSpecDriftWhilePlanningLocked = vi.fn(async () => undefined);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask,
      isBackendMode: vi.fn(() => true),
      // Plan Review R4: a backend-mode store genuinely exposes selection reads; a successful no-selection
      // read is the legitimate default state the strict currentness contract accepts. A store with
      // NO selection reader at all is an unreadable read, which the contract must (and does)
      // refuse — so these fence cases carry the surface a real backend store has.
      getTaskWorkflowSelection: () => undefined,
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => {
        await callback();
      }),
      lockCurrentPlanWhilePlanningLocked,
      reconcileSpecDriftWhilePlanningLocked,
      recordAgentActivity: vi.fn(async () => undefined),
    };

    const accepted = await planReviewAcceptedResult(store, task.id, "# Plan\n", PLAN_ATTEMPT_START);
    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      accepted,
      { signal: controller.signal, requireAttemptStartedAt: PLAN_ATTEMPT_START },
    )).resolves.toBe(true);

    expect(updateTask).not.toHaveBeenCalled();
    expect(lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([pending("plan-review", PLAN_ATTEMPT_START, LEASE_OWNER)]);
  });

  it("persists a failed Plan Review when the spec lock is deterministically unavailable", async () => {
    const task = { id: "FN-249", workflowStepResults: [pending("plan-review", PLAN_ATTEMPT_START, LEASE_OWNER)] } as Task;
    const { store, updateTask } = createStore(task, "direct");
    const logEntry = vi.fn(async () => undefined);
    Object.assign(store, {
      isBackendMode: vi.fn(() => true),
      logEntry,
      // Successful no-selection read — the legitimate default state (see abort case above).
      getTaskWorkflowSelection: () => undefined,
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => callback()),
      lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
        throw new UnavailablePlanLockError("section-duplicate", ["non-goals"], "source-hash");
      }),
      reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => undefined),
    });

    const accepted = await planReviewAcceptedResult(store, task.id, "# Plan\n", PLAN_ATTEMPT_START);
    await expect(persistWorkflowStepResultWithOutcome(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      accepted,
      { requireAttemptStartedAt: PLAN_ATTEMPT_START },
    )).resolves.toMatchObject({
      scopeCurrent: true,
      persisted: true,
      disposition: "applied",
      persistedResult: expect.objectContaining({ status: "failed" }),
    });

    expect(updateTask).toHaveBeenCalledOnce();
    expect(task.approvedPlanFingerprint).toBeUndefined();
    expect(task.workflowStepResults).toEqual([expect.objectContaining({
      workflowStepId: "plan-review", status: "failed", verdict: undefined,
      output: expect.stringContaining("section-duplicate (non-goals)"),
    })]);
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("section-duplicate (non-goals)"), undefined, undefined);
    const seed = vi.fn();
    Object.assign(store, { seedWorkspaceCodeReviewContinuationIfIdle: seed });
    for (let poll = 0; poll < 5; poll++) {
      expect((await rerouteFailedNoVerdictPreMergeGateToReview(store as never, task, {
        requiredPreMergeStepIds: new Set(["plan-review"]),
        mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "same" } } as never,
      })).rerouted).toBe(false);
    }
    expect(seed).not.toHaveBeenCalled();
    expect(getTaskMergeBlocker({
      ...task,
      column: "in-review",
      paused: false,
      status: null,
      steps: [],
    }, { requiredPreMergeStepIds: new Set(["plan-review"]) })).toBe(
      "task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')",
    );
  });

  it("refuses an accepted Plan Review when Reset publishes between its fresh read and fenced write", async () => {
    const task = {
      id: "FN-249",
      workflowStepResults: [pending("plan-review", PLAN_ATTEMPT_START, LEASE_OWNER)],
      approvedPlanFingerprint: "old-plan-fingerprint",
      status: "failed",
    } as Task;
    const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    });
    const lockCurrentPlanWhilePlanningLocked = vi.fn(async () => {
      Object.assign(task, {
        workflowStepResults: [],
        approvedPlanFingerprint: undefined,
        status: undefined,
      });
    });
    const updateWorkflowStepResultsFenced = vi.fn(async (_id: string, compute: (current: Task) => Partial<Task> | null) => {
      expect(compute(task)).toBeNull();
      return { applied: false, reason: "refused" } as const;
    });
    const reconcileSpecDriftWhilePlanningLocked = vi.fn(async () => undefined);
    const store = {
      getTask: vi.fn(async () => task),
      updateTask,
      updateWorkflowStepResultsFenced,
      isBackendMode: vi.fn(() => true),
      // Successful no-selection read — the legitimate default state (see abort case above).
      getTaskWorkflowSelection: () => undefined,
      withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<void>) => {
        await callback();
      }),
      lockCurrentPlanWhilePlanningLocked,
      reconcileSpecDriftWhilePlanningLocked,
      recordAgentActivity: vi.fn(async () => undefined),
    };

    const accepted = await planReviewAcceptedResult(store, task.id, "# Plan\n", PLAN_ATTEMPT_START);
    await expect(persistWorkflowStepResult(
      { store, getRunContextFor: () => undefined, readTaskArtifact: async () => "# Plan\n" } as never,
      task.id,
      accepted,
      { requireAttemptStartedAt: PLAN_ATTEMPT_START },
    )).resolves.toBe(true);

    expect(lockCurrentPlanWhilePlanningLocked).toHaveBeenCalledOnce();
    expect(updateWorkflowStepResultsFenced).toHaveBeenCalledOnce();
    expect(updateTask).not.toHaveBeenCalled();
    expect(reconcileSpecDriftWhilePlanningLocked).not.toHaveBeenCalled();
    expect(store.recordAgentActivity).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual([]);
    expect(task.approvedPlanFingerprint).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  it("discards only the aborted pending lease and leaves a terminal and newer lease intact", async () => {
    const task = {
      id: "FN-249",
      workflowStepResults: [
        pending("code-review", "attempt-a"),
        terminal("code-review", "terminal-a"),
        pending("code-review", "attempt-b"),
      ],
    } as Task;
    const { store } = createStore(task, "core");

    await expect(discardWorkflowStepLease(
      { store, getRunContextFor: () => undefined } as never,
      task.id,
      "code-review",
      "attempt-a",
    )).resolves.toBe(true);

    expect(task.workflowStepResults).toEqual([
      expect.objectContaining({ status: "failed", startedAt: "terminal-a" }),
      expect.objectContaining({ status: "pending", startedAt: "attempt-b" }),
    ]);
  });
});

/*
FNXC:WorkflowStepResults 2026-08-29-02:41:
The unit interleaving above proves the accepted Plan Review branch recomputes against the fenced
row. This PostgreSQL proof drives that production branch while Reset holds the shared advisory
lock, so a late approval cannot restore either its result or approvedPlanFingerprint.
*/
pgDescribe("persistWorkflowStepResult Plan Review reset fence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_plan_review_reset_fence",
    poolMax: 4,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("blocks an accepted Plan Review write behind Reset and refuses the fresh task row", async () => {
    const store = h.store();
    const subject = await store.createTask({ description: "Plan Review reset serialization" });
    const attemptStartedAt = "2026-08-29T02:41:00.000Z";
    await store.updateTask(subject.id, {
      column: "in-progress",
      workflowStepResults: [pending("plan-review", attemptStartedAt, LEASE_OWNER)],
      approvedPlanFingerprint: "old-plan-fingerprint",
    });

    let releasePlanLock!: () => void;
    const planLockRelease = new Promise<void>((resolve) => { releasePlanLock = resolve; });
    let signalPlanLockReached!: () => void;
    const planLockReached = new Promise<void>((resolve) => { signalPlanLockReached = resolve; });
    const originalPlanLock = store.lockCurrentPlanWhilePlanningLocked.bind(store);
    const planLockSpy = vi.spyOn(store, "lockCurrentPlanWhilePlanningLocked").mockImplementation(async (...args) => {
      signalPlanLockReached();
      await planLockRelease;
      return originalPlanLock(...args);
    });

    let signalResetLock!: () => void;
    const resetLockHeld = new Promise<void>((resolve) => { signalResetLock = resolve; });
    let releaseReset!: () => void;
    const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
    const restoreResetHook = __setResetPublicationFailureForTesting(async () => {
      signalResetLock();
      await resetRelease;
    });

    let signalFencedWriter!: () => void;
    const fencedWriterStarted = new Promise<void>((resolve) => { signalFencedWriter = resolve; });
    let observedResults: WorkflowStepResult[] | undefined;
    const originalFencedWriter = store.updateWorkflowStepResultsFenced.bind(store);
    const fencedWriterSpy = vi.spyOn(store, "updateWorkflowStepResultsFenced").mockImplementation(async (taskId, compute) => {
      signalFencedWriter();
      return originalFencedWriter(taskId, (current) => {
        observedResults = current.workflowStepResults;
        return compute(current);
      });
    });
    const reconcileSpy = vi.spyOn(store, "reconcileSpecDriftWhilePlanningLocked");

    try {
      /*
      FNXC:CurrentPlanReviewIdentity 2026-10-11-13:05:
      Plan Review fixture adaptation (review validation): the row now needs a valid dispatch-captured identity so the
      real production branch is actually reached — otherwise proof validation refuses the anchor
      BEFORE the plan-lock seam this case is built to serialize behind. Derived through the same
      production resolver against the real store; the reset-fence behavior under test is untouched.
      */
      const planContent = "## Mission\nApprove the task plan.\n";
      const accepted = await planReviewAcceptedResult(store, subject.id, planContent, attemptStartedAt);
      const persisted = persistWorkflowStepResult(
        { store, getRunContextFor: () => undefined, readTaskArtifact: async () => planContent },
        subject.id,
        accepted,
        { requireAttemptStartedAt: attemptStartedAt },
      );

      await planLockReached;
      const reset = store.resetTaskPublication(subject.id, "todo");
      await resetLockHeld;

      let settled = false;
      void persisted.then(() => { settled = true; });
      releasePlanLock();
      await fencedWriterStarted;
      expect(settled).toBe(false);

      releaseReset();
      await reset;
      await expect(persisted).resolves.toBe(true);
      expect(observedResults ?? []).toEqual([]);
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      // Release both test gates on assertion failure so the harness can clean its pool.
      releasePlanLock();
      releaseReset();
      restoreResetHook();
      planLockSpy.mockRestore();
      fencedWriterSpy.mockRestore();
      reconcileSpy.mockRestore();
    }

    const fresh = await store.getTask(subject.id);
    expect(fresh?.workflowStepResults ?? []).toEqual([]);
    expect(fresh?.approvedPlanFingerprint).toBeUndefined();
  });
});
