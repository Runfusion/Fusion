import { describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

/*
FNXC:ReviewRemediation 2026-08-31-06:36:
END-TO-END guard for the operator-visible contract: a Code Review REVISE must produce Fix steps and
hand the card back for implementation. Every existing suite on this path asserts ONE link -- a claim
disposition, a routing branch, a boolean return -- by spying on its neighbour. That is exactly how
FN-270/FN-273 stranded for a full night with a green suite: each link was individually correct and
the CHAIN was broken, so no test could see it.

This drives the real chain with no spies between the links, from the production entry point
(`handleGraphFailure`) through the remediation backstop, `requestPreMergeOptionalStepFix`,
`appendReviewRemediationSteps`, and `sendTaskBackForFix`, and asserts the artifact an operator
actually looks for: new pending Fix steps on the card.

The fixture is FN-273's REAL persisted row and its REAL reviewer verdict, not an invented shape.
Two prior fixes on this path passed their own tests and failed in production because their fixtures
omitted the true precondition -- a dashboard Retry (pause -> hard-cancel -> unpause) leaves BOTH
`userCanceledTaskIds` and an unconditional `pausedAborted` behind on an idle card.
*/

/* The reviewer verdict exactly as Code Review persisted it on FN-273 at 06:19:48. */
const realReviseResult = {
  notes: "I reviewed the workspace refresh implementation and its production wiring.",
  phase: "pre-merge",
  output: "I reviewed the workspace refresh implementation and its production wiring.",
  source: "optional-group",
  status: "failed",
  verdict: "REVISE",
  findings: [{
    id: "workspace-base-refresh-regression-matrix-incomplete",
    title: "Workspace base-refresh failure and routing cases are not tested",
    body: "Add real behavioral tests for these acquisition outcomes.",
    filePath: "packages/engine/src/__tests__/workspace-base-refresh.test.ts",
    line: 82,
    severity: "critical",
    resolution: "open",
  }],
  startedAt: "2026-08-31T06:17:47.708Z",
  reviewKind: "code",
  completedAt: "2026-08-31T06:19:48.019Z",
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  reviewedCommitSha: "62958c6db72998d96d7ba22de43abbc01b0cebfd",
  reviewInputFingerprint: "0f597d26bb93f95ada977678e96d054973422b1347c241fdbb68dd51a4af2871",
};

function reviewedTask(): TaskDetail {
  return {
    id: "FN-273",
    title: "Workspace file-overlap parity",
    description: "A blocking Code Review revision must reopen implementation.",
    column: "in-review",
    worktree: "/tmp/fusion-worktrees/fn-273",
    branch: "fusion/fn-273",
    baseBranch: "main",
    baseCommitSha: "e5122a76d94643f0c6d63a21dacb9c47a4236ba6",
    currentStep: 6,
    postReviewFixCount: 0,
    enabledWorkflowSteps: ["plan-review", "code-review", "documentation-delivery"],
    dependencies: [],
    reviewConvergenceStage: 0,
    mergeRetries: 0,
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Shared workspace-aware checkout", status: "done" },
      { name: "Engine overlap consumers", status: "done" },
      { name: "Per-repository base refresh", status: "done" },
      { name: "Regression suites", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ],
    log: [],
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    workflowStepResults: [
      {
        phase: "pre-merge", status: "passed", verdict: "APPROVE",
        workflowStepId: "plan-review", workflowStepName: "Plan Review",
        completedAt: "2026-08-30T19:13:45.406Z",
      },
      realReviseResult,
    ],
    createdAt: "2026-08-30T18:59:10.879Z",
    updatedAt: "2026-08-31T06:19:48.128Z",
  } as unknown as TaskDetail;
}

/* A Code Review run that completed traversal and returned REVISE: no interruption fields. */
const reviseRun = {
  disposition: "failed",
  outcome: "failure",
  visitedNodeIds: ["code-review-step"],
  context: { "node:code-review-step:value": "revise" },
} as const;

/*
The shared fake omits `updateTaskAtomic`, which the real TaskStore provides and the remediation
appender requires. Without it `appendReviewRemediationSteps` throws and the chain silently reports
"no remediation" -- a FALSE NEGATIVE that cost a full diagnostic pass. Modelled locally rather than
in the shared factory to keep the blast radius off the ~200 suites that use it.
*/
function storeWithAtomicWrites(task: TaskDetail) {
  const store = createMockStore();
  let live: TaskDetail = task;
  store.getTask.mockImplementation(async () => live);
  store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    live = { ...live, ...patch } as TaskDetail;
    return live;
  });
  (store as unknown as { updateTaskAtomic: unknown }).updateTaskAtomic =
    async (_id: string, compute: (current: TaskDetail) => Record<string, unknown> | null) => {
      const patch = compute(live);
      if (patch) live = { ...live, ...patch } as TaskDetail;
      return live;
    };
  return { store, current: () => live };
}

/*
Parameterised over the project auto-merge setting because it gates the sibling self-healing sweep,
so "does the graph-failure backstop depend on it too?" was an open question while FN-273 was stuck.
It does not: remediation reopens implementation, it does not merge.
*/
describe.each([true, false])("Code Review REVISE reopens implementation (project autoMerge=%s)", (autoMerge) => {
  function harness() {
    resetExecutorMocks();
    const task = reviewedTask();
    const { store, current } = storeWithAtomicWrites(task);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000,
      autoMerge, maxAutoMergeRetries: 3,
    });
    const executor = new TaskExecutor(store as never, "/tmp/test");
    return { executor, store, task, current };
  }

  /** Reproduces a dashboard Retry on an idle in-review card, then the reset the next run performs. */
  function retryThenNewRunIsBorn(executor: TaskExecutor, taskId: string) {
    (executor as never as { markPausedAborted(id: string, p: string): void }).markPausedAborted(taskId, "hard-cancel");
    (executor as never as { userCanceledTaskIds: Set<string> }).userCanceledTaskIds.add(taskId);
    (executor as never as { userCanceledTaskIds: Set<string> }).userCanceledTaskIds.delete(taskId);
    (executor as never as { clearPausedAborted(id: string): void }).clearPausedAborted(taskId);
  }

  it("appends pending Fix steps for the reviewer's findings", async () => {
    const { executor, task, current } = harness();
    retryThenNewRunIsBorn(executor, task.id);

    await (executor as never as { handleGraphFailure(t: TaskDetail, r: unknown): Promise<void> })
      .handleGraphFailure(task, reviseRun);

    const steps = current().steps ?? [];
    const fixSteps = steps.filter((s) => /^Fix:/i.test(String(s.name ?? "")));
    expect(fixSteps.length).toBeGreaterThan(0);
    expect(fixSteps.every((s) => s.status === "pending")).toBe(true);
    // The already-finished implementation steps are preserved, not rewritten.
    expect(steps.slice(0, 6).every((s) => s.status === "done")).toBe(true);
  });

  it("clears the failure state so the card is dispatchable again", async () => {
    const { executor, task, current } = harness();
    retryThenNewRunIsBorn(executor, task.id);

    await (executor as never as { handleGraphFailure(t: TaskDetail, r: unknown): Promise<void> })
      .handleGraphFailure(task, reviseRun);

    expect(current().error).toBeNull();
    expect(current().workflowStepRetries).toBe(0);
  });
});
