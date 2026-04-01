import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MissionStore } from "./mission-store.js";
import { Database } from "./db.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-mission-test-"));
}

/** Helper to create a task in the database for foreign key validation */
function createTaskInDb(
  database: Database,
  taskId: string,
  description = "Test task",
): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`
  ).run(taskId, description, "triage", now, now);
}

describe("MissionStore", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;
  let store: MissionStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".kb");
    db = new Database(kbDir);
    db.init();
    store = new MissionStore(kbDir, db);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Mission CRUD Tests ────────────────────────────────────────────────

  describe("Mission CRUD", () => {
    it("creates a mission with correct defaults", () => {
      const mission = store.createMission({
        title: "Test Mission",
        description: "A test mission",
      });

      expect(mission.id).toMatch(/^M-/);
      expect(mission.title).toBe("Test Mission");
      expect(mission.description).toBe("A test mission");
      expect(mission.status).toBe("planning");
      expect(mission.interviewState).toBe("not_started");
      expect(mission.createdAt).toBeTruthy();
      expect(mission.updatedAt).toBeTruthy();
    });

    it("gets a mission by id", () => {
      const created = store.createMission({ title: "Get Test" });
      const retrieved = store.getMission(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.title).toBe("Get Test");
    });

    it("returns undefined for non-existent mission", () => {
      const result = store.getMission("M-NONEXISTENT");
      expect(result).toBeUndefined();
    });

    it("lists missions ordered by createdAt desc", async () => {
      const m1 = store.createMission({ title: "Mission 1" });
      await new Promise((r) => setTimeout(r, 10)); // Ensure different timestamps
      const m2 = store.createMission({ title: "Mission 2" });
      await new Promise((r) => setTimeout(r, 10));
      const m3 = store.createMission({ title: "Mission 3" });

      const list = store.listMissions();

      expect(list).toHaveLength(3);
      expect(list[0].id).toBe(m3.id); // Newest first
      expect(list[1].id).toBe(m2.id);
      expect(list[2].id).toBe(m1.id);
    });

    it("updates a mission", async () => {
      const mission = store.createMission({ title: "Original" });
      await new Promise((r) => setTimeout(r, 5)); // Ensure timestamp difference
      const updated = store.updateMission(mission.id, {
        title: "Updated",
        status: "active",
      });

      expect(updated.title).toBe("Updated");
      expect(updated.status).toBe("active");
      expect(updated.id).toBe(mission.id);
      expect(updated.createdAt).toBe(mission.createdAt);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(mission.updatedAt).getTime()
      );
    });

    it("throws when updating non-existent mission", () => {
      expect(() => {
        store.updateMission("M-NONEXISTENT", { title: "Test" });
      }).toThrow("Mission M-NONEXISTENT not found");
    });

    it("deletes a mission", () => {
      const mission = store.createMission({ title: "To Delete" });
      store.deleteMission(mission.id);

      const retrieved = store.getMission(mission.id);
      expect(retrieved).toBeUndefined();
    });

    it("throws when deleting non-existent mission", () => {
      expect(() => {
        store.deleteMission("M-NONEXISTENT");
      }).toThrow("Mission M-NONEXISTENT not found");
    });

    it("updates interview state", () => {
      const mission = store.createMission({ title: "Interview Test" });
      const updated = store.updateMissionInterviewState(mission.id, "in_progress");

      expect(updated.interviewState).toBe("in_progress");
    });

    it("emits mission:created event", () => {
      const handler = vi.fn();
      store.on("mission:created", handler);

      const mission = store.createMission({ title: "Event Test" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(mission);
    });

    it("emits mission:updated event", () => {
      const handler = vi.fn();
      store.on("mission:updated", handler);

      const mission = store.createMission({ title: "Event Test" });
      const updated = store.updateMission(mission.id, { title: "Updated" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(updated);
    });

    it("emits mission:deleted event with id", () => {
      const handler = vi.fn();
      store.on("mission:deleted", handler);

      const mission = store.createMission({ title: "Event Test" });
      store.deleteMission(mission.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(mission.id);
    });
  });

  // ── Milestone CRUD Tests ──────────────────────────────────────────────

  describe("Milestone CRUD", () => {
    it("adds a milestone to a mission", () => {
      const mission = store.createMission({ title: "Parent Mission" });
      const milestone = store.addMilestone(mission.id, {
        title: "Test Milestone",
        description: "A test milestone",
      });

      expect(milestone.id).toMatch(/^MS-/);
      expect(milestone.missionId).toBe(mission.id);
      expect(milestone.title).toBe("Test Milestone");
      expect(milestone.description).toBe("A test milestone");
      expect(milestone.status).toBe("planning");
      expect(milestone.orderIndex).toBe(0);
      expect(milestone.dependencies).toEqual([]);
    });

    it("throws when adding milestone to non-existent mission", () => {
      expect(() => {
        store.addMilestone("M-NONEXISTENT", { title: "Test" });
      }).toThrow("Mission M-NONEXISTENT not found");
    });

    it("auto-increments orderIndex for multiple milestones", () => {
      const mission = store.createMission({ title: "Parent" });
      const m1 = store.addMilestone(mission.id, { title: "First" });
      const m2 = store.addMilestone(mission.id, { title: "Second" });
      const m3 = store.addMilestone(mission.id, { title: "Third" });

      expect(m1.orderIndex).toBe(0);
      expect(m2.orderIndex).toBe(1);
      expect(m3.orderIndex).toBe(2);
    });

    it("gets a milestone by id", () => {
      const mission = store.createMission({ title: "Parent" });
      const created = store.addMilestone(mission.id, { title: "Get Test" });
      const retrieved = store.getMilestone(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    it("returns undefined for non-existent milestone", () => {
      const result = store.getMilestone("MS-NONEXISTENT");
      expect(result).toBeUndefined();
    });

    it("lists milestones ordered by orderIndex", () => {
      const mission = store.createMission({ title: "Parent" });
      const m2 = store.addMilestone(mission.id, { title: "Second" });
      const m1 = store.addMilestone(mission.id, { title: "First" });

      // Reorder to ensure orderIndex differs from creation order
      store.reorderMilestones(mission.id, [m2.id, m1.id]);

      const list = store.listMilestones(mission.id);
      expect(list[0].id).toBe(m2.id);
      expect(list[1].id).toBe(m1.id);
    });

    it("updates a milestone", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Original" });
      const updated = store.updateMilestone(milestone.id, {
        title: "Updated",
        status: "active",
      });

      expect(updated.title).toBe("Updated");
      expect(updated.status).toBe("active");
    });

    it("deletes a milestone", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "To Delete" });
      store.deleteMilestone(milestone.id);

      const retrieved = store.getMilestone(milestone.id);
      expect(retrieved).toBeUndefined();
    });

    it("reorders milestones", () => {
      const mission = store.createMission({ title: "Parent" });
      const m1 = store.addMilestone(mission.id, { title: "First" });
      const m2 = store.addMilestone(mission.id, { title: "Second" });
      const m3 = store.addMilestone(mission.id, { title: "Third" });

      store.reorderMilestones(mission.id, [m3.id, m1.id, m2.id]);

      const list = store.listMilestones(mission.id);
      expect(list[0].id).toBe(m3.id);
      expect(list[1].id).toBe(m1.id);
      expect(list[2].id).toBe(m2.id);
      expect(list[0].orderIndex).toBe(0);
      expect(list[1].orderIndex).toBe(1);
      expect(list[2].orderIndex).toBe(2);
    });

    it("throws when reordering with invalid milestone id", () => {
      const mission = store.createMission({ title: "Parent" });
      store.addMilestone(mission.id, { title: "Valid" });

      expect(() => {
        store.reorderMilestones(mission.id, ["MS-NONEXISTENT"]);
      }).toThrow("Milestone MS-NONEXISTENT not found");
    });

    it("emits milestone events", () => {
      const createdHandler = vi.fn();
      const deletedHandler = vi.fn();
      store.on("milestone:created", createdHandler);
      store.on("milestone:deleted", deletedHandler);

      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Test" });
      store.deleteMilestone(milestone.id);

      expect(createdHandler).toHaveBeenCalledTimes(1);
      expect(createdHandler).toHaveBeenCalledWith(milestone);
      expect(deletedHandler).toHaveBeenCalledTimes(1);
      expect(deletedHandler).toHaveBeenCalledWith(milestone.id);
    });

    it("accepts dependencies array", () => {
      const mission = store.createMission({ title: "Parent" });
      const dep1 = store.addMilestone(mission.id, { title: "Dep 1" });
      const milestone = store.addMilestone(mission.id, {
        title: "Dependent",
        dependencies: [dep1.id],
      });

      expect(milestone.dependencies).toEqual([dep1.id]);
    });
  });

  // ── Slice CRUD Tests ──────────────────────────────────────────────────

  describe("Slice CRUD", () => {
    it("adds a slice to a milestone", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, {
        title: "Test Slice",
        description: "A test slice",
      });

      expect(slice.id).toMatch(/^SL-/);
      expect(slice.milestoneId).toBe(milestone.id);
      expect(slice.title).toBe("Test Slice");
      expect(slice.status).toBe("pending");
      expect(slice.orderIndex).toBe(0);
    });

    it("throws when adding slice to non-existent milestone", () => {
      expect(() => {
        store.addSlice("MS-NONEXISTENT", { title: "Test" });
      }).toThrow("Milestone MS-NONEXISTENT not found");
    });

    it("auto-increments orderIndex for slices", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });

      const s1 = store.addSlice(milestone.id, { title: "First" });
      const s2 = store.addSlice(milestone.id, { title: "Second" });

      expect(s1.orderIndex).toBe(0);
      expect(s2.orderIndex).toBe(1);
    });

    it("gets a slice by id", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const created = store.addSlice(milestone.id, { title: "Get Test" });
      const retrieved = store.getSlice(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    it("lists slices ordered by orderIndex", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const s1 = store.addSlice(milestone.id, { title: "First" });
      const s2 = store.addSlice(milestone.id, { title: "Second" });

      // Reorder
      store.reorderSlices(milestone.id, [s2.id, s1.id]);

      const list = store.listSlices(milestone.id);
      expect(list[0].id).toBe(s2.id);
      expect(list[1].id).toBe(s1.id);
    });

    it("updates a slice", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Original" });
      const updated = store.updateSlice(slice.id, { title: "Updated" });

      expect(updated.title).toBe("Updated");
    });

    it("deletes a slice", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "To Delete" });
      store.deleteSlice(slice.id);

      const retrieved = store.getSlice(slice.id);
      expect(retrieved).toBeUndefined();
    });

    it("activates a slice", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "To Activate" });

      const activated = store.activateSlice(slice.id);

      expect(activated.status).toBe("active");
      expect(activated.activatedAt).toBeTruthy();
    });

    it("emits slice:activated event", () => {
      const handler = vi.fn();
      store.on("slice:activated", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Test" });
      const activated = store.activateSlice(slice.id);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(activated);
    });

    it("emits slice:deleted event with id", () => {
      const handler = vi.fn();
      store.on("slice:deleted", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Test" });
      store.deleteSlice(slice.id);

      expect(handler).toHaveBeenCalledWith(slice.id);
    });
  });

  // ── Feature CRUD Tests ────────────────────────────────────────────────

  describe("Feature CRUD", () => {
    it("adds a feature to a slice", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, {
        title: "Test Feature",
        description: "A test feature",
        acceptanceCriteria: "Criteria here",
      });

      expect(feature.id).toMatch(/^F-/);
      expect(feature.sliceId).toBe(slice.id);
      expect(feature.title).toBe("Test Feature");
      expect(feature.status).toBe("defined");
      expect(feature.taskId).toBeUndefined();
    });

    it("throws when adding feature to non-existent slice", () => {
      expect(() => {
        store.addFeature("SL-NONEXISTENT", { title: "Test" });
      }).toThrow("Slice SL-NONEXISTENT not found");
    });

    it("gets a feature by id", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const created = store.addFeature(slice.id, { title: "Get Test" });
      const retrieved = store.getFeature(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    it("lists features for a slice", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const f1 = store.addFeature(slice.id, { title: "Feature 1" });
      const f2 = store.addFeature(slice.id, { title: "Feature 2" });

      const list = store.listFeatures(slice.id);

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(f1.id);
      expect(list[1].id).toBe(f2.id);
    });

    it("updates a feature", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Original" });
      const updated = store.updateFeature(feature.id, { title: "Updated" });

      expect(updated.title).toBe("Updated");
    });

    it("deletes a feature", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "To Delete" });
      store.deleteFeature(feature.id);

      const retrieved = store.getFeature(feature.id);
      expect(retrieved).toBeUndefined();
    });

    it("links a feature to a task", () => {
      createTaskInDb(db, "KB-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Linkable" });

      const linked = store.linkFeatureToTask(feature.id, "KB-001");

      expect(linked.taskId).toBe("KB-001");
      expect(linked.status).toBe("triaged");
    });

    it("emits feature:linked event", () => {
      createTaskInDb(db, "KB-001");

      const handler = vi.fn();
      store.on("feature:linked", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Test" });
      const linked = store.linkFeatureToTask(feature.id, "KB-001");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ feature: linked, taskId: "KB-001" });
    });

    it("unlinks a feature from a task", () => {
      createTaskInDb(db, "KB-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Linkable" });
      store.linkFeatureToTask(feature.id, "KB-001");

      const unlinked = store.unlinkFeatureFromTask(feature.id);

      expect(unlinked.taskId).toBeUndefined();
      expect(unlinked.status).toBe("defined");
    });

    it("finds feature by task id", () => {
      createTaskInDb(db, "KB-999");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Findable" });
      store.linkFeatureToTask(feature.id, "KB-999");

      const found = store.getFeatureByTaskId("KB-999");

      expect(found).toBeDefined();
      expect(found!.id).toBe(feature.id);
    });

    it("returns undefined when no feature linked to task", () => {
      const result = store.getFeatureByTaskId("KB-NONEXISTENT");
      expect(result).toBeUndefined();
    });

    it("emits feature:deleted event with id", () => {
      const handler = vi.fn();
      store.on("feature:deleted", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Test" });
      store.deleteFeature(feature.id);

      expect(handler).toHaveBeenCalledWith(feature.id);
    });
  });

  // ── Cascade Delete Tests ───────────────────────────────────────────────

  describe("Cascade Deletes", () => {
    it("deletes mission → milestones → slices → features", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Child" });
      const slice = store.addSlice(milestone.id, { title: "Grandchild" });
      const feature = store.addFeature(slice.id, { title: "Great-grandchild" });

      store.deleteMission(mission.id);

      expect(store.getMission(mission.id)).toBeUndefined();
      expect(store.getMilestone(milestone.id)).toBeUndefined();
      expect(store.getSlice(slice.id)).toBeUndefined();
      expect(store.getFeature(feature.id)).toBeUndefined();
    });

    it("deletes milestone → slices → features", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Child" });
      const slice = store.addSlice(milestone.id, { title: "Grandchild" });
      const feature = store.addFeature(slice.id, { title: "Great-grandchild" });

      store.deleteMilestone(milestone.id);

      // Mission should still exist
      expect(store.getMission(mission.id)).toBeDefined();
      // But everything below should be gone
      expect(store.getMilestone(milestone.id)).toBeUndefined();
      expect(store.getSlice(slice.id)).toBeUndefined();
      expect(store.getFeature(feature.id)).toBeUndefined();
    });

    it("deletes slice → features", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      store.deleteSlice(slice.id);

      // Mission and milestone should still exist
      expect(store.getMission(mission.id)).toBeDefined();
      expect(store.getMilestone(milestone.id)).toBeDefined();
      // But slice and feature should be gone
      expect(store.getSlice(slice.id)).toBeUndefined();
      expect(store.getFeature(feature.id)).toBeUndefined();
    });
  });

  // ── Status Rollup Tests ───────────────────────────────────────────────

  describe("Status Rollup", () => {
    describe("computeSliceStatus", () => {
      it("returns pending when no features", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Empty Slice" });

        const status = store.computeSliceStatus(slice.id);
        expect(status).toBe("pending");
      });

      it("returns complete when all features done", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Complete Slice" });
        const f1 = store.addFeature(slice.id, { title: "F1" });
        const f2 = store.addFeature(slice.id, { title: "F2" });

        store.updateFeature(f1.id, { status: "done" });
        store.updateFeature(f2.id, { status: "done" });

        const status = store.computeSliceStatus(slice.id);
        expect(status).toBe("complete");
      });

      it("returns active when any feature has task linked", () => {
        createTaskInDb(db, "KB-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Active Slice" });
        const feature = store.addFeature(slice.id, { title: "Linked" });

        store.linkFeatureToTask(feature.id, "KB-001");

        const status = store.computeSliceStatus(slice.id);
        expect(status).toBe("active");
      });
    });

    describe("computeMilestoneStatus", () => {
      it("returns planning when no slices", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Empty Milestone" });

        const status = store.computeMilestoneStatus(milestone.id);
        expect(status).toBe("planning");
      });

      it("returns complete when all slices complete", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Complete Milestone" });
        const s1 = store.addSlice(milestone.id, { title: "S1" });
        const s2 = store.addSlice(milestone.id, { title: "S2" });

        // Make all features done to trigger slice completion
        const f1 = store.addFeature(s1.id, { title: "F1" });
        const f2 = store.addFeature(s2.id, { title: "F2" });
        store.updateFeature(f1.id, { status: "done" });
        store.updateFeature(f2.id, { status: "done" });

        // Force recompute
        store["recomputeSliceStatus"](s1.id);
        store["recomputeSliceStatus"](s2.id);

        const status = store.computeMilestoneStatus(milestone.id);
        expect(status).toBe("complete");
      });

      it("returns active when any slice is active", () => {
        createTaskInDb(db, "KB-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Active Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Active Slice" });
        const feature = store.addFeature(slice.id, { title: "Linked" });

        store.linkFeatureToTask(feature.id, "KB-001");

        const status = store.computeMilestoneStatus(milestone.id);
        expect(status).toBe("active");
      });
    });

    describe("computeMissionStatus", () => {
      it("returns planning when no milestones", () => {
        const mission = store.createMission({ title: "Empty Mission" });

        const status = store.computeMissionStatus(mission.id);
        expect(status).toBe("planning");
      });

      it("returns complete when all milestones complete", () => {
        const mission = store.createMission({ title: "Complete Mission" });
        const m1 = store.addMilestone(mission.id, { title: "M1" });
        const m2 = store.addMilestone(mission.id, { title: "M2" });

        // Complete both milestones
        store.updateMilestone(m1.id, { status: "complete" });
        store.updateMilestone(m2.id, { status: "complete" });

        const status = store.computeMissionStatus(mission.id);
        expect(status).toBe("complete");
      });

      it("returns active when any milestone is active", () => {
        const mission = store.createMission({ title: "Active Mission" });
        const m1 = store.addMilestone(mission.id, { title: "Active M" });
        const m2 = store.addMilestone(mission.id, { title: "Planning M" });

        store.updateMilestone(m1.id, { status: "active" });

        const status = store.computeMissionStatus(mission.id);
        expect(status).toBe("active");
      });
    });
  });

  // ── Mission With Hierarchy Tests ──────────────────────────────────────

  describe("getMissionWithHierarchy", () => {
    it("returns undefined for non-existent mission", () => {
      const result = store.getMissionWithHierarchy("M-NONEXISTENT");
      expect(result).toBeUndefined();
    });

    it("returns mission with full hierarchy", () => {
      const mission = store.createMission({
        title: "Hierarchy Test",
        description: "Testing full tree loading",
      });
      const m1 = store.addMilestone(mission.id, { title: "Milestone 1" });
      const m2 = store.addMilestone(mission.id, { title: "Milestone 2" });
      const s1 = store.addSlice(m1.id, { title: "Slice 1" });
      const s2 = store.addSlice(m1.id, { title: "Slice 2" });
      const f1 = store.addFeature(s1.id, { title: "Feature 1" });
      const f2 = store.addFeature(s1.id, { title: "Feature 2" });

      const withHierarchy = store.getMissionWithHierarchy(mission.id)!;

      expect(withHierarchy.id).toBe(mission.id);
      expect(withHierarchy.title).toBe("Hierarchy Test");
      expect(withHierarchy.milestones).toHaveLength(2);

      const m1Data = withHierarchy.milestones.find((m) => m.id === m1.id)!;
      expect(m1Data.slices).toHaveLength(2);

      const s1Data = m1Data.slices.find((s) => s.id === s1.id)! as import("./mission-types.js").SliceWithFeatures;
      expect(s1Data.features).toHaveLength(2);
      expect(s1Data.features.find((f: import("./mission-types.js").MissionFeature) => f.id === f1.id)).toBeDefined();
      expect(s1Data.features.find((f: import("./mission-types.js").MissionFeature) => f.id === f2.id)).toBeDefined();
    });
  });

  // ── Transaction Tests ────────────────────────────────────────────────

  describe("Transaction Handling", () => {
    it("rolls back reorder on error", () => {
      const mission = store.createMission({ title: "Parent" });
      const m1 = store.addMilestone(mission.id, { title: "M1" });
      const originalOrder = m1.orderIndex;

      expect(() => {
        store.reorderMilestones(mission.id, [m1.id, "MS-NONEXISTENT"]);
      }).toThrow();

      // m1's order should be unchanged due to rollback
      const retrieved = store.getMilestone(m1.id);
      expect(retrieved!.orderIndex).toBe(originalOrder);
    });

    it("rolls back slice reorder on error", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const s1 = store.addSlice(milestone.id, { title: "S1" });
      const originalOrder = s1.orderIndex;

      expect(() => {
        store.reorderSlices(milestone.id, [s1.id, "SL-NONEXISTENT"]);
      }).toThrow();

      const retrieved = store.getSlice(s1.id);
      expect(retrieved!.orderIndex).toBe(originalOrder);
    });
  });

  // ── Event Emission Tests ──────────────────────────────────────────────

  describe("Event Emissions", () => {
    it("emits all mission lifecycle events", () => {
      const created = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();

      store.on("mission:created", created);
      store.on("mission:updated", updated);
      store.on("mission:deleted", deleted);

      const mission = store.createMission({ title: "Test" });
      store.updateMission(mission.id, { title: "Updated" });
      store.deleteMission(mission.id);

      expect(created).toHaveBeenCalledTimes(1);
      expect(updated).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("emits all milestone lifecycle events", () => {
      const created = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();

      store.on("milestone:created", created);
      store.on("milestone:updated", updated);
      store.on("milestone:deleted", deleted);

      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Test" });
      store.updateMilestone(milestone.id, { title: "Updated" });
      store.deleteMilestone(milestone.id);

      expect(created).toHaveBeenCalledTimes(1);
      expect(updated).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("emits all slice lifecycle events", () => {
      const created = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();
      const activated = vi.fn();

      store.on("slice:created", created);
      store.on("slice:updated", updated);
      store.on("slice:deleted", deleted);
      store.on("slice:activated", activated);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Test" });
      store.activateSlice(slice.id);
      store.deleteSlice(slice.id);

      expect(created).toHaveBeenCalledTimes(1);
      expect(updated).toHaveBeenCalledTimes(1); // From activateSlice
      expect(activated).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("emits all feature lifecycle events", () => {
      createTaskInDb(db, "KB-001");

      const created = vi.fn();
      const updated = vi.fn();
      const deleted = vi.fn();
      const linked = vi.fn();

      store.on("feature:created", created);
      store.on("feature:updated", updated);
      store.on("feature:deleted", deleted);
      store.on("feature:linked", linked);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Test" });
      store.linkFeatureToTask(feature.id, "KB-001");
      store.deleteFeature(feature.id);

      expect(created).toHaveBeenCalledTimes(1);
      // Updated is called twice: once by linkFeatureToTask, once by delete triggering recompute
      expect(updated).toHaveBeenCalled();
      expect(linked).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("includes correct data in event payloads", () => {
      createTaskInDb(db, "KB-123");

      const createdHandler = vi.fn();
      const linkedHandler = vi.fn();

      store.on("feature:created", createdHandler);
      store.on("feature:linked", linkedHandler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Test" });

      expect(createdHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          id: feature.id,
          title: "Test",
          status: "defined",
        })
      );

      store.linkFeatureToTask(feature.id, "KB-123");

      expect(linkedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: expect.objectContaining({ id: feature.id }),
          taskId: "KB-123",
        })
      );
    });
  });
});

// vi import for vitest mocking
import { vi } from "vitest";
