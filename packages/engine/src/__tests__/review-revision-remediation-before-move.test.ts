import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR,
  BUILTIN_CODING_IDEAS_WORKFLOW_IR,
  resolveStepReopenPolicy,
  planRemediationPlacement,
  type Task,
  type TaskStep,
} from "@fusion/core";

import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { claimRemediationAttempt, resolveRemediationAttempt } from "../executor/claim-review-remediation-attempt.js";
import { recoverFailedPreMergeWorkflowStep } from "../executor/recover-failed-pre-merge-step.js";
import { sendTaskBackForFix } from "../executor/send-task-back-for-fix.js";
import { performWorkflowRerunBounce } from "../executor/workflow-rerun-bounce.js";

function failedReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-267-symptom",
    title: "Review remediation ordering",
    description: "Reproduce the review-to-WIP empty bounce.",
    column: "in-review",
    worktree: "/tmp/fn-267-symptom",
    modifiedFiles: ["packages/engine/src/self-healing.ts"],
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Code Review", status: "done" },
    ],
    currentStep: 2,
    log: [],
    createdAt: "2026-08-30T09:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewKind: "code",
      reviewInputFingerprint: "fn-264-review-input",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:01:00.000Z",
      findings: [{
        id: "critical-self-healing-orphan",
        severity: "critical",
        filePath: "packages/engine/src/self-healing.ts",
        line: 1,
        title: "Retained empty task container",
        body: "Prune the empty task container after an active-session deferral.",
      }],
    }],
    ...overrides,
  } as Task;
}

function createRecoveryHarness(workflowId: "builtin:coding-ideas-v2" | "builtin:coding-ideas") {
  const row = failedReviewTask();
  const calls: string[] = [];
  let bounce: Promise<unknown> | undefined;
  const store = {
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTask: vi.fn(async () => row),
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      calls.push("updateTask");
      Object.assign(row, patch);
      return row;
    }),
    appendRemediationSteps: vi.fn(async (_id: string, steps: readonly TaskStep[], options: { wave?: number }) => {
      calls.push("appendRemediationSteps");
      const appended = steps.map((step) => ({ ...step, status: "pending" as const }));
      const placement = planRemediationPlacement(row.steps ?? [], appended);
      row.steps = placement.steps;
      return { task: row, appended, appendedCount: appended.length, wave: options.wave ?? 1, ...placement };
    }),
    addTaskComment: vi.fn(async () => {
      calls.push("addTaskComment");
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      calls.push(`logEntry:${action}`);
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      calls.push("moveTask");
      row.column = column;
      return row;
    }),
  };
  const scheduleWorkflowRerun = vi.fn((taskId: string, worktreePath: string, _reason: string, preserve: boolean, persist: boolean) => {
    bounce = performWorkflowRerunBounce({
      store,
      workflowRerunPending: new Set<string>(),
      getExecutionPauseLabel: vi.fn(async () => null),
      resolveResumeLanes: vi.fn(async () => ({ review: "in-review", wip: "in-progress" })),
      clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
    } as never, taskId, worktreePath, preserve, persist);
  });
  const sendBack = (...args: Parameters<typeof sendTaskBackForFix> extends [unknown, ...infer Rest] ? Rest : never) =>
    sendTaskBackForFix({
      store,
      clearCompletedTaskWatchdog: vi.fn(),
      injectWorkflowStepFailureInstructions: vi.fn(async () => undefined),
      reopenLastStepForRevision: vi.fn(async (taskId: string) => {
        calls.push("reopenLastStepForRevision");
        const live = await store.getTask(taskId);
        live.steps = [...(live.steps ?? []), { name: "Documentation & Delivery", status: "pending" }];
      }),
      scheduleWorkflowRerun,
      maxWorkflowStepRetries: 3,
    } as never, ...args);
  const append = (task: Task, info: Parameters<typeof appendReviewRemediationSteps>[2][1]) =>
    appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: vi.fn(async () => "## File Scope\n- `packages/engine/src/self-healing.ts`\n"), sendTaskBackForFix: sendBack },
      task,
      info,
    );
  return { row, calls, store, append, sendBack, waitForBounce: async () => bounce };
}

