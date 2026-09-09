import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { runWorkflowMergeAttemptNode } from "../../workflows/workflow-merge-nodes.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

const now = "2026-06-19T00:00:00.000Z";
const mergeNodes = [
  "merge", "requestMerge", "merge-gate", "merge-attempt",
  "manual-merge-hold", "merge-manual-hold", "retry-backoff", "merge-retry",
] as const;
const mergeReviewSurfaces = ["in-review", "approval-desk"].flatMap((column) =>
  mergeNodes.map((nodeId) => ({ column, nodeId })),
);

function stalePauseAbortError(nodeId: string, column = "in-review"): string {
  return `Workflow graph failure surfaced after paused engine abort during pause/resume in '${column}' at node '${nodeId}' — operator action required; retry or explicitly unpause/resume after inspecting the task`;
}

function configureRenamedLanes(store: ReturnType<typeof createMockStore>): void {
  const ir: WorkflowIr = {
    version: "v2",
    name: "Renamed lifecycle lanes",
    columns: [
      { id: "planning-desk", name: "Planning", traits: [{ trait: "hold" }] },
      { id: "implementation-desk", name: "Implementation", traits: [{ trait: "wip" }] },
      { id: "approval-desk", name: "Approval", traits: [{ trait: "merge" }, { trait: "merge-blocker" }, { trait: "human-review" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
    edges: [{ from: "start", to: "end" }],
  };
  store.getTaskWorkflowSelectionAsync.mockResolvedValue({ workflowId: "WF-rescue", stepIds: [] });
  store.getTaskWorkflowSelection.mockReturnValue({ workflowId: "WF-rescue", stepIds: [] });
  store.getWorkflowDefinition = vi.fn(async () => ({ id: "WF-rescue", name: ir.name, ir }));
}

function makeInReviewTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-6735-T",
    title: "Merge paused abort repro",
    description: "Reproduces benign merge pause abort classification",
    column: "in-review",
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "done" },
    ],
    currentStep: 1,
    log: [],
    branch: "fusion/fn-6735-t",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-6735-t",
    status: null,
    error: null,
    paused: true,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function makeHarness(taskOverrides: Partial<TaskDetail> = {}, settingsOverrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  const task = makeInReviewTask(taskOverrides);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
    maxAutoMergeRetries: 3,
    worktreeInitCommand: undefined,
    ...settingsOverrides,
  });
  if (["approval-desk", "implementation-desk", "planning-desk", "shipped"].includes(task.column)) {
    configureRenamedLanes(store);
  }
  const executor = new TaskExecutor(store, "/tmp/test", {});
  const mergeRequester = vi.fn(async () => ({
    task,
    branch: task.branch ?? "fusion/fn-6735-t",
    merged: true,
    noOp: false,
    worktreeRemoved: true,
    branchDeleted: true,
  }));
  executor.setMergeRequester(mergeRequester as any);
  (executor as any).markPausedAborted(task.id, "hard-cancel");
  return { store, task, executor, mergeRequester };
}

async function invokeGraphFailure(executor: TaskExecutor, task: TaskDetail, nodeId: string, value?: string) {
  await (executor as any).handleGraphFailure(task, {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["review", nodeId],
    context: value === undefined ? {} : { [`node:${nodeId}:value`]: value },
  });
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
}

async function produceImplementationIncompleteMergeNodeValue(task: TaskDetail): Promise<string> {
  const requestMerge = vi.fn().mockResolvedValue({
    outcome: "failure",
    value: "implementation-incomplete",
    data: { status: "failed", reason: "implementation-incomplete" },
  });
  const result = await runWorkflowMergeAttemptNode({
    primitives: { requestMerge, audit: vi.fn() },
  }, {
    run: { runId: "run-implementation-incomplete", taskId: task.id, workflowId: "builtin:coding" },
    node: { node: { id: "merge-attempt", kind: "merge-attempt" } },
  }, task);

  expect(requestMerge).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    outcome: "failure",
    value: "implementation-incomplete",
    contextPatch: { "workflow:merge-status": "implementation-incomplete" },
  });
  return result.value!;
}

