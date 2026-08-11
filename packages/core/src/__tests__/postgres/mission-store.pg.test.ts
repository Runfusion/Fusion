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

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import type { DbTransaction } from "../../postgres/data-layer.js";
import type { TaskCreateInput } from "../../types/task/task-core.js";
import type { MissionEvent } from "../../missions/mission-types.js";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import {
  AsyncMissionStore,
  MissionBlockedClearConflictError,
  MissionResumeConflictError,
  createMission as createMissionRow,
  createMilestone as createMilestoneRow,
  deleteMission as deleteMissionRow,
  getMission as getMissionRow,
  insertMissionEvent,
  listMilestones as listMilestoneRows,
  listMissionEvents,
  listMissions as listMissionRows,
  updateMilestoneValidationState,
} from "../../async-stores/async-mission-store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";

const pgTest = pgDescribe;

pgTest("MissionStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mission_store",
    /* FNXC:MissionStatusWrites 2026-08-10-13:49: Defined-feature bootstrap validates task ownership through a bound project partition. */
    projectId: "mission-store-pg-test",
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
      await updateMilestoneValidationState(tx, "MS-SHARED", "failed");
    });
    expect((await readProject("project-a")).milestones[0]?.validationState).toBe("failed");
    expect((await readProject("project-b")).milestones[0]?.validationState).toBe("not_started");

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.project_id', 'project-a', true)`);
      expect(await deleteMissionRow(tx, "M-SHARED")).toBe(true);
      expect(await getMissionRow(tx, "M-SHARED")).toBeUndefined();
    });
    expect((await readProject("project-b")).missions.map(({ title }) => title)).toEqual(["Project B mission"]);
  });

  it("atomically audits status and autopilot transitions with attributed before/after values", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Audited transitions" });
    const actor = { type: "operator" as const, id: "user-42", displayName: "Operator", source: "dashboard" };

    await m.updateMission(mission.id, { status: "active", autopilotEnabled: true }, { actor });
    // Unchanged sensitive values must not add noise to the activity feed.
    await m.updateMission(mission.id, { status: "active", autopilotEnabled: true }, { actor });
    await m.updateMission(mission.id, { status: "blocked", autopilotEnabled: false }, { actor });

    const events = (await m.getMissionEvents(mission.id, { limit: 20 })).events;
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.eventType)).toEqual([
      "autopilot_disabled", "mission_status_changed", "autopilot_enabled", "mission_status_changed",
    ]);
    const statusEvents = events.filter((event) => event.eventType === "mission_status_changed");
    const persistedActor = { type: "operator", id: "user-42", source: "dashboard" };
    expect(statusEvents.map((event) => event.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "status", from: "planning", to: "active", source: "dashboard", actor: persistedActor }),
      expect.objectContaining({ field: "status", from: "active", to: "blocked", source: "dashboard", actor: persistedActor }),
    ]));
    const autopilotEvents = events.filter((event) => event.eventType.startsWith("autopilot_"));
    expect(autopilotEvents.map((event) => event.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "autopilotEnabled", from: false, to: true, actor: persistedActor }),
      expect.objectContaining({ field: "autopilotEnabled", from: true, to: false, actor: persistedActor }),
    ]));
    expect(events.every((event) => !(event.metadata?.actor as Record<string, unknown> | undefined)?.displayName)).toBe(true);
  });

  it("atomically audits feature status changes from both public status seams", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Feature audit" });
    const milestone = await m.addMilestone(mission.id, { title: "Milestone" });
    const slice = await m.addSlice(milestone.id, { title: "Slice" });
    const first = await m.addFeature(slice.id, { title: "First" });
    const second = await m.addFeature(slice.id, { title: "Second" });
    const actor = { type: "agent" as const, id: "agent-42", source: "fn_feature_set_status", displayName: "Not persisted" };

    await m.updateFeatureStatus(first.id, "done", { actor, reason: `Authorization: Bearer sk-live-ABCDEFG1234567890abcdef ${"ordinary prose ".repeat(100)}` });
    await m.updateFeature(second.id, { status: "done" }, { actor });
    await m.updateFeature(second.id, { title: "No status event" }, { actor });

    const events = (await m.getMissionEvents(mission.id, { limit: 20 })).events
      .filter((event) => event.eventType === "feature_status_changed");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ featureId: first.id, sliceId: slice.id, from: "defined", to: "done", source: "fn_feature_set_status", actor: { type: "agent", id: "agent-42", source: "fn_feature_set_status" }, reasonTruncated: true }),
      expect.objectContaining({ featureId: second.id, sliceId: slice.id, from: "defined", to: "done" }),
    ]));
    const reasonEvent = events.find((event) => (event.metadata as Record<string, unknown>)?.featureId === first.id)!;
    expect(JSON.stringify(reasonEvent.metadata)).toContain("[REDACTED]");
    expect(JSON.stringify(reasonEvent.metadata)).not.toContain("displayName");
    expect((await m.getSlice(slice.id))?.status).toBe("complete");
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
    expect(triaged.map((task) => task.autoMergeProvenance)).toEqual(["mission", "mission"]);
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
    const observedEvents: MissionEvent[] = [];
    m.on("mission:event", (event) => observedEvents.push(event));

    const linked = await m.linkFeatureToTask(feature.id, task.id);
    expect(linked.taskId).toBe(task.id);
    expect(linked.status).toBe("triaged");
    expect(observedEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "feature_status_changed", metadata: expect.objectContaining({ source: "mission-link" }) })]));
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "feature_status_changed",
        metadata: expect.objectContaining({ featureId: feature.id, from: "defined", to: "triaged", source: "mission-link" }),
      }),
    ]));

    const unlinked = await m.unlinkFeatureFromTask(feature.id);
    expect(unlinked.taskId).toBeUndefined();
    expect(unlinked.status).toBe("defined");
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "feature_status_changed",
        metadata: expect.objectContaining({ featureId: feature.id, from: "triaged", to: "defined", source: "mission-store" }),
      }),
    ]));
  });

  it("audits defined-feature bootstrap claims inside their task transaction", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Claim audit" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Claimed feature" });

    const task = await h.store().createTask({
      description: "bootstrap claim",
      missionId: mission.id,
      sliceId: slice.id,
      afterTaskInsert: (tx: DbTransaction, inserted: { id: string }) => m.claimDefinedFeatureTaskInTransaction(tx, {
        featureId: feature.id,
        taskId: inserted.id,
        missionId: mission.id,
        sliceId: slice.id,
      }),
    } as TaskCreateInput & { afterTaskInsert: (tx: DbTransaction, task: { id: string }) => Promise<void> });

    expect(await m.getFeature(feature.id)).toMatchObject({ taskId: task.id, status: "triaged" });
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "feature_status_changed",
        metadata: expect.objectContaining({ featureId: feature.id, from: "defined", to: "triaged", source: "defined-feature-claim" }),
      }),
    ]));
  });

  it("does not overwrite an existing task directory on a creation collision", async () => {
    const taskStore = h.store();
    const existing = await taskStore.createTask({ description: "the existing task must keep its prompt" });
    const existingDir = taskStore.taskDir(existing.id);
    const originalPrompt = await readFile(`${existingDir}/PROMPT.md`, "utf8");
    const allocator = {
      reserveDistributedTaskId: vi.fn().mockResolvedValue({ taskId: existing.id, reservationId: "duplicate-id-reservation" }),
      commitDistributedTaskIdReservation: vi.fn().mockResolvedValue(undefined),
      abortDistributedTaskIdReservation: vi.fn().mockResolvedValue(undefined),
    };
    const allocatorSpy = vi.spyOn(taskStore, "getDistributedTaskIdAllocator").mockReturnValue(allocator as ReturnType<typeof taskStore.getDistributedTaskIdAllocator>);
    try {
      await expect(taskStore.createTask({ description: "a competing task must not overwrite files" }))
        .rejects.toThrow(`Task ID already exists: ${existing.id}`);

      /* FNXC:MissionAdmission 2026-07-23-19:00: a task-row collision leaves the winner's final artifacts untouched because the loser wrote only its staging directory. */
      await expect(readFile(`${existingDir}/PROMPT.md`, "utf8")).resolves.toBe(originalPrompt);
    } finally {
      allocatorSpy.mockRestore();
    }
  });

  it("does not claim a defined feature when task-file materialization fails", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Bootstrap file failure" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Target feature" });
    const taskStore = h.store();
    const claim = vi.fn(async (tx: DbTransaction, taskId: string) =>
      m.claimDefinedFeatureTaskInTransaction(tx, {
        featureId: feature.id,
        taskId,
        missionId: mission.id,
        sliceId: slice.id,
      }),
    );
    const writeTaskJson = vi.spyOn(taskStore, "writeTaskJsonFile").mockRejectedValueOnce(new Error("injected task-file failure"));

    try {
      await expect(taskStore.createTask({
        description: "must not become a partial feature bootstrap",
        missionId: mission.id,
        sliceId: slice.id,
        afterTaskInsert: (tx: DbTransaction, task: { id: string }) => claim(tx, task.id),
      } as TaskCreateInput & { afterTaskInsert: (tx: DbTransaction, task: { id: string }) => Promise<void> })).rejects.toThrow("injected task-file failure");
    } finally {
      writeTaskJson.mockRestore();
    }

    /* FNXC:MissionAdmission 2026-07-23-17:10: filesystem failure precedes the insert-and-claim transaction, so no feature promotion can survive a failed task create. */
    expect(claim).not.toHaveBeenCalled();
    expect(await m.getFeature(feature.id)).toMatchObject({ status: "defined", taskId: undefined });
    expect((await taskStore.listTasks()).some((task) => task.description === "must not become a partial feature bootstrap")).toBe(false);
  });

  it("rejects an unlinked duplicate canonical even when its mission and slice match", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Bootstrap duplicate guard" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Target feature" });
    const task = await h.store().createTask({
      description: "existing work for another feature",
      missionId: mission.id,
      sliceId: slice.id,
    });

    /*
    FNXC:MissionAdmission 2026-07-23-17:20:
    A duplicate canonical does not inherit a feature merely because it shares a
    slice. Only the insert transaction may claim a defined feature for a new
    task; retry reconciliation requires an existing bidirectional link.
    */
    await expect(m.claimDefinedFeatureTask({
      featureId: feature.id,
      taskId: task.id,
      missionId: mission.id,
      sliceId: slice.id,
    })).rejects.toThrow("is not linked to this feature");
    expect(await m.getFeature(feature.id)).toMatchObject({ status: "defined", taskId: undefined });
  });

  it("preserves a late bootstrap duplicate already linked to another feature", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Bootstrap sibling ownership" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const firstFeature = await m.addFeature(slice.id, { title: "First feature" });
    const siblingFeature = await m.addFeature(slice.id, { title: "Sibling feature" });
    const taskStore = h.store();
    const claimedTask = await taskStore.createTask({
      description: "same fingerprint work",
      missionId: mission.id,
      sliceId: slice.id,
    });
    await m.linkFeatureToTask(firstFeature.id, claimedTask.id);
    const siblingTask = await taskStore.createTask({
      description: "same fingerprint work",
      missionId: mission.id,
      sliceId: slice.id,
    });
    await m.linkFeatureToTask(siblingFeature.id, siblingTask.id);

    await m.archiveDefinedFeatureBootstrapDuplicate({
      featureId: firstFeature.id,
      taskId: claimedTask.id,
      duplicateTaskId: siblingTask.id,
    });

    /* FNXC:MissionAdmission 2026-07-23-21:10: a late same-fingerprint task claimed by another feature is not a duplicate eligible for archival. */
    /* FNXC:MergedPlanningColumn 2026-07-29-15:30 (U11): the assertion is "not archived" — the card
       stays where it was created, which for the default lineage is now the merged planning column
       `todo` rather than `triage`. */
    expect(await taskStore.getTask(siblingTask.id)).toMatchObject({ id: siblingTask.id, column: "todo" });
    expect(await m.getFeature(siblingFeature.id)).toMatchObject({ taskId: siblingTask.id, status: "triaged" });
    expect(await m.getFeature(firstFeature.id)).toMatchObject({ taskId: claimedTask.id, status: "triaged" });
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-10:20:
  THE BOOTSTRAP DUPLICATE WAS PARKED IN A LANE THE BOARD DOES NOT DECLARE.

  This path writes `tasks.column` DIRECTLY rather than going through `moveTask`, so neither the
  lifecycle census (which reads comparisons) nor the move-target census (which reads `moveTask`
  arguments) could see the literal `archived`. On a board whose archive lane is renamed, the
  duplicate landed in a column that workflow does not declare — a card in a lane the board cannot
  render, from a path that runs during ordinary feature bootstrap.

  DIFFERENTIAL: `filed` collides with no legacy id, so a surviving `"archived"` cannot pass by luck.

  FNXC:WorkflowResolvedColumns 2026-08-03-23:52:
  This fixture imports the canonical workflow module directly. The PostgreSQL schema barrel is only
  the Drizzle table contract and deliberately does not re-export workflow definitions; sibling
  renamed-lane PostgreSQL coverage uses the same direct source to keep schema and workflow APIs
  separate.
  */
  it("archives a bootstrap duplicate into the RENAMED archive lane", async () => {
    const m = missions();
    const taskStore = h.store();

    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string; nodes?: { column?: string }[]; columns?: { id: string }[];
    };
    ir.id = "custom:renamed-archive-missions";
    for (const node of ir.nodes ?? []) if (node.column === "archived") node.column = "filed";
    for (const column of ir.columns ?? []) if (column.id === "archived") column.id = "filed";
    expect((ir.columns ?? []).map((c) => c.id)).not.toContain("archived");
    const definition = await taskStore.createWorkflowDefinition({ name: "Renamed archive", kind: "workflow", ir } as never);
    const workflowId = (definition as unknown as { id: string }).id;

    const mission = await m.createMission({ title: "Renamed archive bootstrap" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });

    const claimedTask = await taskStore.createTask({ description: "same fingerprint work", missionId: mission.id, sliceId: slice.id });
    await m.linkFeatureToTask(feature.id, claimedTask.id);
    const duplicateTask = await taskStore.createTask({ description: "same fingerprint work", missionId: mission.id, sliceId: slice.id });
    await taskStore.writeTaskWorkflowSelection(duplicateTask.id, workflowId, []);

    await m.archiveDefinedFeatureBootstrapDuplicate({
      featureId: feature.id,
      taskId: claimedTask.id,
      duplicateTaskId: duplicateTask.id,
    });

    expect(await taskStore.getTask(duplicateTask.id)).toMatchObject({ id: duplicateTask.id, column: "filed" });
  });

  /* Control: with no renamed workflow the duplicate still lands in the legacy archive lane, so an
     unconverted board is byte-identical. */
  it("archives a bootstrap duplicate into `archived` on the default lineage", async () => {
    const m = missions();
    const taskStore = h.store();
    const mission = await m.createMission({ title: "Default archive bootstrap" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });

    const claimedTask = await taskStore.createTask({ description: "same fingerprint work", missionId: mission.id, sliceId: slice.id });
    await m.linkFeatureToTask(feature.id, claimedTask.id);
    const duplicateTask = await taskStore.createTask({ description: "same fingerprint work", missionId: mission.id, sliceId: slice.id });

    await m.archiveDefinedFeatureBootstrapDuplicate({
      featureId: feature.id,
      taskId: claimedTask.id,
      duplicateTaskId: duplicateTask.id,
    });

    expect(await taskStore.getTask(duplicateTask.id)).toMatchObject({ id: duplicateTask.id, column: "archived" });
  });

  /*
  FNXC:MissionReconciliation 2026-07-20-08:34:
  Regression coverage exercises every terminal-evidence representation through the real PostgreSQL store. Reconciliation must never route through ordinary triage linking, mutate loop attempts or mission controls, or partially commit when the transaction fails.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-05:05:
  THE INVARIANT: terminal evidence is the card's ROLE, not the id `done`.

  `getTerminalTaskEvidence` tested only `column === "done"`, so a genuinely completed card on a
  renamed board fell through every branch to `nonterminal` and this method threw
  `TASK_NOT_TERMINAL: ... must be in done or supported archived state, not shipped`. Mission
  shipped-delivery repair refused valid work — and the message named the real column while the check
  could not see it, which is the tell that the classifier and the reporter disagreed.

  I deferred this twice on the premise that `AsyncMissionStore` "holds a layer, not a store". It
  holds an OPTIONAL `taskStore`, and the single production construction site supplies it. That is the
  third deferral of mine this session to dissolve on inspection, which is the argument for checking a
  premise before recording it as a blocker.

  REVERT PROOF, measured: restore `column === "done"` and this fails with a
  `TASK_NOT_TERMINAL` rejection naming `shipped`.
  */
  it("accepts a completed card whose board calls the lane something else", async () => {
    const m = missions();
    const store = h.store();
    await store.createWorkflowDefinition({
      name: "Renamed complete",
      ir: {
        version: "v2",
        name: "Renamed complete",
        columns: [
          { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      } as never,
    });
    const mission = await m.createMission({ title: "Renamed-lane repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Delivered" });
    const task = await store.createTask({ description: "shipped elsewhere", column: "shipped" as never });

    const reconciled = await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);

    expect(reconciled).toMatchObject({ taskId: task.id, status: "done" });
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
  THE ARCHIVED HALF OF THE SAME PAIR. The case above pins the `complete` resolver; the `archived`
  one is declared on the very next line and nothing reached it — blinding it back to `["archived"]`
  left the whole 16-file lane-detector set green while blinding its neighbour failed immediately.

  Terminal evidence is "done OR supported archived state", so an archived card is equally valid
  repair evidence. On a board whose archive lane is `vaulted`, the archived half could not see it and
  the method threw `TASK_NOT_TERMINAL` for a card that was genuinely filed away — the same refusal
  the case above fixed, reached through the other door.

  Being adjacent to a covered resolver is not coverage; this is the third such split found in core.
  */
  it("accepts an ARCHIVED card whose board calls the archive lane something else", async () => {
    const m = missions();
    const store = h.store();
    await store.createWorkflowDefinition({
      name: "Renamed archive",
      ir: {
        version: "v2",
        name: "Renamed archive",
        columns: [
          { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "done", name: "Done", traits: [{ trait: "complete" }] },
          { id: "vaulted", name: "Vaulted", traits: [{ trait: "archived" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "todo" },
          { id: "end", kind: "end", column: "done" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      } as never,
    });
    const mission = await m.createMission({ title: "Renamed-archive repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Delivered" });
    const task = await store.createTask({ description: "filed away", column: "done" });
    /*
    A REAL archive, then the lane rename. The `archived` verdict requires all three of
    `deletedAt !== null`, an archive-snapshot row, and `isArchived(column)` — a live card merely
    sitting in an archive-trait column is `invalid-deleted`, not `archived`, so seeding one would
    fail for a reason that has nothing to do with the lane read under test. Archiving first and
    then renaming the recorded lane isolates exactly the third condition.
    */
    await store.archiveTask(task.id, { cleanup: false });
    await h.adminDb().execute(sql`UPDATE project.tasks SET "column" = 'vaulted' WHERE id = ${task.id}`);
    store.taskCache.delete(task.id);

    const reconciled = await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);

    expect(reconciled).toMatchObject({ taskId: task.id, status: "done" });
  });

  it("atomically reconciles live done evidence and remains idempotent", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Parked repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Delivered" });
    const task = await h.store().createTask({ description: "shipped", column: "done" });
    const taskCount = (await h.store().listTasks()).length;

    const reconciled = await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);

    expect(reconciled).toMatchObject({ taskId: task.id, status: "done", loopState: "idle", implementationAttemptCount: 0 });
    expect(await m.getSlice(slice.id)).toMatchObject({ status: "complete" });
    expect(await m.getMilestone(milestone.id)).toMatchObject({ status: "complete" });
    expect(await m.getMission(mission.id)).toMatchObject({ status: "planning", autopilotEnabled: false, autoAdvance: false });
    expect(await h.store().getTask(task.id)).toMatchObject({ missionId: mission.id, sliceId: slice.id, column: "done" });
    expect((await h.store().listTasks()).length).toBe(taskCount);
    const statusEvents = (await m.getMissionEvents(mission.id, { limit: 10 })).events
      .filter((event) => event.eventType === "feature_status_changed");
    expect(statusEvents).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ featureId: feature.id, from: "defined", to: "done", source: "terminal-task-reconcile" }),
    })]);

    const firstUpdatedAt = reconciled.updatedAt;
    const idempotent = await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);
    expect(idempotent.updatedAt).toBe(firstUpdatedAt);
    expect(idempotent).toEqual(reconciled);
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events
      .filter((event) => event.eventType === "feature_status_changed")).toHaveLength(1);

    // A link-only repair has featureChanged=true but no status delta, so it stays silent.
    const linkOnly = await m.addFeature(slice.id, { title: "Already done" });
    await m.updateFeature(linkOnly.id, { status: "done" });
    const linkOnlyTask = await h.store().createTask({ description: "done", column: "done" });
    await m.reconcileFeatureDoneWithTerminalTask(linkOnly.id, linkOnlyTask.id);
    expect((await m.getMissionEvents(mission.id, { limit: 20 })).events
      .filter((event) => event.eventType === "feature_status_changed" && (event.metadata as Record<string, unknown>)?.featureId === linkOnly.id))
      .toHaveLength(1);

    const duplicate = await m.addFeature(slice.id, { title: "Corrupt duplicate" });
    await m.updateFeature(duplicate.id, { taskId: task.id });
    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id)).rejects.toMatchObject({ code: "TASK_FEATURE_CONFLICT" });
    expect(await m.getFeature(feature.id)).toEqual(reconciled);
  });

  it("accepts a supported archived tombstone without resurrecting or back-linking it", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Archived repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Archived delivery" });
    const task = await h.store().createTask({ description: "archived shipped work", column: "done" });
    await h.store().archiveTask(task.id, { cleanup: false });

    const reconciled = await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);

    expect(reconciled).toMatchObject({ taskId: task.id, status: "done", loopState: "idle", implementationAttemptCount: 0 });
    expect(await h.store().getTask(task.id)).toMatchObject({ column: "archived" });
    const tombstones = await h.layer().db
      .select({ column: schema.project.tasks.column, deletedAt: schema.project.tasks.deletedAt, missionId: schema.project.tasks.missionId, sliceId: schema.project.tasks.sliceId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(tombstones).toEqual([{ column: "archived", deletedAt: expect.any(String), missionId: null, sliceId: null }]);
    expect(await m.getMission(mission.id)).toMatchObject({ status: "planning", autopilotEnabled: false, autoAdvance: false });
  });

  it("rejects missing, nonterminal, invalid-deleted, feature mismatch, and duplicate task links without mutation", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Guarded repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const [feature, other] = await Promise.all([
      m.addFeature(slice.id, { title: "Canonical" }),
      m.addFeature(slice.id, { title: "Other" }),
    ]);
    const nonterminal = await h.store().createTask({ description: "active", column: "todo" });
    const invalidDeleted = await h.store().createTask({ description: "deleted without archive", column: "done" });
    await h.layer().db.update(schema.project.tasks).set({ deletedAt: new Date().toISOString() })
      .where(eq(schema.project.tasks.id, invalidDeleted.id));
    const linkedTask = await h.store().createTask({ description: "already linked", column: "done" });
    await m.reconcileFeatureDoneWithTerminalTask(other.id, linkedTask.id);

    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, "FN-MISSING")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, nonterminal.id)).rejects.toMatchObject({ code: "TASK_NOT_TERMINAL" });
    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, invalidDeleted.id)).rejects.toMatchObject({ code: "TASK_ARCHIVE_INVALID" });
    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, linkedTask.id)).rejects.toMatchObject({ code: "TASK_FEATURE_CONFLICT" });

    const canonicalTask = await h.store().createTask({ description: "canonical", column: "done" });
    await m.linkFeatureToTask(feature.id, nonterminal.id);
    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, canonicalTask.id)).rejects.toMatchObject({ code: "FEATURE_TASK_CONFLICT" });
    expect(await m.getFeature(feature.id)).toMatchObject({ taskId: nonterminal.id, status: "triaged", loopState: "implementing" });
    expect(await m.getMission(mission.id)).toMatchObject({ autopilotEnabled: false, autoAdvance: false });
  });

  it("rolls back feature linkage and rollups when reconciliation fails after its writes", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Rollback repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Rollback" });
    const task = await h.store().createTask({ description: "done", column: "done" });
    const layer = h.layer();
    const original = layer.transactionImmediate.bind(layer);
    const transaction = vi.spyOn(layer, "transactionImmediate").mockImplementation(async (callback) => original(async (tx) => {
      await callback(tx);
      throw new Error("injected post-write failure");
    }));

    await expect(m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id)).rejects.toThrow("injected post-write failure");
    transaction.mockRestore();

    expect(await m.getFeature(feature.id)).toMatchObject({ taskId: undefined, status: "defined", loopState: "idle", implementationAttemptCount: 0 });
    expect(await m.getSlice(slice.id)).toMatchObject({ status: "pending" });
    expect(await m.getMilestone(milestone.id)).toMatchObject({ status: "planning" });
    expect(await h.store().getTask(task.id)).toMatchObject({ missionId: undefined, sliceId: undefined });
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events
      .filter((event) => event.eventType === "feature_status_changed")).toHaveLength(0);
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

  it("reconciles repaired and deleted failed assertions before publishing validation updates", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Current assertion rollup" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const validationEvents: Array<{ state: string; rollup: { state: string } }> = [];
    m.on("milestone:validation:updated", (payload) => {
      if (payload.milestoneId === milestone.id) validationEvents.push(payload);
    });
    const failed = await m.addContractAssertion(milestone.id, {
      title: "Repair me", assertion: "works", status: "failed", scope: "milestone",
    });

    const expectCurrentState = async (state: "ready" | "passed" | "blocked" | "not_started") => {
      expect((await m.getMilestoneValidationRollup(milestone.id)).state).toBe(state);
      expect((await m.getMilestone(milestone.id))?.validationState).toBe(state);
      expect(validationEvents.at(-1)).toMatchObject({ state, rollup: { state } });
    };

    expect(await m.getMilestoneValidationRollup(milestone.id)).toMatchObject({ state: "failed", failedAssertions: 1 });
    expect((await m.getMilestone(milestone.id))?.validationState).toBe("failed");
    await m.updateContractAssertion(failed.id, { status: "pending" });
    await expectCurrentState("ready");
    await m.updateContractAssertion(failed.id, { status: "passed" });
    await expectCurrentState("passed");
    await m.updateContractAssertion(failed.id, { status: "blocked" });
    await expectCurrentState("blocked");
    await m.deleteContractAssertion(failed.id);
    await expectCurrentState("not_started");

    const remainingFailure = await m.addContractAssertion(milestone.id, {
      title: "Still failing", assertion: "fails", status: "failed", scope: "milestone",
    });
    const repairedFailure = await m.addContractAssertion(milestone.id, {
      title: "Repairable", assertion: "also fails", status: "failed", scope: "milestone",
    });
    await m.updateContractAssertion(repairedFailure.id, { status: "passed" });
    expect(await m.getMilestoneValidationRollup(milestone.id)).toMatchObject({ state: "failed", failedAssertions: 1 });
    expect((await m.getMilestone(milestone.id))?.validationState).toBe("failed");
    await m.deleteContractAssertion(remainingFailure.id);

    const concurrentFirst = await m.addContractAssertion(milestone.id, {
      title: "Concurrent first", assertion: "first fails", status: "failed", scope: "milestone",
    });
    const concurrentSecond = await m.addContractAssertion(milestone.id, {
      title: "Concurrent second", assertion: "second fails", status: "failed", scope: "milestone",
    });
    await Promise.all([
      m.updateContractAssertion(concurrentFirst.id, { status: "passed" }),
      m.updateContractAssertion(concurrentSecond.id, { status: "passed" }),
    ]);
    await expectCurrentState("passed");
  });

  it("startValidatorRun is returned by getValidatorRunsByFeature", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Validated" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const run = await m.startValidatorRun(feature.id, "manual", undefined, "fingerprint-round-trip");
    expect(run.status).toBe("running");
    expect(run.inputFingerprint).toBe("fingerprint-round-trip");
    expect(run.validatorAttempt).toBe(1);

    const runs = await m.getValidatorRunsByFeature(feature.id);
    expect(runs.map((r) => r.id)).toContain(run.id);

    const fetched = await m.getValidatorRun(run.id);
    expect(fetched?.id).toBe(run.id);
    expect(fetched?.inputFingerprint).toBe("fingerprint-round-trip");
  });

  it("atomically admits one fresh manual validator run and preserves rejected feature state", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Manual admission" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const [first, second] = await Promise.all([
      m.startManualValidatorRun(feature.id),
      m.startManualValidatorRun(feature.id),
    ]);
    const started = first.outcome === "started" ? first : second;
    const blocked = first.outcome === "already-running" ? first : second;
    expect(started).toMatchObject({ outcome: "started" });
    expect(blocked).toMatchObject({ outcome: "already-running", run: { id: started.run.id } });
    expect((await m.getValidatorRunsByFeature(feature.id)).filter((run) => run.status === "running")).toHaveLength(1);
    const beforeRejected = await m.getFeature(feature.id);
    await expect(m.startManualValidatorRun(feature.id)).resolves.toMatchObject({ outcome: "already-running", run: { id: started.run.id } });
    expect(await m.getFeature(feature.id)).toEqual(beforeRejected);

    await m.completeValidatorRun(started.run.id, "passed");
    await expect(m.startManualValidatorRun(feature.id)).resolves.toMatchObject({ outcome: "started" });
  });

  it("serializes a manual trigger with the engine fallback validator creator", async () => {
    /*
    FNXC:MissionValidation 2026-08-11-04:27:
    FN-8963's feature lock must cover the production non-memo engine fallback as well as the
    manual route. Either contender may acquire it first, but their concurrent creation attempts
    must leave exactly one live validator run.
    */
    const m = missions();
    const mission = await m.createMission({ title: "Manual and fallback serialization" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const [manual, fallback] = await Promise.allSettled([
      m.startManualValidatorRun(feature.id),
      m.startValidatorRun(feature.id, "task_completion"),
    ]);

    expect((await m.getValidatorRunsByFeature(feature.id)).filter((run) => run.status === "running")).toHaveLength(1);
    expect(
      (manual.status === "fulfilled" && manual.value.outcome === "started") || fallback.status === "fulfilled",
    ).toBe(true);
    if (manual.status === "fulfilled" && manual.value.outcome === "started") {
      expect(fallback).toMatchObject({ status: "rejected" });
    } else {
      expect(manual).toMatchObject({ status: "fulfilled", value: { outcome: "already-running" } });
    }
  });

  it("reports the newest fresh run when legacy data has multiple running rows", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Legacy concurrent validation rows" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const older = await m.startValidatorRun(feature.id, "task_completion");
    await h.layer().transactionImmediate(async (tx) => {
      await tx.update(schema.project.missionValidatorRuns)
        .set({ startedAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(schema.project.missionValidatorRuns.id, older.id));
    });
    const newest = await m.startValidatorRun(feature.id, "task_completion");

    await expect(m.startManualValidatorRun(feature.id))
      .resolves.toMatchObject({ outcome: "already-running", run: { id: newest.id } });
    expect((await m.getValidatorRunsByFeature(feature.id)).filter((run) => run.status === "running")).toHaveLength(2);
  });

  it("manual admission blocks fresh automatic runs but ignores stale runs", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Cross surface admission" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const automatic = await m.admitValidatorRun(feature.id, { inputFingerprint: "fp-a", failureBudget: 3, reusePass: false });
    expect(automatic).toMatchObject({ outcome: "start" });
    await expect(m.startManualValidatorRun(feature.id)).resolves.toMatchObject({ outcome: "already-running", run: { id: automatic.run!.id } });
    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "fp-a", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "running", run: { id: automatic.run!.id } });

    await m.completeValidatorRun(automatic.run!.id, "error");
    const stale = await m.startValidatorRun(feature.id, "task_completion");
    await h.layer().transactionImmediate(async (tx) => {
      await tx.update(schema.project.missionValidatorRuns)
        .set({ startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() })
        .where(eq(schema.project.missionValidatorRuns.id, stale.id));
    });
    await expect(m.startManualValidatorRun(feature.id)).resolves.toMatchObject({ outcome: "started" });
  });

  /*
  FNXC:MissionValidation 2026-08-11-05:26:
  A replacement validator owns feature state across every stale-run terminal surface: manual admission after an old engine run, engine fallback after an old manual run, and the stale reaper. Historical runs still become terminal records but cannot overwrite the replacement's validating state.
  */
  it("keeps replacement validator ownership when superseded runs complete or are reaped", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Superseded validator ownership" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const staleAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const ageRun = async (runId: string) => {
      await h.layer().transactionImmediate(async (tx) => {
        await tx.update(schema.project.missionValidatorRuns)
          .set({ startedAt: staleAt })
          .where(eq(schema.project.missionValidatorRuns.id, runId));
      });
    };

    const manualReplacementFeature = await m.addFeature(slice.id, { title: "Manual replacement" });
    const oldEngineRun = await m.startValidatorRun(manualReplacementFeature.id, "task_completion");
    await ageRun(oldEngineRun.id);
    const manualReplacement = await m.startManualValidatorRun(manualReplacementFeature.id);
    expect(manualReplacement).toMatchObject({ outcome: "started" });
    await m.completeValidatorRun(oldEngineRun.id, "failed");
    expect(await m.getValidatorRun(oldEngineRun.id)).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
    });
    expect(await m.getFeature(manualReplacementFeature.id)).toMatchObject({
      lastValidatorRunId: manualReplacement.run.id,
      loopState: "validating",
    });

    const fallbackReplacementFeature = await m.addFeature(slice.id, { title: "Fallback replacement" });
    const oldManual = await m.startManualValidatorRun(fallbackReplacementFeature.id);
    expect(oldManual).toMatchObject({ outcome: "started" });
    await ageRun(oldManual.run.id);
    const fallbackReplacement = await m.startValidatorRun(fallbackReplacementFeature.id, "task_completion");
    await m.completeValidatorRun(oldManual.run.id, "passed");
    expect(await m.getValidatorRun(oldManual.run.id)).toMatchObject({
      status: "passed",
      completedAt: expect.any(String),
    });
    expect(await m.getFeature(fallbackReplacementFeature.id)).toMatchObject({
      lastValidatorRunId: fallbackReplacement.id,
      loopState: "validating",
    });

    const reaperReplacementFeature = await m.addFeature(slice.id, { title: "Reaper replacement" });
    const oldReapTarget = await m.startValidatorRun(reaperReplacementFeature.id, "task_completion");
    await ageRun(oldReapTarget.id);
    const reaperReplacement = await m.startManualValidatorRun(reaperReplacementFeature.id);
    expect(reaperReplacement).toMatchObject({ outcome: "started" });
    await m.reapValidatorRun(oldReapTarget.id, "stale owner");
    expect(await m.getValidatorRun(oldReapTarget.id)).toMatchObject({
      status: "error",
      completedAt: expect.any(String),
    });
    expect(await m.getFeature(reaperReplacementFeature.id)).toMatchObject({
      lastValidatorRunId: reaperReplacement.run.id,
      loopState: "validating",
    });

    const terminalMissionFeature = await m.addFeature(slice.id, { title: "Terminal mission guard" });
    const terminalMissionRun = await m.startValidatorRun(terminalMissionFeature.id, "task_completion");
    const layer = h.layer();
    const originalTransaction = layer.transactionImmediate.bind(layer);
    let archiveBeforeReapTransaction = true;
    const transaction = vi.spyOn(layer, "transactionImmediate").mockImplementation(async (callback) => {
      if (archiveBeforeReapTransaction) {
        archiveBeforeReapTransaction = false;
        await m.updateMission(mission.id, { status: "archived" });
      }
      return originalTransaction(callback);
    });
    try {
      await m.reapValidatorRun(terminalMissionRun.id, "mission became terminal");
    } finally {
      transaction.mockRestore();
    }
    expect(await m.getMission(mission.id)).toMatchObject({ status: "archived" });
    expect(await m.getFeature(terminalMissionFeature.id)).toMatchObject({
      lastValidatorRunId: terminalMissionRun.id,
      loopState: "validating",
    });
  });

  it("refuses automatic-after-manual admission across the fingerprint-less boundary", async () => {
    /*
    FNXC:MissionValidation 2026-08-11-05:38:
    FN-8976 reconciles the former automatic-after-manual gap. A live fingerprint-less manual run
    blocks automatic admission without mutating feature state; content-addressed terminal decisions
    remain fingerprint-scoped after this feature-liveness refusal.
    */
    const m = missions();
    const mission = await m.createMission({ title: "Fingerprint boundary" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const manual = await m.startManualValidatorRun(feature.id);
    expect(manual).toMatchObject({ outcome: "started", run: { inputFingerprint: undefined, status: "running" } });
    const before = await m.getFeature(feature.id);
    const beforeEvents = (await m.getMissionEvents(mission.id, { limit: 100 })).events.length;

    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "c".repeat(64), failureBudget: 3, reusePass: true }))
      .resolves.toMatchObject({ outcome: "running", run: { id: manual.run.id }, blockingScope: "feature" });
    expect((await m.getValidatorRunsByFeature(feature.id)).filter((run) => run.status === "running")).toHaveLength(1);
    const after = await m.getFeature(feature.id);
    expect(after).toMatchObject({
      validatorAttemptCount: before?.validatorAttemptCount,
      lastValidatorRunId: before?.lastValidatorRunId,
      loopState: before?.loopState,
      validationBudgetFingerprint: before?.validationBudgetFingerprint,
      validationBudgetRunId: before?.validationBudgetRunId,
      validationBudgetBlockedAt: before?.validationBudgetBlockedAt,
    });
    const warnings = (await m.getMissionEvents(mission.id, { limit: 100 })).events
      .filter((event) => event.description === "validation memoized");
    expect(warnings).toHaveLength(1);
    expect((await m.getMissionEvents(mission.id, { limit: 100 })).events).toHaveLength(beforeEvents + 1);
    expect(warnings[0]?.metadata).toMatchObject({ outcome: "running", featureId: feature.id, runId: manual.run.id, blockingScope: "feature" });
    expect((await m.getMissionEvents(mission.id, { limit: 100 })).events.some((event) => event.description === "validation-stuck")).toBe(false);
  });

  it("blocks every fresh feature-scoped running run but ignores a stale run", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Feature scoped automatic admission" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const different = await m.startValidatorRun(feature.id, "task_completion", undefined, "different");
    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "requested", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "running", run: { id: different.id }, blockingScope: "feature" });
    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "different", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "running", run: { id: different.id }, blockingScope: "feature" });
    await m.completeValidatorRun(different.id, "error");
    const fallback = await m.startValidatorRun(feature.id, "task_completion");
    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "requested", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "running", run: { id: fallback.id }, blockingScope: "feature" });
    await m.completeValidatorRun(fallback.id, "error");

    const stale = await m.startValidatorRun(feature.id, "task_completion");
    await h.layer().transactionImmediate(async (tx) => {
      await tx.update(schema.project.missionValidatorRuns)
        .set({ startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() })
        .where(eq(schema.project.missionValidatorRuns.id, stale.id));
    });
    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "requested", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "start" });
  });

  it("reports the newest fresh run when legacy data has multiple running rows", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Automatic legacy concurrent validation rows" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const older = await m.startValidatorRun(feature.id, "task_completion");
    await h.layer().transactionImmediate(async (tx) => {
      await tx.update(schema.project.missionValidatorRuns)
        .set({ startedAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(schema.project.missionValidatorRuns.id, older.id));
    });
    const newest = await m.startValidatorRun(feature.id, "task_completion");

    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "requested", failureBudget: 3, reusePass: false }))
      .resolves.toMatchObject({ outcome: "running", run: { id: newest.id }, blockingScope: "feature" });
  });

  it("keeps reuse-pass behind a live fingerprint-less run", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Live run precedes reuse" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const passed = await m.startValidatorRun(feature.id, "task_completion", undefined, "reuse");
    await m.completeValidatorRun(passed.id, "passed");
    const manual = await m.startManualValidatorRun(feature.id);

    await expect(m.admitValidatorRun(feature.id, { inputFingerprint: "reuse", failureBudget: 3, reusePass: true }))
      .resolves.toMatchObject({ outcome: "running", run: { id: manual.run.id }, blockingScope: "feature" });
    expect((await m.getFeature(feature.id))?.status).not.toBe("done");
  });

  it("serializes concurrent manual and automatic admission", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Concurrent cross-surface admission" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const [manual, automatic] = await Promise.all([
      m.startManualValidatorRun(feature.id),
      m.admitValidatorRun(feature.id, { inputFingerprint: "concurrent", failureBudget: 3, reusePass: false }),
    ]);
    expect((await m.getValidatorRunsByFeature(feature.id)).filter((run) => run.status === "running")).toHaveLength(1);
    expect([manual.outcome, automatic.outcome].filter((outcome) => outcome === "started" || outcome === "start")).toHaveLength(1);
    expect([manual.outcome, automatic.outcome].filter((outcome) => outcome === "already-running" || outcome === "running")).toHaveLength(1);
  });

  it("does not let reuse-pass or budget exhaustion block a manual validator run", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Terminal automatic outcomes" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const reuseFeature = await m.addFeature(slice.id, { title: "Reuse" });
    const passed = await m.startValidatorRun(reuseFeature.id, "task_completion", undefined, "reuse");
    await m.completeValidatorRun(passed.id, "passed");
    await expect(m.admitValidatorRun(reuseFeature.id, { inputFingerprint: "reuse", failureBudget: 3, reusePass: true })).resolves.toMatchObject({ outcome: "reuse-pass" });
    await expect(m.startManualValidatorRun(reuseFeature.id)).resolves.toMatchObject({ outcome: "started" });

    const budgetFeature = await m.addFeature(slice.id, { title: "Budget" });
    const failed = await m.startValidatorRun(budgetFeature.id, "task_completion", undefined, "budget");
    await m.completeValidatorRun(failed.id, "failed");
    await expect(m.admitValidatorRun(budgetFeature.id, { inputFingerprint: "budget", failureBudget: 1, reusePass: false })).resolves.toMatchObject({ outcome: "budget-exhausted" });
    await expect(m.startManualValidatorRun(budgetFeature.id)).resolves.toMatchObject({ outcome: "started" });
  });

  it("clears all validation-budget provenance when a changed fingerprint is admitted", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Changed validation input" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });
    const exhaustedFingerprint = "a".repeat(64);
    const changedFingerprint = "b".repeat(64);

    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await m.startValidatorRun(feature.id, "task_completion", undefined, exhaustedFingerprint);
      await m.completeValidatorRun(run.id, "failed", "deterministic failure");
    }
    await expect(m.admitValidatorRun(feature.id, {
      inputFingerprint: exhaustedFingerprint,
      failureBudget: 3,
      reusePass: true,
    })).resolves.toMatchObject({ outcome: "budget-exhausted" });
    expect(await m.getFeature(feature.id)).toMatchObject({
      loopState: "blocked",
      validationBudgetFingerprint: exhaustedFingerprint,
    });

    await expect(m.admitValidatorRun(feature.id, {
      inputFingerprint: changedFingerprint,
      failureBudget: 3,
      reusePass: true,
    })).resolves.toMatchObject({ outcome: "start", run: { inputFingerprint: changedFingerprint } });
    expect(await m.getFeature(feature.id)).toMatchObject({
      loopState: "validating",
      validationBudgetFingerprint: undefined,
      validationBudgetRunId: undefined,
      validationBudgetBlockedAt: undefined,
    });
  });

  it("audits validator reuse-pass status promotion and skips repeat admission", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Reuse pass audit" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Validated feature" });
    const fingerprint = "reuse-pass-fingerprint";
    const run = await m.startValidatorRun(feature.id, "scheduled", undefined, fingerprint);
    await m.completeValidatorRun(run.id, "passed", "passed");

    await expect(m.admitValidatorRun(feature.id, {
      inputFingerprint: fingerprint,
      failureBudget: 1,
      reusePass: true,
    })).resolves.toMatchObject({ outcome: "reuse-pass", run: { id: run.id } });
    expect((await m.getMissionEvents(mission.id, { limit: 10 })).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "feature_status_changed",
        metadata: expect.objectContaining({ featureId: feature.id, from: "defined", to: "done", source: "validator-reuse-pass" }),
      }),
    ]));

    await m.admitValidatorRun(feature.id, { inputFingerprint: fingerprint, failureBudget: 1, reusePass: true });
    expect((await m.getMissionEvents(mission.id, { limit: 20 })).events
      .filter((event) => event.eventType === "feature_status_changed" && (event.metadata as Record<string, unknown>)?.featureId === feature.id))
      .toHaveLength(1);
  });

  it("audits each changed superseded generated fix without expanding the bulk write", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Superseded fix audit" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const root = await m.addFeature(slice.id, { title: "Root" });
    const failedRun = await m.startValidatorRun(root.id, "scheduled");
    await m.completeValidatorRun(failedRun.id, "failed", "needs fix");
    const firstFix = await m.createGeneratedFixFeature(root.id, failedRun.id, [], "repair");
    const secondRoot = await m.addFeature(slice.id, { title: "Second root" });
    const secondRun = await m.startValidatorRun(secondRoot.id, "scheduled");
    await m.completeValidatorRun(secondRun.id, "failed", "needs fix");
    const secondFix = await m.createGeneratedFixFeature(secondRoot.id, secondRun.id, [], "repair");
    await m.updateFeature(root.id, { lastValidatorStatus: "passed", loopState: "passed" });
    await m.updateFeature(secondRoot.id, { lastValidatorStatus: "passed", loopState: "passed" });

    await expect(m.reconcileSupersededGeneratedFixFeatures(slice.id)).resolves.toMatchObject({
      supersededCount: 2,
      featureIds: expect.arrayContaining([firstFix.id, secondFix.id]),
    });
    const audited = (await m.getMissionEvents(mission.id, { limit: 20 })).events
      .filter((event) => event.eventType === "feature_status_changed" && (event.metadata as Record<string, unknown>)?.source === "superseded-fix-reconcile");
    expect(audited).toHaveLength(2);
    expect(audited.map((event) => (event.metadata as Record<string, unknown>)?.featureId))
      .toEqual(expect.arrayContaining([firstFix.id, secondFix.id]));

    await expect(m.reconcileSupersededGeneratedFixFeatures(slice.id)).resolves.toMatchObject({ supersededCount: 0, featureIds: [] });
    expect((await m.getMissionEvents(mission.id, { limit: 20 })).events
      .filter((event) => event.eventType === "feature_status_changed" && (event.metadata as Record<string, unknown>)?.source === "superseded-fix-reconcile"))
      .toHaveLength(2);
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

  it("shares the root retry budget across fix-of-fix lineage", async () => {
    /* FNXC:MissionLineageBudget 2026-07-22-12:00: deterministic remediation chains must exhaust the original feature, never restart at each child. */
    const m = missions();
    const mission = await m.createMission({ title: "Root budget" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const root = await m.addFeature(slice.id, { title: "F" });
    let source = root;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await m.transitionLoopState(source.id, "implementing");
      const run = await m.startValidatorRun(source.id, "scheduled");
      await m.completeValidatorRun(run.id, "failed", "deterministic failure");
      source = await m.createGeneratedFixFeature(source.id, run.id, [], "deterministic failure");
      expect((await m.getFeature(root.id))?.implementationAttemptCount).toBe(attempt);
    }
    await m.transitionLoopState(source.id, "implementing");
    const fourthRun = await m.startValidatorRun(source.id, "scheduled");
    await m.completeValidatorRun(fourthRun.id, "failed", "deterministic failure");
    await expect(m.createGeneratedFixFeature(source.id, fourthRun.id, [], "deterministic failure"))
      .rejects.toThrow("MISSION_REMEDIATION_STOPPED: budget-exhausted");
    expect(await m.getFeature(root.id)).toMatchObject({ loopState: "blocked", implementationStopReason: "budget-exhausted", implementationAttemptCount: 3 });
  });

  it("records generated-task archive as a durable root stop before unlinking", async () => {
    /*
    FNXC:MissionLineageBudget 2026-07-22-15:30:
    Task archive is a supported removal surface. Its archive transaction must
    retain the root stop even though it clears the generated feature's task link.
    */
    const m = missions();
    const mission = await m.createMission({ title: "Generated task stop" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const root = await m.addFeature(slice.id, { title: "F" });
    const run = await m.startValidatorRun(root.id, "scheduled");
    await m.completeValidatorRun(run.id, "failed", "repair");
    const fix = await m.createGeneratedFixFeature(root.id, run.id, [], "repair");
    const task = await h.store().createTask({ description: "Generated fix task" });
    await m.linkFeatureToTask(fix.id, task.id);

    await h.store().archiveTask(task.id, { cleanup: false });

    expect(await m.getFeature(root.id)).toMatchObject({
      loopState: "blocked",
      implementationStopReason: "operator-intervention",
    });
    expect(await m.getFeature(fix.id)).toMatchObject({ taskId: undefined });
    const stops = await h.layer().db.select().from(schema.project.missionLineageStops)
      .where(sql`${schema.project.missionLineageStops.rootFeatureId} = ${root.id}`);
    expect(stops).toMatchObject([{ reason: "operator-intervention", origin: "task-archive" }]);
  });

  it("clears only a stale blocked mission badge with one attributed audit event", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Clear stale blocked badge" });
    await m.updateMission(mission.id, { status: "blocked" });
    const before = (await m.getMissionEvents(mission.id, { limit: 20 })).events.length;
    const cleared = await m.clearMissionBlockedStatus(mission.id, { actor: { type: "operator", id: "operator", source: "dashboard" }, reason: "resolved" });
    expect(cleared.mission.status).toBe("planning");
    expect(cleared.blockers).toEqual([]);
    const events = (await m.getMissionEvents(mission.id, { limit: 20 })).events;
    expect(events).toHaveLength(before + 1);
    expect(events[0]).toMatchObject({ eventType: "mission_status_changed", metadata: expect.objectContaining({ from: "blocked", to: "planning", repairAction: "clear-blocked", reason: "resolved", actor: { type: "operator", id: "operator", source: "dashboard" } }) });
    await expect(m.clearMissionBlockedStatus(mission.id, { actor: { type: "operator", id: "operator", source: "dashboard" } })).rejects.toBeInstanceOf(MissionBlockedClearConflictError);
  });

  /*
  FNXC:MissionBlockedRepair 2026-08-11-03:24:
  Clearing a stale mission badge is deliberately non-destructive. Exercise the persisted
  feature-stop and lineage-stop fixture so this transaction cannot accidentally launder the
  records that still make Resume unsafe, while the legacy conflict wire remains duplicated.
  */
  it("clears a blocked badge without laundering persisted stop records", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Persisted blocked repair" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const root = await m.addFeature(slice.id, { title: "Budget-exhausted root" });
    const stoppedAt = "2026-08-11T03:24:00.000Z";

    await h.layer().db.update(schema.project.missionFeatures)
      .set({
        loopState: "blocked",
        implementationStopReason: "budget-exhausted",
        implementationStoppedAt: stoppedAt,
        implementationStopOrigin: "validator-budget",
      })
      .where(sql`${schema.project.missionFeatures.id} = ${root.id}`);
    await h.layer().db.insert(schema.project.missionLineageStops).values({
      projectId: "mission-store-pg-test",
      rootFeatureId: root.id,
      missionId: mission.id,
      reason: "budget-exhausted",
      stoppedAt,
      origin: "validator-budget",
    });
    await m.updateMission(mission.id, { status: "blocked" });

    const featureBefore = await m.getFeature(root.id);
    const stopsBefore = await h.layer().db.select().from(schema.project.missionLineageStops)
      .where(sql`${schema.project.missionLineageStops.rootFeatureId} = ${root.id}`);
    const cleared = await m.clearMissionBlockedStatus(mission.id, {
      actor: { type: "operator", id: "operator", source: "dashboard" },
      reason: "badge is stale",
    });

    expect(cleared.mission.status).toBe(await m.computeMissionStatus(mission.id));
    expect(cleared.blockers).toEqual([
      expect.objectContaining({ schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: root.id, reason: "budget-exhausted", source: "feature-row", missionId: mission.id, stoppedAt, origin: "validator-budget" }),
      expect.objectContaining({ schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: root.id, reason: "budget-exhausted", source: "lineage-stop", missionId: mission.id, stoppedAt, origin: "validator-budget" }),
    ]);
    expect(await m.getFeature(root.id)).toEqual(featureBefore);
    expect(await h.layer().db.select().from(schema.project.missionLineageStops)
      .where(sql`${schema.project.missionLineageStops.rootFeatureId} = ${root.id}`)).toEqual(stopsBefore);
    const resumeError = await m.resumeMission(mission.id).then(
      () => undefined,
      (error) => error as MissionResumeConflictError,
    );
    expect(resumeError).toBeInstanceOf(MissionResumeConflictError);
    expect(resumeError?.descriptors).toEqual([
      expect.objectContaining({ schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: root.id, source: "feature-row", reason: "budget-exhausted" }),
      expect.objectContaining({ schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: root.id, source: "lineage-stop", reason: "budget-exhausted", stoppedAt, origin: "validator-budget" }),
    ]);
    expect((resumeError as unknown as Record<string, unknown>).blockers).toBeUndefined();
  });

  it("records generated-feature deletion as a durable root stop and resumes only explicitly", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Operator stop" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const root = await m.addFeature(slice.id, { title: "F" });
    await m.transitionLoopState(root.id, "implementing");
    const run = await m.startValidatorRun(root.id, "scheduled");
    await m.completeValidatorRun(run.id, "failed", "repair");
    const fix = await m.createGeneratedFixFeature(root.id, run.id, [], "repair");
    await m.deleteFeature(fix.id);
    expect(await m.getFeature(root.id)).toMatchObject({ loopState: "blocked", implementationStopReason: "operator-intervention", implementationAttemptCount: 1 });
    const stops = await h.layer().db.select().from(schema.project.missionLineageStops)
      .where(sql`${schema.project.missionLineageStops.rootFeatureId} = ${root.id}`);
    expect(stops).toHaveLength(1);
    await m.updateMission(mission.id, { status: "blocked" });
    await expect(m.resumeMission(mission.id)).resolves.toMatchObject({ status: "active" });
    expect(await m.getFeature(root.id)).toMatchObject({ loopState: "needs_fix", implementationAttemptCount: 1, implementationStopReason: undefined });
  });

  it("allows startup recovery to move an interrupted validation back to implementing", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Interrupted validation" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });

    await m.transitionLoopState(feature.id, "implementing");
    const interruptedRun = await m.startValidatorRun(feature.id, "scheduled");
    expect((await m.getFeature(feature.id))?.loopState).toBe("validating");

    await expect(m.transitionLoopState(feature.id, "implementing")).resolves.toMatchObject({
      id: feature.id,
      loopState: "implementing",
      lastValidatorStatus: "error",
    });
    await expect(m.getValidatorRun(interruptedRun.id)).resolves.toMatchObject({
      status: "error",
      summary: "Interrupted validation was superseded by loop-state recovery",
    });
    expect((await m.listStaleRunningValidatorRuns(-1)).map((run) => run.id)).not.toContain(interruptedRun.id);
  });

  it("rejects an unknown persisted loop state with the normal transition error", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Legacy state" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Feature" });
    await h.layer().db
      .update(schema.project.missionFeatures)
      .set({ loopState: "legacy_state" as never })
      .where(sql`${schema.project.missionFeatures.id} = ${feature.id}`);

    await expect(m.transitionLoopState(feature.id, "implementing")).rejects.toThrow(
      "Invalid loop state transition from 'legacy_state' to 'implementing'. Allowed transitions from 'legacy_state': none",
    );
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

  /*
  FNXC:MissionTaskPrefix 2026-07-26-12:00:
  Per-mission taskPrefix round-trips on create/update and clears to NULL so triage re-inherits the project prefix (PR #1930 / #2347).
  */
  it("round-trips mission taskPrefix on create/update and clears to undefined", async () => {
    const m = missions();
    const mission = await m.createMission({ title: "Prefixed", taskPrefix: "ERR" });
    expect((await m.getMission(mission.id))?.taskPrefix).toBe("ERR");

    const updated = await m.updateMission(mission.id, { taskPrefix: "BUG" });
    expect(updated.taskPrefix).toBe("BUG");
    expect((await m.getMission(mission.id))?.taskPrefix).toBe("BUG");

    const cleared = await m.updateMission(mission.id, { taskPrefix: undefined });
    expect(cleared.taskPrefix).toBeUndefined();
    expect((await m.getMission(mission.id))?.taskPrefix).toBeUndefined();

    const raw = (await h.layer().db.execute(
      sql`SELECT task_prefix FROM project.missions WHERE id = ${mission.id}`,
    )) as unknown as Array<{ task_prefix: string | null }>;
    expect(raw[0]?.task_prefix).toBeNull();
  });

  it("mints triaged task ids with the mission's taskPrefix", async () => {
    const m = missions();
    await h.store().updateSettings({ taskPrefix: "FN" });
    const mission = await m.createMission({ title: "Mission", taskPrefix: "ERR" });
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "Ship prefix", acceptanceCriteria: "id uses ERR" });

    const triaged = await m.triageFeature(feature.id);
    expect(triaged.taskId).toBeTruthy();
    expect(triaged.taskId).toMatch(/^ERR-\d+$/);
  });


  describe("automatic status rollup ownership", () => {
    it("preserves blocked and archived missions through hierarchy churn", async () => {
      const m = missions();
      const createProtectedHierarchy = async (status: "blocked" | "archived") => {
        const mission = await m.createMission({ title: `Protected ${status}` });
        const milestone = await m.addMilestone(mission.id, { title: "MS" });
        const slice = await m.addSlice(milestone.id, { title: "SL" });
        await m.updateMission(mission.id, { status });
        return { mission, milestone, slice };
      };
      const renamed = await createProtectedHierarchy("blocked");
      const eventCount = (await m.getMissionEvents(renamed.mission.id)).events.length;
      await m.updateMilestone(renamed.milestone.id, { title: "renamed" });
      expect(await m.getMission(renamed.mission.id)).toMatchObject({ status: "blocked" });
      expect((await m.getMissionEvents(renamed.mission.id)).events).toHaveLength(eventCount);
      const sliced = await createProtectedHierarchy("blocked");
      await m.updateSlice(sliced.slice.id, { title: "edited" });
      await m.deleteSlice(sliced.slice.id);
      expect(await m.getMission(sliced.mission.id)).toMatchObject({ status: "blocked" });
      const deleted = await createProtectedHierarchy("blocked");
      await m.deleteMilestone(deleted.milestone.id);
      expect(await m.getMission(deleted.mission.id)).toMatchObject({ status: "blocked" });
      const archived = await createProtectedHierarchy("archived");
      await m.updateMilestone(archived.milestone.id, { title: "churn" });
      expect(await m.getMission(archived.mission.id)).toMatchObject({ status: "archived" });
    });

    /*
    FNXC:MissionStatusRollup 2026-08-11-04:41:
    The recompute transaction locks the mission before calculating its derived status. Hold that
    calculation while an explicit blocked write queues behind the row lock; releasing the rollup
    must leave the later operator write intact instead of replaying a stale derived status.
    */
    it("does not overwrite an explicit blocked mission queued during a rollup", async () => {
      const m = missions();
      const mission = await m.createMission({ title: "Concurrent protected mission" });
      const milestone = await m.addMilestone(mission.id, { title: "MS" });
      const originalCompute = (m as any).computeMissionStatusWithHandle.bind(m);
      let enteredCompute!: () => void;
      let releaseCompute!: () => void;
      const computeEntered = new Promise<void>((resolve) => { enteredCompute = resolve; });
      const computeRelease = new Promise<void>((resolve) => { releaseCompute = resolve; });
      (m as any).computeMissionStatusWithHandle = async (...args: unknown[]) => {
        enteredCompute();
        await computeRelease;
        return originalCompute(...args);
      };
      try {
        const rollup = m.updateMilestone(milestone.id, { title: "churn" });
        await computeEntered;
        const explicitBlock = m.updateMission(mission.id, { status: "blocked" });
        releaseCompute();
        await Promise.all([rollup, explicitBlock]);
      } finally {
        (m as any).computeMissionStatusWithHandle = originalCompute;
      }
      expect(await m.getMission(mission.id)).toMatchObject({ status: "blocked" });
    });

    it("does not overwrite an explicit blocked milestone queued during a rollup", async () => {
      const m = missions();
      const mission = await m.createMission({ title: "Concurrent protected milestone" });
      const milestone = await m.addMilestone(mission.id, { title: "MS" });
      const slice = await m.addSlice(milestone.id, { title: "SL" });
      const originalCompute = (m as any).computeMilestoneStatusWithHandle.bind(m);
      let enteredCompute!: () => void;
      let releaseCompute!: () => void;
      const computeEntered = new Promise<void>((resolve) => { enteredCompute = resolve; });
      const computeRelease = new Promise<void>((resolve) => { releaseCompute = resolve; });
      (m as any).computeMilestoneStatusWithHandle = async (...args: unknown[]) => {
        enteredCompute();
        await computeRelease;
        return originalCompute(...args);
      };
      try {
        const rollup = m.updateSlice(slice.id, { title: "churn" });
        await computeEntered;
        const explicitBlock = m.updateMilestone(milestone.id, { status: "blocked" });
        releaseCompute();
        await Promise.all([rollup, explicitBlock]);
      } finally {
        (m as any).computeMilestoneStatusWithHandle = originalCompute;
      }
      expect(await m.getMilestone(milestone.id)).toMatchObject({ status: "blocked" });
    });

    it("preserves blocked milestones during terminal-task reconcile", async () => {
      const m = missions();
      const mission = await m.createMission({ title: "Protected reconcile" });
      const milestone = await m.addMilestone(mission.id, { title: "MS" });
      const slice = await m.addSlice(milestone.id, { title: "SL" });
      const feature = await m.addFeature(slice.id, { title: "Delivered" });
      const task = await h.store().createTask({ description: "done", column: "done" });
      await m.updateMilestone(milestone.id, { status: "blocked" });
      const milestoneUpdated = vi.fn();
      m.on("milestone:updated", milestoneUpdated);
      await m.reconcileFeatureDoneWithTerminalTask(feature.id, task.id);
      expect(await m.getFeature(feature.id)).toMatchObject({ status: "done", taskId: task.id });
      expect(await m.getSlice(slice.id)).toMatchObject({ status: "complete" });
      expect(await m.getMilestone(milestone.id)).toMatchObject({ status: "blocked" });
      expect(milestoneUpdated).not.toHaveBeenCalled();
    });
  });

});
