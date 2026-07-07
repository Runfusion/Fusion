import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7066",
    title: "Optional step fix",
    description: "Fix optional workflow findings",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    prompt: "# Task\n## Steps\n### Step 0: Implement\n- [x] done",
    worktree: "/tmp/fusion/fn-7066",
    postReviewFixCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

const reviseInfo = {
  stepName: "Code Review",
  feedback: "packages/engine/src/example.ts:1 needs a guard",
  phase: "pre-merge" as const,
  status: "advisory_failure" as const,
  verdict: "REVISE",
};

function revisionLog(stepName: string, key: string, attempt: number) {
  return {
    timestamp: new Date().toISOString(),
    action: `Pre-merge optional workflow step requested executor fixes (attempt ${attempt}/2)`,
    outcome: `Step: ${stepName}\nWorkflow revision key: ${key}`,
  };
}

describe("TaskExecutor pre-merge optional-step fix seam", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("sends Code Review, Browser Verification, and gate-promoted pre-merge revisions back for remediation", async () => {
    const cases = [
      { stepName: "Code Review", status: "advisory_failure" as const, feedback: "review finding" },
      { stepName: "Browser Verification", status: "advisory_failure" as const, feedback: "browser finding" },
      { stepName: "Code Review", status: "failed" as const, feedback: "gate-promoted finding" },
    ];

    for (const testCase of cases) {
      const store = createMockStore();
      const liveTask = task({ postReviewFixCount: 0, worktree: "/tmp/fusion/fn-7066" });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
        ...reviseInfo,
        stepName: testCase.stepName,
        status: testCase.status,
        feedback: testCase.feedback,
      });

      expect(scheduled).toBe(true);
      expect(sendBack).toHaveBeenCalledWith(
        liveTask,
        "/tmp/fusion/fn-7066",
        testCase.feedback,
        testCase.stepName,
        expect.stringContaining("requested revision"),
      );
    }
  });

  it("does not bounce post-merge, fast-mode skipped, approved, or non-revision optional outcomes", async () => {
    const cases = [
      { phase: "post-merge" as const, status: "advisory_failure" as const, verdict: "REVISE" },
      { phase: "pre-merge" as const, status: "passed" as const, verdict: "APPROVE" },
      { phase: "pre-merge" as const, status: "passed" as const, verdict: "workflow-step-skipped" },
      { phase: "pre-merge" as const, status: "advisory_failure" as const, verdict: "APPROVE_WITH_NOTES" },
    ];

    for (const testCase of cases) {
      const store = createMockStore();
      const liveTask = task({ postReviewFixCount: 0 });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
        ...reviseInfo,
        ...testCase,
      });

      expect(scheduled).toBe(false);
      expect(sendBack).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ postReviewFixCount: expect.any(Number) }), undefined);
    }
  });

  it("consumes budget before sending the task back for optional-step remediation", async () => {
    const store = createMockStore();
    const liveTask = task({ postReviewFixCount: 0 });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 2 });
    const executor = new TaskExecutor(store, "/tmp/test");
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

    expect(scheduled).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 1 }, undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      expect.stringContaining("attempt 1/2"),
      expect.stringContaining("packages/engine/src/example.ts:1 needs a guard"),
      undefined,
    );
    expect(sendBack).toHaveBeenCalledWith(
      liveTask,
      "/tmp/fusion/fn-7066",
      "packages/engine/src/example.ts:1 needs a guard",
      "Code Review",
      expect.stringContaining("requested revision"),
    );
    expect(store.updateTask.mock.invocationCallOrder[0]).toBeLessThan(sendBack.mock.invocationCallOrder[0]);
  });

  it("routes Plan Review failures to triage replan instead of executor remediation", async () => {
    const store = createMockStore();
    const liveTask = task({ postReviewFixCount: 0, column: "in-progress", status: null });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).markPausedAborted(liveTask.id);
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      stepName: "Plan Review",
      feedback: "PROMPT.md is missing the new workflow-order requirement",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE",
      nodeId: "plan-review",
    });

    expect(scheduled).toBe(true);
    expect(sendBack).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      "AI spec revision requested",
      expect.stringContaining("PROMPT.md is missing the new workflow-order requirement"),
      undefined,
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      "Plan Review failed — moved to triage for automatic replan (attempt 1/unbounded)",
      expect.stringContaining("PROMPT.md is missing the new workflow-order requirement"),
      undefined,
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-7066", "triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 1 }, undefined);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7066", {
      status: "needs-replan",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      graphResumeRetryCount: 0,
    }, undefined);
    expect((executor as any).pausedAborted.has("FN-7066")).toBe(false);
  });

  it("honors Plan Review workflow-setting caps before automatic replan", async () => {
    const zeroStore = createMockStore();
    const zeroTask = task({ postReviewFixCount: 0, column: "in-progress" });
    zeroStore.getTask.mockResolvedValue(zeroTask);
    zeroStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 9, planReviewMaxRevisions: 0 });
    const zeroExecutor = new TaskExecutor(zeroStore, "/tmp/test");

    await expect((zeroExecutor as any).requestPreMergeOptionalStepFix(zeroTask.id, zeroTask, {
      stepName: "Plan Review",
      feedback: "needs spec edits",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE",
      nodeId: "plan-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(false);
    expect(zeroStore.moveTask).not.toHaveBeenCalled();
    expect(zeroStore.updateTask).not.toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 1 }, undefined);

    const cappedStore = createMockStore();
    const exhaustedTask = task({
      postReviewFixCount: 2,
      column: "in-progress",
      log: [revisionLog("Plan Review", "plan-review", 1), revisionLog("Plan Review", "plan-review", 2)],
    });
    cappedStore.getTask.mockResolvedValue(exhaustedTask);
    cappedStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 9, planReviewMaxRevisions: 2 });
    const cappedExecutor = new TaskExecutor(cappedStore, "/tmp/test");

    await expect((cappedExecutor as any).requestPreMergeOptionalStepFix(exhaustedTask.id, exhaustedTask, {
      stepName: "Plan Review",
      feedback: "needs spec edits",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE",
      nodeId: "plan-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(false);
    expect(cappedStore.moveTask).not.toHaveBeenCalled();
  });

  /*
   * FN-7561: the unbounded Plan Review replan default must still stop at a finite
   * safety ceiling. Below the cap it keeps replanning; at the cap it halts with a
   * loud log entry and leaves the task for a human instead of looping forever
   * (FN-7525 ran 13+ attempts overnight with no operator visibility).
   */
  it("keeps replanning an unbounded Plan Review loop just below the safety cap", async () => {
    const store = createMockStore();
    const belowLog = Array.from({ length: 14 }, (_, i) => revisionLog("Plan Review", "plan-review", i + 1));
    const loopingTask = task({ postReviewFixCount: 14, column: "in-progress", log: belowLog });
    store.getTask.mockResolvedValue(loopingTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 9 }); // no planReviewMaxRevisions → unbounded
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).requestPreMergeOptionalStepFix(loopingTask.id, loopingTask, {
      stepName: "Plan Review",
      feedback: "one more disagreement",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE",
      nodeId: "plan-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(true);

    expect(store.moveTask).toHaveBeenCalledWith("FN-7066", "triage");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      "Plan Review failed — moved to triage for automatic replan (attempt 15/unbounded)",
      expect.anything(),
      undefined,
    );
  });

  it("halts the unbounded Plan Review replan loop at the safety cap and leaves the task for a human", async () => {
    const store = createMockStore();
    const cappedLog = Array.from({ length: 15 }, (_, i) => revisionLog("Plan Review", "plan-review", i + 1));
    const loopingTask = task({ postReviewFixCount: 15, column: "in-progress", log: cappedLog });
    store.getTask.mockResolvedValue(loopingTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 9 }); // unbounded default
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).requestPreMergeOptionalStepFix(loopingTask.id, loopingTask, {
      stepName: "Plan Review",
      feedback: "still disagreeing after fifteen tries",
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: "REVISE",
      nodeId: "plan-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(false);

    // Halted: no replan side effects.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 16 }, undefined);
    // Loud, human-visible halt log.
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      expect.stringContaining("Plan Review replan safety cap reached (15/15)"),
      expect.stringContaining("still disagreeing after fifteen tries"),
      undefined,
    );
  });

  it("does not replan a malformed (advisory_failure, no verdict) Plan Review result", async () => {
    // FN-7561 invariant: a malformed reviewer response (no parseable verdict) is an
    // infra/formatting failure, not a plan defect, and must never bounce the task to triage.
    const store = createMockStore();
    const liveTask = task({ column: "in-progress" });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
    const executor = new TaskExecutor(store, "/tmp/test");

    await expect((executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      stepName: "Plan Review",
      feedback: "unparseable reviewer output",
      phase: "pre-merge" as const,
      status: "advisory_failure" as const,
      verdict: undefined,
      nodeId: "plan-review",
    })).resolves.toBe(false);

    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("clears stale pause-abort provenance silently before a fresh unpaused execution dispatch", async () => {
    const store = createMockStore();
    const liveTask = task({ column: "todo", paused: false, userPaused: false });
    store.getSettings.mockResolvedValue({ globalPause: false });
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).markPausedAborted(liveTask.id);

    await (executor as any).clearStalePauseAbortBeforeDispatch(liveTask);

    expect((executor as any).pausedAborted.has("FN-7066")).toBe(false);
    /*
     * FNXC:WorkflowLifecycle 2026-07-07-08:35:
     * FN-7335 wired a best-effort "Pause abort marked: provenance=… source=…" breadcrumb into markPausedAborted() itself (via safeLogEntry), so the setup markPausedAborted() call above now produces one store.logEntry. clearStalePauseAbortBeforeDispatch() must still clear SILENTLY: it logs via executorLog only and must NOT emit its own store.logEntry (the marker is volatile engine state, not a task event). Assert no "cleared stale pause-abort marker" log reached the store.
     */
    expect(
      store.logEntry.mock.calls.some(([, message]: [string, string]) =>
        /cleared stale pause-abort marker/i.test(message),
      ),
    ).toBe(false);
  });

  it("clears pause-abort provenance for manual retry", () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).markPausedAborted("FN-7066");

    executor.clearPauseAbortStateForManualRetry("FN-7066");

    expect((executor as any).pausedAborted.has("FN-7066")).toBe(false);
  });

  it("preserves pause-abort provenance while the task or engine is actually paused", async () => {
    for (const { taskPatch, settings } of [
      { taskPatch: { paused: true }, settings: { globalPause: false } },
      { taskPatch: { userPaused: true }, settings: { globalPause: false } },
      { taskPatch: { paused: false, userPaused: false }, settings: { globalPause: true } },
    ]) {
      const store = createMockStore();
      const liveTask = task({ column: "todo", ...taskPatch });
      store.getSettings.mockResolvedValue(settings);
      const executor = new TaskExecutor(store, "/tmp/test");
      (executor as any).markPausedAborted(liveTask.id);

      await (executor as any).clearStalePauseAbortBeforeDispatch(liveTask);

      expect((executor as any).pausedAborted.has("FN-7066")).toBe(true);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-7066",
        "Cleared stale pause-abort marker before unpaused execution dispatch",
        undefined,
        undefined,
      );
    }
  });

  it("uses the default budget of 3 for repeated fix passes and then declines when exhausted", async () => {
    const sendBackCalls: number[] = [];

    for (const count of [0, 1, 2, 3]) {
      const store = createMockStore();
      const liveTask = task({
        postReviewFixCount: count,
        log: Array.from({ length: count }, (_, index) => revisionLog("Code Review", "code review", index + 1)),
      });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({});
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockImplementation(async () => {
        sendBackCalls.push(count);
      });

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

      if (count < 3) {
        expect(scheduled).toBe(true);
        expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: count + 1 }, undefined);
        expect(store.logEntry).toHaveBeenCalledWith(
          "FN-7066",
          expect.stringContaining(`attempt ${count + 1}/3`),
          expect.any(String),
          undefined,
        );
        expect(sendBack).toHaveBeenCalledOnce();
      } else {
        expect(scheduled).toBe(false);
        expect(store.updateTask).not.toHaveBeenCalledWith("FN-7066", expect.objectContaining({ postReviewFixCount: 4 }), undefined);
        expect(sendBack).not.toHaveBeenCalled();
      }
    }

    expect(sendBackCalls).toEqual([0, 1, 2]);
  });

  it("lets per-step maxRevisions override the global budget", async () => {
    for (const count of [1, 2]) {
      const store = createMockStore();
      const liveTask = task({
        postReviewFixCount: count,
        log: Array.from({ length: count }, (_, index) => revisionLog("Code Review", "code review", index + 1)),
      });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: 9 });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
        ...reviseInfo,
        maxRevisions: 2,
      });

      expect(scheduled).toBe(count < 2);
      if (count < 2) {
        expect(store.logEntry).toHaveBeenCalledWith("FN-7066", expect.stringContaining("attempt 2/2"), expect.any(String), undefined);
        expect(sendBack).toHaveBeenCalledOnce();
      } else {
        expect(sendBack).not.toHaveBeenCalled();
      }
    }
  });

  it("adds declared File Scope boundaries to optional-step remediation instructions", () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const guard = (executor as any).buildWorkflowFailureScopeGuard(
      task({ sourceMetadata: { fileScope: ["packages/dashboard/app/components/WorkflowTabs.tsx"] } }),
      [
        "# Task",
        "",
        "## File Scope",
        "- `packages/dashboard/app/components/WorkflowTabs.css`",
        "",
        "## Steps",
        "- Implement",
      ].join("\n"),
    );

    expect(guard).toContain("Treat the declared File Scope as the remediation boundary");
    expect(guard).toContain("packages/dashboard/app/components/WorkflowTabs.css");
    expect(guard).toContain("packages/dashboard/app/components/WorkflowTabs.tsx");
    expect(guard).toContain("split them into a separate task");
  });

  it("honors workflow-setting revision caps before node and global budgets for Code Review", async () => {
    const cappedStore = createMockStore();
    const cappedTask = task({ postReviewFixCount: 1, log: [revisionLog("Code Review", "code-review", 1)] });
    cappedStore.getTask.mockResolvedValue(cappedTask);
    cappedStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 9, codeReviewMaxRevisions: 2 });
    const cappedExecutor = new TaskExecutor(cappedStore, "/tmp/test");
    const cappedSendBack = vi.spyOn(cappedExecutor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((cappedExecutor as any).requestPreMergeOptionalStepFix(cappedTask.id, cappedTask, {
      ...reviseInfo,
      nodeId: "code-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(true);
    expect(cappedStore.logEntry).toHaveBeenCalledWith("FN-7066", expect.stringContaining("attempt 2/2"), expect.any(String), undefined);
    expect(cappedSendBack).toHaveBeenCalledOnce();

    const zeroStore = createMockStore();
    const zeroTask = task({ postReviewFixCount: 0 });
    zeroStore.getTask.mockResolvedValue(zeroTask);
    zeroStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 9, codeReviewMaxRevisions: 0 });
    const zeroExecutor = new TaskExecutor(zeroStore, "/tmp/test");
    const zeroSendBack = vi.spyOn(zeroExecutor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((zeroExecutor as any).requestPreMergeOptionalStepFix(zeroTask.id, zeroTask, {
      ...reviseInfo,
      nodeId: "code-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(false);
    expect(zeroSendBack).not.toHaveBeenCalled();
  });

  it("keeps Plan Review and Code Review workflow caps independent", async () => {
    const store = createMockStore();
    const liveTask = task({
      postReviewFixCount: 1,
      log: [revisionLog("Plan Review", "plan-review", 1)],
    });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 9, planReviewMaxRevisions: 1, codeReviewMaxRevisions: 1 });
    const executor = new TaskExecutor(store, "/tmp/test");
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      ...reviseInfo,
      nodeId: "code-review",
      maxRevisions: "unbounded",
    })).resolves.toBe(true);

    expect(store.logEntry).toHaveBeenCalledWith("FN-7066", expect.stringContaining("attempt 1/1"), expect.stringContaining("Workflow revision key: code-review"), undefined);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 2 }, undefined);
    expect(sendBack).toHaveBeenCalledOnce();
  });

  it("honors unbounded and zero per-step maxRevisions states", async () => {
    const unboundedStore = createMockStore();
    const exhaustedTask = task({
      postReviewFixCount: 99,
      log: Array.from({ length: 99 }, (_, index) => revisionLog("Code Review", "code review", index + 1)),
    });
    unboundedStore.getTask.mockResolvedValue(exhaustedTask);
    unboundedStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 1 });
    const unboundedExecutor = new TaskExecutor(unboundedStore, "/tmp/test");
    const unboundedSendBack = vi.spyOn(unboundedExecutor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((unboundedExecutor as any).requestPreMergeOptionalStepFix(exhaustedTask.id, exhaustedTask, {
      ...reviseInfo,
      maxRevisions: "unbounded",
    })).resolves.toBe(true);
    expect(unboundedStore.logEntry).toHaveBeenCalledWith("FN-7066", expect.stringContaining("attempt 100/unbounded"), expect.any(String), undefined);
    expect(unboundedSendBack).toHaveBeenCalledOnce();

    const zeroStore = createMockStore();
    const liveTask = task({ postReviewFixCount: 0 });
    zeroStore.getTask.mockResolvedValue(liveTask);
    zeroStore.getSettings.mockResolvedValue({ maxPostReviewFixes: 9 });
    const zeroExecutor = new TaskExecutor(zeroStore, "/tmp/test");
    const zeroSendBack = vi.spyOn(zeroExecutor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect((zeroExecutor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      ...reviseInfo,
      maxRevisions: 0,
    })).resolves.toBe(false);
    expect(zeroSendBack).not.toHaveBeenCalled();
  });

  it("declines without sending back when maxPostReviewFixes disables or exhausts the budget", async () => {
    for (const { settingsMax, count } of [
      { settingsMax: 0, count: 0 },
      { settingsMax: 1, count: 1 },
    ]) {
      const store = createMockStore();
      const liveTask = task({
        postReviewFixCount: count,
        log: Array.from({ length: count }, (_, index) => revisionLog("Code Review", "code review", index + 1)),
      });
      store.getTask.mockResolvedValue(liveTask);
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: settingsMax });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, reviseInfo);

      expect(scheduled).toBe(false);
      expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ postReviewFixCount: expect.any(Number) }), expect.anything());
      expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ postReviewFixCount: expect.any(Number) }), undefined);
      expect(sendBack).not.toHaveBeenCalled();
    }
  });
});
