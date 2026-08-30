import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { persistWorkflowStepResult } from "../executor/execute-workflow-graph.js";

const codeFingerprintOverride = vi.hoisted(() => ({ value: "stable-review-diff" as string | null }));
vi.mock("../worktree/review-diff-fingerprint.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/review-diff-fingerprint.js")>("../worktree/review-diff-fingerprint.js");
  return {
    ...actual,
    computeReviewDiffFingerprint: vi.fn(async () => "stable-review-diff"),
    computeCodeReviewInputFingerprint: vi.fn(async (...args: Parameters<typeof actual.computeCodeReviewInputFingerprint>) =>
      codeFingerprintOverride.value ?? actual.computeCodeReviewInputFingerprint(...args)), 
  };
});
import { performWorkflowRerunBounce } from "../executor/workflow-rerun-bounce.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-217-review",
    title: "Review input reuse",
    description: "Do not review unchanged input twice",
    column: "in-review",
    worktree: "/tmp/fn-217-review",
    branch: "fusion/fn-217-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as any;
}

function planReviewStep() {
  return {
    id: "graph:plan-review-step",
    name: "Plan Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the plan.",
    toolMode: "readonly",
    enabled: true,
    optionalGroupId: "plan-review",
    reviewKind: "plan",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  } as any;
}

function codeReviewStep() {
  return {
    ...planReviewStep(),
    id: "graph:code-review-step",
    name: "Code Review",
    prompt: "Review the implementation.",
    optionalGroupId: "code-review",
    reviewKind: "code",
  } as any;
}

function installReviewer(output: string) {
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
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", partial: output, contentIndex: 0, delta: output },
            });
          }
        }),
        dispose: vi.fn(),
      },
    };
  });
}

async function persistResult(store: any, subject: any, outcome: any, options: { stepId?: string; stepName?: string } = {}) {
  await persistWorkflowStepResult({
    store,
    getRunContextFor: () => undefined,
    readTaskArtifact: vi.fn(async () => "# Approved plan\n"),
  } as any, subject.id, {
    workflowStepId: options.stepId ?? "plan-review-step",
    workflowStepName: options.stepName ?? "Plan Review",
    phase: "pre-merge",
    status: outcome.success ? "passed" : "failed",
    verdict: outcome.verdict,
    output: outcome.output,
    notes: outcome.notes,
    findings: outcome.findings,
    reviewInputFingerprint: outcome.reviewInputFingerprint,
    repositoryScopeRevision: outcome.repositoryScopeRevision,
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: "2026-08-28T01:01:00.000Z",
  });
}

