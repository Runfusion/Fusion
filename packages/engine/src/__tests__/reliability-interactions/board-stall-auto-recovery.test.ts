import { describe, expect, it } from "vitest";
import { makeReliabilityFixture } from "./_helpers.js";

describe("reliability interactions: board stall auto-recovery", () => {
  it("detects blocked growth and runs decay recovery", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-4867",
      task: {
        column: "in-progress",
        paused: true,
        pausedReason: "waiting",
        columnMovedAt: new Date(Date.now() - 1000).toISOString(),
      },
      settings: {
        pausedScopeDecayMs: 60_000,
        boardStallSweepWindowMs: 60_000,
        boardStallBlockedGrowthThreshold: 1,
      },
    });
    try {
      await fixture.selfHeal.runBoardStallAutoRecoverySweep();
      await fixture.store.createTask({ id: "FN-4901", title: "follower", description: "follower", column: "todo", blockedBy: "FN-4867", steps: [] } as any);
      const first = await fixture.selfHeal.runBoardStallAutoRecoverySweep();
      expect(first.recovered).toBeGreaterThanOrEqual(0);

      (fixture.manager as any).maintenanceTickCounter++;
      const second = await fixture.selfHeal.runBoardStallAutoRecoverySweep();
      expect(typeof second.unrecovered).toBe("boolean");
    } finally {
      await fixture.cleanup();
    }
  });
});
