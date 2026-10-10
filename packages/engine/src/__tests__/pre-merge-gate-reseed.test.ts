import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC: "Plan approved but spec lock unavailable:",
  computeWorkflowIrPin: vi.fn(() => ({ irHash: "ir-hash" })),
  evaluatePreMergeApprovals: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
}));
vi.mock("@fusion/core", () => core);

import {
  rerouteFailedNoVerdictPreMergeGateToReview,
  rerouteUnrunPreMergeGateToReview,
} from "../merge/pre-merge-gate-reseed.js";

const singular = { kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } } as any;
const subject = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-9243",
  column: "in-review",
  autoMerge: true,
  workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", reviewKind: "plan" }],
  ...overrides,
}) as any;

function store(seeded = true) {
  return {
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded })),
    moveTask: vi.fn(),
  } as any;
}

const required = new Set(["security-review", "code-review"]);

beforeEach(() => {
  core.evaluatePreMergeApprovals.mockReturnValue([
    { workflowStepId: "security-review", state: "missing" },
    { workflowStepId: "code-review", state: "missing" },
  ]);
  core.resolveWorkflowIrForTask.mockResolvedValue({
    name: "Review",
    nodes: [
      { id: "security-review", kind: "optional-group", column: "in-progress", config: {} },
      { id: "code-review", kind: "step-review", column: "in-review", config: {} },
    ],
  });
});

describe("unrun pre-merge gate reseed", () => {
  it.each(["output", "notes"])("does not redispatch deterministic plan-lock failures carried in %s", async (field) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{
      workflowStepId: "security-review", reviewKind: "plan", status: "failed",
      [field]: "Plan approved but spec lock unavailable: mission-missing (mission).",
    }] });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required, mergeContent: singular,
      })).rerouted).toBe(false);
    }
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it.each([rerouteUnrunPreMergeGateToReview, rerouteFailedNoVerdictPreMergeGateToReview])("never seeds pre-merge work after landing", async (reroute) => {
    const fake = store();
    const task = subject({ mergeDetails: { mergeConfirmed: true }, workflowStepResults: [{ workflowStepId: "code-review", status: "failed" }] });
    expect((await reroute(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("bounds consecutive failed no-verdict attempts without discarding evidence", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", phase: "pre-merge", status: "failed" };
    const task = subject({ workflowStepResults: [{ ...failure, priorAttempts: [failure, failure, failure] }] });
    const before = structuredClone(task);
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(false);
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("allows recovery for new review input despite old failure history", async () => {
    const fake = store();
    const failure = { workflowStepId: "code-review", status: "failed", reviewInputFingerprint: "old" };
    const task = subject({ workflowStepResults: [{ ...failure, reviewInputFingerprint: "new", priorAttempts: [failure, failure, failure] }] });
    expect((await rerouteFailedNoVerdictPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular })).rerouted).toBe(true);
  });

  it("seeds the earliest missing gate without mutating review evidence or moving the card", async () => {
    const task = subject();
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9243", nodeId: "security-review", state: "runnable", sourceColumn: "in-review", targetColumn: "in-progress",
    }));
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it.each([
    ["undefined results", subject({ workflowStepResults: undefined }), required, singular, "seeded"],
    ["empty results", subject({ workflowStepResults: [] }), required, singular, "seeded"],
    ["all reported", subject(), required, singular, "no-unrun-gate"],
    ["no enabled gates", subject(), new Set<string>(), singular, "no-unrun-gate"],
    ["workspace content", subject(), required, { kind: "workspace" }, "not-singular"],
    ["workspace task", subject({ workspaceWorktrees: {} }), required, singular, "not-singular"],
    ["operator hold", subject({ paused: true }), required, singular, "operator-held"],
  ] as const)("declines %s without writes", async (_label, task, requiredIds, content, reason) => {
    if (reason === "no-unrun-gate" && requiredIds.size > 0) core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "approved" },
    ]);
    const before = structuredClone(task);
    const fake = store();
    const result = await rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: requiredIds, mergeContent: content as any });
    expect(result.reason).toBe(reason);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("preserves last-result semantics and marks a raced seed as an active continuation", async () => {
    core.evaluatePreMergeApprovals.mockReturnValueOnce([
      { workflowStepId: "security-review", state: "approved" },
      { workflowStepId: "code-review", state: "missing" },
    ]);
    const task = subject({ workflowStepResults: [{ workflowStepId: "security-review", status: "failed" }, { workflowStepId: "security-review", status: "passed", verdict: "APPROVE" }] });
    const before = structuredClone(task);
    const fake = store(false);
    await expect(rerouteUnrunPreMergeGateToReview(fake, task, { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(fake.moveTask).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it("declines a missing gate absent from the workflow route", async () => {
    core.resolveWorkflowIrForTask.mockResolvedValueOnce({ name: "Review", nodes: [] });
    const fake = store();
    await expect(rerouteUnrunPreMergeGateToReview(fake, subject(), { requiredPreMergeStepIds: required, mergeContent: singular }))
      .resolves.toMatchObject({ rerouted: false, reason: "no-review-route" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("re-seeds exactly a failed no-verdict code review while retaining its finding evidence", async () => {
    const task = subject({
      steps: [{ name: "Documentation & Delivery", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const before = structuredClone(task);
    const fake = store();

    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: true, reason: "seeded", nodeId: "code-review" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      nodeId: "code-review",
      runId: expect.stringContaining("failed-no-verdict-pre-merge-gate-reseed"),
    }));
    expect(task).toEqual(before);
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]).toMatchObject({ status: "done" });
  });

  it.each([
    ["a real REVISE", { status: "failed", verdict: "REVISE" }],
    ["a deterministic input-proof failure", { status: "failed", output: "Code Review failed before producing a verdict: review-input-unprovable" }],
    ["a direct input-proof diagnostic", { status: "failed", output: "Code Review review input is unprovable (git-diff-too-large); reviewer dispatch refused." }],
    ["a pending result", { status: "pending" }],
    ["a bypassed result", { status: "skipped", bypassedBy: "operator" }],
    ["a post-merge result", { status: "failed", phase: "post-merge" }],
  ])("does not re-run %s", async (_label, result) => {
    const fake = store();
    const task = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", ...result }] });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "no-failed-no-verdict-gate" });
    expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("refuses duplicate dispatch, manual hold, selection change, and non-singular content", async () => {
    const retryTask = subject({ workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }] });
    const duplicate = store(false);
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(duplicate, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
    })).resolves.toMatchObject({ rerouted: false, reason: "active-continuation", nodeId: "code-review" });

    for (const [task, content, expected] of [
      [subject({ paused: true, workflowStepResults: retryTask.workflowStepResults }), singular, "operator-held"],
      [retryTask, { kind: "workspace" }, "not-singular"],
    ] as const) {
      const fake = store();
      await expect(rerouteFailedNoVerdictPreMergeGateToReview(fake, task, {
        requiredPreMergeStepIds: required,
        mergeContent: content as any,
      })).resolves.toMatchObject({ rerouted: false, reason: expected });
      expect(fake.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    }

    const changed = store(false);
    changed.seedWorkspaceCodeReviewContinuationIfIdle.mockResolvedValueOnce({ seeded: false, reason: "workflow-selection-changed" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(changed, retryTask, {
      requiredPreMergeStepIds: required,
      mergeContent: singular,
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: ["code-review"] },
    })).resolves.toMatchObject({ rerouted: false, reason: "workflow-selection-changed" });
  });
});