describe("unchanged review input reuse", () => {
  beforeEach(() => {
    resetExecutorMocks();
    codeFingerprintOverride.value = "stable-review-diff";
  });


  it("invokes a review node exactly once for identical authoritative input", async () => {
    const subject = task();
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    const executor = new TaskExecutor(store as any, "/tmp/test");
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n\nDo the work.\n");
    installReviewer('{"verdict":"REVISE","notes":"prose only"}');

    const first = await (executor as any).executeWorkflowStep(subject, planReviewStep(), subject.worktree, {});
    await persistResult(store, subject, first);
    const second = await (executor as any).executeWorkflowStep(subject, planReviewStep(), subject.worktree, {});

    expect(first).toMatchObject({ success: true, verdict: "APPROVE_WITH_NOTES" });
    expect(second).toMatchObject({ success: true, verdict: "APPROVE_WITH_NOTES", reviewInputFingerprint: first.reviewInputFingerprint });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      subject.id,
      expect.stringContaining("reused the recorded result for unchanged review input"),
    );
    expect(subject).not.toHaveProperty("awaitingApprovalReason");
  });

  it("invokes the reviewer again after the authoritative input changes", async () => {
    const subject = task();
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    const executor = new TaskExecutor(store as any, "/tmp/test");
    let prompt = "# Approved plan\n\nVersion one.\n";
    vi.spyOn(executor as any, "readTaskArtifact").mockImplementation(async () => prompt);
    installReviewer('{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}');

    const first = await (executor as any).executeWorkflowStep(subject, planReviewStep(), subject.worktree, {});
    await persistResult(store, subject, first);
    prompt = "# Approved plan\n\nVersion two.\n";
    const second = await (executor as any).executeWorkflowStep(subject, planReviewStep(), subject.worktree, {});

    expect(second.reviewInputFingerprint).not.toBe(first.reviewInputFingerprint);
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("dispatches a fresh Code Review when repository scope changes over an identical diff", async () => {
    const worktree = process.cwd();
    const subject = task({
      worktree,
      baseCommitSha: "base-commit",
      repositoryScope: {
        state: "confirmed",
        revision: 1,
        repositories: ["Merge"],
      },
    });
    const store = createMockStore();
    store.getTask.mockImplementation(async () => subject);
    const executor = new TaskExecutor(store as any, worktree);
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n\nReview the implementation.\n");
    installReviewer('{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}');

    const first = await (executor as any).executeWorkflowStep(subject, codeReviewStep(), worktree, {});
    expect(first.reviewInputFingerprint).toBeTypeOf("string");
    expect(first.repositoryScopeRevision).toBe(1);
    await persistResult(store, subject, first, {
      stepId: "code-review-step",
      stepName: "Code Review",
    });
    await expect(store.getTask(subject.id)).resolves.toMatchObject({
      workflowStepResults: [expect.objectContaining({ repositoryScopeRevision: 1 })],
    });

    const reused = await (executor as any).executeWorkflowStep(subject, codeReviewStep(), worktree, {});
    expect(reused).toMatchObject({
      success: true,
      reviewInputFingerprint: first.reviewInputFingerprint,
      repositoryScopeRevision: 1,
    });
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    subject.repositoryScope.revision = 2;
    const refreshed = await (executor as any).executeWorkflowStep(subject, codeReviewStep(), worktree, {});

    expect(refreshed.reviewInputFingerprint).toBe(first.reviewInputFingerprint);
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("refuses a review-to-WIP bounce without named pending remediation", async () => {
    const subject = task({ steps: [] });
    const store = {
      getTask: vi.fn(async () => subject),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(async () => undefined),
    };

    const outcome = await performWorkflowRerunBounce({
      store,
      workflowRerunPending: new Set<string>(),
      getExecutionPauseLabel: vi.fn(async () => null),
      resolveResumeLanes: vi.fn(async () => ({ wip: "in-progress", review: "in-review" })),
      clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
    } as never, subject.id, subject.worktree, true);

    expect(outcome).toBe("refused-no-remediation");
    expect(subject.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(subject).not.toHaveProperty("awaitingApprovalReason");
  });

  it("bounces exactly once when REVISE carries named pending remediation", async () => {
    const subject = task({
      steps: [{
        name: "Fix: Repair the guard",
        status: "pending",
        remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", findingId: "guard", detail: "Repair the guard" },
      }],
    });
    const store = {
      getTask: vi.fn(async () => subject),
      moveTask: vi.fn(async (_id: string, column: string) => Object.assign(subject, { column })),
      updateTask: vi.fn(async (_id: string, patch: object) => Object.assign(subject, patch)),
      logEntry: vi.fn(async () => undefined),
    };

    const outcome = await performWorkflowRerunBounce({
      store,
      workflowRerunPending: new Set<string>(),
      getExecutionPauseLabel: vi.fn(async () => null),
      resolveResumeLanes: vi.fn(async () => ({ wip: "in-progress", review: "in-review" })),
      clearTerminalStepFailuresForRetry: vi.fn(async () => undefined),
    } as never, subject.id, subject.worktree, true);

    expect(outcome).toBe("bounced");
    expect(subject.column).toBe("in-progress");
    expect(store.moveTask).toHaveBeenCalledOnce();
    expect(store.moveTask).toHaveBeenCalledWith(subject.id, "in-progress", expect.objectContaining({
      lifecycleReason: "code-review-revise-remediation",
    }));
  });
});
