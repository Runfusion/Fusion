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
import { sql } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import {
  AsyncMissionStore,
  createMission as createMissionRow,
  createMilestone as createMilestoneRow,
  deleteMission as deleteMissionRow,
  getMission as getMissionRow,
  insertMissionEvent,
  listMilestones as listMilestoneRows,
  listMissionEvents,
  listMissions as listMissionRows,
} from "../../async-mission-store.js";

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

  /*
  FNXC:MissionProjectIsolation 2026-07-14-21:35:
  Two projects sharing one PostgreSQL schema may reuse every mission-local identifier. Mission helpers must bind inserts, direct CRUD, hierarchy lists, and event queries to the session project partition even on an administrative connection that bypasses row-level security; an unbound session may see only quarantined legacy rows.
  */
  it("isolates duplicate mission hierarchies across two project scopes", async () => {
    const db = h.adminDb();
    const now = new Date().toISOString();
    const missionInput = (title: string) => ({
      id: "M-SHARED",
      title,
      status: "planning",
      interviewState: "not_started",
      autoAdvance: false,
      autopilotEnabled: false,
      autopilotState: "inactive",
      createdAt: now,
      updatedAt: now,
    });
    const seedProject = async (projectId: string, title: string): Promise<void> => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('fusion.project_id', ${projectId}, true)`);
        await createMissionRow(tx, missionInput(`${title} mission`));
        await createMilestoneRow(tx, {
          id: "MS-SHARED", missionId: "M-SHARED", title: `${title} milestone`,
          status: "planning", orderIndex: 0, interviewState: "not_started",
          dependencies: [], createdAt: now, updatedAt: now,
        });
        await insertMissionEvent(tx, {
          id: "ME-SHARED", missionId: "M-SHARED", eventType: "created",
          description: `${title} event`, timestamp: now, seq: 1,
        });
      });
    };
    const readProject = async (projectId: string) => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.project_id', ${projectId}, true)`);
      return {
        missions: await listMissionRows(tx),
        milestones: await listMilestoneRows(tx, "M-SHARED"),
        events: await listMissionEvents(tx, "M-SHARED"),
      };
    });

    await seedProject("project-a", "Project A");
    await seedProject("project-b", "Project B");

    const projectA = await readProject("project-a");
    const projectB = await readProject("project-b");
    expect(projectA.missions.map(({ title }) => title)).toEqual(["Project A mission"]);
    expect(projectB.missions.map(({ title }) => title)).toEqual(["Project B mission"]);
    expect(projectA.milestones.map(({ title }) => title)).toEqual(["Project A milestone"]);
    expect(projectB.milestones.map(({ title }) => title)).toEqual(["Project B milestone"]);
    expect(projectA.events.map(({ description }) => description)).toEqual(["Project A event"]);
    expect(projectB.events.map(({ description }) => description)).toEqual(["Project B event"]);
    expect(await listMissionRows(db)).toEqual([]);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-a', true)`);
      expect(await deleteMissionRow(tx, "M-SHARED")).toBe(true);
      expect(await getMissionRow(tx, "M-SHARED")).toBeUndefined();
    });
    expect((await readProject("project-b")).missions.map(({ title }) => title)).toEqual(["Project B mission"]);
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

  it("stamps only autoMerge:false mission triage tasks while preserving the shared branch group", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Single PR", autoMerge: false });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const [single, bulk] = await Promise.all([
      m.addFeature(slice.id, { title: "Single" }),
      m.addFeature(slice.id, { title: "Bulk" }),
    ]);

    await m.triageFeature(single.id);
    await m.triageSlice(slice.id);
    const tasks = await h.store().listTasks();
    const triaged = tasks.filter((task) => ["Single", "Bulk"].includes(task.title));
    expect(triaged).toHaveLength(2);
    expect(triaged.map((task) => task.autoMerge)).toEqual([false, false]);
    // Single and bulk triage must join the one lazily-created mission group, not merely any group.
    expect(new Set(triaged.map((task) => task.branchContext?.groupId))).toEqual(new Set([triaged[0]!.branchContext!.groupId]));
    expect(triaged[0]!.branchContext?.groupId).toBeDefined();

  });

  it("leaves task autoMerge inherited for undefined and true mission overrides", async () => {
    const m = missions();
    for (const autoMerge of [undefined, true] as const) {
      const mission = await m.createMission({ title: `Inherited ${String(autoMerge)}`, autoMerge });
      const milestone = await m.addMilestone(mission.id, { title: "MS" });
      const slice = await m.addSlice(milestone.id, { title: "SL" });
      const feature = await m.addFeature(slice.id, { title: "Feature" });
      await m.triageFeature(feature.id);
      const task = (await h.store().listTasks()).find((candidate) => candidate.title === "Feature");
      expect(task?.autoMerge).toBeUndefined();
    }
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

  it("runs the validator/fix lifecycle and reaps stale runs in PostgreSQL", async () => {
    /*
    FNXC:PostgresMissionRuntime 2026-07-14-17:23:
    Mission validation and generated remediation are runtime capabilities in PostgreSQL, including durable failures, idempotent fix creation, terminal run events, retry state, and stale-owner recovery.
    */
    const m = missions();
    const mission = await m.createMission({ title: "Validator lifecycle" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature", acceptanceCriteria: "observable result" });
    const [assertion] = await m.ensureFeatureAssertionLinked(feature.id);
    expect(assertion).toBeDefined();

    await m.transitionLoopState(feature.id, "implementing");
    const run = await m.startValidatorRun(feature.id, "task_completion");
    const failures = await m.recordValidatorFailures(run.id, [{
      featureId: feature.id,
      assertionId: assertion!.id,
      expected: "expected",
      actual: "actual",
    }]);
    expect(failures).toHaveLength(1);
    expect(await m.getFailuresForRun(run.id)).toHaveLength(1);

    const completed = await m.completeValidatorRun(run.id, "failed", "needs repair");
    expect(completed.status).toBe("failed");
    expect((await m.getFeature(feature.id))?.loopState).toBe("needs_fix");

    const fix = await m.createGeneratedFixFeature(feature.id, run.id, [assertion!.id], "expected vs actual");
    expect(fix.generatedFromFeatureId).toBe(feature.id);
    expect((await m.createGeneratedFixFeature(feature.id, run.id, [assertion!.id])).id).toBe(fix.id);
    expect((await m.getFeature(feature.id))?.implementationAttemptCount).toBe(1);

    const staleRun = await m.startValidatorRun(fix.id, "scheduled");
    expect((await m.listStaleRunningValidatorRuns(-1)).map((candidate) => candidate.id)).toContain(staleRun.id);
    const reaped = await m.reapValidatorRun(staleRun.id, "owner disappeared");
    expect(reaped.status).toBe("error");
    expect(reaped.summary).toBe("owner disappeared");
    expect((await m.getFeature(fix.id))?.loopState).toBe("needs_fix");
  });

  it("allows startup recovery to move an interrupted validation back to implementing", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Interrupted validation" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });

    await m.transitionLoopState(feature.id, "implementing");
    await m.startValidatorRun(feature.id, "scheduled");
    expect((await m.getFeature(feature.id))?.loopState).toBe("validating");

    await expect(m.transitionLoopState(feature.id, "implementing")).resolves.toMatchObject({
      id: feature.id,
      loopState: "implementing",
    });
  });

  it("allows exactly one terminal validator transition when completion races the stale reaper", async () => {
    const primary = missions();
    const competing = new AsyncMissionStore(h.layer(), h.store());
    const mission = await primary.createMission({ title: "Validator race" });
    const milestone = await primary.addMilestone(mission.id, { title: "MS" });
    const slice = await primary.addSlice(milestone.id, { title: "SL" });
    const feature = await primary.addFeature(slice.id, { title: "F" });
    await primary.transitionLoopState(feature.id, "implementing");
    const run = await primary.startValidatorRun(feature.id, "scheduled");
    const terminalEvents: string[] = [];
    primary.on("validator-run:completed", (completed) => terminalEvents.push(completed.status));
    competing.on("validator-run:completed", (completed) => terminalEvents.push(completed.status));

    const [completion, reaping] = await Promise.all([
      primary.completeValidatorRun(run.id, "passed", "validator won"),
      competing.reapValidatorRun(run.id, "reaper won"),
    ]);
    const persistedRun = await primary.getValidatorRun(run.id);
    const persistedFeature = await primary.getFeature(feature.id);

    expect(completion.status).toBe(persistedRun?.status);
    expect(reaping.status).toBe(persistedRun?.status);
    expect(terminalEvents).toEqual([persistedRun?.status]);
    if (persistedRun?.status === "passed") {
      expect(persistedFeature?.loopState).toBe("passed");
      expect(persistedFeature?.lastValidatorStatus).toBe("passed");
    } else {
      expect(persistedRun?.status).toBe("error");
      expect(persistedFeature?.loopState).toBe("needs_fix");
      expect(persistedFeature?.lastValidatorStatus).toBe("error");
    }
  });

  it("creates one generated fix and consumes one retry under concurrent stores", async () => {
    const primary = missions();
    const competing = new AsyncMissionStore(h.layer(), h.store());
    const mission = await primary.createMission({ title: "Fix race" });
    const milestone = await primary.addMilestone(mission.id, { title: "MS" });
    const slice = await primary.addSlice(milestone.id, { title: "SL" });
    const feature = await primary.addFeature(slice.id, { title: "F" });
    await primary.transitionLoopState(feature.id, "implementing");
    const run = await primary.startValidatorRun(feature.id, "scheduled");
    await primary.completeValidatorRun(run.id, "failed", "repair");

    const [first, second] = await Promise.all([
      primary.createGeneratedFixFeature(feature.id, run.id, [], "first"),
      competing.createGeneratedFixFeature(feature.id, run.id, [], "second"),
    ]);

    expect(first.id).toBe(second.id);
    expect((await primary.getFeature(feature.id))?.implementationAttemptCount).toBe(1);
    const lineageRows = await h.layer().db
      .select({ id: schema.project.missionFixFeatureLineage.id })
      .from(schema.project.missionFixFeatureLineage)
      .where(sql`${schema.project.missionFixFeatureLineage.sourceFeatureId} = ${feature.id} AND ${schema.project.missionFixFeatureLineage.runId} = ${run.id}`);
    expect(lineageRows).toHaveLength(1);
  });

  it("persists validator failure batches and reads snapshot failures across the run set", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Bulk validator failures" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F", acceptanceCriteria: "bulk observable" });
    const [assertion] = await m.ensureFeatureAssertionLinked(feature.id);
    await m.transitionLoopState(feature.id, "implementing");
    const run = await m.startValidatorRun(feature.id, "manual");
    const failures = await m.recordValidatorFailures(run.id, Array.from({ length: 32 }, (_, index) => ({
      featureId: feature.id,
      assertionId: assertion!.id,
      message: `failure-${index}`,
      expected: "expected",
      actual: `actual-${index}`,
    })));
    expect(failures).toHaveLength(32);
    expect(await m.getFailuresForRun(run.id)).toHaveLength(32);
    const snapshot = await m.getFeatureLoopSnapshot(feature.id);
    expect(snapshot.failures.map((failure) => failure.message)).toEqual(Array.from({ length: 32 }, (_, index) => `failure-${index}`));
  });

  it("seeds assertion batches idempotently including duplicate rows in one request", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Bulk assertion seed" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const features = await Promise.all(Array.from({ length: 12 }, (_, index) => m.addFeature(slice.id, { title: `F-${index}` })));
    const inputs = features.map((feature, index) => ({
      featureId: feature.id,
      milestoneId: milestone.id,
      title: `Assertion ${index}`,
      assertion: `observable outcome ${index}`,
    }));
    inputs.push({ ...inputs[0]! });

    /* FNXC:PostgresMissionAssertionSeeding 2026-07-14-17:55: One real-PG seed call proves multi-row creation/linking and within-batch deduplication; a second call proves durable idempotence. */
    expect(await m.seedContractAssertionsForFeatures(inputs)).toEqual({
      scanned: 13,
      created: 12,
      linked: 12,
      skippedExisting: 1,
    });
    expect(await m.seedContractAssertionsForFeatures(inputs)).toEqual({
      scanned: 13,
      created: 0,
      linked: 0,
      skippedExisting: 13,
    });
    const seeded = (await m.listContractAssertions(milestone.id)).filter((assertion) => assertion.title.startsWith("Assertion "));
    expect(seeded).toHaveLength(12);
    for (const feature of features) {
      expect((await m.listAssertionsForFeature(feature.id)).filter((assertion) => assertion.title.startsWith("Assertion "))).toHaveLength(1);
    }
  });

  it("derives task goal provenance through its owning mission", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Goal provenance" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });
    const task = await h.store().createTask({ description: "mission delivery" });
    const now = new Date().toISOString();
    await h.store().getAsyncLayer()!.db.insert(schema.project.goals).values({
      id: "G-TASK-PROVENANCE",
      title: "Task goal",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await m.linkGoal(mission.id, "G-TASK-PROVENANCE");
    await m.linkFeatureToTask(feature.id, task.id);

    expect(await m.listGoalIdsForTask(task.id)).toEqual(["G-TASK-PROVENANCE"]);
    expect((await m.listGoalsForTask(task.id)).map((goal) => goal.id)).toEqual(["G-TASK-PROVENANCE"]);
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
