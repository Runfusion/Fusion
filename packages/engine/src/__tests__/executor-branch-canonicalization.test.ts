import { describe, expect, it } from "vitest";
import { canonicalFusionBranchName } from "../worktree/worktree-names.js";

describe("executor branch canonicalization", () => {
  it("canonicalizes mixed-case task IDs to lowercase fusion branches", () => {
    expect(canonicalFusionBranchName("FN-5083")).toBe("fusion/fn-5083");
    expect(canonicalFusionBranchName("Fn-ABC-123")).toBe("fusion/fn-abc-123");
  });

  it("returns the canonical lowercase branch form for standard and case-only variant task IDs", () => {
    expect(canonicalFusionBranchName("FN-6383")).toBe("fusion/fn-6383");
    expect(canonicalFusionBranchName("Fn-ABC-123")).toBe("fusion/fn-abc-123");
    expect(canonicalFusionBranchName("FUSION-001")).toBe("fusion/fusion-001");
  });

  it("preserves already-lowercase task ids and documents that callers must not pass branch names", () => {
    expect(canonicalFusionBranchName("fn-6383")).toBe("fusion/fn-6383");
    expect(canonicalFusionBranchName("fusion/fn-1")).toBe("fusion/fusion/fn-1");
  });

  it("lowercases arbitrary task-id shapes without slugifying or trimming characters", () => {
    expect(canonicalFusionBranchName("TASK_42")).toBe("fusion/task_42");
    expect(canonicalFusionBranchName("feature/Foo")).toBe("fusion/feature/foo");
  });

  it("pins malformed and edge inputs to prefix-plus-lowercase behavior", () => {
    expect(canonicalFusionBranchName("")).toBe("fusion/");
    expect(canonicalFusionBranchName("   ")).toBe("fusion/   ");
    expect(canonicalFusionBranchName("ABC123XYZ")).toBe("fusion/abc123xyz");
  });
});
