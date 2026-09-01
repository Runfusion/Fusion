import { describe, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  AUTOMATED_BYPASS_ACTORS,
  isAuditedOperatorBypass,
  requiresContentReviewProof,
  resolveUnprovenReviewApproval,
} from "../merge/pre-merge-approval.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";

function result(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "passed",
    verdict: "APPROVE",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    findings: [{ id: "finding-1", title: "Finding", body: "Body", severity: "high", resolution: "open" }],
    ...overrides,
  };
}

describe("requiresContentReviewProof", () => {
  it.each([
    ["code-review", undefined, true],
    ["code-review", "code", true],
    ["custom-review", "code", true],
    ["custom-review", undefined, false],
  ] as const)("classifies id=%s kind=%s", (workflowStepId, reviewKind, expected) => {
    expect(requiresContentReviewProof(workflowStepId, { reviewKind })).toBe(expected);
  });
});

describe("isAuditedOperatorBypass", () => {
  const audited = {
    status: "skipped" as const,
    bypassedBy: "operator-1",
    bypassedAt: "2026-09-01T00:02:00.000Z",
    bypassReason: "Reviewer transport failed",
  };

  it.each([
    ["failed target", { ...audited, bypassedFromStatus: "failed" }, true],
    ["absent gate", { ...audited, bypassedFromStatus: "absent" }, true],
    ["fast mode", { ...audited, bypassedBy: FAST_MODE_BYPASS_ACTOR, bypassedFromStatus: "absent" }, false],
    ["missing time", { ...audited, bypassedAt: undefined }, false],
    ["missing reason", { ...audited, bypassReason: undefined }, false],
    ["blank actor", { ...audited, bypassedBy: "   " }, false],
    ["passed carrier", { ...audited, status: "passed" }, false],
  ] as const)("classifies %s", (_name, candidate, expected) => {
    expect(isAuditedOperatorBypass(candidate)).toBe(expected);
  });

  it("shares the automated actor definition with fast mode", () => {
    expect(AUTOMATED_BYPASS_ACTORS).toEqual(new Set([FAST_MODE_BYPASS_ACTOR]));
  });
});

describe("resolveUnprovenReviewApproval", () => {
  it.each([
    ["kind and identity", result({ reviewKind: "code" })],
    ["kind only", result({ workflowStepId: "custom-review", reviewKind: "code", verdict: "APPROVE_WITH_NOTES" })],
    ["identity only", result({ reviewKind: undefined })],
  ])("downgrades a singular proofless approval by %s", (_name, candidate) => {
    const resolution = resolveUnprovenReviewApproval(candidate, { workspace: false });
    expect(resolution?.downgraded).toMatchObject({
      workflowStepId: candidate.workflowStepId,
      status: "failed",
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
      findings: candidate.findings,
    });
    expect(resolution?.downgraded).not.toHaveProperty("verdict");
    expect(resolution?.downgraded.output).toContain("reviewInputFingerprint");
    expect(resolution?.downgraded.notes).toBe(resolution?.reason);
  });

  it.each([
    ["workspace", result(), { workspace: true }],
    ["plan review", result({ workflowStepId: "plan-review", reviewKind: "plan" }), { workspace: false }],
    ["non-review gate", result({ workflowStepId: "documentation-delivery", reviewKind: undefined }), { workspace: false }],
    ["post-merge", result({ phase: "post-merge" }), { workspace: false }],
    ["operator bypass", result({ status: "skipped", verdict: undefined, bypassedBy: "operator", bypassedAt: "now", bypassReason: "reason" }), { workspace: false }],
    ["fast bypass", result({ status: "skipped", verdict: undefined, bypassedBy: FAST_MODE_BYPASS_ACTOR, bypassedAt: "now", bypassReason: "reason" }), { workspace: false }],
    ["archived remediation", result({ remediationArchivedAt: "now" }), { workspace: false }],
    ["pending", result({ status: "pending", verdict: undefined }), { workspace: false }],
    ["failed", result({ status: "failed", verdict: undefined }), { workspace: false }],
    ["fingerprinted", result({ reviewInputFingerprint: "proof" }), { workspace: false }],
    ["stale fingerprint", result({ reviewInputFingerprint: "stale" }), { workspace: false }],
  ])("does not downgrade %s", (_name, candidate, options) => {
    expect(resolveUnprovenReviewApproval(candidate, options)).toBeUndefined();
  });
});
