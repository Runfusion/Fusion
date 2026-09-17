/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — behavioral contract for the per-card human plan decision predicates. These tests exist to
pin the three invariants every gate depends on: automatic `approvedPlanFingerprint` is never human
proof, proof is scoped to both the plan and the review episode, and anything absent/stale/malformed
fails closed.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import type { WorkflowStepResult } from "../types/workflow/workflow-steps.js";
import {
  HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH,
  HumanPlanApprovalMessageError,
  buildHumanPlanApprovalCreationState,
  clearHumanPlanApprovalDecision,
  hasCurrentHumanPlanApproval,
  isHumanPlanApprovalDecidable,
  isHumanPlanApprovalEnabled,
  isHumanPlanApprovalPending,
  resolveApprovedHumanPlanNote,
  resolveHumanPlanApprovalExecutionMode,
  resolvePlanReviewEpisodeId,
  sanitizeHumanPlanApprovalMessage,
} from "../planner/human-plan-approval.js";

const EPISODE = "2026-09-15T06:24:00.000Z";
const FINGERPRINT = "a".repeat(64);

function planReviewPassed(completedAt = EPISODE, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...overrides,
  } as WorkflowStepResult;
}

function armedTask(overrides: Partial<Task> = {}): Task {
  return {
    humanPlanApproval: { enabled: true },
    approvedPlanFingerprint: FINGERPRINT,
    workflowStepResults: [planReviewPassed()],
    ...overrides,
  } as Task;
}

function approvedDecision(overrides: Partial<NonNullable<NonNullable<Task["humanPlanApproval"]>["decision"]>> = {}) {
  return {
    requestId: "req-1",
    decision: "approved" as const,
    message: "Attention aux migrations",
    decidedBy: "dashboard-operator",
    decidedAt: EPISODE,
    planFingerprint: FINGERPRINT,
    planningEpisodeId: EPISODE,
    ...overrides,
  };
}

describe("isHumanPlanApprovalEnabled", () => {
  it("treats absent state as not armed so existing project policy is preserved", () => {
    expect(isHumanPlanApprovalEnabled({} as Task)).toBe(false);
    expect(isHumanPlanApprovalEnabled(undefined)).toBe(false);
  });

  it("treats an explicitly disabled state as not armed and as granting no approval", () => {
    const task = { humanPlanApproval: { enabled: false, decision: approvedDecision() } } as unknown as Task;
    expect(isHumanPlanApprovalEnabled(task)).toBe(false);
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
    expect(isHumanPlanApprovalPending(task)).toBe(false);
  });
});

describe("resolvePlanReviewEpisodeId", () => {
  it("identifies the current satisfied Plan Review result", () => {
    expect(resolvePlanReviewEpisodeId([planReviewPassed()])).toBe(EPISODE);
  });

  it("ignores a superseded result so a rejected episode can never be reused", () => {
    expect(resolvePlanReviewEpisodeId([planReviewPassed(EPISODE, { supersededAt: EPISODE })])).toBeUndefined();
  });

  it("ignores an unsatisfied result and a result carrying no usable stamp", () => {
    expect(resolvePlanReviewEpisodeId([planReviewPassed(EPISODE, { status: "failed" })])).toBeUndefined();
    expect(resolvePlanReviewEpisodeId([planReviewPassed(EPISODE, { completedAt: undefined })])).toBeUndefined();
    expect(resolvePlanReviewEpisodeId(undefined)).toBeUndefined();
  });

  it("falls back to startedAt when an adapter omits completedAt", () => {
    const started = "2026-09-15T05:00:00.000Z";
    expect(resolvePlanReviewEpisodeId([
      planReviewPassed(EPISODE, { completedAt: undefined, startedAt: started }),
    ])).toBe(started);
  });
});

describe("hasCurrentHumanPlanApproval", () => {
  it("refuses an automatic fingerprint with no operator decision", () => {
    const task = armedTask();
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
    expect(isHumanPlanApprovalPending(task)).toBe(true);
  });

  it("accepts a decision matching both the plan and the review episode", () => {
    const task = armedTask({ humanPlanApproval: { enabled: true, decision: approvedDecision() } });
    expect(hasCurrentHumanPlanApproval(task)).toBe(true);
    expect(isHumanPlanApprovalPending(task)).toBe(false);
    expect(resolveApprovedHumanPlanNote(task)).toBe("Attention aux migrations");
  });

  it("refuses a decision whose plan fingerprint no longer matches", () => {
    const task = armedTask({
      humanPlanApproval: { enabled: true, decision: approvedDecision({ planFingerprint: "b".repeat(64) }) },
    });
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
  });

  it("refuses a byte-identical regenerated plan approved in an earlier episode", () => {
    // Same fingerprint (plan text unchanged after rejection), new review episode.
    const task = armedTask({
      workflowStepResults: [
        planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
        planReviewPassed("2026-09-15T09:00:00.000Z"),
      ],
      humanPlanApproval: { enabled: true, decision: approvedDecision() },
    });
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
    expect(isHumanPlanApprovalPending(task)).toBe(true);
  });

  it("refuses a rejection record as release proof", () => {
    const task = armedTask({
      humanPlanApproval: { enabled: true, decision: approvedDecision({ decision: "rejected" }) },
    });
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
    expect(resolveApprovedHumanPlanNote(task)).toBeUndefined();
  });

  it("refuses a malformed decision payload", () => {
    const task = armedTask({
      humanPlanApproval: { enabled: true, decision: "approved" as never },
    });
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
  });

  it("refuses when Plan Review is not satisfied yet, even with a decision present", () => {
    const task = armedTask({
      workflowStepResults: [planReviewPassed(EPISODE, { status: "failed", verdict: "REVISE" })],
      humanPlanApproval: { enabled: true, decision: approvedDecision() },
    });
    expect(hasCurrentHumanPlanApproval(task)).toBe(false);
    expect(isHumanPlanApprovalPending(task)).toBe(true);
    expect(isHumanPlanApprovalDecidable(task)).toBe(false);
  });
});

