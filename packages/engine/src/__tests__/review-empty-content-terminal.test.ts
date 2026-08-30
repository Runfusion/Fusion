import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";

const fingerprintState = vi.hoisted(() => ({ value: "empty-review-input:v1" as string | undefined }));
vi.mock("../worktree/review-diff-fingerprint.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/review-diff-fingerprint.js")>("../worktree/review-diff-fingerprint.js");
  return {
    ...actual,
    computeCodeReviewInputFingerprint: vi.fn(async () => fingerprintState.value),
  };
});

import { TaskExecutor } from "../executor.js";
import { persistWorkflowStepResult } from "../executor/execute-workflow-graph.js";
import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import {
  terminalizeEmptyReviewContent,
  type EmptyReviewContentGateFence,
} from "../executor/review-empty-content-close.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-225-empty",
    title: "No code changes",
    description: "Nothing needs changing",
    column: "in-review",
    worktree: process.cwd(),
    branch: "fusion/fn-225-empty",
    baseCommitSha: "HEAD",
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as any;
}

function codeReviewStep() {
  return {
    id: "graph:code-review",
    name: "Code Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the implementation.",
    toolMode: "readonly",
    enabled: true,
    optionalGroupId: "code-review",
    reviewKind: "code",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  } as any;
}

function installApprovingReviewer() {
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => {
          listeners.push(listener);
          return () => undefined;
        },
        prompt: vi.fn(async () => {
          const output = '{"verdict":"APPROVE","notes":"reviewed"}';
          for (const listener of listeners) listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", partial: output, contentIndex: 0, delta: output },
          });
        }),
        dispose: vi.fn(),
      },
    };
  });
}

describe("empty Code Review content", () => {
  beforeEach(() => {
    resetExecutorMocks();
    fingerprintState.value = EMPTY_REVIEW_DIFF_FINGERPRINT;
    installApprovingReviewer();
  });

  it("passes an explicitly no-commit singular task without dispatching a reviewer", async () => {
    const subject = task({ noCommitsExpected: true });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    store.updateTaskAtomic = vi.fn(async (_id: string, updater: (task: any) => any) => {
      const patch = await updater(subject);
      if (patch) Object.assign(subject, patch);
      return subject;
    });
    store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(subject, patch);
      return subject;
    });
    const executor = new TaskExecutor(store as any, process.cwd());
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n");

    const outcome = await (executor as any).executeWorkflowStep(subject, codeReviewStep(), process.cwd(), {});

    expect(outcome).toMatchObject({
      success: true,
      verdict: "APPROVE",
      reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
    });
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      subject.id,
      expect.stringContaining("passed without reviewer dispatch"),
    );

    await persistWorkflowStepResult({
      store,
      getRunContextFor: () => undefined,
      readTaskArtifact: vi.fn(async () => "# Approved plan\n"),
    } as any, subject.id, {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: outcome.success ? "passed" : "failed",
      verdict: outcome.verdict,
      output: outcome.output,
      notes: outcome.notes,
      reviewInputFingerprint: outcome.reviewInputFingerprint,
      startedAt: "2026-08-28T01:00:00.000Z",
      completedAt: "2026-08-28T01:01:00.000Z",
    });
    expect(subject.workflowStepResults).toEqual([
      expect.objectContaining({ status: "passed", verdict: "APPROVE", reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT }),
    ]);
  });

  it.each([
    ["missing explicit field", {}],
    ["workspace task", { noCommitsExpected: true, workspaceWorktrees: {} }],
  ])("dispatches for %s", async (_label, overrides) => {
    const subject = task(overrides);
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    const executor = new TaskExecutor(store as any, process.cwd());
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n");

    await (executor as any).executeWorkflowStep(subject, codeReviewStep(), process.cwd(), {});

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("dispatches when the diff is non-empty", async () => {
    fingerprintState.value = "a".repeat(64);
    const subject = task({ noCommitsExpected: true });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    const executor = new TaskExecutor(store as any, process.cwd());
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n");

    await (executor as any).executeWorkflowStep(subject, codeReviewStep(), process.cwd(), {});

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });
});

function failedEmptyResult() {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "failed",
    reviewKind: "code",
    verdict: "REVISE",
    reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:01:00.000Z",
  } as any;
}

const emptyFence: EmptyReviewContentGateFence = {
  workflowStepId: "code-review",
  stepName: "Code Review",
  expectedStartedAt: "2026-08-28T01:00:00.000Z",
  expectedCompletedAt: "2026-08-28T01:01:00.000Z",
  expectedVerdict: "REVISE",
  expectedReviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
};

function closeHarness(mutateInsideClaim?: (row: any) => void, settings: Record<string, unknown> = {}) {
  const row = task({ workflowStepResults: [failedEmptyResult()] });
  const audit = vi.fn(async () => undefined);
  const store: any = {
    getTask: vi.fn(async () => row),
    getSettings: vi.fn(async () => settings),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(row, patch);
      return row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: any) => any) => {
      mutateInsideClaim?.(row);
      const patch = await updater(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: audit,
  };
  return { row, store, audit };
}