describe("merge-node paused-abort retry classification (FN-6735)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  /*
  Surface Enumeration coverage:
  - Merge seam node ids: legacy `merge`, `requestMerge`, primitive merge-region ids, and historical aliases all route through the same classifier.
  - Auto-merge paths: autopilot autoMerge:true and shared-branch local integration are both exercised.
  - Pause sources: benign hard-cancel/undefined-like generic pause is retried; global/user pause controls remain terminal; system pause (`paused` without userPaused/global-pause) still classifies implementation-incomplete fail-closed/resumable.
  - Retry/data states: retry budget, mergeConfirmed partial landing, conflict, foreign/contamination, and pre-existing failure all avoid retry.
  - FN-5147/FN-7749: autoMerge:false human-gated in-review tasks preserve the manual merge hold cleanly without failed parking or requeueing.
  - Worktree tracking: resumable implementation-incomplete requeue keeps activeWorktrees registration when a worktree is preserved; fail-closed releases it.
  */
  it.each([
    "merge",
    "requestMerge",
    "merge-gate",
    "merge-attempt",
    "manual-merge-hold",
    "merge-manual-hold",
    "retry-backoff",
    "merge-retry",
  ] as const)("re-enqueues benign paused merge graph failure at node %s without operator-action failure", async (nodeId) => {
    const { store, task, executor, mergeRequester } = makeHarness();

    await invokeGraphFailure(executor, task, nodeId);

    expect(mergeRequester).toHaveBeenCalledWith(task.id);
    const messages = logText(store);
    expect(messages).toContain(`Workflow graph merge failure at node '${nodeId}' routed to bounded auto-merge retry after benign pause/resume abort`);
    expect(messages).not.toContain("Workflow graph failure surfaced after paused engine abort during pause/resume");
    expect(messages).not.toContain("operator action required");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      undefined,
    );
  });

  it("allows shared-branch-group local integration to retry even when global autoMerge is off", async () => {
    // FN-8823 (3dd824d04e): under project auto-merge Off, a shared-branch member is HELD unless its
    // task explicitly opts in with autoMerge: true (see AGENTS.md "autoMerge: false callout"). The
    // invariant this test guards — shared local integration retries under global Off — now requires
    // that explicit member opt-in; an undefined member autoMerge is fenced by design.
    const { store, task, executor, mergeRequester } = makeHarness({
      autoMerge: true,
      branchContext: { groupId: "BG-6735", source: "mission", assignmentMode: "shared" },
    }, { autoMerge: false });

    await invokeGraphFailure(executor, task, "merge-gate");

    expect(mergeRequester).toHaveBeenCalledWith(task.id);
    expect(logText(store)).toContain("routed to bounded auto-merge retry after benign pause/resume abort");
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }), undefined);
  });

  it("retries FN-7335-style merge pause aborts while AI merge review status is active", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ status: "reviewing" });

    await invokeGraphFailure(executor, task, "merge");

    expect(mergeRequester).toHaveBeenCalledWith(task.id);
    const messages = logText(store);
    expect(messages).toContain("Pause abort classified: provenance=hard-cancel; node=merge");
    expect(messages).toContain("column=in-review; status=reviewing");
    expect(messages).toContain("Workflow graph merge failure at node 'merge' routed to bounded auto-merge retry after benign pause/resume abort");
    expect(messages).not.toContain("operator action required");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      undefined,
    );
  });

  it("parks genuine merge conflicts as terminal instead of retrying forever", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ autoMerge: undefined, paused: false }, { autoMerge: false });

    await invokeGraphFailure(executor, task, "merge", "merge-conflict");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("operator action required") }),
      undefined,
    );
  });

  it("parks contaminated or foreign-only merge graph failures as terminal", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ autoMerge: undefined, paused: false }, { autoMerge: false });

    await invokeGraphFailure(executor, task, "merge-attempt", "foreign-only-contamination");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("operator action required") }),
      undefined,
    );
  });

  it("respects exhausted mergeRetries budget by terminal parking", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ mergeRetries: 3 });

    await invokeGraphFailure(executor, task, "retry-backoff");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("operator action required") }),
      undefined,
    );
  });

  it("leaves pre-existing real failures unchanged and does not re-enqueue", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ status: "failed", error: "real failure before graph unwind" });

    await invokeGraphFailure(executor, task, "merge");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    "merge",
    "requestMerge",
    "merge-gate",
    "merge-attempt",
    "manual-merge-hold",
    "merge-manual-hold",
    "retry-backoff",
    "merge-retry",
  ] as const)("honors a durable merger blocker at node %s after the task rebounded", async (nodeId) => {
    const blocker = "no-commits task has incomplete work with no net branch changes";
    const { store, task, executor, mergeRequester } = makeHarness({
      column: "todo",
      status: null,
      error: blocker,
      paused: false,
    });

    await invokeGraphFailure(executor, task, nodeId, blocker);

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    const messages = logText(store);
    expect(messages).toContain("honoring park, not retrying or resuming merge");
    expect(messages).not.toContain("routed to bounded auto-merge retry");
  });

  it.each([
    "merge",
    "requestMerge",
    "merge-gate",
    "merge-attempt",
    "manual-merge-hold",
    "merge-manual-hold",
    "retry-backoff",
    "merge-retry",
  ] as const)("preserves human-gated autoMerge:false in-review manual hold at node %s", async (nodeId) => {
    const { store, task, executor, mergeRequester } = makeHarness({ autoMerge: undefined, paused: false }, { autoMerge: false });

    await invokeGraphFailure(executor, task, nodeId, "merge-finalize-blocked");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      undefined,
    );
    expect(logText(store)).toContain("Workflow graph run ended at manual merge hold with auto-merge off — benign, in-review manual-hold state preserved for Merge & Close");
    expect(logText(store)).not.toContain("Workflow graph failure surfaced after paused engine abort during pause/resume");
    expect(logText(store)).not.toContain("operator action required");
  });

  it("preserves task-level autoMerge:false manual hold when global autoMerge is on", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ autoMerge: false, paused: false }, { autoMerge: true });

    await invokeGraphFailure(executor, task, "merge-manual-hold", "merge-finalize-blocked");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }), undefined);
    expect(logText(store)).toContain("manual merge hold with auto-merge off");
  });

  /*
  FNXC:ManualMergeHoldRescue 2026-09-09-09:13:
  Stale pause-abort errors are not durable merger blockers. Recover only the matching merge-node
  signature on an unpaused, human-gated review row, across aliases and workflow-renamed lanes.
  The same rows with real pause/cancel/blocker evidence must remain untouched.
  */
  it.each(mergeReviewSurfaces)("clears a stale manual hold at $nodeId in $column in place", async ({ nodeId, column }) => {
    const { store, task, executor, mergeRequester } = makeHarness({
      column, autoMerge: undefined, paused: false, status: "failed", error: stalePauseAbortError(nodeId, column),
    }, { autoMerge: false });
    (executor as any).addActiveWorktree(task.id, task.worktree);

    await invokeGraphFailure(executor, task, nodeId, "merge-finalize-blocked");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { status: null, error: null }, undefined);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(await store.getTask(task.id)).toMatchObject({ column, status: null, error: null, steps: task.steps, worktree: task.worktree });
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect(logText(store)).toContain("Auto-recovered: cleared stale auto-merge-off manual merge hold pause-abort failure — failure notification suppressed");
    expect(logText(store)).not.toContain("honoring park, not retrying or resuming merge");
  });

  it.each(mergeReviewSurfaces)("honors the durable park when manual-hold classification rejects at $nodeId in $column", async ({ nodeId, column }) => {
    const { store, task, executor, mergeRequester } = makeHarness({
      column, autoMerge: undefined, paused: false, status: "failed", error: stalePauseAbortError(nodeId, column),
    }, { autoMerge: false });
    (executor as any).addActiveWorktree(task.id, task.worktree);
    const sharedGroupLookup = vi.spyOn(executor as any, "isLiveSharedBranchGroupMember")
      .mockRejectedValue(new Error("shared branch-group lookup unavailable"));
    const persistTokenUsage = vi.spyOn(executor as any, "persistTokenUsage").mockResolvedValue(undefined);
    const parkedTask = structuredClone(task);

    await invokeGraphFailure(executor, task, nodeId, "merge-finalize-blocked");

    expect(sharedGroupLookup).toHaveBeenCalledExactlyOnceWith(task);
    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(await store.getTask(task.id)).toEqual(parkedTask);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
    expect((executor as any).pausedAborted.has(task.id)).toBe(false);
    expect((executor as any).pausedAbortProvenance.has(task.id)).toBe(false);
    expect(persistTokenUsage).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(logText(store)).toContain("honoring park, not retrying or resuming merge");
    expect(logText(store)).not.toContain("Auto-recovered: cleared stale");
  });

  const recoveryFences: Array<{ name: string; overrides?: Partial<TaskDetail>; value?: string; provenance?: string; cancel?: boolean; clearAbort?: boolean }> = [
    { name: "live system pause", overrides: { paused: true, pausedReason: "system-pause-park" } },
    { name: "explicit user pause", overrides: { userPaused: true } },
    { name: "global pause", provenance: "global-pause" },
    { name: "operator cancellation", cancel: true },
    { name: "absent abort marker", clearAbort: true },
    { name: "merge conflict", value: "merge-conflict" },
    { name: "contamination", value: "foreign-only-contamination" },
    { name: "retry exhaustion", value: "merge-retry-exhausted" },
    { name: "unproven merge boundary", value: "merge-boundary-unproven" },
    { name: "real failure", overrides: { error: "real failure before graph unwind" } },
    { name: "durable dependency blocker", overrides: { error: "BLOCKED: dependency unavailable" } },
    { name: "empty review park", overrides: { error: "NO REVIEWABLE CONTENT: no task diff" } },
    { name: "auto merge enabled", overrides: { autoMerge: true } },
    { name: "different stale node", overrides: { error: stalePauseAbortError("parse") } },
  ];
  it.each(mergeReviewSurfaces.flatMap((surface) => recoveryFences.map((fence) => ({ ...surface, ...fence }))))(
    "preserves $name at $nodeId in $column instead of clearing a manual hold",
    async ({ nodeId, column, overrides, value, provenance, cancel, clearAbort }) => {
      const { store, task, executor, mergeRequester } = makeHarness({
        column, autoMerge: undefined, paused: false, status: "failed", error: stalePauseAbortError(nodeId, column), ...overrides,
      }, { autoMerge: false });
      if (provenance) (executor as any).markPausedAborted(task.id, provenance);
      if (cancel) (executor as any).userCanceledTaskIds.add(task.id);
      if (clearAbort) (executor as any).clearPausedAborted(task.id);

      await invokeGraphFailure(executor, task, nodeId, value ?? "merge-finalize-blocked");

      expect(mergeRequester).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(await store.getTask(task.id)).toMatchObject({ column, status: task.status, error: task.error });
      expect(logText(store)).not.toContain("Auto-recovered: cleared stale");
    },
  );

  it("preserves global and explicit user pause terminal behavior", async () => {
    const globalHarness = makeHarness();
    (globalHarness.executor as any).markPausedAborted(globalHarness.task.id, "global-pause");

    await invokeGraphFailure(globalHarness.executor, globalHarness.task, "merge");

    expect(globalHarness.mergeRequester).not.toHaveBeenCalled();
    expect(globalHarness.store.updateTask).toHaveBeenCalledWith(
      globalHarness.task.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("global pause") }),
      undefined,
    );

    const userHarness = makeHarness({ userPaused: true });
    await invokeGraphFailure(userHarness.executor, userHarness.task, "merge");

    expect(userHarness.mergeRequester).not.toHaveBeenCalled();
    expect(userHarness.store.updateTask).toHaveBeenCalledWith(
      userHarness.task.id,
      expect.objectContaining({ status: "failed", error: expect.stringContaining("explicit user pause") }),
      undefined,
    );
  });

  it("finalizes merge-confirmed partial landing evidence without retrying merge", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({ mergeDetails: { mergeConfirmed: true } as any });

    await invokeGraphFailure(executor, task, "merge");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: null, error: null, paused: false }),
    );
  });

  const implementationIncompleteMergeNodes = [
    "merge",
    "requestMerge",
    "merge-gate",
    "merge-attempt",
    "manual-merge-hold",
    "merge-manual-hold",
    "retry-backoff",
    "merge-retry",
  ] as const;

  it.each(["merge-attempt", "merge"] as const)("routes primitive-produced implementation-incomplete no-proof failure at node %s without requesting no-op merge", async (nodeId) => {
    const { store, task, executor, mergeRequester } = makeHarness({
      steps: [],
      currentStep: 0,
      branch: null,
      worktree: null,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: false,
    } as Partial<TaskDetail>);
    (executor as any).addActiveWorktree(task.id, "/tmp/fusion-fn-9166-fail-closed");

    const value = await produceImplementationIncompleteMergeNodeValue(task);
    await invokeGraphFailure(executor, task, nodeId, value);

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("implementation incomplete with no executable proof to resume"),
      }),
      undefined,
    );
    expect(logText(store)).toContain(`Workflow graph merge blocked at node '${nodeId}': implementation incomplete with no executable proof to resume — failing instead of retrying merge`);
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
  });

  it.each(["merge-attempt", "merge"] as const)("contains primitive-produced implementation-incomplete review failure at node %s without requesting merge", async (nodeId) => {
    const worktreePath = "/tmp/fusion-fn-9166-resumable";
    const { store, task, executor, mergeRequester } = makeHarness({
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      branch: "fusion/fn-9166-resumable",
      worktree: worktreePath,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: false,
    } as Partial<TaskDetail>);
    (executor as any).addActiveWorktree(task.id, worktreePath);

    const value = await produceImplementationIncompleteMergeNodeValue(task);
    await invokeGraphFailure(executor, task, nodeId, value);

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(logText(store)).toContain("automatic recovery cannot move 'in-review' backward");
    expect(await store.getTask(task.id)).toMatchObject({ column: "in-review", status: "failed", steps: task.steps, worktree: worktreePath });
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
  });

  it.each(implementationIncompleteMergeNodes)("fails implementation-incomplete no-proof merge pause abort at node %s without requesting no-op merge", async (nodeId) => {
    const { store, task, executor, mergeRequester } = makeHarness({
      steps: [],
      currentStep: 0,
      branch: null,
      worktree: null,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: false,
    } as Partial<TaskDetail>);
    mergeRequester.mockImplementation(async () => {
      await store.updateTask(task.id, {
        mergeDetails: {
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason: "no-branch",
        },
      });
      return {
        task,
        branch: null,
        merged: true,
        noOp: true,
        mergeConfirmed: true,
        reason: "no-branch",
        worktreeRemoved: false,
        branchDeleted: false,
      } as any;
    });

    await invokeGraphFailure(executor, task, nodeId, "implementation-incomplete");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "done", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        mergeDetails: expect.objectContaining({ noOpMerge: true, noOpReason: "no-branch" }),
      }),
      expect.anything(),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("implementation incomplete with no executable proof to resume"),
      }),
      undefined,
    );
    const messages = logText(store);
    expect(messages).toContain(`Workflow graph merge blocked at node '${nodeId}': implementation incomplete with no executable proof to resume — failing instead of retrying merge`);
    expect(messages).not.toContain("routed to bounded auto-merge retry after benign pause/resume abort");
  });

  /*
  FNXC:LifecycleContainment 2026-09-09-09:13:
  Automatic merge recovery never grants review-to-WIP authority. Incomplete review work stays
  failed in review; the same pending work already in WIP resumes in place, including renamed lanes.
  */
  it.each(["in-review", "approval-desk", "in-progress", "implementation-desk"].flatMap((column) =>
    mergeNodes.map((nodeId) => ({ column, nodeId })),
  ))("contains implementation-incomplete parsed steps at $nodeId in $column without requesting merge", async ({ nodeId, column }) => {
    const { store, task, executor, mergeRequester } = makeHarness({
      column,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      branch: null,
      worktree: null,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: false,
    } as Partial<TaskDetail>);

    await invokeGraphFailure(executor, task, nodeId, "implementation-incomplete");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    const messages = logText(store);
    if (column === "in-progress" || column === "implementation-desk") {
      expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null, error: null }, undefined);
      expect(await store.getTask(task.id)).toMatchObject({ column, status: null, error: null, steps: task.steps });
      expect(messages).toContain(`with incomplete work — resuming in place in '${column}'`);
    } else {
      expect(store.updateTask).toHaveBeenCalledWith(task.id, {
        status: "failed",
        error: expect.stringContaining("implementation incomplete with no executable proof to resume"),
      }, undefined);
      expect(await store.getTask(task.id)).toMatchObject({ column, status: "failed", steps: task.steps });
      expect(messages).toContain(`automatic recovery cannot move '${column}' backward`);
    }
    expect(messages).not.toContain("routed to bounded auto-merge retry after benign pause/resume abort");
  });

  /*
  FNXC:WorkflowMerge 2026-07-14-18:20:
  Greptile P1 regressions for FN-1165: system-paused rows must still classify, and resumable requeue must not drop active worktree tracking while preserving a persisted worktree.
  */
  it("classifies system-paused implementation-incomplete merge failures fail-closed instead of pause-abort parking", async () => {
    const { store, task, executor, mergeRequester } = makeHarness({
      steps: [],
      currentStep: 0,
      branch: null,
      worktree: null,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      // System pause park (not userPaused / not global-pause provenance).
      paused: true,
      userPaused: false,
      pausedReason: "awaiting-engine-recovery",
    } as Partial<TaskDetail>);
    (executor as any).addActiveWorktree(task.id, "/tmp/fusion-fn-1165-fail-closed");

    await invokeGraphFailure(executor, task, "merge", "implementation-incomplete");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("implementation incomplete with no executable proof to resume"),
      }),
      undefined,
    );
    const messages = logText(store);
    expect(messages).toContain("Workflow graph merge blocked at node 'merge': implementation incomplete with no executable proof to resume — failing instead of retrying merge");
    expect(messages).not.toContain("operator action required");
    expect(messages).not.toContain("benign, paused awaiting explicit unpause");
    // Fail-closed may release tracking — no second worktree will be allocated for a terminal row.
    expect((executor as any).activeWorktrees.has(task.id)).toBe(false);
  });

  it("resumes system-paused implementation-incomplete WIP steps in place and keeps active worktree tracking", async () => {
    const worktreePath = "/tmp/fusion-fn-1165-resumable-wt";
    const { store, task, executor, mergeRequester } = makeHarness({
      column: "in-progress",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      branch: "fusion/fn-1165-resumable",
      worktree: worktreePath,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: true,
      userPaused: false,
      pausedReason: "system-pause-park",
    } as Partial<TaskDetail>);
    (executor as any).addActiveWorktree(task.id, worktreePath);

    await invokeGraphFailure(executor, task, "merge", "implementation-incomplete");

    expect(mergeRequester).not.toHaveBeenCalled();
    // FNXC:LifecycleContainment 2026-09-09-09:13: Clear system pause without moving the WIP row.
    expect(store.updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ paused: false, pausedReason: null }),
      undefined,
    );
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(await store.getTask(task.id)).toMatchObject({ column: "in-progress", status: null, error: null, paused: false, steps: task.steps });
    const messages = logText(store);
    expect(messages).toContain("with incomplete work — resuming in place in 'in-progress'");
    expect(messages).not.toContain("operator action required");
    // Resumable path keeps active registration so the preserved worktree stays counted.
    expect((executor as any).activeWorktrees.has(task.id)).toBe(true);
    expect((executor as any).getActiveWorktreePaths(task.id)).toEqual([worktreePath]);
  });

  it("keeps active worktree tracking on non-paused implementation-incomplete WIP resume", async () => {
    const worktreePath = "/tmp/fusion-fn-1165-unpaused-resumable-wt";
    const { store, task, executor, mergeRequester } = makeHarness({
      column: "in-progress",
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      branch: "fusion/fn-1165-unpaused",
      worktree: worktreePath,
      modifiedFiles: undefined,
      workflowStepResults: undefined,
      paused: false,
    } as Partial<TaskDetail>);
    (executor as any).addActiveWorktree(task.id, worktreePath);

    await invokeGraphFailure(executor, task, "merge-gate", "implementation-incomplete");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(await store.getTask(task.id)).toMatchObject({ column: "in-progress", status: null, error: null, steps: task.steps, worktree: worktreePath });
    expect((executor as any).activeWorktrees.has(task.id)).toBe(true);
    expect((executor as any).getActiveWorktreePaths(task.id)).toEqual([worktreePath]);
  });

});
