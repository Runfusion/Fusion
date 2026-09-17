/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — behavioral contract of the per-card delivery lock.

These assert OBSERVABLE decisions of the shared predicates every merge door consumes, not source
text: whether the door opens, which destination an accord authorizes, and which evidence change
invalidates it.
*/

import { describe, expect, it } from "vitest";

import {
  HUMAN_MERGE_APPROVAL_BLOCKER,
  HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH,
  HUMAN_MERGE_REJECTION_BLOCKER,
  HumanMergeApprovalMessageError,
  buildDuplicatedHumanMergeApprovalState,
  buildHumanMergeApprovalCreationState,
  clearHumanMergeApprovalDecision,
  describeHumanMergeContentSignature,
  describeHumanMergeTargetSignature,
  encodeHumanMergeCandidateToken,
  formatHumanMergeRejectionSection,
  getHumanMergeApprovalBlocker,
  hasCurrentHumanMergeApproval,
  hasInFlightHumanMergeCreatePrIntent,
  isHumanMergeApprovalBlocker,
  isHumanMergeApprovalEnabled,
  isSameHumanMergeCandidate,
  isValidHumanMergeCandidate,
  nextHumanMergeRemediationGeneration,
  parseHumanMergeDecisionAction,
  resolveHumanMergeDecision,
  resolveHumanMergeLockGeneration,
  resolvePendingHumanMergeRejection,
  sanitizeHumanMergeInstruction,
  sanitizeHumanMergeNote,
  toggleHumanMergeApprovalState,
  type HumanMergeApprovalState,
  type HumanMergeCandidateIdentity,
  type HumanMergeDeliveryAction,
} from "../merge/human-merge-approval.js";
import type { MergeContentDescriptor } from "../merge/merge-content-descriptor.js";

const CANDIDATE: HumanMergeCandidateIdentity = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:abc123",
  targetSignature: "merge:repo@origin:fusion/FN-1->main",
};

function armed(
  overrides: Partial<HumanMergeApprovalState> = {},
): { humanMergeApproval: HumanMergeApprovalState } {
  return { humanMergeApproval: { enabled: true, generation: 1, ...overrides } };
}

function decided(
  deliveryAction: HumanMergeDeliveryAction,
  candidate: HumanMergeCandidateIdentity = CANDIDATE,
): { humanMergeApproval: HumanMergeApprovalState } {
  return armed({
    decision: {
      requestId: "req-1",
      action: deliveryAction,
      deliveryAction,
      decidedBy: "dashboard-operator",
      decidedAt: "2026-09-17T11:00:00.000Z",
      candidate,
    },
  });
}

describe("FN-514 delivery lock — arming", () => {
  it("treats absent, false and malformed state as not armed, so legacy rows keep today's behavior", () => {
    expect(isHumanMergeApprovalEnabled(undefined)).toBe(false);
    expect(isHumanMergeApprovalEnabled({})).toBe(false);
    expect(isHumanMergeApprovalEnabled({ humanMergeApproval: { enabled: false, generation: 3 } })).toBe(false);
    expect(isHumanMergeApprovalEnabled({ humanMergeApproval: { enabled: "yes" } as never })).toBe(false);
    expect(getHumanMergeApprovalBlocker({})).toBeUndefined();
  });

  it("blocks delivery for an armed card with no decision at all", () => {
    expect(getHumanMergeApprovalBlocker(armed())).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
    expect(isHumanMergeApprovalBlocker(getHumanMergeApprovalBlocker(armed()))).toBe(true);
  });

  it("creation accepts only the boolean and never a caller-supplied decision", () => {
    expect(buildHumanMergeApprovalCreationState(true)).toEqual({ enabled: true, generation: 1 });
    expect(buildHumanMergeApprovalCreationState(false)).toBeUndefined();
    expect(buildHumanMergeApprovalCreationState(undefined)).toBeUndefined();
    const forged = buildHumanMergeApprovalCreationState({
      enabled: true,
      generation: 99,
      decision: { requestId: "x", action: "merge", deliveryAction: "merge", decidedBy: "me", decidedAt: "now", candidate: CANDIDATE },
    } as never);
    expect(forged).toEqual({ enabled: true, generation: 1 });
    expect(hasCurrentHumanMergeApproval({ humanMergeApproval: forged })).toBe(false);
  });

  it("every toggle bumps the generation, so a prior accord can never be revived by re-arming", () => {
    /*
    Disarming RETAINS the row so the counter keeps advancing. Dropping it would reset the generation
    to 1 on the next arm, and a candidate captured under generation 1 would then match again.
    */
    const disarmed = toggleHumanMergeApprovalState({ enabled: true, generation: 4 }, false);
    expect(disarmed).toMatchObject({ enabled: false, generation: 5 });
    expect(isHumanMergeApprovalEnabled({ humanMergeApproval: disarmed! })).toBe(false);
    expect(toggleHumanMergeApprovalState(disarmed!, true)?.generation).toBe(6);

    const rearmed = toggleHumanMergeApprovalState({ enabled: true, generation: 4 }, true);
    expect(rearmed?.generation).toBe(5);
    expect(resolveHumanMergeLockGeneration({ humanMergeApproval: rearmed! })).toBe(5);
    // The stale decision references generation 4 and is therefore unusable.
    expect(resolveHumanMergeDecision({ humanMergeApproval: { ...rearmed!, decision: decided("merge").humanMergeApproval.decision } })).toBeUndefined();
  });
});