describe("empty review graph-failure settle", () => {
  it("settles the terminal park forward from WIP to review and reasserts it after a clearing move", async () => {
    const parkedError = "NO REVIEWABLE CONTENT: Code Review rejected a provably empty diff.";
    const row = task({
      column: "in-progress",
      status: "failed",
      error: parkedError,
      steps: [{ name: "Implementation", status: "pending" }],
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => row);
    store.getSettings.mockResolvedValue({ autoMerge: true } as any);
    store.moveTask.mockImplementation(async (_id: string, column: string) => {
      row.column = column;
      row.status = undefined;
      row.error = undefined;
      return row;
    });
    store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(row, patch);
      return row;
    });
    const executor = new TaskExecutor(store as any, process.cwd());

    await (executor as any).handleGraphFailure(row, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute", "code-review", "code-review-remediation"],
      failedNodeId: "code-review-remediation",
      failureValue: "remediation-not-scheduled",
      context: {},
    });

    expect(store.moveTask).toHaveBeenCalledTimes(1);
    expect(store.moveTask).toHaveBeenCalledWith(row.id, "in-review", expect.objectContaining({
      moveSource: "engine",
      preserveProgress: true,
      preserveWorktree: true,
      preserveStatus: true,
      allowDirectInReviewMove: true,
    }));
    expect(row).toMatchObject({ column: "in-review", status: "failed", error: parkedError });
    expect(store.logEntry.mock.calls.flatMap((call: unknown[]) => call).join("\n")).not.toContain("Workflow graph terminated with failure");
  });

  it("honors a terminal merger park that remains in the review lane", async () => {
    const mergerError = "branch had no net changes vs main — operator review required";
    const row = task({ column: "in-review", status: "failed", error: mergerError });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => row);
    store.getSettings.mockResolvedValue({ autoMerge: true } as any);
    const executor = new TaskExecutor(store as any, process.cwd());

    await (executor as any).handleGraphFailure(row, {
      disposition: "failed", outcome: "failure", visitedNodeIds: ["merge-attempt"], context: {},
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith(row.id, expect.objectContaining({
      error: expect.stringContaining("Workflow graph terminated with failure"),
    }), expect.anything());
    expect(row).toMatchObject({ column: "in-review", status: "failed", error: mergerError });
  });

  it("does not move a park already resting in review", async () => {
    const row = task({ column: "in-review", status: "failed", error: "NO REVIEWABLE CONTENT: empty" });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => row);
    store.getSettings.mockResolvedValue({ autoMerge: true } as any);
    const executor = new TaskExecutor(store as any, process.cwd());

    await (executor as any).handleGraphFailure(row, {
      disposition: "failed", outcome: "failure", visitedNodeIds: ["code-review-remediation"], context: {},
    });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(row).toMatchObject({ column: "in-review", status: "failed", error: "NO REVIEWABLE CONTENT: empty" });
  });
});

describe("empty review terminal compare-and-set", () => {
  it("parks once and declines an idempotent second claim", async () => {
    const { row, store, audit } = closeHarness();
    const deps = { store, getRunContextFor: () => ({ agentId: "executor", runId: "run-225" }) } as any;

    await expect(terminalizeEmptyReviewContent(deps, row.id, emptyFence)).resolves.toBe(true);
    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/^NO REVIEWABLE CONTENT:/) });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    await expect(terminalizeEmptyReviewContent(deps, row.id, emptyFence)).resolves.toBe(false);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["approval", (row: any) => { row.workflowStepResults[0].status = "passed"; row.workflowStepResults[0].verdict = "APPROVE"; }],
    ["operator bypass", (row: any) => { row.workflowStepResults[0].status = "skipped"; row.workflowStepResults[0].bypassedAt = "2026-08-28T02:00:00.000Z"; }],
    ["supersession", (row: any) => { row.workflowStepResults[0].supersededAt = "2026-08-28T02:00:00.000Z"; }],
    ["remediation archive", (row: any) => { row.workflowStepResults[0].remediationArchivedAt = "2026-08-28T02:00:00.000Z"; }],
    ["new attempt", (row: any) => { row.workflowStepResults[0].startedAt = "2026-08-28T03:00:00.000Z"; }],
    ["changed fingerprint", (row: any) => { row.workflowStepResults[0].reviewInputFingerprint = "a".repeat(64); }],
    ["missing gate", (row: any) => { row.workflowStepResults = []; }],
    ["pause", (row: any) => { row.paused = true; }],
    ["user pause", (row: any) => { row.userPaused = true; }],
    ["delete", (row: any) => { row.deletedAt = "2026-08-28T02:00:00.000Z"; }],
    ["another classifier", (row: any) => { row.status = "awaiting-approval"; row.error = "operator decision"; }],
    ["auto-merge hold", (row: any) => { row.autoMerge = false; row.autoMergeProvenance = "user"; }],
  ])("declines when %s wins inside the atomic read", async (_label, mutate) => {
    const { row, store, audit } = closeHarness(mutate);
    const priorStatus = row.status;
    const priorError = row.error;

    await expect(terminalizeEmptyReviewContent({
      store,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-225" }),
    } as any, row.id, emptyFence)).resolves.toBe(false);

    expect(row.status).toBe(priorStatus === undefined && _label === "another classifier" ? "awaiting-approval" : row.status);
    if (_label === "another classifier") expect(row.error).toBe("operator decision");
    else expect(row.error).toBe(priorError);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each(["globalPause", "enginePaused"])("declines while %s is active", async (setting) => {
    const { row, store, audit } = closeHarness(undefined, { [setting]: true });
    await expect(terminalizeEmptyReviewContent({
      store,
      getRunContextFor: () => ({ agentId: "executor", runId: "run-225" }),
    } as any, row.id, emptyFence)).resolves.toBe(false);
    expect(row.status).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps minimal stores fail-closed on a competing mutation", async () => {
    const { row, store } = closeHarness();
    delete store.updateTaskAtomic;
    row.workflowStepResults[0].status = "passed";
    row.workflowStepResults[0].verdict = "APPROVE";
    await expect(terminalizeEmptyReviewContent({ store, getRunContextFor: () => undefined } as any, row.id, emptyFence)).resolves.toBe(false);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
