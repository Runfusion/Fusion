import { describe, expect, it } from "vitest";
import {
  decideBranchGroupMemberIntegration,
  decideBranchGroupPromotion,
} from "../workflow-branch-group-merge.js";

describe("workflow branch-group merge subgraphs", () => {
  it("allows shared member integration while global auto-merge is off", () => {
    expect(decideBranchGroupMemberIntegration({
      task: { id: "FN-MEMBER", autoMerge: false, branchContext: { assignmentMode: "shared", branchName: "shared/fn" } as any },
      settings: { autoMerge: false },
    })).toEqual({
      stage: "member-integration",
      allowed: true,
      outcome: "success",
    });
  });

  it("gates non-shared member integration when global auto-merge is off", () => {
    expect(decideBranchGroupMemberIntegration({
      task: { id: "FN-MEMBER", branchContext: { assignmentMode: "exclusive", branchName: "feature/fn" } as any },
      settings: { autoMerge: false },
    })).toEqual({
      stage: "member-integration",
      allowed: false,
      outcome: "manual-required",
      reason: "global-auto-merge-disabled",
    });
  });

  it("keeps group promotion gated by global and group auto-merge", () => {
    const input = {
      task: { id: "FN-GROUP", branchContext: { assignmentMode: "shared", branchName: "shared/fn" } as any },
      settings: { autoMerge: false },
    };
    expect(decideBranchGroupPromotion(input)).toEqual({
      stage: "group-promotion",
      allowed: false,
      outcome: "manual-required",
      reason: "global-auto-merge-disabled",
    });
    expect(decideBranchGroupPromotion({ ...input, settings: { autoMerge: true }, groupAutoMerge: false })).toEqual({
      stage: "group-promotion",
      allowed: false,
      outcome: "manual-required",
      reason: "group-auto-merge-disabled",
    });
    expect(decideBranchGroupPromotion({
      task: { id: "FN-GROUP", autoMerge: false, branchContext: { assignmentMode: "shared", branchName: "shared/fn" } as any },
      settings: { autoMerge: true },
      groupAutoMerge: true,
    })).toEqual({
      stage: "group-promotion",
      allowed: true,
      outcome: "success",
    });
  });
});
