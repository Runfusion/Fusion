/*
FNXC:MissionAutoMerge 2026-07-19-00:00:
Engine coverage must prove the production PostgreSQL MissionStore path stamps only
single-pull-request mission tasks and puts every member in the same lazy branch group.
*/
import { expect, it } from "vitest";
import type { AsyncMissionStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";

pgDescribe("mission auto-merge cascade PostgreSQL", () => {
  it("stamps false missions and preserves inherited true or undefined missions", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_mission_auto_merge_cascade" });
    try {
      const missions = harness.store.getMissionStore() as AsyncMissionStore;
      const singlePr = await missions.createMission({ title: "Single PR", autoMerge: false });
      const milestone = await missions.addMilestone(singlePr.id, { title: "Milestone" });
      const slice = await missions.addSlice(milestone.id, { title: "Slice" });
      const first = await missions.addFeature(slice.id, { title: "First feature" });
      const second = await missions.addFeature(slice.id, { title: "Second feature" });
      await missions.triageFeature(first.id);
      await missions.triageFeature(second.id);

      const tasks = (await harness.store.listTasks()).filter((task) =>
        ["First feature", "Second feature"].includes(task.title),
      );
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => task.autoMerge)).toEqual([false, false]);
      const groupIds = new Set(tasks.map((task) => task.branchContext?.groupId));
      expect(groupIds.size).toBe(1);
      const groupId = tasks[0]?.branchContext?.groupId;
      expect(groupId).toBeDefined();

      // FNXC:MissionAutoMerge 2026-07-19-16:35:
      // A shared task context is useful only when it points to the lazily materialized
      // group that owns this mission and contains every triaged member. Assert the
      // persisted group rather than accepting a matching but dangling group id.
      const group = await harness.store.getBranchGroup(groupId!);
      expect(group).toMatchObject({
        id: groupId,
        sourceType: "mission",
        sourceId: singlePr.id,
      });
      expect(await harness.store.listTasksByBranchGroup(groupId!)).toHaveLength(2);

      for (const autoMerge of [true, undefined] as const) {
        const mission = await missions.createMission({ title: `Inherited ${String(autoMerge)}`, autoMerge });
        const inheritedMilestone = await missions.addMilestone(mission.id, { title: "Milestone" });
        const inheritedSlice = await missions.addSlice(inheritedMilestone.id, { title: "Slice" });
        const feature = await missions.addFeature(inheritedSlice.id, { title: `Feature ${String(autoMerge)}` });
        await missions.triageFeature(feature.id);
        const task = (await harness.store.listTasks()).find((candidate) => candidate.title === `Feature ${String(autoMerge)}`);
        expect(task?.autoMerge).toBeUndefined();
      }
    } finally {
      await harness.teardown();
    }
  });
});
