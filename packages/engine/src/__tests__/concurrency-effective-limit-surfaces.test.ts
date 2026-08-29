import { describe, expect, it } from "vitest";
import { resolveActiveTaskCapacityLimit, formatAdmissionCapacityQueuedReason } from "../concurrency/concurrency.js";
import { formatConcurrencyLimitReason } from "../scheduler.js";

describe("effective concurrency operator surfaces", () => {
  it("uses one ceiling for unset, configured, and worktree-bound admission", () => {
    expect(resolveActiveTaskCapacityLimit({})).toBe(2);
    expect(resolveActiveTaskCapacityLimit({ maxConcurrent: 6, maxWorktrees: 9 })).toBe(6);
    expect(resolveActiveTaskCapacityLimit({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true })).toBe(4);
    expect(resolveActiveTaskCapacityLimit({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false })).toBe(8);
  });

  it("names the effective ceiling and binding setting in the shared admission reason", () => {
    expect(formatAdmissionCapacityQueuedReason({
      maxConcurrent: 8,
      maxWorktrees: 4,
      worktreeLimitEnabled: true,
      claimed: 4,
      holderTaskIds: ["FN-1"],
    })).toContain("effectiveLimit=4; bindingKnob=maxWorktrees");
  });

  it("names the effective ceiling and binding setting in scheduler diagnostics", () => {
    const reason = formatConcurrencyLimitReason({
      available: 0,
      bindingGates: ["maxWorktrees"],
      maxConcurrentGate: { used: 4, limit: 8, slack: 4 },
      maxWorktreesGate: { used: 4, limit: 4, slack: 0 },
      semaphoreGate: undefined,
      holders: { maxConcurrent: ["FN-1"], maxWorktrees: ["FN-1"], semaphore: undefined },
    });
    expect(reason).toContain("effectiveLimit=4 (bindingKnob=maxWorktrees)");
  });
});
