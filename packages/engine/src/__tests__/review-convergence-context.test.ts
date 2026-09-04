import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";
import { buildReviewConvergenceContext } from "../executor/optional-step-revision.js";
import { reviewInputSignature } from "../executor/request-pre-merge-optional-step-fix.js";

const failedRound = {
  workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge" as const,
  status: "skipped" as const,
  priorAttempts: [{
    workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge" as const,
    status: "failed" as const, verdict: "REVISE" as const,
    findings: [
      { id: "reset-retry", title: "Reset remains retryable", body: "Keep retry available." },
      { id: "transaction", title: "Atomic rollback", body: "Explain the transaction boundary." },
    ],
  }],
};

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-06:41:
FN-149's archival fix is only effective when the next reviewer receives the restored ledger. These
prompt assertions prevent the FN-123 failure mode where durable evidence existed but convergence
instructions were dispatched without the prior findings or round number.
*/
describe("FN-149 review convergence context", () => {
  beforeEach(() => resetExecutorMocks());

  it("composes fresh archived findings into the round-two reviewer system prompt", async () => {
    const fresh = {
      id: "FN-149-prompt", title: "Review history", description: "verify history", column: "in-review", worktree: "/tmp/wt", baseCommitSha: "base",
      dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
      workflowStepResults: [failedRound],
    };
    const stale = { ...fresh, workflowStepResults: [] };
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    store.getTask.mockResolvedValue(fresh);
    let systemPrompt = "";
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      systemPrompt = options.systemPrompt;
      const listeners: Array<(event: any) => void> = [];
      return { session: { state: {}, subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => {}; }, prompt: async () => listeners.forEach((listener) => listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: '{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}' } })), dispose: vi.fn() } };
    });
    const executor = new TaskExecutor(store as any, "/tmp/test");
    await (executor as any).executeWorkflowStep(stale, {
      id: "graph:code-review", name: "Code Review", description: "", mode: "prompt", phase: "pre-merge", gateMode: "advisory", prompt: "Review.", toolMode: "readonly", enabled: true, reviewKind: "code",
    }, "/tmp/wt", {});
    expect(systemPrompt).toContain("Code Review attempt 2");
    expect(systemPrompt).toContain("reset-retry");
    expect(systemPrompt).toContain("Reset remains retryable");
    expect(systemPrompt).toContain("transaction");
    expect(systemPrompt).toContain("Verify each prior blocker");
    expect(systemPrompt).toContain("Your prior findings on this gate");
    expect(systemPrompt).not.toMatch(/Prior Findings In This Review Pass[\\s\\S]*reset-retry/);
  });

  it("uses the fresh Plan Review snapshot for disputes recorded during remediation", async () => {
    const planRound = {
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge" as const,
      status: "skipped" as const,
      priorAttempts: [{
        workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge" as const,
        status: "failed" as const, verdict: "REVISE" as const,
        findings: [{
          id: "disputed-plan-finding",
          title: "Plan scope",
          body: "Expand the scope.",
          disputedAt: "2026-08-28T10:00:00.000Z",
          disputeRationale: "The existing scope already covers the acceptance criterion.",
        }],
      }],
    };
    const fresh = {
      id: "FN-224-plan", title: "Plan dispute", description: "verify dispute", column: "in-progress", worktree: "/tmp/wt", baseCommitSha: "base",
      dependencies: [], steps: [], currentStep: 0, log: [], workflowStepResults: [planRound],
      createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const stale = { ...fresh, workflowStepResults: [] };
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    store.getTask.mockResolvedValue(fresh);
    let systemPrompt = "";
    mockedCreateFnAgent.mockImplementation(async (options: any) => {
      systemPrompt = options.systemPrompt;
      const listeners: Array<(event: any) => void> = [];
      return { session: { state: {}, subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => {}; }, prompt: async () => listeners.forEach((listener) => listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: '{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}' } })), dispose: vi.fn() } };
    });
    const executor = new TaskExecutor(store as any, "/tmp/test");

    await (executor as any).executeWorkflowStep(stale, {
      id: "graph:plan-review", name: "Plan Review", description: "", mode: "prompt", phase: "pre-merge", gateMode: "advisory", prompt: "Review.", toolMode: "readonly", enabled: true, reviewKind: "plan", optionalGroupId: "plan-review",
    }, "/tmp/wt", {});

    expect(systemPrompt).toContain("### Disputed by the implementer");
    expect(systemPrompt).toContain("disputed-plan-finding");
    expect(systemPrompt).toContain("The existing scope already covers the acceptance criterion.");
  });

  it("gives the round-two code reviewer its own open findings and convergence directive", () => {
    const context = buildReviewConvergenceContext({ workflowStepResults: [failedRound] } as any, {
      revisionKey: "code-review", reviewKind: "code", changeSummaryBlock: "### Changed since your previous review\nNo commits landed.",
    });
    expect(context).toContain("Code Review attempt 2");
    expect(context).toContain("### Changed since your previous review");
    expect(context.indexOf("### Changed since your previous review")).toBeLessThan(context.indexOf("### Your prior findings on this gate"));
    expect(context).toContain("reset-retry");
    expect(context).toContain("Reset remains retryable");
    expect(context).toContain("transaction");
    expect(context).toContain("Verify each prior blocker");
  });

  it("omits the block for a first attempt and applies the severity ratchet on attempt three", () => {
    expect(buildReviewConvergenceContext({ workflowStepResults: [] } as any, {
      revisionKey: "code-review", reviewKind: "code",
    })).toBe("");
    const third = buildReviewConvergenceContext({ workflowStepResults: [{
      ...failedRound,
      priorAttempts: [...failedRound.priorAttempts, { ...failedRound.priorAttempts[0] }],
    }] } as any, { revisionKey: "code-review", reviewKind: "code" });
    expect(third).toContain("Code Review attempt 3");
    expect(third).toContain("Severity ratchet (attempt 3+)");
  });

  it("normalizes graph ids before selecting the gate's dedicated prior-findings block", () => {
    const context = buildReviewConvergenceContext({ workflowStepResults: [failedRound] } as any, {
      revisionKey: "code-review", reviewKind: "code",
    });
    expect(context).toContain("Your prior findings on this gate");
    expect(context).toContain("reset-retry");
  });

  it("does not treat a graph-prefixed id as a different review gate", () => {
    const graphGateId = "graph:code-review".replace(/^graph:/, "");
    expect(buildReviewConvergenceContext({ workflowStepResults: [failedRound] } as any, {
      revisionKey: graphGateId, reviewKind: "code",
    })).toContain("Code Review attempt 2");
  });

  it("signs unchanged workspace review input even when the scope revision is absent", () => {
    const makeResult = (fingerprint: string) => ({
      workflowStepId: "code-review",
      verdict: "REVISE",
      repositoryReviewOutcomes: [{
        repository: "Merge",
        status: "REVIEWED",
        verdict: "REVISE",
        fingerprint,
        findings: [{ id: "volatile", title: "Guard", body: "Repair the guard", filePath: "Merge/src/a.ts" }],
      }],
    });

    expect(reviewInputSignature(makeResult("tree-1") as never)).toBeTruthy();
    expect(reviewInputSignature(makeResult("tree-1") as never)).toBe(reviewInputSignature(makeResult("tree-1") as never));
    expect(reviewInputSignature(makeResult("tree-1") as never)).not.toBe(reviewInputSignature(makeResult("tree-2") as never));
  });
});
