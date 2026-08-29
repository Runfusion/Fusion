import { describe, expect, it } from "vitest";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { classifyTaskError } from "../errors/error-classifier.js";

describe("classifyTaskError", () => {
  it("classifies branch-conflict-stale", () => {
    const error = new BranchConflictError({
      branchName: "fusion/fn-1",
      conflictingWorktreePath: "/tmp/wt",
      existingTipSha: "abc123abc123",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "retry",
    }) as BranchConflictError & { kind?: string };
    error.kind = "stale";
    expect(classifyTaskError(error).class).toBe("branch-conflict-stale");
  });

  it("classifies branch-conflict-live-other", () => {
    const error = new BranchConflictError({
      branchName: "fusion/fn-1",
      conflictingWorktreePath: "/tmp/wt",
      existingTipSha: "abc123abc123",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "retry",
    }) as BranchConflictError & { kind?: string };
    error.kind = "live-foreign";
    expect(classifyTaskError(error).class).toBe("branch-conflict-live-other");
  });

  it("classifies branch-conflict-reclaimable", () => {
    const error = new BranchConflictError({
      branchName: "fusion/fn-1",
      conflictingWorktreePath: "/tmp/wt",
      existingTipSha: "abc123abc123",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "retry",
    }) as BranchConflictError & { kind?: string };
    error.kind = "reclaimable";
    expect(classifyTaskError(error).class).toBe("branch-conflict-reclaimable");
  });

  it("classifies branch-conflict-unrecoverable", () => {
    const error = new BranchConflictError({
      branchName: "fusion/fn-1",
      conflictingWorktreePath: "/tmp/wt",
      existingTipSha: "abc123abc123",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "retry",
    });
    expect(classifyTaskError(error).class).toBe("branch-conflict-unrecoverable");
  });

  it("classifies worktree-missing", () => {
    expect(classifyTaskError(new Error("fatal: '/tmp/wt' is not a working tree")).class).toBe("worktree-missing");
  });

  it("classifies worktree-locked", () => {
    expect(classifyTaskError(new Error("worktree is locked"))).toEqual({
      class: "worktree-locked",
      recoverable: "auto",
      retryAfterMs: 2000,
    });
  });

  it("classifies merge-conflict", () => {
    expect(classifyTaskError(new Error("CONFLICT (content): Merge conflict in file.ts")).class).toBe("merge-conflict");
  });

  it("classifies audit-failure", () => {
    const err = new Error("audit failed");
    err.name = "SquashAuditError";
    expect(classifyTaskError(err).class).toBe("audit-failure");
  });

  it("classifies unknown", () => {
    expect(classifyTaskError("something odd").class).toBe("unknown");
  });
});
