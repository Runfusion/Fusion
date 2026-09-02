import { describe, expect, it } from "vitest";
import {
  isWorktreeCapacityHolder,
  type WorktreeCapacityTaskShape,
} from "../agents/worktree-capacity-holder.js";

function task(overrides: Partial<WorktreeCapacityTaskShape> = {}): WorktreeCapacityTaskShape {
  return {
    column: "todo",
    columnTerminalKind: "none",
    ...overrides,
  };
}

describe("isWorktreeCapacityHolder", () => {
  it("does not count a checkout-free planning card", () => {
    expect(isWorktreeCapacityHolder(task({ status: "planning" }))).toBe(false);
  });

  it("counts a live WIP card before acquisition persists a checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "working",
      columnCountsTowardWip: true,
    }))).toBe(true);
  });

  it("counts a live review card with a singular checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "review",
      columnIsReviewOrMerge: true,
      status: "reviewing",
      worktree: "/worktrees/FN-282",
    }))).toBe(true);
  });

  it("counts a live review card with workspace checkouts only", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "review",
      columnIsReviewOrMerge: true,
      status: "reviewing",
      workspaceWorktrees: {
        "packages/core": {
          worktreePath: "/worktrees/FN-282/core",
          branch: "fusion/fn-282-core",
        },
      },
    }))).toBe(true);
  });

  it.each([
    ["singular", { worktree: "/worktrees/FN-282" }],
    ["workspace", {
      workspaceWorktrees: {
        "packages/core": {
          worktreePath: "/worktrees/FN-282/core",
          branch: "fusion/fn-282-core",
        },
      },
    }],
  ])("counts a hold-lane needs-replan card with a retained %s checkout", (_kind, checkout) => {
    expect(isWorktreeCapacityHolder(task({
      column: "hold",
      columnIsIntakeOrHold: true,
      status: "needs-replan",
      ...checkout,
    }))).toBe(true);
  });

  it.each([
    ["paused", { paused: true }],
    ["failed", { status: "failed" as const }],
  ])("does not count a %s WIP card", (_label, state) => {
    expect(isWorktreeCapacityHolder(task({
      column: "working",
      columnCountsTowardWip: true,
      worktree: "/worktrees/FN-282",
      ...state,
    }))).toBe(false);
  });

  it("does not count a terminal card with a retained checkout", () => {
    expect(isWorktreeCapacityHolder(task({
      column: "done",
      columnTerminalKind: "complete",
      worktree: "/worktrees/FN-282",
    }))).toBe(false);
  });
});
