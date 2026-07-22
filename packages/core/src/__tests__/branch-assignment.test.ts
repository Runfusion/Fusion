import { describe, expect, it } from "vitest";
import {
  deriveAutoTaskBranchName,
  derivePerTaskBranchName,
  resolveEntryPointBranchAssignment,
  sanitizeBranchSegment,
  isValidBranchGroupBranchName,
  validateBranchGroupBranchName,
  filterTasksByBranchGroup,
} from "../branch/branch-assignment.js";

describe("isValidBranchGroupBranchName (Fix #11)", () => {
  it("accepts legitimate branch names", () => {
    for (const name of [
      "feature/auth-shared",
      "fusion/fn-123",
      "main",
      "release/v1.2.3",
      "release-1.2.3",
      "fn/shared",
      "a",
    ]) {
      expect(isValidBranchGroupBranchName(name)).toBe(true);
    }
  });

  it("rejects injection-shaped and unsafe names", () => {
    for (const name of [
      "$(touch /tmp/x)",
      "`whoami`",
      "feature; rm -rf /",
      "a|b",
      "a&b",
      "branch with spaces",
      "-leading-dash",
      'has"quote',
      "has'quote",
      "back\\slash",
      "a..b",
      "a~b",
      "a^b",
      "a:b",
      "trailing/",
      "/leading",
      "",
      "   ",
      "tail.lock",
      // git check-ref-format --branch parity (rejected by git):
      "foo//bar", // consecutive slashes / empty segment
      "foo/.tmp", // segment starting with '.'
      ".hidden", // top-level segment starting with '.'
      "foo.lock/bar", // segment ending in '.lock'
      "@", // the lone '@'
      "foo@{bar", // '@{' sequence
      "foo/", // trailing slash
      "foo.", // trailing dot
      "foo..bar", // '..' anywhere
    ]) {
      expect(isValidBranchGroupBranchName(name)).toBe(false);
    }
  });

  it("validateBranchGroupBranchName throws on invalid and returns valid", () => {
    expect(validateBranchGroupBranchName("feature/ok")).toBe("feature/ok");
    expect(() => validateBranchGroupBranchName("$(touch /tmp/x)")).toThrow(/Invalid branch group branch name/);
  });
});

describe("filterTasksByBranchGroup (Fix #8/#9)", () => {
  const tasks = [
    { id: "T1", branchContext: { groupId: "BG-1" } },
    { id: "T2", branchContext: { groupId: "planning:PS-1" } },
    { id: "T3", branchContext: { groupId: "BG-2" } },
    { id: "T4", branchContext: undefined },
  ];

  it("matches the real BG id", () => {
    const group = { id: "BG-2", sourceType: "planning", sourceId: "PS-2" };
    expect(filterTasksByBranchGroup(tasks, group, "BG-2").map((t) => t.id)).toEqual(["T3"]);
  });

  it("also matches the legacy synthetic groupId for planning/mission groups", () => {
    const group = { id: "BG-1", sourceType: "planning", sourceId: "PS-1" };
    expect(filterTasksByBranchGroup(tasks, group, "BG-1").map((t) => t.id).sort()).toEqual(["T1", "T2"]);
  });

  it("does not apply the legacy fallback for non-planning/mission sources", () => {
    const group = { id: "BG-1", sourceType: "task", sourceId: "PS-1" };
    expect(filterTasksByBranchGroup(tasks, group, "BG-1").map((t) => t.id)).toEqual(["T1"]);
  });
});

describe("branch-assignment", () => {
  it("sanitizes branch segments", () => {
    expect(sanitizeBranchSegment("  FN-123 add parser!!!  ")).toBe("fn-123-add-parser");
  });

  it("derives per-task branches", () => {
    expect(derivePerTaskBranchName("feature/planning", "FN-123 add parser")).toBe("feature/planning/fn-123-add-parser");
    expect(derivePerTaskBranchName(undefined, "FN-123")).toBeUndefined();
    expect(derivePerTaskBranchName("feature/planning", "   ")).toBe("feature/planning");
  });

  it("derives auto task branches", () => {
    expect(deriveAutoTaskBranchName("FN-5671", "Branch Strategy Dropdown")).toBe("fusion/fn-5671-branch-strategy-dropdown");
    expect(deriveAutoTaskBranchName("FN-5671", "   ")).toBe("fusion/fn-5671");
  });

  it("resolves shared mode with per-task working branch and shared merge target", () => {
    const resolvedBranch = "feature/planning";
    const assignment = resolveEntryPointBranchAssignment({
      assignmentMode: "shared",
      resolvedBranch,
      taskSegment: "FN-123 add parser",
    });
    expect(assignment).toEqual({
      workingBranch: "feature/planning/fn-123-add-parser",
      mergeTargetBranch: "feature/planning",
    });
    expect(assignment.workingBranch).not.toBe(resolvedBranch);
  });

  it("resolves shared mode with empty segment fallback", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "shared",
      resolvedBranch: "feature/planning",
      taskSegment: "   ",
    })).toEqual({
      workingBranch: "feature/planning",
      mergeTargetBranch: "feature/planning",
    });
  });

  it("resolves shared mode with undefined resolved branch", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "shared",
      resolvedBranch: undefined,
      taskSegment: "FN-123",
    })).toEqual({
      workingBranch: undefined,
      mergeTargetBranch: undefined,
    });
  });

  it("resolves per-task-derived mode", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "per-task-derived",
      resolvedBranch: "feature/planning",
      taskSegment: "FN-123 add parser",
    })).toEqual({
      workingBranch: "feature/planning/fn-123-add-parser",
      mergeTargetBranch: undefined,
    });
  });

  it("resolves project-default mode", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "project-default",
      resolvedBranch: "feature/planning",
      taskSegment: "FN-123 add parser",
    })).toEqual({
      workingBranch: undefined,
      mergeTargetBranch: undefined,
    });
  });

  it("resolves existing and custom-new modes", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "existing",
      resolvedBranch: "feature/existing",
    })).toEqual({
      workingBranch: "feature/existing",
      mergeTargetBranch: undefined,
    });
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "custom-new",
      resolvedBranch: "feature/custom",
    })).toEqual({
      workingBranch: "feature/custom",
      mergeTargetBranch: undefined,
    });
  });
});
