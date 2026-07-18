/*
FNXC:UnlinkedMissionsAdvisory 2026-07-17-16:25:
The scheduler must persist the same active-unlinked advisory through PostgreSQL
as it does through the synchronous MissionStore. This integration test uses the
canonical TaskStore harness so query ordering and insight deduplication remain
real backend behavior rather than a structural mock.
*/
import { expect, it } from "vitest";
import type { AsyncGoalStore, AsyncMissionStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  UNLINKED_MISSIONS_ADVISORY_TITLE,
  UnlinkedMissionsAdvisoryReporter,
} from "../unlinked-missions-advisory-reporter.js";

pgDescribe("UnlinkedMissionsAdvisoryReporter PostgreSQL", () => {
  it("persists one advisory for only active unlinked missions without duplicating it", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_unlinked_advisory" });
    try {
      const missions = harness.store.getMissionStore() as AsyncMissionStore;
      const goals = harness.store.getGoalStore() as AsyncGoalStore;
      const linked = await missions.createMission({ title: "Linked" });
      const unlinked = await missions.createMission({ title: "Unlinked" });
      const archived = await missions.createMission({ title: "Archived" });
      const goal = await goals.createGoal({ title: "Goal" });
      await missions.updateMission(linked.id, { status: "active" });
      await missions.updateMission(unlinked.id, { status: "active" });
      await missions.linkGoal(linked.id, goal.id);
      await missions.updateMission(archived.id, { status: "archived" });

      const projectId = "pg-reporter";
      const reporter = new UnlinkedMissionsAdvisoryReporter({
        store: harness.store,
        projectId,
        now: () => Date.parse("2026-07-17T16:25:00.000Z"),
      });

      await expect(reporter.report()).resolves.toEqual({ alerted: true });
      await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "already-reported" });

      const insights = await harness.store.getInsightStore().listInsights({
        projectId,
        category: "workflow",
      });
      expect(insights.filter((insight) => insight.title === UNLINKED_MISSIONS_ADVISORY_TITLE)).toHaveLength(1);
      expect(JSON.parse(insights[0]!.content ?? "{}").missionIds).toEqual([unlinked.id]);
    } finally {
      await harness.teardown();
    }
  });
});
