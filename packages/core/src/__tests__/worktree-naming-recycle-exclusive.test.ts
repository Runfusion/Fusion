import { describe, it, expect } from "vitest";
import {
  assertWorktreeNamingRecycleExclusive,
  isRecycleWorktreeNamingConflict,
  RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE,
} from "../settings-validation.js";

describe("worktreeNaming/recycleWorktrees mutual exclusion", () => {
  it("flags only recycle + task-id together as a conflict", () => {
    expect(isRecycleWorktreeNamingConflict({ recycleWorktrees: true, worktreeNaming: "task-id" })).toBe(true);
    expect(isRecycleWorktreeNamingConflict({ recycleWorktrees: true, worktreeNaming: "random" })).toBe(false);
    expect(isRecycleWorktreeNamingConflict({ recycleWorktrees: true, worktreeNaming: "task-title" })).toBe(false);
    expect(isRecycleWorktreeNamingConflict({ recycleWorktrees: false, worktreeNaming: "task-id" })).toBe(false);
    expect(isRecycleWorktreeNamingConflict({ worktreeNaming: "task-id" })).toBe(false);
    expect(isRecycleWorktreeNamingConflict({})).toBe(false);
    expect(isRecycleWorktreeNamingConflict(undefined)).toBe(false);
  });

  it("assert throws with the canonical message only for the conflicting combo", () => {
    expect(() => assertWorktreeNamingRecycleExclusive({ recycleWorktrees: true, worktreeNaming: "task-id" }))
      .toThrow(RECYCLE_WORKTREE_NAMING_CONFLICT_MESSAGE);
    expect(() => assertWorktreeNamingRecycleExclusive({ recycleWorktrees: true, worktreeNaming: "random" })).not.toThrow();
    expect(() => assertWorktreeNamingRecycleExclusive({ recycleWorktrees: false, worktreeNaming: "task-id" })).not.toThrow();
    expect(() => assertWorktreeNamingRecycleExclusive({})).not.toThrow();
  });
});
