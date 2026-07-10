import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-06-19T00:00:00.000Z";

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

describe("merge-node paused-abort retry classification (FN-6735)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  /*
  Surface Enumeration coverage:
  - Merge seam node ids: legacy `merge`, `requestMerge`, primitive merge-region ids, and historical aliases all route through the same classifier.
  - Auto-merge paths: autopilot autoMerge:true and shared-branch local integration are both exercised.
  - Pause sources: benign hard-cancel/undefined-like generic pause is retried; global/user pause controls remain terminal.
  - Retry/data states: retry budget, mergeConfirmed partial landing, conflict, foreign/contamination, and pre-existing failure all avoid retry.
  - FN-5147/FN-7749: autoMerge:false human-gated in-review tasks preserve the manual merge hold cleanly without failed parking or requeueing.
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
    const { store, task, executor, mergeRequester } = makeHarness({
      autoMerge: undefined,
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

  it("clears stale already-parked autoMerge:false merge-node pause-abort failures in place", async () => {
    const staleError = "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'merge-manual-hold' — operator action required; retry or explicitly unpause/resume after inspecting the task";
    const { store, task, executor, mergeRequester } = makeHarness({ autoMerge: undefined, paused: false, status: "failed", error: staleError }, { autoMerge: false });

    await invokeGraphFailure(executor, task, "merge-manual-hold", "merge-finalize-blocked");

    expect(mergeRequester).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null, error: null }, undefined);
    expect(logText(store)).toContain("Auto-recovered: cleared stale auto-merge-off manual merge hold pause-abort failure — failure notification suppressed");
    expect(logText(store)).not.toContain("Workflow graph failure surfaced after paused engine abort during pause/resume");
  });

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
});
