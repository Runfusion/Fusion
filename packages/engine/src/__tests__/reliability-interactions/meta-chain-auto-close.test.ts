import { describe, expect, it } from "vitest";
/*
FNXC:PgMigrationQuarantine 2026-07-18-04:10:
VAL-REMOVAL-005 reliability fixtures use PostgreSQL AsyncDataLayer storage. Read
run audits through getRunAuditEventsAsync so each assertion observes committed
backend events rather than the removed synchronous SQLite read surface.
*/
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const canRun = hasGit && hasPg;
(canRun ? describe : describe.skip)("reliability interactions: meta chain auto-close", () => {
  it("replays FN-4890 incident shape across two maintenance ticks", async () => {
    const now = Date.now();
    const fixture = await makeReliabilityFixture({
      taskId: "FN-4890-FIXTURE",
      task: { id: "FN-4890-FIXTURE", title: "Fixture anchor", column: "todo" },
      settings: {
        pausedScopeDecayMs: 1,
        metaTaskStallAutoCloseMs: 2 * 60 * 60_000,
        boardStallSweepWindowMs: 2 * 60 * 60_000,
        boardStallBlockedGrowthThreshold: 1,
      },
    });

    try {
      const holder = await fixture.store.createTask({
        id: "FN-4867",
        title: "Target holder",
        description: "paused holder",
        column: "in-progress",
        steps: [],
      } as any);
      await fixture.store.updateTask(holder.id, {
        paused: true,
        pausedReason: "waiting-for-review",
        columnMovedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      } as any);
      expect((await fixture.store.getTask(holder.id))?.paused).toBe(true);

      const meta1 = await fixture.store.createTask({ id: "FN-4872", title: `Recover ${holder.id}`, description: "meta", column: "todo", noCommitsExpected: true, steps: [] } as any);
      const meta2 = await fixture.store.createTask({ id: "FN-4878", title: `Recover ${meta1.id}`, description: "meta", column: "todo", noCommitsExpected: true, steps: [] } as any);
      const meta3 = await fixture.store.createTask({ id: "FN-4881", title: `Unblock ${meta2.id}`, description: "meta", column: "todo", noCommitsExpected: true, steps: [] } as any);
      const meta4 = await fixture.store.createTask({ id: "FN-4883", title: `Finalize ${holder.id}`, description: "meta", column: "todo", noCommitsExpected: true, steps: [] } as any);
      const metaTasks = [meta1, meta2, meta3, meta4];

      const followerIds: string[] = [];
      for (let idx = 1; idx <= 5; idx += 1) {
        const follower = await fixture.store.createTask({
          id: `FN-490${idx}`,
          title: `Follower ${idx}`,
          description: "blocked follower",
          column: "todo",
          steps: [],
        } as any);
        await fixture.store.updateTask(follower.id, { blockedBy: holder.id } as any);
        followerIds.push(follower.id);
      }

      await (fixture.manager as any).runMaintenance();
      await (fixture.manager as any).runMaintenance();

      const taskMapAfterSecondTick = new Map(
        (await fixture.store.listTasks({ includeArchived: true })).map((task) => [task.id, task]),
      );

      expect(taskMapAfterSecondTick.get(holder.id)?.column).toBe("todo");
      const remainingFollowers = followerIds.filter(
        (followerId) => taskMapAfterSecondTick.get(followerId)?.blockedBy === holder.id,
      );
      expect(remainingFollowers).toHaveLength(0);
      const metaColumns = Object.fromEntries(
        metaTasks.map((meta) => [meta.id, taskMapAfterSecondTick.get(meta.id)?.column]),
      );
      expect(metaColumns).toEqual({
        [meta1.id]: "archived",
        [meta2.id]: "todo",
        [meta3.id]: "archived",
        [meta4.id]: "archived",
      });

      const runAudits = await fixture.store.getRunAuditEventsAsync({ limit: 200 });
      const decayAudits = runAudits.filter((event) => event.mutationType === "task:auto-rebound-paused-scope-decay");
      const metaResolvedAudits = runAudits.filter((event) => event.mutationType === "task:auto-archived-meta-resolved");
      expect(decayAudits.length).toBeGreaterThanOrEqual(1);
      expect(metaResolvedAudits.length).toBeGreaterThanOrEqual(3);
    } finally {
      await fixture.cleanup();
    }
  });
});