describe("FN-514 delivery lock — destination is part of the authorization", () => {
  it("a merge accord opens the door", () => {
    expect(hasCurrentHumanMergeApproval(decided("merge"))).toBe(true);
    expect(getHumanMergeApprovalBlocker(decided("merge"))).toBeUndefined();
  });

  it("a create-pr accord NEVER opens a merge door", () => {
    expect(hasCurrentHumanMergeApproval(decided("create-pr"))).toBe(false);
    expect(getHumanMergeApprovalBlocker(decided("create-pr"))).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("a create-pr accord is in-flight until its receipt settles, closing the window before prInfo.manual exists", () => {
    expect(hasInFlightHumanMergeCreatePrIntent(decided("create-pr"))).toBe(true);
    const settled = decided("create-pr");
    settled.humanMergeApproval.decision!.receipt = { state: "succeeded", at: "now", prNumber: 7 };
    expect(hasInFlightHumanMergeCreatePrIntent(settled)).toBe(false);
    // Even a succeeded PR handoff still refuses merge: it is not a merge authorization.
    expect(hasCurrentHumanMergeApproval(settled)).toBe(false);
    expect(hasInFlightHumanMergeCreatePrIntent(decided("merge"))).toBe(false);
  });
});

describe("FN-514 delivery lock — candidate identity binding", () => {
  it("matching live evidence keeps the accord usable", () => {
    expect(hasCurrentHumanMergeApproval(decided("merge"), {
      workflowSignature: CANDIDATE.workflowSignature,
      reviewEpisodeId: CANDIDATE.reviewEpisodeId,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "abc123" } },
      target: { kind: "merge", repositories: [{ repository: "repo", remote: "origin", head: "fusion/FN-1", base: "main" }] },
    })).toBe(true);
  });

  it.each<[string, Parameters<typeof hasCurrentHumanMergeApproval>[1]]>([
    ["changed content", { mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "different" } } }],
    ["unreadable content", { mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git failed" } } }],
    ["new review episode", { reviewEpisodeId: "2026-09-17T12:00:00.000Z" }],
    ["new workflow selection", { workflowSignature: "builtin:pr@2" }],
    ["changed target base", { target: { kind: "merge", repositories: [{ repository: "repo", remote: "origin", head: "fusion/FN-1", base: "release" }] } }],
    ["changed scope revision", { repositoryScopeRevision: 9 }],
  ])("refuses the accord when %s", (_label, evidence) => {
    expect(hasCurrentHumanMergeApproval(decided("merge"), evidence)).toBe(false);
  });

  it("a note or receipt update alone does not invalidate the accord", () => {
    const withNote = decided("merge");
    withNote.humanMergeApproval.decision!.message = "ship it";
    withNote.humanMergeApproval.decision!.receipt = { state: "in-progress", at: "now" };
    expect(hasCurrentHumanMergeApproval(withNote, {
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "abc123" } },
    })).toBe(true);
  });

  it("recovery scanners that supply no evidence still see the lock rather than merge-readiness", () => {
    expect(getHumanMergeApprovalBlocker(armed())).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("refuses a decision whose persisted candidate is structurally invalid", () => {
    const forged = armed({
      decision: {
        requestId: "r", action: "merge", deliveryAction: "merge", decidedBy: "x", decidedAt: "y",
        candidate: { lockGeneration: 1, workflowSignature: "", reviewEpisodeId: "e", contentSignature: "c", targetSignature: "t" },
      },
    });
    expect(resolveHumanMergeDecision(forged)).toBeUndefined();
    expect(hasCurrentHumanMergeApproval(forged)).toBe(false);
  });
});