describe("FN-267 review remediation precedes review-to-WIP movement", () => {
  it("admits one keyable review episode before a counter, narration, or recovery can run", async () => {
    const row = failedReviewTask();
    const store = {
      getTask: vi.fn(async () => row),
      updateWorkflowStepResultsFenced: vi.fn(async (_id: string, compute: (current: Task) => { workflowStepResults: Task["workflowStepResults"] } | null) => {
        const patch = compute(row);
        if (!patch) return { applied: false as const, reason: "refused" as const };
        row.workflowStepResults = patch.workflowStepResults;
        return { applied: true as const, task: row };
      }),
    };
    const target = row.workflowStepResults![0]!;
    const first = await claimRemediationAttempt(store as never, row.id, target, "test", row);
    const second = await claimRemediationAttempt(store as never, row.id, target, "test", row);

    expect(first.kind).toBe("claimed");
    expect(second.kind).toBe("held");
    expect(store.updateWorkflowStepResultsFenced).toHaveBeenCalledTimes(2);
    if (first.kind === "claimed") {
      await expect(resolveRemediationAttempt(store as never, row.id, first.claim, "release")).resolves.toMatchObject({ applied: true });
      expect(row.workflowStepResults![0]).not.toHaveProperty("remediationAttemptOwner");
    }
  });
  it("reproduces the FN-264 none-policy empty bounce until recovery appends named remediation", async () => {
    const harness = createRecoveryHarness("builtin:coding-ideas-v2");
    expect(resolveStepReopenPolicy(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR)).toBe("none");

    await recoverFailedPreMergeWorkflowStep({
      store: harness.store as never,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, label: "unbounded", key: "code-review", attempts: 0,
      })),
      appendReviewRemediationSteps: harness.append,
      sendTaskBackForFix: harness.sendBack,
    } as never, harness.row);
    const outcome = await harness.waitForBounce();

    expect(outcome).toBe("bounced");
    expect(harness.row.column).toBe("in-progress");
    expect(harness.row.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "pending",
        remediation: expect.objectContaining({ gate: "Code Review", findingId: "critical-self-healing-orphan" }),
      }),
    ]));
    expect(harness.calls.indexOf("appendRemediationSteps")).toBeLessThan(harness.calls.indexOf("moveTask"));
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      harness.row.id,
      "Workflow rerun refused — no pending remediation work",
      expect.anything(),
    );
  });

  it("returns an incomplete Code Review REVISE to WIP with a deterministic Fix step", async () => {
    const harness = createRecoveryHarness("builtin:coding-ideas-v2");
    harness.row.workflowStepResults![0]!.findings = [];

    await recoverFailedPreMergeWorkflowStep({
      store: harness.store as never,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, label: "unbounded", key: "code-review", attempts: 0,
      })),
      appendReviewRemediationSteps: harness.append,
      sendTaskBackForFix: harness.sendBack,
    } as never, harness.row);
    const outcome = await harness.waitForBounce();

    expect(outcome).toBe("bounced");
    expect(harness.row.column).toBe("in-progress");
    expect(harness.row.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Fix: Turn Code Review feedback into actionable fixes",
        remediation: expect.objectContaining({
          findingId: "missing-code-review-fix-steps",
          detail: expect.stringContaining("Inspect the review feedback"),
        }),
      }),
    ]));
    expect(harness.calls.indexOf("appendRemediationSteps")).toBeLessThan(harness.calls.indexOf("moveTask"));
  });

  /*
  FNXC:ReviewEmptyContent 2026-08-30-13:36:
  FN-267: the empty-diff sentinel is the shape that used to park terminally before any Fix step
  existed, so its regression must run the REAL producer and the REAL guarded bounce — a mocked
  appender proves the branch was taken, not that durable remediation was written or that the card
  actually reached WIP. Mocked-producer ordering cases live beside the FN-225 entry points; this one
  deliberately spends the full chain on the sentinel.
  */
  it("writes the real fallback Fix step and reaches WIP for an empty-diff REVISE with no findings", async () => {
    const harness = createRecoveryHarness("builtin:coding-ideas-v2");
    harness.row.workflowStepResults![0]!.reviewInputFingerprint = EMPTY_REVIEW_DIFF_FINGERPRINT;
    harness.row.workflowStepResults![0]!.findings = [];

    await recoverFailedPreMergeWorkflowStep({
      store: harness.store as never,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, label: "unbounded", key: "code-review", attempts: 0,
      })),
      appendReviewRemediationSteps: harness.append,
      sendTaskBackForFix: harness.sendBack,
    } as never, harness.row);
    const outcome = await harness.waitForBounce();

    // The card was never parked as unreviewable...
    expect(harness.row.status).not.toBe("failed");
    expect(harness.row.error ?? "").not.toMatch(/^NO REVIEWABLE CONTENT:/);
    // ...the deterministic Fix step is durable...
    expect(harness.row.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Fix: Turn Code Review feedback into actionable fixes",
        status: "pending",
        remediation: expect.objectContaining({ gate: "Code Review", findingId: "missing-code-review-fix-steps" }),
      }),
    ]));
    // ...and it was durable BEFORE the move, which is what the bounce guard requires.
    expect(harness.calls.indexOf("appendRemediationSteps")).toBeLessThan(harness.calls.indexOf("moveTask"));
    expect(outcome).toBe("bounced");
    expect(harness.row.column).toBe("in-progress");
  });

  it("treats a reopened trailing occurrence as the pending work required by the bounce", async () => {
    const harness = createRecoveryHarness("builtin:coding-ideas");
    expect(resolveStepReopenPolicy(BUILTIN_CODING_IDEAS_WORKFLOW_IR)).toBe("reopen-trailing");

    await recoverFailedPreMergeWorkflowStep({
      store: harness.store as never,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, label: "unbounded", key: "code-review", attempts: 0,
      })),
      appendReviewRemediationSteps: harness.append,
      sendTaskBackForFix: harness.sendBack,
    } as never, harness.row);
    const outcome = await harness.waitForBounce();

    expect(outcome).toBe("bounced");
    expect(harness.row.column).toBe("in-progress");
    expect(harness.row.steps?.some((step) => step.status === "pending" && step.remediation === undefined)).toBe(true);
    expect(harness.store.logEntry).not.toHaveBeenCalledWith(
      harness.row.id,
      "Workflow rerun refused — no pending remediation work",
      expect.anything(),
    );
  });
});
