import { describe, expect, it } from "vitest";
import { upsertWorkflowStepResult } from "@fusion/core";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler, type WorkflowNodeResult } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowStepResults 2026-07-09-00:55:
FN-7727 (Symptom Verification): self-healing (`recoverFailedPreMergeWorkflowStep` /
`recoverReviewTasksWithFailedPreMergeSteps`) re-runs a failed pre-merge review node
in place. Before this fix, the executor graph adapter's `recordWorkflowStepResult`
did `existing[idx] = result` and silently erased the prior failed attempt. This
test drives the EXACT adapter contract production uses (`upsertWorkflowStepResult`
from `@fusion/core`, persisted through a fake store's getTask/updateTask round-trip,
the same shape as `TaskExecutor`'s `recordWorkflowStepResult` closure) across two
separate `WorkflowGraphExecutor.run()` dispatches of the SAME node — simulating a
self-healing recovery re-run — and asserts the prior failed attempt survives in
`priorAttempts`.
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

function taskWith(enabled: string[] | undefined): TaskDetail {
  return { id: "FN-CR", enabledWorkflowSteps: enabled } as TaskDetail;
}

/** A single optional-group ("code-review") node graph, matching the production
 *  pre-merge review shape closely enough to exercise the recorder contract. */
function codeReviewGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "code-review-recovery-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "code-review",
        kind: "optional-group",
        config: {
          name: "Code review",
          defaultOn: false,
          template: {
            nodes: [{ id: "reviewstep", kind: "prompt", config: { prompt: "review" } }],
            edges: [],
          },
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "code-review" },
      { from: "code-review", to: "end", condition: "success" },
      { from: "code-review", to: "end", condition: "failure" },
    ],
  };
}

function innerHandler(reviewResult: WorkflowNodeResult): WorkflowNodeHandler {
  return async (node) => (node.id === "reviewstep" ? reviewResult : { outcome: "success" });
}

/** Fake store + recorder mirroring TaskExecutor.recordWorkflowStepResult (executor.ts
 *  ~5040): getTask -> upsertWorkflowStepResult -> updateTask, persisted between calls
 *  so a second dispatch sees the first dispatch's persisted result — exactly the
 *  self-healing recovery re-run shape (parked in-review, re-dispatched later). */
function makeFakeStore() {
  let workflowStepResults: WorkflowStepResult[] = [];
  const record = async (_taskId: string, result: WorkflowStepResult) => {
    const live = { workflowStepResults };
    workflowStepResults = upsertWorkflowStepResult(live.workflowStepResults, result);
  };
  return {
    record,
    getResults: () => workflowStepResults,
  };
}

describe("self-healing recovery re-run preserves prior failed WorkflowStepResult history (FN-7727)", () => {
  it("keeps the current failed entry plus the prior failed attempt in priorAttempts across two dispatches", async () => {
    const store = makeFakeStore();

    // First dispatch (initial pre-merge run): code-review REVISEs -> failed.
    const firstExecutor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "failure", value: "REVISE" }) },
      recordWorkflowStepResult: store.record,
    });
    const firstRun = await firstExecutor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());
    expect(firstRun.outcome).toBe("failure");

    const afterFirst = store.getResults();
    const firstEntry = afterFirst.find((r) => r.workflowStepId === "code-review");
    expect(firstEntry?.status).toBe("failed");
    expect(firstEntry?.priorAttempts ?? []).toHaveLength(0);

    // Self-healing sends the task back for fix; the graph re-runs the SAME node.
    // Second dispatch: code-review REVISEs again -> a NEW failed attempt.
    const secondExecutor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "failure", value: "REVISE" }) },
      recordWorkflowStepResult: store.record,
    });
    const secondRun = await secondExecutor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());
    expect(secondRun.outcome).toBe("failure");

    const afterSecond = store.getResults();
    // Exactly ONE current code-review entry — the Symptom Verification assertion.
    const codeReviewEntries = afterSecond.filter((r) => r.workflowStepId === "code-review");
    expect(codeReviewEntries).toHaveLength(1);
    const finalEntry = codeReviewEntries[0];
    expect(finalEntry.status).toBe("failed");
    // The FIRST dispatch's failed attempt must be preserved in priorAttempts, not lost.
    expect(finalEntry.priorAttempts?.length).toBeGreaterThanOrEqual(1);
    expect(finalEntry.priorAttempts?.[0].status).toBe("failed");
    expect(finalEntry.priorAttempts?.[0].startedAt).toBe(firstEntry?.startedAt);
  });
});