describe("FN-514 content and target signatures", () => {
  it("distinguishes proven-empty from unavailable evidence", () => {
    expect(describeHumanMergeContentSignature({ kind: "singular", diff: { state: "empty" } })).toBe("singular:empty");
    expect(describeHumanMergeContentSignature({ kind: "singular", diff: { state: "unavailable", reason: "x" } })).toBeUndefined();
    expect(describeHumanMergeContentSignature(undefined)).toBeUndefined();
  });

  it("orders workspace repositories canonically so key order cannot change the signature", () => {
    const a: MergeContentDescriptor = {
      kind: "workspace",
      repositories: { state: "captured", fingerprints: { b: "2", a: "1" }, inScopeModified: ["z", "y"] },
    };
    const b: MergeContentDescriptor = {
      kind: "workspace",
      repositories: { state: "captured", fingerprints: { a: "1", b: "2" }, inScopeModified: ["y", "z"] },
    };
    expect(describeHumanMergeContentSignature(a)).toBe(describeHumanMergeContentSignature(b));
    expect(describeHumanMergeContentSignature({ kind: "workspace", repositories: { state: "unavailable", reason: "x" } })).toBeUndefined();
  });

  it("separates the create-pr target from the merge target for identical repositories", () => {
    const repositories = [{ repository: "r", remote: "origin", head: "h", base: "b" }];
    expect(describeHumanMergeTargetSignature({ kind: "merge", repositories }))
      .not.toBe(describeHumanMergeTargetSignature({ kind: "create-pr", repositories }));
    expect(describeHumanMergeTargetSignature({ kind: "merge", repositories: [] })).toBeUndefined();
  });

  it("produces an unambiguous candidate token even when a field contains the separator", () => {
    const a = encodeHumanMergeCandidateToken({ ...CANDIDATE, workflowSignature: "a~b", reviewEpisodeId: "c" });
    const b = encodeHumanMergeCandidateToken({ ...CANDIDATE, workflowSignature: "a", reviewEpisodeId: "b~c" });
    expect(a).not.toBe(b);
    expect(isSameHumanMergeCandidate(CANDIDATE, { ...CANDIDATE })).toBe(true);
    expect(isSameHumanMergeCandidate(CANDIDATE, undefined)).toBe(false);
    expect(isValidHumanMergeCandidate({ ...CANDIDATE, lockGeneration: "1" })).toBe(false);
  });
});

describe("FN-514 messages", () => {
  it("accepts an empty note for positive actions but refuses an empty rejection instruction", () => {
    expect(sanitizeHumanMergeNote("   ")).toBeUndefined();
    expect(sanitizeHumanMergeNote(undefined)).toBeUndefined();
    expect(sanitizeHumanMergeNote("  ok  ")).toBe("ok");
    expect(() => sanitizeHumanMergeInstruction("   ")).toThrow(HumanMergeApprovalMessageError);
    expect(() => sanitizeHumanMergeInstruction(undefined)).toThrow(HumanMergeApprovalMessageError);
    expect(sanitizeHumanMergeInstruction("  fix the nav  ")).toBe("fix the nav");
  });

  it("enforces the shared length ceiling on both", () => {
    const tooLong = "x".repeat(HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH + 1);
    expect(() => sanitizeHumanMergeNote(tooLong)).toThrow(HumanMergeApprovalMessageError);
    expect(() => sanitizeHumanMergeInstruction(tooLong)).toThrow(HumanMergeApprovalMessageError);
    expect(sanitizeHumanMergeInstruction("x".repeat(HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH))).toHaveLength(
      HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH,
    );
    expect(() => sanitizeHumanMergeNote(42 as never)).toThrow(HumanMergeApprovalMessageError);
  });

  it("refuses an unknown or generic action rather than defaulting to one", () => {
    expect(parseHumanMergeDecisionAction("merge")).toBe("merge");
    expect(parseHumanMergeDecisionAction("create-pr")).toBe("create-pr");
    expect(parseHumanMergeDecisionAction("reject")).toBe("reject");
    for (const bad of ["approve", "MERGE", "", undefined, 1]) {
      expect(() => parseHumanMergeDecisionAction(bad)).toThrow(HumanMergeApprovalMessageError);
    }
  });
});

