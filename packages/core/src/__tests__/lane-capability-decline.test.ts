import { describe, expect, it } from "vitest";
import {
  LANE_CAPABILITY_DECLINE_CODE,
  LANE_CAPABILITY_DECLINE_REMEDY,
  buildLaneCapabilityFreezePatch,
  formatLaneCapabilityDeclineReason,
  hasLaneCapabilityFreeze,
  isLaneCapabilityDecline,
  laneCapabilityDeclinePolicy,
  describeLaneCapabilityDecline,
  REVIEW_CAPABILITY_DECLINE_CODE,
  REVIEW_CAPABILITY_DECLINE_REMEDY,
  REVIEWER_RUN_LANE_DECLINE_PREFIX,
  reviewerRunLaneDeclineReason,
} from "../index.js";

/** The implementation sentence's remedy phrase that must NEVER appear in a review decline. */
const REVIEW_DECLINE_FORBIDDEN_PHRASE = '"executor"-role agent';

/*
FNXC:LaneCapabilityDecline 2026-09-26-19:40 (RUFU-272 Step 3):
The named decline is the operator contract of the lane-capability fix: the refusal must name the
lane, the policy/roles that produced it, the card, and the remedy — on the task row, not only in an
agent log. These pins guard the sentence shape, the classifier round-trip against the EXACT
persisted builder output, and the freeze's resume preservation (rename-aware by construction).
*/

const auditLane = { id: "agent-audit", role: "reviewer" as never, roles: ["reviewer"] as never, runtimeConfig: { assignmentPolicy: "none" } };
const card = { id: "FN-1", column: "todo", currentStep: 0 };

describe("formatLaneCapabilityDeclineReason", () => {
  it("names the lane id, the policy, the card, and the remedy", () => {
    const reason = formatLaneCapabilityDeclineReason(auditLane, card);
    expect(reason).toContain("agent-audit");
    expect(reason).toContain('assignmentPolicy "none"');
    expect(reason).toContain("FN-1");
    expect(reason).toContain(LANE_CAPABILITY_DECLINE_REMEDY);
    // The remedy names the knobs an operator can actually turn.
    expect(reason).toMatch(/reassign|role tags|assignment policy/i);
  });

  it("policy line carries roles for a policy-auto role refusal", () => {
    const lane = { id: "agent-x", role: "reviewer" as never, roles: ["reviewer", "triage"] as never };
    expect(laneCapabilityDeclinePolicy(lane)).toBe("auto/[reviewer,triage]");
    expect(formatLaneCapabilityDeclineReason(lane, card)).toContain('roles "reviewer, triage"');
  });
});

describe("buildLaneCapabilityFreezePatch + classifier round-trip", () => {
  const stranded = {
    id: "RUFU-257",
    column: "building", // renamed work lane — the resume point must be THIS lane, never hardcoded todo
    currentStep: 2,
    worktree: "/tmp/wt/rufu-257",
    branch: "fusion/rufu-257",
  };

  it("preserves the resume column / step / worktree / branch of a renamed-lane card", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(patch.externalBlock?.resume).toEqual({
      column: "building",
      currentStep: 2,
      worktree: "/tmp/wt/rufu-257",
      branch: "fusion/rufu-257",
    });
    // The freeze performs NO column move: whatever resume-adjacent move happens, the lane is the card's own.
    expect(patch.column).toBeUndefined();
  });

  it("classifier round-trips on the EXACT persisted builder shapes and refuses unrelated blocks", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(isLaneCapabilityDecline({ error: patch.error, externalBlock: patch.externalBlock })).toBe(true);
    expect(hasLaneCapabilityFreeze({ ...stranded, ...patch } as never)).toBe(true);

    expect(isLaneCapabilityDecline({
      error: "BLOCKED: project-configuration/overlap-delivery-unavailable: other",
      externalBlock: { origin: "project-configuration", code: "overlap-delivery-unavailable", message: "x", source: "dependency-readiness", blockedAt: new Date().toISOString(), resume: { column: "building", currentStep: 0 } },
    })).toBe(false);
    expect(isLaneCapabilityDecline({ error: "BLOCKED: host-environment/HOST-X: disk", externalBlock: undefined })).toBe(false);
    expect(isLaneCapabilityDecline({ error: undefined, externalBlock: undefined })).toBe(false);
  });

  it("freeze is operator-recoverable state: external-block pause, NEVER pausedByAgentId", () => {
    const patch = buildLaneCapabilityFreezePatch(stranded as never, auditLane as never);
    expect(patch.status).toBe("blocked");
    expect(patch.paused).toBe(true);
    expect(patch.pausedReason).toBe("external-block");
    /* Design Lock 8 hazard: a card paused BY ITS OWN ASSIGNEE is auto-unpaused by the assignment
    seam. The decline freeze must never carry an agent pause attribution for exactly that reason. */
    expect(patch.pausedByAgentId).toBeNull();
    expect(patch.error).toContain(LANE_CAPABILITY_DECLINE_CODE);
    expect(patch.externalBlock?.origin).toBe("project-configuration");
  });
});

