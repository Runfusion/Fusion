import { describe, expect, it, vi } from "vitest";
import { PlanningLifecycleLockTransportError, type Task, type TaskStore } from "@fusion/core";
import {
  isPlanningLifecycleLockTransportFailure,
} from "../planning-handoff-recovery.js";
import {
  retryPlanningLifecycleLockTransportFailure,
  runImplementation,
} from "../executor/run-implementation.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-179-lock",
    title: "Lock retry",
    description: "exercise the executor recovery lane",
    column: "in-progress",
    worktree: "/tmp/fn-179-worktree",
    branch: "fusion/FN-179-lock",
    recoveryRetryCount: 0,
    ...overrides,
  } as Task;
}

/**
 * FNXC:WorkspacePlanningLock 2026-08-23-08:20:
 * FN-179 keeps the executor recovery mutation in the same helper both production catch sites
 * invoke. Exercise that helper with the real transport error so retry state, graph requeue, and
 * prepared-worktree preservation cannot regress behind a predicate-only test.
 */
describe("executor planning lifecycle lock transport recovery", () => {
  it("preserves the prepared worktree while the production recovery branch requeues a real transport error", async () => {
    const current = task();
    const store = {
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
    } as unknown as TaskStore;
    const markGraphExecuteSelfRequeued = vi.fn();
    const retried = await retryPlanningLifecycleLockTransportFailure(
      { store, getRunContextFor: () => undefined, markGraphExecuteSelfRequeued } as never,
      current,
      new PlanningLifecycleLockTransportError("acquisition timed out after 5000ms").message,
      async () => "todo",
    );

    expect(retried).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(current.id, expect.objectContaining({ recoveryRetryCount: 1 }));
    expect(store.moveTask).toHaveBeenCalledWith(current.id, "todo", { preserveProgress: true });
    expect(markGraphExecuteSelfRequeued).toHaveBeenCalledWith(current.id);
    expect(current.worktree).toBe("/tmp/fn-179-worktree");
    expect(current.branch).toBe("fusion/FN-179-lock");
    expect(store.logEntry).toHaveBeenCalledWith(current.id, expect.stringContaining("Planning lifecycle lock transport failure"), undefined, undefined);
  });

  /*
   * FNXC:WorkspacePlanningLock 2026-08-23-07:45:
   * FN-179 must prove the production implementation entry recognizes the typed planning-lock
   * transport failure before transient or terminal cleanup. Calling the recovery helper alone
   * cannot detect either catch branch being removed or misordered.
   */
  it("retries a typed planning-lock failure through runImplementation without removing the worktree", async () => {
    const current = task({ dependencies: [], paused: false, userPaused: false });
    const store = {
      getTask: vi.fn(async () => current),
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      getFusionDir: vi.fn(() => "/tmp/fusion"),
      setPluginWorkflowStepTemplates: vi.fn(),
      recordAgentActivity: vi.fn(async () => undefined),
      listTasks: vi.fn(async () => []),
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
    } as unknown as TaskStore;
    const deps = {
      store,
      rootDir: "/tmp/fusion",
      options: {},
      executing: new Set<string>(),
      currentRunContexts: new Map(),
      effectiveColumnAgentByTask: new Map(),
      loopRecoveryState: new Map(),
      tokenUsageBaselines: new Map(),
      branchConflictErrorCount: new Map(),
      activeWorktrees: new Map(),
      pausedAborted: new Set<string>(),
      userCanceledTaskIds: new Set<string>(),
      stuckAborted: new Map(),
      depAborted: new Set<string>(),
      workspaceConfig: undefined,
      getRunContextFor: () => undefined,
      maybeDispatchWorkflowWorkEngine: vi.fn(async () => false),
      resolveEffectivePrincipalId: vi.fn(() => undefined),
      shouldDeferForHeartbeat: vi.fn(async () => false),
      resolveResumeLanes: vi.fn(async () => ({ wip: "in-progress", hold: "todo" })),
      transitionReviewAddressing: vi.fn(async () => undefined),
      ensureWorkspaceConfig: vi.fn(async () => { throw new PlanningLifecycleLockTransportError("acquisition timed out after 5000ms"); }),
      handleNonContinuableSessionError: vi.fn(async () => false),
      handleNonContinuableSessionRetry: vi.fn(async () => false),
      markGraphExecuteSelfRequeued: vi.fn(),
      terminateAllChildren: vi.fn(async () => undefined),
      resumeApprovalAfterUnwindIfNeeded: vi.fn(async () => undefined),
    } as never;

    await runImplementation(deps, current, vi.fn());

    expect((store as any).updateTask).toHaveBeenCalledWith(current.id, expect.objectContaining({ recoveryRetryCount: 1 }));
    expect((store as any).moveTask).toHaveBeenCalledWith(current.id, "todo", { preserveProgress: true });
    expect((store as any).updateTask).not.toHaveBeenCalledWith(current.id, expect.objectContaining({ status: "failed" }));
    expect(current.worktree).toBe("/tmp/fn-179-worktree");
    expect(current.branch).toBe("fusion/FN-179-lock");
  });

  it("leaves exhaustion for the existing terminal path rather than retrying forever", async () => {
    const current = task({ recoveryRetryCount: 3 });
    const store = { logEntry: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn() } as unknown as TaskStore;
    await expect(retryPlanningLifecycleLockTransportFailure(
      { store, getRunContextFor: () => undefined, markGraphExecuteSelfRequeued: vi.fn() } as never,
      current,
      "Planning lifecycle lock acquisition timed out after 5000ms",
      async () => "todo",
    )).resolves.toBe(false);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("recognizes only canonical lock transport messages after graph error flattening", () => {
    expect(isPlanningLifecycleLockTransportFailure(undefined, "Planning lifecycle lock acquisition timed out after 5000ms")).toBe(true);
    expect(isPlanningLifecycleLockTransportFailure(undefined, "Planning lifecycle lock transport unavailable: connection reset")).toBe(true);
    expect(isPlanningLifecycleLockTransportFailure(undefined, "request timed out")).toBe(false);
    expect(isPlanningLifecycleLockTransportFailure(undefined, "acquisition timed out")).toBe(false);
  });
});