describe("isHumanPlanApprovalDecidable", () => {
  it("becomes decidable once the review is satisfied and a plan fingerprint exists", () => {
    expect(isHumanPlanApprovalDecidable(armedTask())).toBe(true);
  });

  it("is not decidable without a plan fingerprint", () => {
    expect(isHumanPlanApprovalDecidable(armedTask({ approvedPlanFingerprint: undefined }))).toBe(false);
  });

  it("is not decidable once the current decision already approved this plan", () => {
    const task = armedTask({ humanPlanApproval: { enabled: true, decision: approvedDecision() } });
    expect(isHumanPlanApprovalDecidable(task)).toBe(false);
  });
});

describe("resolveApprovedHumanPlanNote", () => {
  it("returns undefined for a blank note so prompts never gain an empty section", () => {
    const task = armedTask({
      humanPlanApproval: { enabled: true, decision: approvedDecision({ message: "   " }) },
    });
    expect(resolveApprovedHumanPlanNote(task)).toBeUndefined();
  });

  it("preserves Unicode content verbatim", () => {
    const message = "Attention : ne casse pas l'été ✅ 表示";
    const task = armedTask({
      humanPlanApproval: { enabled: true, decision: approvedDecision({ message }) },
    });
    expect(resolveApprovedHumanPlanNote(task)).toBe(message);
  });
});

describe("sanitizeHumanPlanApprovalMessage", () => {
  it("accepts absent and blank input as no message", () => {
    expect(sanitizeHumanPlanApprovalMessage(undefined)).toBeUndefined();
    expect(sanitizeHumanPlanApprovalMessage(null)).toBeUndefined();
    expect(sanitizeHumanPlanApprovalMessage("   \n ")).toBeUndefined();
  });

  it("trims surrounding whitespace and preserves Unicode", () => {
    expect(sanitizeHumanPlanApprovalMessage("  vérifie les index 🚀  ")).toBe("vérifie les index 🚀");
  });

  it("refuses a non-string value", () => {
    expect(() => sanitizeHumanPlanApprovalMessage(42)).toThrow(HumanPlanApprovalMessageError);
    expect(() => sanitizeHumanPlanApprovalMessage({ text: "x" })).toThrow(HumanPlanApprovalMessageError);
  });

  it("refuses an over-long message and accepts one exactly at the limit", () => {
    const atLimit = "x".repeat(HUMAN_PLAN_APPROVAL_MESSAGE_MAX_LENGTH);
    expect(sanitizeHumanPlanApprovalMessage(atLimit)).toBe(atLimit);
    expect(() => sanitizeHumanPlanApprovalMessage(`${atLimit}y`)).toThrow(HumanPlanApprovalMessageError);
  });
});

describe("buildHumanPlanApprovalCreationState", () => {
  it("arms from an explicit true flag", () => {
    expect(buildHumanPlanApprovalCreationState(true)).toEqual({ enabled: true });
  });

  it("does not arm from absent, false, or string input", () => {
    expect(buildHumanPlanApprovalCreationState(undefined)).toBeUndefined();
    expect(buildHumanPlanApprovalCreationState(false)).toBeUndefined();
    expect(buildHumanPlanApprovalCreationState("true")).toBeUndefined();
  });

  it("drops a forged decision supplied at creation", () => {
    const forged = { enabled: true, decision: approvedDecision() };
    expect(buildHumanPlanApprovalCreationState(forged)).toEqual({ enabled: true });
  });
});

/*
FN-408 remediation: arming the requirement neutralizes Fast, because Fast skips planning and plan
review entirely and would leave the card with no decision to make and no way out.
*/
describe("resolveHumanPlanApprovalExecutionMode", () => {
  it("drops fast execution for an armed card", () => {
    expect(resolveHumanPlanApprovalExecutionMode(true, "fast")).toBeUndefined();
  });

  it("leaves every other combination untouched", () => {
    expect(resolveHumanPlanApprovalExecutionMode(false, "fast")).toBe("fast");
    expect(resolveHumanPlanApprovalExecutionMode(true, "standard")).toBe("standard");
    expect(resolveHumanPlanApprovalExecutionMode(true, undefined)).toBeUndefined();
    expect(resolveHumanPlanApprovalExecutionMode(false, undefined)).toBeUndefined();
  });
});

describe("clearHumanPlanApprovalDecision", () => {
  it("keeps the requirement and drops the decision", () => {
    expect(clearHumanPlanApprovalDecision({ enabled: true, decision: approvedDecision() })).toEqual({ enabled: true });
  });

  it("returns the explicit clear sentinel when nothing is armed", () => {
    expect(clearHumanPlanApprovalDecision(undefined)).toBeNull();
    expect(clearHumanPlanApprovalDecision({ enabled: false })).toBeNull();
  });
});

describe("legacy data", () => {
  it("never arms from the retired requirePlanApproval value", () => {
    const legacy = { requirePlanApproval: true, approvedPlanFingerprint: FINGERPRINT } as unknown as Task;
    expect(isHumanPlanApprovalEnabled(legacy)).toBe(false);
    expect(isHumanPlanApprovalPending(legacy)).toBe(false);
    expect(hasCurrentHumanPlanApproval(legacy)).toBe(false);
  });
});
