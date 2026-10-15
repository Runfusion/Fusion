import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { SelfHealingManager, COMPLETION_HANDOFF_LIMBO_GRACE_MS, MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES } from "../../self-healing.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4999-T",
    title: "t",
    description: "d",
    column: "in-review",
    dependencies: [],
    steps: [{ id: "1", title: "s", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function doneMarker(minutesAgo = 6) {
  return { action: "Task marked done by agent", timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString() } as any;
}

function createStore(
  task: Task,
  mergeQueuedTaskIds: string[] = [],
  logEntryOnce?: (taskId: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => Promise<boolean>,
) {
  let current = { ...task } as Task;
  const logEntry = vi.fn(async () => undefined);
  const recordedKeys = new Set<string>();
  const atomicLogEntryOnce = vi.fn(async (taskId: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => {
    if (recordedKeys.has(input.dedupeKey)) return false;
    recordedKeys.add(input.dedupeKey);
    await logEntry(taskId, input.action, input.outcome);
    return true;
  });
  return {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => [current]),
    getBranchGroup: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      current = { ...current, ...updates } as Task;
      return current;
    }),
    moveTask: vi.fn(async () => undefined),
    enqueueMergeQueue: vi.fn(async () => undefined),
    peekMergeQueue: vi.fn(() => mergeQueuedTaskIds.map((taskId) => ({
      taskId,
      enqueuedAt: new Date().toISOString(),
      priority: "normal",
      leasedBy: null,
      leasedAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      lastError: null,
    }))),
    logEntry,
    logEntryOnce: logEntryOnce ?? atomicLogEntryOnce,
    recordRunAuditEvent: vi.fn(async () => undefined),
    _get: () => current,
  } as any;
}

function limboTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    worktree: "/tmp/wt",
    status: undefined,
    review: undefined,
    reviewState: undefined,
    mergeDetails: undefined,
    log: [doneMarker()],
    ...overrides,
  });
}

