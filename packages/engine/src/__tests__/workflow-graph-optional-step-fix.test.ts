import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { MAX_RECOVERY_RETRIES } from "../recovery-policy.js";
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

  it("requeues the planning owner for a missing required artifact without consuming review revision budget", async () => {
    const store = createMockStore();
    const liveTask = task({ column: "in-progress", recoveryRetryCount: 0, postReviewFixCount: 0 });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 0 });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      stepName: "Plan Review",
      feedback: "PROMPT.md could not be loaded",
      phase: "pre-merge",
      status: "failed",
      failureValue: "required-artifact-missing:PROMPT.md",
      nodeId: "plan-review",
    });

    expect(scheduled).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith(liveTask.id, "triage");
    expect(store.updateTask).toHaveBeenCalledWith(liveTask.id, expect.objectContaining({
      status: "needs-replan",
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    }), undefined);
    for (const [, patch] of store.updateTask.mock.calls) {
      expect((patch as Partial<Task>).postReviewFixCount ?? 0).toBe(0);
    }
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:required-artifact-missing",
      metadata: expect.objectContaining({ artifactKeys: ["PROMPT.md"], action: "replan", attempt: 1 }),
    }));
  });

  /*
  FNXC:RequiredArtifactRecovery 2026-07-21-17:00:
  Protected lifecycle states suppress missing-artifact replanning. Storage read
  failures instead consume bounded graph-resume retries without being relabeled
  as confirmed absence or terminal task failure.
  */
  it.each([
    { label: "user-paused", patch: { paused: true, userPaused: true } },
    { label: "merged", patch: { column: "in-review", mergeDetails: { mergeConfirmed: true } } },
    { label: "manual-review", patch: { column: "in-review", autoMerge: false } },
  ])("does not replan a $label task when lifecycle state changes before recovery", async ({ patch }) => {
    const store = createMockStore();
    const initial = task({ recoveryRetryCount: 0 });
    const protectedTask = task({ ...patch } as Partial<Task>);
    store.getTask.mockResolvedValueOnce(initial).mockResolvedValue(protectedTask);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(initial.id, initial, {
      stepName: "Plan Review",
      feedback: "PROMPT.md could not be loaded",
      phase: "pre-merge",
      status: "failed",
      failureValue: "required-artifact-missing:PROMPT.md",
      nodeId: "plan-review",
    });

    expect(scheduled).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("honors a pause that races recovery immediately before the replan move", async () => {
    const store = createMockStore();
    const initial = task({ recoveryRetryCount: 0 });
    const paused = task({ paused: true, userPaused: true });
    store.getTask
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(paused);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).requestPreMergeOptionalStepFix(initial.id, initial, {
      stepName: "Plan Review",
      feedback: "PROMPT.md could not be loaded",
      phase: "pre-merge",
      status: "failed",
      failureValue: "required-artifact-missing:PROMPT.md",
      nodeId: "plan-review",
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("holds and retries a graph-entry storage read failure without replanning or failing", async () => {
    const store = createMockStore();
    const liveTask = task({ graphResumeRetryCount: 0 });
    store.getTask.mockResolvedValue(liveTask);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(liveTask, {
      disposition: "failed",
      outcome: "failure",
      reason: "workflow-required-artifact-read-failed:PROMPT.md:database unavailable",
      visitedNodeIds: ["workflow-entry-artifact"],
      context: { "node:workflow-entry-artifact:value": "required-artifact-read-failed:PROMPT.md" },
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(liveTask.id, {
      graphResumeRetryCount: 1,
    }, undefined);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      liveTask.id,
      expect.objectContaining({ status: "failed" }),
      undefined,
    );
  });

  it("parks visibly when missing-artifact recovery is exhausted", async () => {
    const store = createMockStore();
    const liveTask = task({ recoveryRetryCount: MAX_RECOVERY_RETRIES });
    store.getTask.mockResolvedValue(liveTask);
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      stepName: "Code Review",
      feedback: "PROMPT.md could not be loaded",
      phase: "pre-merge",
      status: "failed",
      failureValue: "required-artifact-missing:PROMPT.md",
      nodeId: "code-review",
    });

    expect(scheduled).toBe(true);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(liveTask.id, expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("REQUIRED_ARTIFACT_RECOVERY_EXHAUSTED"),
    }), undefined);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:required-artifact-missing",
      metadata: expect.objectContaining({ action: "park-failed" }),
    }));
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
        true,
        false,
        { attempt: 1, max: 3 },
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
      true,
      false,
      { attempt: 1, max: 2 },
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

  it("does not hard-cancel the graph that performs its own Plan Review replan move", async () => {
    const store = createMockStore();
    const liveTask = task({ postReviewFixCount: 0, column: "in-progress", status: null });
    store.getTask.mockResolvedValue(liveTask);
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
    const executor = new TaskExecutor(store, "/tmp/test");
    const abortSpy = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);
    store.moveTask.mockImplementation(async (_taskId: string, column: string) => {
      await (store as any)._triggerAsync("task:moved", {
        task: { ...liveTask, column },
        from: "in-progress",
        to: column,
        source: "engine",
      });
      return { ...liveTask, column };
    });

    (executor as any).graphRouting.add(liveTask.id);
    try {
      await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
        stepName: "Plan Review",
        feedback: "PROMPT.md needs a revision",
        phase: "pre-merge" as const,
        status: "failed" as const,
        verdict: "REVISE",
        nodeId: "plan-review",
      });

      expect(store.moveTask).toHaveBeenCalledWith(liveTask.id, "triage");
      expect(abortSpy).not.toHaveBeenCalled();
      expect((executor as any).pausedAborted.has(liveTask.id)).toBe(false);
    } finally {
      (executor as any).graphRouting.delete(liveTask.id);
    }
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
      /*
      FNXC:PlanReviewReplanCap 2026-07-19-2d:10 (U3 / SHIP):
      Cap-exhausted now returns TRUE, and true means "handled" — not "replanned". U3 re-owned the
      cap park from the deleted triage gate, so instead of silently leaving the task in place
      (the old `false`) the seam parks it awaiting-approval for a human. Asserting the park rather
      than the bare boolean is what makes this test state the contract: the replan did NOT happen,
      AND the task is now visibly waiting on a person.
      */
    })).resolves.toBe(true);
    expect(cappedStore.moveTask).not.toHaveBeenCalled();
    expect(cappedStore.updateTask).toHaveBeenCalledWith(
      "FN-7066",
      expect.objectContaining({ status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" }),
      undefined,
    );
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
      /*
      FNXC:PlanReviewReplanCap 2026-07-19-2d:10 (U3 / SHIP):
      Same U3 contract change as the finite-cap case above: the unbounded-default safety ceiling
      parks awaiting-approval instead of leaving the task in place, so the seam reports handled.
      The halt log moved with it — the escalation message names the cap and carries the reviewer's
      last feedback, which is the operator-visible half of "leaves the task for a human".
      */
    })).resolves.toBe(true);

    // Halted: no replan side effects.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-7066", { postReviewFixCount: 16 }, undefined);
    // Parked for a person, with the distinct replan-cap reason.
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-7066",
      expect.objectContaining({ status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" }),
      undefined,
    );
    // Loud, human-visible halt log naming the cap and the last feedback.
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7066",
      expect.stringContaining("Plan Review replan cap reached"),
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

  it.each([
    { label: "rate limited provider", feedback: "429 Too Many Requests", failureValue: undefined },
    { label: "model fallback exhaustion", feedback: "Unable to select a usable model after 2 attempts", failureValue: undefined },
    { label: "operator-actionable model access", feedback: "403 forbidden: insufficient permissions for this model", failureValue: undefined },
    { label: "network transport", feedback: "ECONNRESET while contacting reviewer", failureValue: undefined },
    { label: "websocket transport", feedback: "WebSocket closed 1006", failureValue: undefined },
    { label: "abort diagnostic", feedback: "request was aborted", failureValue: undefined },
    { label: "raw exception", feedback: "(no feedback captured)", failureValue: "exception" },
    { label: "raw abort", feedback: "(no feedback captured)", failureValue: "aborted" },
  ])("keeps a $label Plan Review failure in place without replanning", async ({ feedback, failureValue }) => {
    const store = createMockStore();
    const liveTask = task({ column: "in-progress", status: null });
    store.getTask.mockResolvedValue(liveTask);
    const executor = new TaskExecutor(store, "/tmp/test");

    const scheduled = await (executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
      stepName: "Plan Review",
      feedback,
      phase: "pre-merge" as const,
      status: "failed" as const,
      verdict: undefined,
      failureValue,
      nodeId: "plan-review",
    });

    expect(scheduled).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(liveTask.id, expect.objectContaining({ status: "needs-replan" }), undefined);
    expect(store.logEntry).toHaveBeenCalledWith(
      liveTask.id,
      "Plan Review provider failure — task kept in place",
      expect.stringContaining(liveTask.column),
      undefined,
    );
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

  it("keeps graph-owned Code Review remediation unbounded past the legacy three-pass display cap", async () => {
    for (const count of [0, 1, 2, 3, 4, 5, 6]) {
      const store = createMockStore();
      const liveTask = task({
        postReviewFixCount: count,
        log: Array.from({ length: count }, (_, index) => revisionLog("Code Review", "code-review", index + 1)),
      });
      store.getTask.mockResolvedValue(liveTask);
      // The generic optional-gate fallback stays three; the graph-owned Code Review
      // node must not inherit it when the workflow-specific value is unset.
      store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
      const executor = new TaskExecutor(store, "/tmp/test");
      const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

      await expect((executor as any).requestPreMergeOptionalStepFix(liveTask.id, liveTask, {
        ...reviseInfo,
        nodeId: "code-review",
      })).resolves.toBe(true);

      expect(store.logEntry).toHaveBeenCalledWith(
        liveTask.id,
        expect.stringContaining(`attempt ${count + 1}/unbounded`),
        expect.stringContaining("Workflow revision key: code-review"),
        undefined,
      );
      expect(sendBack).toHaveBeenCalledWith(
        liveTask,
        liveTask.worktree,
        reviseInfo.feedback,
        reviseInfo.stepName,
        expect.any(String),
        true,
        false,
        { attempt: count + 1, max: undefined },
      );
    }
  });

  it("keeps the retry presentation aligned with the next attempt during failed-step recovery", async () => {
    const store = createMockStore();
    const liveTask = task({
      column: "in-review",
      log: Array.from({ length: 3 }, (_, index) => revisionLog("Code Review", "code-review", index + 1)),
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Fix the review finding.",
        completedAt: new Date().toISOString(),
      }],
    });
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3 });
    const executor = new TaskExecutor(store, "/tmp/test");
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect(executor.recoverFailedPreMergeWorkflowStep(liveTask)).resolves.toBe(true);

    expect(sendBack).toHaveBeenCalledWith(
      liveTask,
      liveTask.worktree,
      "Fix the review finding.",
      "Code Review",
      expect.any(String),
      true,
      false,
      { attempt: 4, max: undefined },
    );
  });

  /*
   * FNXC:WorkflowRevisionBudget 2026-07-22-18:30:
   * Self-healing calls the failed-step recovery seam directly. It must not
   * bypass an operator's finite Code Review cap merely because the candidate
   * filter was skipped or raced; unlimited remains eligible by default.
   */
  it.each([
    { label: "zero automatic remediations", codeReviewMaxRevisions: 0, attempts: 0 },
    { label: "an exhausted finite cap", codeReviewMaxRevisions: 2, attempts: 2 },
  ])("does not recover Code Review after $label", async ({ codeReviewMaxRevisions, attempts }) => {
    const store = createMockStore();
    const liveTask = task({
      column: "in-review",
      log: Array.from({ length: attempts }, (_, index) => revisionLog("Code Review", "code-review", index + 1)),
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        output: "Fix the review finding.",
        completedAt: new Date().toISOString(),
      }],
    });
    store.getSettings.mockResolvedValue({ maxPostReviewFixes: 3, codeReviewMaxRevisions });
    const executor = new TaskExecutor(store, "/tmp/test");
    const sendBack = vi.spyOn(executor as any, "sendTaskBackForFix").mockResolvedValue(undefined);

    await expect(executor.recoverFailedPreMergeWorkflowStep(liveTask)).resolves.toBe(false);

    expect(sendBack).not.toHaveBeenCalled();
  });

  it("writes an unbounded retry label into Code Review remediation instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "fn-8503-"));
    const fusionDir = join(root, ".fusion");
    const promptPath = join(fusionDir, "tasks", "FN-7066", "PROMPT.md");
    try {
      await mkdir(join(fusionDir, "tasks", "FN-7066"), { recursive: true });
      await writeFile(promptPath, "# Task\n\n## Steps\n- Fix it\n");
      const store = createMockStore();
      store.getFusionDir.mockReturnValue(fusionDir);
      const executor = new TaskExecutor(store, "/tmp/test");

      await (executor as any).injectWorkflowStepFailureInstructions(
        task(),
        "Address the Code Review finding.",
        "Code Review",
        { attempt: 6, max: undefined },
      );

      await expect(readFile(promptPath, "utf8")).resolves.toContain("**Retry:** 6/unbounded (unlimited remaining)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
