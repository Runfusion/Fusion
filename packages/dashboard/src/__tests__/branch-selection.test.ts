import { describe, expect, it } from "vitest";
import {
  deriveAutoTaskBranch,
  derivePerTaskBranch,
  getBranchSelectionMode,
  resolveBranchAssignmentContext,
  resolveBranchSelection,
  resolveEntryPointBranchAssignment,
} from "../routes/branch-selection.js";

describe("branch-selection", () => {
  it("resolves project-default and auto-new without branch", () => {
    expect(resolveBranchSelection({ mode: "project-default", baseBranch: "main" }, undefined, undefined)).toEqual({
      branch: undefined,
      baseBranch: "main",
    });
    expect(resolveBranchSelection({ mode: "auto-new" }, undefined, "develop")).toEqual({
      branch: undefined,
      baseBranch: undefined,
    });
  });

  it("requires branchName for existing/custom-new", () => {
    expect(() => resolveBranchSelection({ mode: "existing" }, undefined, undefined)).toThrow(
      "branchSelection.branchName is required",
    );
  });

  it("resolves shared-group with shared feature branch and no working branch", () => {
    expect(resolveBranchSelection({ mode: "shared-group", branchName: "feature/shared" }, undefined, "main")).toEqual({
      branch: undefined,
      baseBranch: undefined,
      sharedFeatureBranch: "feature/shared",
    });
    expect(() => resolveBranchSelection({ mode: "shared-group" }, undefined, undefined)).toThrow(
      "branchSelection.branchName is required for shared-group mode",
    );
  });

  it("resolves assignment context", () => {
    // Absent input resolves to undefined so callers fall back to their own
    // default (e.g. mission triage uses mission.branchStrategy).
    expect(resolveBranchAssignmentContext(undefined)).toEqual({ mode: undefined });
    expect(resolveBranchAssignmentContext(null)).toEqual({ mode: undefined });
    expect(resolveBranchAssignmentContext({})).toEqual({ mode: undefined });
    expect(resolveBranchAssignmentContext({ mode: "shared" })).toEqual({ mode: "shared" });
    expect(resolveBranchAssignmentContext({ mode: "per-task-derived" })).toEqual({ mode: "per-task-derived" });
    expect(() => resolveBranchAssignmentContext({ mode: "bad" })).toThrow("branchAssignment.mode must be one of");
  });

  it("derives a per-task branch suffix", () => {
    expect(derivePerTaskBranch("feature/planning", "FN-123 add parser")).toBe("feature/planning/fn-123-add-parser");
    expect(derivePerTaskBranch(undefined, "FN-123")).toBeUndefined();
  });

  it("derives auto task branches from id + short name", () => {
    expect(deriveAutoTaskBranch("FN-5671", "Branch Strategy Dropdown")).toBe("fusion/fn-5671-branch-strategy-dropdown");
    expect(deriveAutoTaskBranch("FN-5671", "   ")).toBe("fusion/fn-5671");
    expect(deriveAutoTaskBranch("FN-5671", "!!!")).toBe("fusion/fn-5671");
  });

  it("reads requested branch mode", () => {
    expect(getBranchSelectionMode(undefined)).toBeUndefined();
    expect(getBranchSelectionMode({ mode: "auto-new" })).toBe("auto-new");
    expect(getBranchSelectionMode({ mode: "shared-group" })).toBe("shared-group");
  });

  it("re-exports entry-point branch assignment helper", () => {
    expect(resolveEntryPointBranchAssignment({
      assignmentMode: "shared",
      resolvedBranch: "feature/planning",
      taskSegment: "FN-123 add parser",
    })).toEqual({
      workingBranch: "feature/planning/fn-123-add-parser",
      mergeTargetBranch: "feature/planning",
    });
  });
});
