import { describe, expect, it } from "vitest";
import { canonicalFusionBranchName } from "../worktree-names.js";

describe("executor branch canonicalization", () => {
  it("canonicalizes mixed-case task IDs to lowercase fusion branches", () => {
    expect(canonicalFusionBranchName("FN-5083")).toBe("fusion/fn-5083");
    expect(canonicalFusionBranchName("Fn-ABC-123")).toBe("fusion/fn-abc-123");
  });
});
