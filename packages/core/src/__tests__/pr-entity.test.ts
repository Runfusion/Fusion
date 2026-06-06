import { describe, expect, it } from "vitest";
import {
  isPrBacked,
  isPrEntityActionable,
  isPrEntityActive,
  isPrEntityAutoMergeReady,
} from "../pr-entity.js";
import type { PrEntity } from "../types.js";

function entity(overrides: Partial<PrEntity> = {}): PrEntity {
  return {
    id: "PR-1",
    sourceType: "task",
    sourceId: "T-1",
    repo: "owner/repo",
    headBranch: "fusion/t-1",
    state: "open",
    autoMerge: false,
    unverified: false,
    responseRounds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("PR entity predicates", () => {
  it("isPrEntityActive is true for non-terminal states only", () => {
    for (const state of ["creating", "open", "responding"] as const) {
      expect(isPrEntityActive(entity({ state }))).toBe(true);
    }
    for (const state of ["merged", "closed", "failed"] as const) {
      expect(isPrEntityActive(entity({ state }))).toBe(false);
    }
  });

  it("isPrBacked is false for terminal entities and for null", () => {
    expect(isPrBacked(null)).toBe(false);
    expect(isPrBacked(entity({ state: "merged" }))).toBe(false);
    expect(isPrBacked(entity({ state: "open" }))).toBe(true);
  });

  it("member -> group-branch integration is NOT PR-backed even with an open entity", () => {
    const open = entity({ state: "open" });
    // The deadlock guard: a shared member landing onto its group branch must
    // remain in the legacy member-integration path.
    expect(isPrBacked(open, { mergeTargetSource: "branch-group-integration" })).toBe(false);
    // The group promotion / default-branch merge IS PR-backed.
    expect(isPrBacked(open, { mergeTargetSource: "default" })).toBe(true);
    expect(isPrBacked(open)).toBe(true);
  });

  it("unverified entity is still PR-backed (R19 hard gate) but not actionable", () => {
    const unverified = entity({ unverified: true });
    expect(isPrBacked(unverified)).toBe(true);
    expect(isPrEntityActionable(unverified)).toBe(false);
    expect(isPrEntityActionable(entity({ unverified: false }))).toBe(true);
  });

  it("auto-merge readiness requires opt-in, approval, green checks, clean mergeable, and verified", () => {
    const base = entity({
      autoMerge: true,
      reviewDecision: "APPROVED",
      checksRollup: "success",
      mergeable: "clean",
    });
    expect(isPrEntityAutoMergeReady(base)).toBe(true);
    expect(isPrEntityAutoMergeReady({ ...base, autoMerge: false })).toBe(false);
    expect(isPrEntityAutoMergeReady({ ...base, reviewDecision: "CHANGES_REQUESTED" })).toBe(false);
    expect(isPrEntityAutoMergeReady({ ...base, checksRollup: "pending" })).toBe(false);
    expect(isPrEntityAutoMergeReady({ ...base, mergeable: "unknown" })).toBe(false);
    expect(isPrEntityAutoMergeReady({ ...base, unverified: true })).toBe(false);
  });
});