/*
FNXC:LaneCapabilityWake 2026-10-22-15:55 (RUFU-766):
The review decline is a different operator contract from the implementation decline. The implementation sentence
names `executor` as the missing role and the Workflow Executor hand-off as the remedy — for a card sitting in its
review lane both are wrong: granting a reviewer the executor role does not make it review-capable, and handing the
card to executors removes it from the pool that owns the review. rtm3 (2026-10-22) had that sentence on eleven
cards while the real gap was an executor-only pool plus `operatorLanguage:"auto"` crashing every review session
(RUFU-707). These legs pin the two vocabularies apart.
*/
describe("describeLaneCapabilityDecline (review vs implementation purpose)", () => {
  // rtm3's real shape: one lane per project, `assignmentPolicy` unset (=> auto), roles ["reviewer"].
  const reviewerLane = { id: "agent-a48e6364", role: "reviewer" as never, roles: ["reviewer"] as never, runtimeConfig: {} };
  // The lane a genuine review refusal is about: no `reviewer` tag at all.
  const executorLane = { id: "agent-25b8efb4", role: "executor" as never, roles: ["executor"] as never, runtimeConfig: { assignmentPolicy: "auto" } };
  const reviewCard = { id: "KUBE-027", column: "in-review", currentStep: 0 };
  const implCard = { id: "KUBE-184", column: "todo", currentStep: 0 };

  it("review purpose: names the review task, its lane, and the reviewer requirement — never `executor`", () => {
    const d = describeLaneCapabilityDecline(executorLane, reviewCard, "review");
    expect(d.auditCode).toBe(REVIEW_CAPABILITY_DECLINE_CODE);
    expect(d.reason).toContain("review task KUBE-027");
    expect(d.reason).toContain("Review lane: `in-review`");
    expect(d.reason).toContain('"reviewer"');
    expect(d.reason).not.toContain(REVIEW_DECLINE_FORBIDDEN_PHRASE);
    expect(d.reason).not.toContain("Workflow Executor");
    expect(d.remedy).toContain("reviewer");
    expect(d.remedy).not.toContain(REVIEW_DECLINE_FORBIDDEN_PHRASE);
    // A renamed board names its own lane rather than the legacy literal.
    expect(describeLaneCapabilityDecline(executorLane, { id: "KUBE-027", column: "qa-acceptance" }, "review").reason)
      .toContain("Review lane: `qa-acceptance`");
  });

  it("implementation purpose: the sentence, remedy, and code are the pre-RUFU-766 ones, byte for byte", () => {
    const d = describeLaneCapabilityDecline(reviewerLane, implCard, "implementation");
    expect(d.auditCode).toBe(LANE_CAPABILITY_DECLINE_CODE);
    expect(d.reason).toBe(formatLaneCapabilityDeclineReason(reviewerLane, implCard));
    expect(d.remedy).toBe(LANE_CAPABILITY_DECLINE_REMEDY);
    expect(d.ledgerReason).toBe(reviewerRunLaneDeclineReason(reviewerLane));
  });

  it("the ledger witness keeps its historical shape for BOTH purposes — a deployed sweep must keep reading it", () => {
    const reviewLedger = describeLaneCapabilityDecline(reviewerLane, reviewCard, "review").ledgerReason;
    expect(reviewLedger).toBe(`${REVIEWER_RUN_LANE_DECLINE_PREFIX}auto/[reviewer]`);
    expect(reviewLedger).toBe(reviewerRunLaneDeclineReason(reviewerLane));
    // The audit code is what distinguishes them; the witness text is the shared compatibility surface.
    expect(describeLaneCapabilityDecline(reviewerLane, reviewCard, "review").ledgerReason)
      .toBe(describeLaneCapabilityDecline(reviewerLane, implCard, "implementation").ledgerReason);
  });
});
