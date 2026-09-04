import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowStepResult } from "@fusion/core";

import { claimRemediationAttempt } from "../executor/claim-review-remediation-attempt.js";
import { ClaimSupersededError, fenceStoreForClaim } from "../executor/fence-store-for-claim.js";

/*
FNXC:LifecycleContainment 2026-08-30-13:36:
FN-267: guarding durable writes call-site by call-site did not converge — the remediation requester
narrates from more than a dozen branches, and each review round found the next unguarded one. The
fence makes the boundary structural: a claimed run's durable writers re-assert ownership first and
refuse once the round has moved on, so a branch added later is covered by construction. These cases
pin the fence itself; the production-path consequence (a silent "nothing scheduled") is pinned in
graph-failure-backstop-claim.test.ts.
*/

function taskWithFailedReview(): Task {
  return {
    id: "FN-267-fence",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-08-30T13:00:00.000Z",
    updatedAt: "2026-08-30T13:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewKind: "code",
      reviewInputFingerprint: "fence-round-one",
      startedAt: "2026-08-30T13:00:00.000Z",
      completedAt: "2026-08-30T13:01:00.000Z",
      findings: [{ id: "f1", severity: "critical", title: "One", body: "Fix it.", filePath: "a.ts" }],
    }],
  } as unknown as Task;
}

function store(row: Task) {
  return {
    getTask: vi.fn(async () => row),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(row, patch)),
    moveTask: vi.fn(async () => row),
    addTaskComment: vi.fn(async () => undefined),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
  };
}

const supersede = (row: Task) => {
  row.workflowStepResults = [{
    ...row.workflowStepResults![0],
    reviewInputFingerprint: "fence-round-two",
    findings: [{ id: "f2", severity: "critical", title: "Two", body: "Different.", filePath: "b.ts" }],
  }] as WorkflowStepResult[];
};

describe("FN-267 a claimed run writes through a fenced store", () => {
  it("passes durable writes through while the claim is held", async () => {
    const row = taskWithFailedReview();
    const raw = store(row);
    const admission = await claimRemediationAttempt(raw as never, row.id, row.workflowStepResults![0]!, "test", row);
    expect(admission.kind).toBe("claimed");
    const fenced = fenceStoreForClaim(raw as never, row.id, (admission as { claim: never }).claim);

    await fenced.logEntry(row.id, "still ours", undefined);
    await fenced.moveTask(row.id, "in-progress");

    expect(raw.logEntry).toHaveBeenCalledWith(row.id, "still ours", undefined);
    expect(raw.moveTask).toHaveBeenCalledTimes(1);
  });

  it("refuses every durable writer once a newer round replaces the claimed one", async () => {
    const row = taskWithFailedReview();
    const raw = store(row);
    const admission = await claimRemediationAttempt(raw as never, row.id, row.workflowStepResults![0]!, "test", row);
    const fenced = fenceStoreForClaim(raw as never, row.id, (admission as { claim: never }).claim);
    supersede(row);

    await expect(fenced.logEntry(row.id, "stale narration", undefined)).rejects.toBeInstanceOf(ClaimSupersededError);
    await expect(fenced.moveTask(row.id, "in-progress")).rejects.toBeInstanceOf(ClaimSupersededError);
    await expect(fenced.updateTask(row.id, { postReviewFixCount: 9 })).rejects.toBeInstanceOf(ClaimSupersededError);
    await expect(fenced.addTaskComment(row.id, "stale comment")).rejects.toBeInstanceOf(ClaimSupersededError);

    // Nothing reached the real store, so the newer round carries no trace of the stale attempt.
    expect(raw.logEntry).not.toHaveBeenCalled();
    expect(raw.moveTask).not.toHaveBeenCalled();
    expect(raw.addTaskComment).not.toHaveBeenCalled();
    expect(row.postReviewFixCount).toBeUndefined();
  });

  it("leaves reads unfenced so a superseded run can still observe state", async () => {
    const row = taskWithFailedReview();
    const raw = store(row);
    const admission = await claimRemediationAttempt(raw as never, row.id, row.workflowStepResults![0]!, "test", row);
    const fenced = fenceStoreForClaim(raw as never, row.id, (admission as { claim: never }).claim);
    supersede(row);

    await expect(fenced.getTask(row.id)).resolves.toMatchObject({ id: row.id });
    await expect(fenced.getSettings()).resolves.toMatchObject({ autoMerge: true });
  });
});
