/**
 * FNXC:MissionStore 2026-06-27-16:20:
 * PostgreSQL integration coverage for the MissionStore port (U5). `store.getMissionStore()`
 * previously THREW "MissionStore is not available in PG backend mode" (the dashboard
 * /api/missions + goal→mission routes 503'd); it now returns the AsyncDataLayer-backed
 * AsyncMissionStore. This drives the real wiring (getMissionStoreImpl → AsyncMissionStore)
 * through the shared PG harness and asserts: createMission → addMilestone → addSlice →
 * addFeature → getMissionWithHierarchy assembles the tree; listMissionsWithSummaries
 * counts; reorderMilestones/reorderSlices new order; linkGoal/unlinkGoal +
 * listGoalIdsForMission round-trip; linkFeatureToTask/unlinkFeatureFromTask;
 * addContractAssertion → listContractAssertions; startValidatorRun → getValidatorRunsByFeature;
 * computeMissionStatus reflects state; missing mission → undefined. Runs in the blocking
 * gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncMissionStore } from "../../async-mission-store.js";

const pgTest = pgDescribe;

pgTest("MissionStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mission_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getMissionStore() returns AsyncMissionStore (async methods).
  const missions = (): AsyncMissionStore => h.store().getMissionStore() as AsyncMissionStore;

  it("does not throw when resolving the store in backend mode", () => {
    expect(h.store().backendMode).toBe(true);
    expect(() => missions()).not.toThrow();
  });

  it("createMission → addMilestone → addSlice → addFeature assembles getMissionWithHierarchy tree", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Ship payments" });
    expect(mission.id).toMatch(/^M-/);
    const milestone = await m.addMilestone(mission.id, { title: "Backend" });
    const slice = await m.addSlice(milestone.id, { title: "DB layer" });
    const feature = await m.addFeature(slice.id, { title: "Add table", acceptanceCriteria: "table exists" });

    const tree = await m.getMissionWithHierarchy(mission.id);
    expect(tree).toBeDefined();
    expect(tree!.milestones).toHaveLength(1);
    expect(tree!.milestones[0]!.id).toBe(milestone.id);
    expect(tree!.milestones[0]!.slices).toHaveLength(1);
    expect(tree!.milestones[0]!.slices[0]!.id).toBe(slice.id);
    expect(tree!.milestones[0]!.slices[0]!.features).toHaveLength(1);
    expect(tree!.milestones[0]!.slices[0]!.features[0]!.id).toBe(feature.id);
  });

  it("listMissionsWithSummaries returns hierarchy counts", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Counted" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    await m.addFeature(slice.id, { title: "F1" });
    await m.addFeature(slice.id, { title: "F2" });

    const all = await m.listMissionsWithSummaries();
    const row = all.find((x) => x.id === mission.id);
    expect(row).toBeDefined();
    expect(row!.summary.totalMilestones).toBe(1);
    expect(row!.summary.totalFeatures).toBe(2);
    expect(row!.summary.completedFeatures).toBe(0);
  });

  it("reorderMilestones / reorderSlices persist the new order", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Reorder" });
    const a = await m.addMilestone(mission.id, { title: "A" });
    const b = await m.addMilestone(mission.id, { title: "B" });
    const c = await m.addMilestone(mission.id, { title: "C" });
    await m.reorderMilestones(mission.id, [c.id, a.id, b.id]);
    const ordered = (await m.listMilestones(mission.id)).map((x) => x.id);
    expect(ordered).toEqual([c.id, a.id, b.id]);

    const s1 = await m.addSlice(a.id, { title: "s1" });
    const s2 = await m.addSlice(a.id, { title: "s2" });
    await m.reorderSlices(a.id, [s2.id, s1.id]);
    const sliceOrder = (await m.listSlices(a.id)).map((x) => x.id);
    expect(sliceOrder).toEqual([s2.id, s1.id]);
  });

  it("linkGoal / unlinkGoal round-trips through listGoalIdsForMission", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Goal-linked" });
    // GoalStore is not ported; seed a goal row directly via the async layer.
    const now = new Date().toISOString();
    const goalId = "G-TEST-MISSION";
    await h.store().getAsyncLayer()!.db.insert(schema.project.goals).values({
      id: goalId,
      title: "A goal",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const link = await m.linkGoal(mission.id, goalId);
    expect(link.goalId).toBe(goalId);
    expect(await m.listGoalIdsForMission(mission.id)).toEqual([goalId]);
    expect(await m.listMissionIdsForGoal(goalId)).toEqual([mission.id]);

    expect(await m.unlinkGoal(mission.id, goalId)).toBe(true);
    expect(await m.listGoalIdsForMission(mission.id)).toEqual([]);
  });

  it("linkFeatureToTask / unlinkFeatureFromTask updates the feature", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Task-linked" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const task = await h.store().createTask({ description: "delivery task" });

    const linked = await m.linkFeatureToTask(feature.id, task.id);
    expect(linked.taskId).toBe(task.id);
    expect(linked.status).toBe("triaged");

    const unlinked = await m.unlinkFeatureFromTask(feature.id);
    expect(unlinked.taskId).toBeUndefined();
    expect(unlinked.status).toBe("defined");
  });

  it("addContractAssertion appears in listContractAssertions", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Asserted" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const created = await m.addContractAssertion(milestone.id, {
      title: "Has endpoint",
      assertion: "GET /x returns 200",
      status: "pending",
    });
    const list = await m.listContractAssertions(milestone.id);
    expect(list.some((a) => a.id === created.id)).toBe(true);
    expect(list.find((a) => a.id === created.id)!.assertion).toBe("GET /x returns 200");
  });

  it("startValidatorRun is returned by getValidatorRunsByFeature", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Validated" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const run = await m.startValidatorRun(feature.id, "manual");
    expect(run.status).toBe("running");
    expect(run.validatorAttempt).toBe(1);

    const runs = await m.getValidatorRunsByFeature(feature.id);
    expect(runs.map((r) => r.id)).toContain(run.id);

    const fetched = await m.getValidatorRun(run.id);
    expect(fetched?.id).toBe(run.id);
  });

  it("computeMissionStatus reflects milestone state", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Status" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    expect(await m.computeMissionStatus(mission.id)).toBe("planning");

    await m.updateMilestone(milestone.id, { status: "active" });
    expect(await m.computeMissionStatus(mission.id)).toBe("active");
  });

  it("missing mission → undefined", async () => {
    const m = missions();
    expect(await m.getMission("M-DOES-NOT-EXIST")).toBeUndefined();
    expect(await m.getMissionWithHierarchy("M-DOES-NOT-EXIST")).toBeUndefined();
    expect(await m.getMissionHealth("M-DOES-NOT-EXIST")).toBeUndefined();
  });
});
