import { describe, expect, it } from "vitest";
import { resolveAgentCapacityLimit, formatAdmissionCapacityQueuedReason } from "../concurrency/concurrency.js";
import { formatConcurrencyLimitReason } from "../scheduler.js";

describe("effective concurrency operator surfaces", () => {
  it("keeps the agent ceiling independent from the worktree setting", () => {
    expect(resolveAgentCapacityLimit({})).toBe(2);
    expect(resolveAgentCapacityLimit({ maxConcurrent: 6 })).toBe(6);
    expect(resolveAgentCapacityLimit({ maxConcurrent: 8 })).toBe(8);
  });

  it("reports the explicitly exhausted admission gate", () => {
    expect(formatAdmissionCapacityQueuedReason({
      gate: "maxWorktrees",
      limit: 4,
      claimed: 4,
      holderTaskIds: ["FN-1"],
    })).toBe("queued — maxWorktrees capacity exhausted: used=4/4; gate=maxWorktrees; holders=FN-1");
  });

  it("reports scheduler gates independently without a binding-knob ceiling", () => {
    const reason = formatConcurrencyLimitReason({
      available: 0,
      bindingGates: ["maxWorktrees"],
      maxConcurrentGate: { used: 4, limit: 8, slack: 4 },
      maxWorktreesGate: { used: 4, limit: 4, slack: 0 },
      semaphoreGate: undefined,
      holders: { maxConcurrent: ["FN-1"], maxWorktrees: ["FN-1"], semaphore: undefined },
    });
    expect(reason).toContain("maxConcurrent used=4/8");
    expect(reason).toContain("maxWorktrees used=4/4");
    expect(reason).not.toContain("bindingKnob");
  });
});
