import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "./store.js";
import { Database } from "./db.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-mission-integration-"));
}

function getPrivateDb(store: TaskStore): Database | null {
  return (store as unknown as { _db: Database | null })._db;
}

function assertHierarchyIntegrity(
  hierarchy: NonNullable<ReturnType<ReturnType<TaskStore["getMissionStore"]>["getMissionWithHierarchy"]>>,
) {
  expect(hierarchy.milestones.every((milestone, index) => milestone.orderIndex === index)).toBe(true);
  expect(new Set(hierarchy.milestones.map((milestone) => milestone.id)).size).toBe(hierarchy.milestones.length);

  for (const milestone of hierarchy.milestones) {
    expect(milestone.slices.every((slice, index) => slice.orderIndex === index)).toBe(true);
    expect(new Set(milestone.slices.map((slice) => slice.id)).size).toBe(milestone.slices.length);
    for (const slice of milestone.slices) {
      expect(slice.milestoneId).toBe(milestone.id);
      expect(new Set(slice.features.map((feature) => feature.id)).size).toBe(slice.features.length);
      for (const feature of slice.features) {
        expect(feature.sliceId).toBe(slice.id);
      }
    }
  }
}

/**
 * Creates a mission hierarchy large enough to exercise rollups, reorder logic,
 * and cascade deletions in integration scenarios.
 */
async function createHierarchy(store: TaskStore) {
  const missionStore = store.getMissionStore();
  const mission = missionStore.createMission({
    title: "Launch authentication",
    description: "Mission hierarchy integration test",
  });

  const milestones = Array.from({ length: 3 }, (_, milestoneIndex) => {
    const milestone = missionStore.addMilestone(mission.id, {
      title: `Milestone ${milestoneIndex + 1}`,
      description: `Phase ${milestoneIndex + 1}`,
    });

    const slices = Array.from({ length: 2 }, (_, sliceIndex) => {
      const slice = missionStore.addSlice(milestone.id, {
        title: `Slice ${milestoneIndex + 1}.${sliceIndex + 1}`,
        description: `Slice ${milestoneIndex + 1}.${sliceIndex + 1}`,
      });

      const features = Array.from({ length: 3 }, (_, featureIndex) =>
        missionStore.addFeature(slice.id, {
          title: `Feature ${milestoneIndex + 1}.${sliceIndex + 1}.${featureIndex + 1}`,
          description: "Feature description",
          acceptanceCriteria: "criterion",
        }),
      );

      return { ...slice, features };
    });

    return { ...milestone, slices };
  });

  return { missionStore, mission, milestones };
}

/**
 * MissionStore integration tests verify the missions hierarchy when it shares
 * the same SQLite database as TaskStore. These scenarios cover linking tasks
 * to features, rollup state transitions, hierarchy integrity after reorders and
 * deletions, foreign-key cleanup, and event emissions that other packages rely on.
 */
