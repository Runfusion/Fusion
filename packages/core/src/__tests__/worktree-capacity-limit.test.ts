import { describe, expect, it } from "vitest";
import { resolveWorktreeCapacityLimit } from "../workflow-capacity.js";
import { DEFAULT_SETTINGS } from "../settings-schema.js";

/*
FNXC:CapacityModel 2026-07-28-12:40:
`resolveWorktreeCapacityLimit` is THE single expression of "are worktrees a
capacity dimension for this project?". These cases pin the distinction the whole
worktrees-off design rests on: OFF returns `null` (absence — callers build no gate)
and never a large number, because "very high" is a limiter that can start binding
again while absence cannot.
*/
describe("resolveWorktreeCapacityLimit", () => {
  it("returns the configured limit when worktrees are enabled", () => {
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 7, worktreeLimitEnabled: true })).toBe(7);
  });

  it("treats an omitted worktreeLimitEnabled as ON (back-compat for every existing project)", () => {
    // Existing rows have no `worktreeLimitEnabled` key. They must keep gating exactly
    // as before — an upgrade must not silently remove a limiter operators rely on.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 3 } as never)).toBe(3);
  });

  it("returns null — not Infinity, not a large number — when worktrees are off", () => {
    const resolved = resolveWorktreeCapacityLimit({ maxWorktrees: 4, worktreeLimitEnabled: false });
    expect(resolved).toBeNull();
    // Explicitly NOT a number: a numeric "disabled" value is a sentinel, and a
    // sentinel is what silently stopped binding in the capacity-pool-id defect.
    expect(typeof resolved).not.toBe("number");
  });

  it("ignores maxWorktrees entirely when off, including values that would deadlock", () => {
    // 0 deadlocks the ON path (`used >= 0` holds on an empty board). Off must not
    // care what the number is.
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 0, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: 999, worktreeLimitEnabled: false })).toBeNull();
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: false } as never)).toBeNull();
  });

  it("falls back to the shipped default when the limit is missing or non-finite", () => {
    expect(resolveWorktreeCapacityLimit({ worktreeLimitEnabled: true } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit(undefined)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Number.NaN } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
    expect(resolveWorktreeCapacityLimit({ maxWorktrees: Infinity } as never)).toBe(DEFAULT_SETTINGS.maxWorktrees);
  });

  it("ships with worktrees enabled by default", () => {
    // The supported shape is everything-in-a-worktree, planning included.
    expect(DEFAULT_SETTINGS.worktreeLimitEnabled).toBe(true);
  });
});
