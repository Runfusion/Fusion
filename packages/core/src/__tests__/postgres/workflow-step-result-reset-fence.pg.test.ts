import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Task, WorkflowStepResult } from "../../types.js";
import { __setResetPublicationFailureForTesting } from "../../task-store/reset-lifecycle.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkflowStepResults 2026-08-29-02:12:
FN-249 requires the workflow-step write to contend with Reset's task advisory transaction, not
with updateTaskAtomic's process-local mutex. These PostgreSQL cases hold Reset after it acquires
that lock, prove the writer cannot settle until publication commits, and then prove its in-transaction
attempt check sees the fresh row instead of restoring old step or plan-approval evidence.
*/
pgDescribe("TaskStore workflow-step-result reset fence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_step_result_fence",
    poolMax: 4,
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const pending = (workflowStepId: string, startedAt: string): WorkflowStepResult => ({
    workflowStepId,
    workflowStepName: workflowStepId,
    phase: "pre-merge",
    source: "optional-group",
    status: "pending",
    startedAt,
  });

  const terminal = (workflowStepId: string, startedAt: string): WorkflowStepResult => ({
    ...pending(workflowStepId, startedAt),
    status: "failed",
    completedAt: "2026-08-29T02:12:00.000Z",
  });

  function replaceAttempt(
    current: Task,
    workflowStepId: string,
    startedAt: string,
    replacement: WorkflowStepResult,
  ) {
    if (!current.workflowStepResults?.some((entry) => entry.workflowStepId === workflowStepId && entry.startedAt === startedAt)) {
      return null;
    }
    return {
      workflowStepResults: current.workflowStepResults.map((entry) =>
        entry.workflowStepId === workflowStepId && entry.startedAt === startedAt ? replacement : entry,
      ),
    };
  }

  it("blocks behind Reset's advisory transaction and refuses the published fresh row", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "serialize workflow result with reset" });
    await store.updateTask(task.id, {
      column: "in-progress",
      workflowStepResults: [pending("code-review", "attempt-a")],
      approvedPlanFingerprint: "old-plan-fingerprint",
    });

    let signalResetLock!: () => void;
    const resetLockHeld = new Promise<void>((resolve) => { signalResetLock = resolve; });
    let releaseReset!: () => void;
    const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
    const restoreHook = __setResetPublicationFailureForTesting(async () => {
      signalResetLock();
      await resetRelease;
    });

    try {
      const reset = store.resetTaskPublication(task.id, "todo");
      await resetLockHeld;

      let settled = false;
      let observedResults: WorkflowStepResult[] | undefined;
      const lateWrite = store.updateWorkflowStepResultsFenced(task.id, (current) => {
        observedResults = current.workflowStepResults;
        return replaceAttempt(current, "code-review", "attempt-a", terminal("code-review", "attempt-a"));
      }).then((outcome) => {
        settled = true;
        return outcome;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      releaseReset();
      await reset;
      await expect(lateWrite).resolves.toEqual({ applied: false, reason: "refused" });
      expect(observedResults ?? []).toEqual([]);
    } finally {
      restoreHook();
    }

    const fresh = await store.getTask(task.id);
    expect(fresh).toMatchObject({ column: "todo" });
    expect(fresh?.workflowStepResults ?? []).toEqual([]);
    expect(fresh?.approvedPlanFingerprint).toBeUndefined();
  });

  it("shows updateTaskAtomic is deliberately not serialized with Reset's advisory transaction", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "in-process atomic negative control" });
    await store.updateTask(task.id, { workflowStepResults: [pending("code-review", "attempt-a")] });

    let signalResetLock!: () => void;
    const resetLockHeld = new Promise<void>((resolve) => { signalResetLock = resolve; });
    let releaseReset!: () => void;
    const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
    const restoreHook = __setResetPublicationFailureForTesting(async () => {
      signalResetLock();
      await resetRelease;
    });

    try {
      const reset = store.resetTaskPublication(task.id, "todo");
      await resetLockHeld;
      let signalAtomicWrite!: () => void;
      const atomicEntered = new Promise<void>((resolve) => { signalAtomicWrite = resolve; });
      const atomic = store.updateTaskAtomic(task.id, (current) => {
        signalAtomicWrite();
        return replaceAttempt(current, "code-review", "attempt-a", terminal("code-review", "attempt-a"));
      });

      await atomicEntered;
      await atomic;
      releaseReset();
      await reset;
    } finally {
      restoreHook();
    }

    expect((await store.getTask(task.id))?.workflowStepResults ?? []).toEqual([]);
  });

  it("allows a write that commits before Reset, then lets Reset clear it", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "reset wins after ordinary write" });
    await store.updateTask(task.id, {
      workflowStepResults: [pending("code-review", "attempt-a")],
      approvedPlanFingerprint: "old-plan-fingerprint",
    });

    const written = await store.updateWorkflowStepResultsFenced(task.id, (current) => {
      const patch = replaceAttempt(current, "code-review", "attempt-a", terminal("code-review", "attempt-a"));
      return patch ? { ...patch, approvedPlanFingerprint: "accepted-plan-fingerprint" } : null;
    });
    expect(written).toMatchObject({ applied: true });

    const reset = await store.resetTaskPublication(task.id, "todo");
    expect(reset.workflowStepResults ?? []).toEqual([]);
    expect(reset.approvedPlanFingerprint).toBeUndefined();
  });

  it("updates only workflow-result fields and refuses missing or deleted rows", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "field bounded workflow result write" });
    const seeded = await store.updateTask(task.id, {
      column: "in-progress",
      status: "failed",
      worktree: "/tmp/fn-249-worktree",
      branch: "fusion/fn-249",
      branchWriteOrigin: "engine",
      dependencies: [],
      workflowStepResults: [pending("code-review", "attempt-a")],
    });

    const result = await store.updateWorkflowStepResultsFenced(task.id, (current) => replaceAttempt(
      current,
      "code-review",
      "attempt-a",
      terminal("code-review", "attempt-a"),
    ));
    expect(result).toMatchObject({ applied: true });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      column: seeded.column,
      status: seeded.status,
      worktree: seeded.worktree,
      branch: seeded.branch,
      dependencies: seeded.dependencies,
    });

    await expect(store.updateWorkflowStepResultsFenced("FN-missing", () => ({ workflowStepResults: [] })))
      .resolves.toEqual({ applied: false, reason: "task-missing" });
    await store.deleteTask(task.id);
    await expect(store.updateWorkflowStepResultsFenced(task.id, () => ({ workflowStepResults: [] })))
      .resolves.toEqual({ applied: false, reason: "task-deleted" });
  });

  it("discards only the matching pending lease and leaves terminal or later attempts intact", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "discard only aborted lease" });
    await store.updateTask(task.id, {
      workflowStepResults: [
        pending("code-review", "attempt-a"),
        terminal("code-review", "terminal-a"),
        pending("code-review", "attempt-b"),
      ],
    });

    const discarded = await store.updateWorkflowStepResultsFenced(task.id, (current) => {
      const matching = current.workflowStepResults?.find((entry) =>
        entry.workflowStepId === "code-review"
        && entry.status === "pending"
        && entry.startedAt === "attempt-a",
      );
      return matching
        ? { workflowStepResults: current.workflowStepResults?.filter((entry) => entry !== matching) }
        : null;
    });
    expect(discarded).toMatchObject({ applied: true });
    expect((await store.getTask(task.id))?.workflowStepResults).toEqual([
      expect.objectContaining({ status: "failed", startedAt: "terminal-a" }),
      expect.objectContaining({ status: "pending", startedAt: "attempt-b" }),
    ]);
  });
});