describe("MissionStore integration with TaskStore", () => {
  let rootDir: string;
  let taskStore: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));

    rootDir = makeTmpDir();
    taskStore = new TaskStore(rootDir);
    await taskStore.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates and retrieves a full hierarchy through the shared MissionStore", async () => {
    const { missionStore, mission } = await createHierarchy(taskStore);

    const fullMission = missionStore.getMissionWithHierarchy(mission.id);

    expect(fullMission).toBeDefined();
    expect(fullMission?.milestones).toHaveLength(3);
    expect(fullMission?.milestones.every((milestone) => milestone.slices.length === 2)).toBe(true);
    expect(
      fullMission?.milestones.every((milestone) =>
        milestone.slices.every((slice) => {
          const hierarchySlice = slice as typeof slice & { features: Array<{ id: string }> };
          return hierarchySlice.features.length === 3;
        }),
      ),
    ).toBe(true);
  });

  it("links features to real TaskStore tasks and updates sliceId without populating missionId", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);
    const feature = milestones[0].slices[0].features[0];

    const linkedTask = await taskStore.createTask({
      title: "Build login form",
      description: "Implement the login form task used for mission linking.",
      column: "todo",
    });

    // TaskStore persists tasks to disk first, so create a DB-backed snapshot
    // using a normal update path before MissionStore writes the linkage field.
    await taskStore.moveTask(linkedTask.id, "in-progress");

    const linkedFeature = missionStore.linkFeatureToTask(feature.id, linkedTask.id);
    const storedTask = await taskStore.getTask(linkedTask.id);
    const taskRow = getPrivateDb(taskStore)?.prepare(
      "SELECT missionId, sliceId FROM tasks WHERE id = ?",
    ).get(linkedTask.id) as { missionId: string | null; sliceId: string | null } | undefined;

    expect(linkedFeature.taskId).toBe(linkedTask.id);
    expect(linkedFeature.status).toBe("triaged");
    expect(storedTask.sliceId).toBe(milestones[0].slices[0].id);
    expect(taskRow?.sliceId).toBe(milestones[0].slices[0].id);
    expect(taskRow?.missionId).toBe(mission.id);

    const linkedHierarchy = missionStore.getMissionWithHierarchy(mission.id);
    expect(linkedHierarchy?.milestones[0].slices[0].features[0].taskId).toBe(linkedTask.id);
  });

  it("rolls up status from features to slices, milestones, and mission", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);
    const [firstMilestone] = milestones;
    const [firstSlice] = firstMilestone.slices;

    const linkedFeatures: { featureId: string; taskId: string }[] = [];
    for (const feature of firstSlice.features) {
      const task = await taskStore.createTask({
        title: feature.title,
        description: `Task for ${feature.title}`,
        column: "todo",
      });
      await taskStore.moveTask(task.id, "in-progress");
      missionStore.linkFeatureToTask(feature.id, task.id);
      linkedFeatures.push({ featureId: feature.id, taskId: task.id });
    }

    let updatedSlice = missionStore.getSlice(firstSlice.id);
    let updatedMilestone = missionStore.getMilestone(firstMilestone.id);
    let updatedMission = missionStore.getMission(mission.id);

    expect(updatedSlice?.status).toBe("active");
    expect(updatedMilestone?.status).toBe("active");
    expect(updatedMission?.status).toBe("active");

    for (const { featureId, taskId } of linkedFeatures) {
      await taskStore.moveTask(taskId, "in-review");
      await taskStore.moveTask(taskId, "done");
      missionStore.updateFeature(featureId, { taskId, status: "done" });
    }

    updatedSlice = missionStore.getSlice(firstSlice.id);
    updatedMilestone = missionStore.getMilestone(firstMilestone.id);
    updatedMission = missionStore.getMission(mission.id);

    expect(updatedSlice?.status).toBe("complete");
    expect(updatedMilestone?.status).toBe("active");
    expect(updatedMission?.status).toBe("active");
  });

  it("persists missionId and sliceId when linking a feature to a task", async () => {
    const missionStore = taskStore.getMissionStore();
    const mission = missionStore.createMission({ title: "Test Mission" });
    const milestone = missionStore.addMilestone(mission.id, { title: "Milestone 1" });
    const slice = missionStore.addSlice(milestone.id, { title: "Slice 1" });
    const feature = missionStore.addFeature(slice.id, { title: "Feature 1" });

    const task = await taskStore.createTask({
      description: "Implement feature",
      title: "Feature implementation",
      column: "todo",
    });

    missionStore.linkFeatureToTask(feature.id, task.id);

    const reloaded = await taskStore.getTask(task.id);
    expect(reloaded.missionId).toBe(mission.id);
    expect(reloaded.sliceId).toBe(slice.id);
  });

  it("clears missionId and sliceId when unlinking a feature from a task", async () => {
    const missionStore = taskStore.getMissionStore();
    const mission = missionStore.createMission({ title: "Test Mission" });
    const milestone = missionStore.addMilestone(mission.id, { title: "Milestone 1" });
    const slice = missionStore.addSlice(milestone.id, { title: "Slice 1" });
    const feature = missionStore.addFeature(slice.id, { title: "Feature 1" });

    const task = await taskStore.createTask({
      description: "Implement feature",
      title: "Feature implementation",
      column: "todo",
    });

    missionStore.linkFeatureToTask(feature.id, task.id);
    missionStore.unlinkFeatureFromTask(feature.id);

    const reloaded = await taskStore.getTask(task.id);
    expect(reloaded.missionId).toBeUndefined();
    expect(reloaded.sliceId).toBeUndefined();
  });

  it("cascades mission deletion across milestones, slices, and features", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);
    const milestoneIds = milestones.map((milestone) => milestone.id);
    const sliceIds = milestones.flatMap((milestone) => milestone.slices.map((slice) => slice.id));
    const featureIds = milestones.flatMap((milestone) =>
      milestone.slices.flatMap((slice) => slice.features.map((feature) => feature.id)),
    );

    missionStore.deleteMission(mission.id);

    expect(missionStore.getMission(mission.id)).toBeUndefined();
    expect(milestoneIds.every((id) => missionStore.getMilestone(id) === undefined)).toBe(true);
    expect(sliceIds.every((id) => missionStore.getSlice(id) === undefined)).toBe(true);
    expect(featureIds.every((id) => missionStore.getFeature(id) === undefined)).toBe(true);
  });

  it("recomputes order indexes after deleting a middle milestone and preserves child integrity after reorder", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);
    const [firstMilestone, middleMilestone, lastMilestone] = milestones;

    missionStore.deleteMilestone(middleMilestone.id);

    const afterDelete = missionStore.listMilestones(mission.id);
    expect(afterDelete.map((milestone) => milestone.id)).toEqual([firstMilestone.id, lastMilestone.id]);
    missionStore.reorderMilestones(mission.id, [firstMilestone.id, lastMilestone.id]);

    const afterRecompute = missionStore.listMilestones(mission.id);
    expect(afterRecompute.map((milestone) => milestone.orderIndex)).toEqual([0, 1]);
    expect(missionStore.getSlice(middleMilestone.slices[0].id)).toBeUndefined();
    expect(missionStore.getFeature(middleMilestone.slices[0].features[0].id)).toBeUndefined();

    missionStore.reorderMilestones(mission.id, [lastMilestone.id, firstMilestone.id]);
    const reordered = missionStore.getMissionWithHierarchy(mission.id);

    expect(reordered?.milestones.map((milestone) => milestone.id)).toEqual([
      lastMilestone.id,
      firstMilestone.id,
    ]);
    expect(reordered?.milestones[0].slices.map((slice) => slice.id)).toEqual(
      lastMilestone.slices.map((slice) => slice.id),
    );
    expect(reordered?.milestones[1].slices[0].features.map((feature) => feature.id)).toEqual(
      firstMilestone.slices[0].features.map((feature) => feature.id),
    );
    expect(reordered).toBeDefined();
    assertHierarchyIntegrity(reordered!);
  });

  it("emits mission lifecycle events for creation, linking, and slice activation in order", async () => {
    const missionStore = taskStore.getMissionStore();
    const events: string[] = [];

    missionStore.on("mission:created", () => events.push("mission:created"));
    missionStore.on("feature:linked", () => events.push("feature:linked"));
    missionStore.on("slice:activated", () => events.push("slice:activated"));

    const mission = missionStore.createMission({ title: "Event mission" });
    const milestone = missionStore.addMilestone(mission.id, { title: "Event milestone" });
    const slice = missionStore.addSlice(milestone.id, { title: "Event slice" });
    const feature = missionStore.addFeature(slice.id, { title: "Event feature" });
    const task = await taskStore.createTask({
      title: "Event task",
      description: "Task for event assertions",
      column: "todo",
    });
    await taskStore.moveTask(task.id, "in-progress");

    missionStore.linkFeatureToTask(feature.id, task.id);
    await missionStore.activateSlice(slice.id);

    expect(events).toEqual(["mission:created", "feature:linked", "slice:activated"]);
  });

  it("uses the same Database instance for TaskStore and MissionStore", () => {
    const missionStore = taskStore.getMissionStore();
    const db = getPrivateDb(taskStore);
    const missionStoreDb = (missionStore as unknown as { db: Database }).db;

    expect(db).toBeDefined();
    expect(missionStoreDb).toBe(db);
  });

  it("keeps hierarchy retrievable after repeated deterministic reorder operations", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);

    missionStore.reorderMilestones(mission.id, [milestones[2].id, milestones[0].id, milestones[1].id]);
    missionStore.reorderMilestones(mission.id, [milestones[1].id, milestones[2].id, milestones[0].id]);

    for (const milestone of missionStore.listMilestones(mission.id)) {
      const slices = missionStore.listSlices(milestone.id);
      missionStore.reorderSlices(
        milestone.id,
        slices
          .map((slice) => slice.id)
          .reverse(),
      );
    }

    const hierarchy = missionStore.getMissionWithHierarchy(mission.id);

    expect(hierarchy?.milestones).toHaveLength(3);
    expect(hierarchy).toBeDefined();
    assertHierarchyIntegrity(hierarchy!);
  });

  it("keeps hierarchy valid under overlapping reorder and lookup operations", async () => {
    const { missionStore, mission, milestones } = await createHierarchy(taskStore);

    await Promise.all([
      Promise.resolve().then(() =>
        missionStore.reorderMilestones(mission.id, [milestones[1].id, milestones[2].id, milestones[0].id]),
      ),
      Promise.resolve().then(() => {
        const slices = missionStore.listSlices(milestones[0].id);
        missionStore.reorderSlices(milestones[0].id, slices.map((slice) => slice.id).reverse());
      }),
      Promise.resolve().then(() => missionStore.getMissionWithHierarchy(mission.id)),
      Promise.resolve().then(() => missionStore.listMissions()),
    ]);

    const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
    expect(hierarchy).toBeDefined();
    assertHierarchyIntegrity(hierarchy!);
  });

  it("keeps all descendants retrievable after bulk feature completion updates", async () => {
    const { missionStore, mission } = await createHierarchy(taskStore);
    const hierarchy = missionStore.getMissionWithHierarchy(mission.id)!;

    for (const milestone of hierarchy.milestones) {
      for (const slice of milestone.slices) {
        for (const feature of slice.features) {
          missionStore.updateFeature(feature.id, { status: "done" });
        }
      }
    }

    const refreshed = missionStore.getMissionWithHierarchy(mission.id)!;
    expect(refreshed.milestones).toHaveLength(3);
    expect(
      refreshed.milestones.every((milestone) =>
        milestone.slices.every((slice) => {
          const hierarchySlice = slice as typeof slice & { features: Array<{ status: string }> };
          return hierarchySlice.features.every((feature) => feature.status === "done");
        }),
      ),
    ).toBe(true);
  });

  it("clears mission feature task links when a linked task is deleted", async () => {
    const { missionStore, milestones } = await createHierarchy(taskStore);
    const feature = milestones[0].slices[0].features[0];
    const task = await taskStore.createTask({
      title: "Delete linked task",
      description: "Task used to verify foreign key cleanup.",
      column: "todo",
    });
    await taskStore.moveTask(task.id, "in-progress");
    missionStore.linkFeatureToTask(feature.id, task.id);

    await taskStore.deleteTask(task.id);

    const refreshed = missionStore.getFeature(feature.id);
    expect(refreshed?.taskId).toBeUndefined();
  });

  // ── Parity: Restart Fidelity Tests ──────────────────────────────────

  describe("Parity: Restart Fidelity", () => {
    it("persists mission status across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({
        title: "Restart Test Mission",
        description: "Testing persistence",
      });

      // Verify initial status is planning
      expect(mission.status).toBe("planning");

      // Update to active
      missionStore.updateMission(mission.id, { status: "active", autopilotEnabled: true });

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getMission(mission.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.title).toBe("Restart Test Mission");
      expect(retrieved!.status).toBe("active");
      expect(retrieved!.autopilotEnabled).toBe(true);
    });

    it("persists autopilot state across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({
        title: "Autopilot State Test",
        autopilotEnabled: true,
      });

      // Update autopilot state
      missionStore.updateMission(mission.id, { autopilotState: "watching" });

      // Update to a different state
      missionStore.updateMission(mission.id, { autopilotState: "inactive" });

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getMission(mission.id);
      expect(retrieved!.autopilotState).toBe("inactive");
    });

    it("persists feature-to-task linkage across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({ title: "Linkage Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      const task = await taskStore.createTask({
        title: "Linked Task",
        description: "Task linked to feature",
        column: "todo",
      });

      missionStore.linkFeatureToTask(feature.id, task.id);

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getFeature(feature.id);
      expect(retrieved!.taskId).toBe(task.id);
      expect(retrieved!.status).toBe("triaged");
    });

    it("persists feature status across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({ title: "Status Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      // Transition through states
      missionStore.updateFeatureStatus(feature.id, "triaged");
      missionStore.updateFeatureStatus(feature.id, "in-progress");
      missionStore.updateFeatureStatus(feature.id, "blocked");

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const hierarchy = missionStore2.getMissionWithHierarchy(mission.id);
      expect(hierarchy!.milestones[0].slices[0].features[0].status).toBe("blocked");
    });

    it("persists mission events across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({ title: "Events Test" });

      // Log multiple events
      vi.advanceTimersByTime(1);
      missionStore.logMissionEvent(mission.id, "mission_started", "Mission started");
      vi.advanceTimersByTime(1);
      missionStore.logMissionEvent(mission.id, "slice_activated", "Slice activated");
      vi.advanceTimersByTime(1);
      missionStore.logMissionEvent(mission.id, "feature_triaged", "Feature triaged");

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const events = missionStore2.getMissionEvents(mission.id);
      expect(events.events.length).toBe(3);
      // Events are ordered by timestamp DESC, so most recent first
      expect(events.events[0].eventType).toBe("feature_triaged"); // Most recent
      expect(events.events[1].eventType).toBe("slice_activated");
      expect(events.events[2].eventType).toBe("mission_started"); // Oldest
    });

    it("persists hierarchy ordering across store restart", async () => {
      const { missionStore, mission, milestones } = await createHierarchy(taskStore);

      // Reorder milestones
      missionStore.reorderMilestones(mission.id, [
        milestones[2].id,
        milestones[0].id,
        milestones[1].id,
      ]);

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const hierarchy = missionStore2.getMissionWithHierarchy(mission.id);
      expect(hierarchy!.milestones[0].id).toBe(milestones[2].id);
      expect(hierarchy!.milestones[1].id).toBe(milestones[0].id);
      expect(hierarchy!.milestones[2].id).toBe(milestones[1].id);
    });

    it("persists planning notes and verification across store restart", async () => {
      const missionStore = taskStore.getMissionStore();
      const mission = missionStore.createMission({ title: "Planning Context Test" });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "M1",
        planningNotes: "Use JWT authentication",
        verification: "Users can log in",
      });
      const slice = missionStore.addSlice(milestone.id, {
        title: "S1",
        planningNotes: "Build login form component",
        verification: "Form validates input",
      });

      // Restart store
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrievedMilestone = missionStore2.getMilestone(milestone.id);
      expect(retrievedMilestone!.planningNotes).toBe("Use JWT authentication");
      expect(retrievedMilestone!.verification).toBe("Users can log in");

      const retrievedSlice = missionStore2.getSlice(slice.id);
      expect(retrievedSlice!.planningNotes).toBe("Build login form component");
      expect(retrievedSlice!.verification).toBe("Form validates input");
    });
  });
});