describe("FN-514 rejection is not cancellable by toggling the lock", () => {
  const rejection = {
    requestId: "rej-1",
    instruction: "The navigation is wrong",
    rejectedBy: "dashboard-operator",
    rejectedAt: "2026-09-17T11:30:00.000Z",
    candidate: CANDIDATE,
    remediationGeneration: 1,
    state: "pending" as const,
  };

  it("blocks delivery while a rejection still owes corrections, before any approval consideration", () => {
    expect(getHumanMergeApprovalBlocker(armed({ rejection }))).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
    // Even with a positive accord recorded, the pending rejection wins.
    const both = decided("merge");
    both.humanMergeApproval.rejection = rejection;
    expect(getHumanMergeApprovalBlocker(both)).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
  });

  it("disarming the lock preserves the rejection obligation and its instruction", () => {
    const disarmed = toggleHumanMergeApprovalState({ enabled: true, generation: 1, rejection }, false);
    expect(disarmed).not.toBeNull();
    expect(disarmed!.enabled).toBe(false);
    expect(disarmed!.generation).toBe(2);
    expect(disarmed!.rejection?.instruction).toBe("The navigation is wrong");
    expect(resolvePendingHumanMergeRejection({ humanMergeApproval: disarmed! })?.state).toBe("pending");
    expect(getHumanMergeApprovalBlocker({ humanMergeApproval: disarmed! })).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
  });

  it("stops blocking once the corrections are published", () => {
    const published = { ...rejection, state: "published" as const };
    expect(resolvePendingHumanMergeRejection(armed({ rejection: published }))).toBeUndefined();
    expect(getHumanMergeApprovalBlocker(armed({ rejection: published }))).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("gives each rejection episode a fresh, monotonic remediation generation", () => {
    expect(nextHumanMergeRemediationGeneration(undefined)).toBe(1);
    expect(nextHumanMergeRemediationGeneration({ enabled: true, generation: 1, remediationGeneration: 4 })).toBe(5);
  });

  it("formats the instruction as a mandatory correction contract, and nothing when absent", () => {
    expect(formatHumanMergeRejectionSection(undefined)).toBe("");
    expect(formatHumanMergeRejectionSection({ ...rejection, instruction: "   " })).toBe("");
    const section = formatHumanMergeRejectionSection(rejection);
    expect(section).toContain("The navigation is wrong");
    expect(section).toContain("cannot be closed without changes");
  });
});

describe("FN-514 reset and duplication", () => {
  it("reset keeps the intent, invalidates every accord, and preserves the remediation counter", () => {
    const reset = clearHumanMergeApprovalDecision({
      enabled: true,
      generation: 2,
      remediationGeneration: 3,
      decision: decided("merge").humanMergeApproval.decision,
    });
    expect(reset).toEqual({ enabled: true, generation: 3, remediationGeneration: 3 });
    expect(hasCurrentHumanMergeApproval({ humanMergeApproval: reset! })).toBe(false);
    expect(clearHumanMergeApprovalDecision(undefined)).toBeNull();
    expect(clearHumanMergeApprovalDecision({ enabled: false, generation: 1 })).toBeNull();
  });

  it("duplication keeps the lock intent only — no accord, destination or remediation inheritance", () => {
    expect(buildDuplicatedHumanMergeApprovalState({
      enabled: true,
      generation: 6,
      remediationGeneration: 2,
      decision: decided("create-pr").humanMergeApproval.decision,
    })).toEqual({ enabled: true, generation: 1 });
    expect(buildDuplicatedHumanMergeApprovalState(undefined)).toBeUndefined();
    expect(buildDuplicatedHumanMergeApprovalState({ enabled: false, generation: 2 })).toBeUndefined();
  });
});
