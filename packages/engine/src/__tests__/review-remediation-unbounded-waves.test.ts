import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBuiltinWorkflow,
  hasOpenEquivalentRemediationStep,
  planRemediationPlacement,
  type Task,
  type TaskStep,
  type WorkflowReviewFinding,
} from "@fusion/core";

import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";

beforeEach(() => resetExecutorMocks());

const prompt = "# Task\n\n## File Scope\n\n- `packages/engine/src/**`\n";
const finding: WorkflowReviewFinding = {
  id: "finding-guard",
  title: "Retry guard is wrong",
  body: "Correct the retry guard",
  filePath: "packages/engine/src/retry.ts",
  line: 42,
  severity: "critical",
};

function harness() {
  const task = {
    id: "FN-236-WAVES",
    column: "in-review",
    worktree: "/tmp/fn-236-waves",
    prompt,
    modifiedFiles: ["packages/engine/src/retry.ts"],
    log: [],
    steps: [{ name: "Implement", status: "done" }, { name: "Testing & Verification", status: "done" }],
    workflowStepResults: [],
  } as Task;
  const sendTaskBackForFix = vi.fn(async () => undefined);
  let atomicTail: Promise<void> = Promise.resolve();
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding" })),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const workflow = getBuiltinWorkflow(id);
      return workflow ? { ir: workflow.ir } : undefined;
    }),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string, runContext?: never) => {
      task.log = [...(task.log ?? []), { timestamp: new Date().toISOString(), action, outcome, runContext }];
    }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return task;
    }),
    updateTaskAtomic: vi.fn((_id: string, mutate: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const operation = atomicTail.then(async () => {
        const patch = await mutate(task);
        if (patch) Object.assign(task, patch);
        return task;
      });
      atomicTail = operation.then(() => undefined, () => undefined);
      return operation;
    }),
    appendRemediationSteps: vi.fn(async (_id: string, candidates: readonly TaskStep[], options: { wave?: number }) => {
      const appended: TaskStep[] = [];
      for (const candidate of candidates) {
        if (!candidate.remediation || hasOpenEquivalentRemediationStep([...(task.steps ?? []), ...appended], candidate)) continue;
        appended.push({
          ...candidate,
          status: "pending",
          remediation: { ...candidate.remediation, wave: candidate.remediation.wave ?? options.wave ?? 1 },
        });
      }
      if (appended.length > 0) {
        const placement = planRemediationPlacement(task.steps ?? [], appended);
        task.steps = placement.steps;
        task.currentStep = placement.insertionIndex;
        return { task, appended, appendedCount: appended.length, wave: options.wave ?? 1, ...placement };
      }
      return { task, appended, appendedCount: 0, wave: options.wave ?? 1 };
    }),
  };
  const deps = {
    store: store as never,
    getRunContextFor: () => undefined,
    recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
    parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    readTaskArtifact: vi.fn(async () => task.prompt),
    appendReviewRemediationSteps: (
      live: Task,
      info: never,
      options?: Parameters<typeof appendReviewRemediationSteps>[3],
    ) => appendReviewRemediationSteps(
      { store: store as never, readTaskArtifact: async () => task.prompt, sendTaskBackForFix },
      live,
      info,
      options,
    ),
    workflowLifecycleMovesInFlight: new Set<string>(),
    sendTaskBackForFix,
  };

  function setReview(fingerprint: string, currentFinding: WorkflowReviewFinding = finding) {
    const previous = task.workflowStepResults?.[0];
    task.workflowStepResults = [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      reviewKind: "code",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewInputFingerprint: fingerprint,
      findings: [currentFinding],
      ...(previous ? { priorAttempts: [previous] } : {}),
    }];
  }

  async function revise(fingerprint: string, maxRevisions: number | "unbounded" = "unbounded", currentFinding = finding) {
    setReview(fingerprint, currentFinding);
    return requestPreMergeOptionalStepFix(deps as never, task.id, task, {
      stepName: "Code Review",
      feedback: currentFinding.body,
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      nodeId: "code-review",
      reviewKind: "code",
      maxRevisions,
      findings: [currentFinding],
    });
  }

  const finishPending = () => {
    for (const step of task.steps ?? []) if (step.status === "pending") step.status = "done";
  };

  return { task, store, deps, sendTaskBackForFix, revise, finishPending };
}

