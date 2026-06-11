import { describe, expect, it } from "vitest";
import { projectWorkflowWorkStatus, type WorkflowWorkItem } from "@fusion/core";
import { classifyMergePrimitiveResult } from "../workflow-merge-nodes.js";
import { nextWorkflowRetryState } from "../workflow-node-retry-policy.js";
import { publishWorkflowRecoveryEvent } from "../workflow-recovery-events.js";
import { decideBranchGroupMemberIntegration, decideBranchGroupPromotion } from "../workflow-branch-group-merge.js";

describe("workflow-owned merge cutover matrix", () => {
  it("classifies merge success manual hold and already-landed outcomes", () => {
    expect(classifyMergePrimitiveResult({ status: "merged" }, undefined, "success")).toEqual({
      outcome: "success",
      value: "merged",
    });
    expect(classifyMergePrimitiveResult({ status: "merged", noOp: true }, undefined, "success")).toEqual({
      outcome: "success",
      value: "already-landed",
    });
    expect(classifyMergePrimitiveResult({ status: "manual-required" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "manual-required",
    });
  });

  it("classifies transient and permanent merge failures", () => {
    expect(classifyMergePrimitiveResult({ status: "timeout" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "transient-failure",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "File scope violation" }, undefined, "failure")).toEqual({
      outcome: "failure",
      value: "file-scope-violation",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "Already landed on main" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "already-landed",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "socket hang up" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "transient-failure",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "manual conflict resolution required" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "manual-required",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "branch rejected" }, undefined, "failure")).toEqual({
      outcome: "failure",
      value: "merge-failed",
    });
  });

  it("covers retry exhaustion", () => {
    expect(nextWorkflowRetryState({
      runId: "run-1",
      taskId: "FN-CUTOVER",
      nodeId: "merge-retry",
      attempt: 2,
      maxAttempts: 3,
      now: "2026-06-09T00:00:00.000Z",
    })).toMatchObject({ attempt: 3, exhausted: true, retryAfter: null });
  });

  it("publishes recovery wake work", () => {
    const recoveryStore = {
      upsertWorkflowWorkItem: (input: any) => ({ id: "recovery-work", ...input, attempt: 0, retryAfter: null, leaseOwner: null, leaseExpiresAt: null, createdAt: input.now, updatedAt: input.now }),
    };
    expect(publishWorkflowRecoveryEvent(recoveryStore, {
      taskId: "FN-CUTOVER",
      kind: "already-landed",
      source: "self-healing",
      now: "2026-06-09T00:00:00.000Z",
    })).toMatchObject({ nodeId: "recovery-router", kind: "recovery", state: "runnable" });
  });

  it("covers branch-group member integration and promotion gates", () => {
    expect(decideBranchGroupMemberIntegration({
      task: { id: "FN-CUTOVER", branchContext: { assignmentMode: "shared" } as any },
      settings: { autoMerge: false },
    })).toMatchObject({ allowed: true, stage: "member-integration" });
    expect(decideBranchGroupPromotion({
      task: { id: "FN-CUTOVER", branchContext: { assignmentMode: "shared" } as any },
      settings: { autoMerge: false },
    })).toMatchObject({ allowed: false, stage: "group-promotion" });
  });

  it("uses workflow projection before legacy retry fields", () => {
    const work: WorkflowWorkItem = {
      id: "work-1",
      runId: "run-1",
      taskId: "FN-CUTOVER",
      nodeId: "merge-retry",
      kind: "retry",
      state: "retrying",
      attempt: 1,
      retryAfter: "2026-06-09T00:05:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "socket hang up",
      blockedReason: null,
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };
    expect(projectWorkflowWorkStatus({ id: "FN-CUTOVER", mergeRetries: 99, status: "legacy" } as any, [work])).toMatchObject({
      source: "workflow",
      status: "retrying",
      attempt: 1,
    });
  });
});