describe("FN-4999 reliability interactions: completion-handoff-limbo", () => {
  it("recovers exact signature by requeueing auto-merge after accepted handoff", async () => {
    const store = createStore(limboTask());
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).toHaveBeenCalledTimes(1);
    expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-4999-T");
    expect(store.enqueueMergeQueue).toHaveBeenCalledWith("FN-4999-T");
    expect(store.logEntry).toHaveBeenCalledWith("FN-4999-T", expect.stringMatching(/Auto-recovered \(FN-4999\)/));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-completion-handoff-limbo",
      target: "FN-4999-T",
      metadata: expect.objectContaining({
        ageMs: expect.any(Number),
        source: "self-healing-in-review-sweep",
        attempts: 1,
      }),
    }));
    const event = store.recordRunAuditEvent.mock.calls.find((call: any[]) => call[0].mutationType === "task:auto-recover-completion-handoff-limbo")?.[0];
    expect(event.metadata.ageMs).toBeGreaterThanOrEqual(COMPLETION_HANDOFF_LIMBO_GRACE_MS);
  });

  it("re-seeds an enabled missing gate once and never re-emits merge", async () => {
    const store = createStore(limboTask({ enabledWorkflowSteps: ["code-review"] }));
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] }));
    let seeded = false;
    store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => {
      if (seeded) return { seeded: false, reason: "active-continuation" };
      seeded = true;
      return { seeded: true, reason: "seeded" };
    });
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(2);
    expect(seeded).toBe(true);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-4999-T",
      nodeId: "code-review",
      kind: "task",
      state: "runnable",
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: [] },
    }));
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).startsWith("[pre-merge] completion-handoff gate wait:")).length).toBe(1);
  });
  it.each([
    { label: "pending", result: { workflowStepId: "code-review", status: "pending" } },
    { label: "failed", result: { workflowStepId: "code-review", status: "failed" } },
    { label: "stale", result: { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", reviewInputFingerprint: "older-content" } },
  ])("waits once and never merges when an enabled gate is $label", async ({ result }) => {
    const store = createStore(limboTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [result as any],
    }));
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] }));
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toBeUndefined();
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).startsWith("[pre-merge] completion-handoff gate wait:")).length).toBe(1);
  });
  it("persists one gate wait when concurrent recovery workers observe the same signature", async () => {
    const persistedWaitActions: string[] = [];
    const persistedWaitKeys = new Set<string>();
    const logEntryOnce = vi.fn(async (_taskId: string, input: { action: string; dedupeKey: string }) => {
      // Yield once so both independent managers observe the same initial task
      // snapshot before the shared durable claim decides the append.
      await Promise.resolve();
      if (persistedWaitKeys.has(input.dedupeKey)) return false;
      persistedWaitKeys.add(input.dedupeKey);
      persistedWaitActions.push(input.action);
      return true;
    });
    const task = limboTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "code-review", status: "pending" }],
    });
    const firstStore = createStore(task, [], logEntryOnce);
    const secondStore = createStore(task, [], logEntryOnce);
    firstStore.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] }));
    secondStore.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] }));

    await Promise.all([
      new SelfHealingManager(firstStore, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) }).recoverCompletionHandoffLimbo(),
      new SelfHealingManager(secondStore, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) }).recoverCompletionHandoffLimbo(),
    ]);

    expect(logEntryOnce).toHaveBeenCalledTimes(2);
    expect(persistedWaitActions).toHaveLength(1);
    expect(persistedWaitActions[0]).toMatch(/^\[pre-merge\] completion-handoff gate wait:/);
    expect(firstStore.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(secondStore.enqueueMergeQueue).not.toHaveBeenCalled();
  });

  it("re-evaluates a changed gate signature without replaying the prior wait", async () => {
    const store = createStore(limboTask({ enabledWorkflowSteps: ["code-review"] }));
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: [] }));
    store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: false, reason: "active-continuation" }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) });
    await manager.recoverCompletionHandoffLimbo();
    store._get().workflowStepResults = [{ workflowStepId: "code-review", status: "pending" }];
    await manager.recoverCompletionHandoffLimbo();
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).startsWith("[pre-merge] completion-handoff gate wait:")).length).toBe(2);
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
  });
  it("is no-op before grace period elapses", async () => {
    const store = createStore(limboTask({ log: [doneMarker(0.5)] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) });
    await manager.recoverCompletionHandoffLimbo();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    { label: "scheduler pause", task: { paused: true } },
    { label: "user pause", task: { userPaused: true } },
    { label: "KB-2751-shaped user pause", task: { id: "KB-2751", userPaused: true } },
  ])("does not perform task-specific recovery side effects for $label", async ({ task }) => {
    const store = createStore(limboTask(task));
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });
  it("skips active tasks", async () => {
    const requeueForAutoMerge = vi.fn(() => true);
    const store = createStore(limboTask());
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge, isTaskActive: () => true });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  // FNXC:CompletionHandoffRecovery 2026-08-11-12:05: Manual holds suppress recovery unless a permitted live shared group owns the integration path.
  it.each([
    {
      label: "task-level user hold while project auto-merge is on",
      task: { autoMerge: false, autoMergeProvenance: "user" as const },
      projectAutoMerge: true,
    },
    {
      label: "standalone mission-policy hold while project auto-merge is on",
      task: { autoMerge: false, autoMergeProvenance: "mission" as const },
      projectAutoMerge: true,
    },
    {
      label: "inherited hold while project auto-merge is off",
      task: {},
      projectAutoMerge: false,
    },
  ])("preserves $label instead of recreating merge work", async ({ task, projectAutoMerge }) => {
    const store = createStore(limboTask(task));
    store.getSettings.mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      autoMerge: projectAutoMerge,
      integrationBranch: "main",
    });
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps a permitted live shared-group member recovery flowing", async () => {
    const store = createStore(limboTask({
      autoMerge: false,
      autoMergeProvenance: "mission",
      branchContext: { assignmentMode: "shared", groupId: "BG-4999", source: "mission" },
    }));
    store.getSettings.mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      autoMerge: true,
      integrationBranch: "main",
    });
    store.getBranchGroup.mockResolvedValue({
      id: "BG-4999",
      status: "open",
      branchName: "mission/M-4999",
    });
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(store.getBranchGroup).toHaveBeenCalledWith("BG-4999");
    expect(store.enqueueMergeQueue).toHaveBeenCalledWith("FN-4999-T");
    expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-4999-T");
  });

  it("honors legitimate merge blockers", async () => {
    const requeueForAutoMerge = vi.fn(() => true);
    const store = createStore(limboTask({ status: "failed" }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  it("is no-op when marker is absent", async () => {
    const requeueForAutoMerge = vi.fn(() => true);
    const store = createStore(limboTask({ log: [{ action: "workflow step", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  it("emits exhausted event and fails task at cap", async () => {
    const requeueForAutoMerge = vi.fn(() => true);
    const store = createStore(limboTask({ completionHandoffLimboRecoveryCount: MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-4999-T", expect.objectContaining({ status: "failed", error: "Completion handoff limbo recovery exhausted" }));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-recover-completion-handoff-limbo-exhausted" }));
  });

  it("increments completionHandoffLimboRecoveryCount on each accepted recovery", async () => {
    const store = createStore(limboTask());
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) });

    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();

    const increments = store.updateTask.mock.calls
      .map((call: any[]) => call[1]?.completionHandoffLimboRecoveryCount)
      .filter((value: unknown) => typeof value === "number");
    expect(increments).toEqual([1, 2, 3]);
  });

  it("does not increment completionHandoffLimboRecoveryCount when merge requeue is rejected", async () => {
    const store = createStore(limboTask({ completionHandoffLimboRecoveryCount: 2 }));
    const requeueForAutoMerge = vi.fn(() => false);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-4999-T");
    expect(store._get().completionHandoffLimboRecoveryCount).toBe(2);
    expect(store._get().status).toBeUndefined();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-completion-handoff-limbo",
    }));
  });

  it("increments completionHandoffLimboRecoveryCount when merge requeue is accepted", async () => {
    const store = createStore(limboTask({ completionHandoffLimboRecoveryCount: 1 }));
    const requeueForAutoMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(store._get().completionHandoffLimboRecoveryCount).toBe(2);
    expect(store.logEntry).toHaveBeenCalledWith("FN-4999-T", expect.stringMatching(/Auto-recovered \(FN-4999\)/));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-completion-handoff-limbo",
      metadata: expect.objectContaining({ attempts: 2 }),
    }));
  });

  it("skips tasks already held by the merge queue without incrementing the count", async () => {
    const store = createStore(limboTask({ completionHandoffLimboRecoveryCount: 1 }), ["FN-4999-T"]);
    const requeueForAutoMerge = vi.fn(() => false);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(store._get().completionHandoffLimboRecoveryCount).toBe(1);
    expect(store._get().status).toBeUndefined();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  // FNXC:CompletionHandoffRecovery 2026-08-11-12:05: Merge-queue ownership clears false exhaustion before auto-merge admission is evaluated.
  it("clears false handoff exhaustion for tasks already held by the merge queue", async () => {
    const store = createStore(limboTask({
      status: "failed",
      error: "Completion handoff limbo recovery exhausted",
      completionHandoffLimboRecoveryCount: MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES,
      autoMerge: false,
      autoMergeProvenance: "user",
    }), ["FN-4999-T"]);
    store.getSettings.mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      autoMerge: true,
      integrationBranch: "main",
    });
    const requeueForAutoMerge = vi.fn(() => false);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.enqueueMergeQueue).not.toHaveBeenCalled();
    expect(store._get().status).toBeNull();
    expect(store._get().error).toBeNull();
    expect(store._get().completionHandoffLimboRecoveryCount).toBe(0);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4999-T",
      "Auto-recovered: cleared false completion-handoff exhaustion while task is already owned by merge queue",
    );
  });

  it("exhausts only after three accepted limbo recoveries", async () => {
    const store = createStore(limboTask());
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn(() => true) });

    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    expect(store._get().completionHandoffLimboRecoveryCount).toBe(MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES);
    expect(store._get().status).toBeUndefined();

    await manager.recoverCompletionHandoffLimbo();

    expect(store.updateTask).toHaveBeenLastCalledWith("FN-4999-T", expect.objectContaining({
      status: "failed",
      error: "Completion handoff limbo recovery exhausted",
    }));
  });
});