describe("unbounded review remediation waves", () => {
  it("appends and dispatches five consecutive changed Code Review waves", async () => {
    const h = harness();
    for (let round = 1; round <= 5; round += 1) {
      await expect(h.revise(`fingerprint-${round}`)).resolves.toBe(true);
      h.finishPending();
    }

    expect(h.sendTaskBackForFix).toHaveBeenCalledTimes(5);
    expect(Math.max(...(h.task.steps ?? []).map((step) => step.remediation?.wave ?? 0))).toBe(5);
    expect(h.task.log?.filter((entry) => entry.action.includes("requested named remediation"))).toHaveLength(5);
    expect(h.store.logEntry.mock.calls.flat().join("\n")).not.toContain("wave-exhausted");
  });

  it("routes an identical review fingerprint to convergence without appending", async () => {
    const h = harness();
    await expect(h.revise("same-fingerprint")).resolves.toBe(true);
    h.finishPending();
    const appendCount = h.store.appendRemediationSteps.mock.calls.length;
    h.task.reviewConvergenceStage = 2;

    await expect(h.revise("same-fingerprint")).resolves.toBe(false);
    expect(h.store.appendRemediationSteps).toHaveBeenCalledTimes(appendCount);
    expect(h.sendTaskBackForFix).toHaveBeenCalledTimes(1);
    expect(h.task.reviewConvergenceEscalationCount).toBe(1);
  });

  it("binds an authored two-pass cap using production-written attempt entries", async () => {
    const h = harness();
    await expect(h.revise("cap-fingerprint-1", 2)).resolves.toBe(true);
    h.finishPending();
    await expect(h.revise("cap-fingerprint-2", 2)).resolves.toBe(true);
    h.finishPending();
    h.task.reviewConvergenceStage = 2;

    await expect(h.revise("cap-fingerprint-3", 2)).resolves.toBe(false);
    expect(h.sendTaskBackForFix).toHaveBeenCalledTimes(2);
    expect(h.store.appendRemediationSteps).toHaveBeenCalledTimes(0);
    expect(h.task.log?.filter((entry) => entry.action.includes("requested named remediation"))).toHaveLength(2);
    expect(h.store.logEntry).toHaveBeenCalledWith(
      h.task.id,
      "Pre-merge remediation not scheduled — revision budget exhausted",
      expect.stringContaining("Maximum revisions: 2"),
      undefined,
    );
  });

  it("commits the attempt with the fix step before executor delivery", async () => {
    const h = harness();
    h.sendTaskBackForFix.mockRejectedValueOnce(new Error("executor delivery interrupted"));

    await expect(h.revise("delivery-fingerprint", 1)).rejects.toThrow("executor delivery interrupted");

    expect(h.task.steps?.filter((step) => step.remediation?.gate === "Code Review")).toHaveLength(1);
    expect(h.task.log?.filter((entry) => entry.action.includes("requested named remediation"))).toHaveLength(1);
    expect(h.store.logEntry.mock.calls.some((call) => String(call[1]).includes("requested named remediation"))).toBe(false);
  });

  it("atomically admits only one concurrent delivery at an authored one-pass cap", async () => {
    const h = harness();
    h.task.reviewConvergenceStage = 2;
    const secondFinding = { ...finding, id: "finding-second", body: "Correct the second retry guard", line: 43 };

    await Promise.all([
      h.revise("concurrent-fingerprint-1", 1, finding),
      h.revise("concurrent-fingerprint-2", 1, secondFinding),
    ]);

    expect(h.sendTaskBackForFix).toHaveBeenCalledTimes(1);
    expect(h.task.steps?.filter((step) => step.remediation?.gate === "Code Review")).toHaveLength(1);
    expect(h.task.log?.filter((entry) => entry.action.includes("requested named remediation"))).toHaveLength(1);
    expect(h.store.logEntry).toHaveBeenCalledWith(
      h.task.id,
      "Pre-merge remediation not scheduled — revision budget exhausted",
      expect.stringContaining("Maximum revisions: 1"),
      undefined,
    );
  });

  it("dedupes open remediation but allows the same completed defect to recur", async () => {
    const h = harness();
    await expect(h.revise("duplicate-fingerprint-1")).resolves.toBe(true);
    const firstWave = Math.max(...(h.task.steps ?? []).map((step) => step.remediation?.wave ?? 0));

    await expect(h.revise("duplicate-fingerprint-2")).resolves.toBe(false);
    expect(h.store.logEntry).toHaveBeenCalledWith(
      h.task.id,
      "Review remediation released as non-blocking",
      "review-remediation-no-pending-work",
    );

    h.finishPending();
    await expect(h.revise("duplicate-fingerprint-3")).resolves.toBe(true);
    expect(Math.max(...(h.task.steps ?? []).map((step) => step.remediation?.wave ?? 0))).toBe(firstWave + 1);
  });
});
