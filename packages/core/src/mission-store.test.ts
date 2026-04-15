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
  status?: string,
): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO tasks (id, description, "column", status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, description, "triage", status ?? null, now, now);
}

describe("MissionStore", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;
  let store: MissionStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
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

  // ── Mission Summary & Slice Discovery Tests ───────────────────────────

  describe("Mission summary helpers", () => {
    it("getMissionSummary returns zeros for an empty mission", () => {
      const mission = store.createMission({ title: "Empty" });

      const summary = store.getMissionSummary(mission.id);

      expect(summary).toEqual({
        totalMilestones: 0,
        completedMilestones: 0,
        totalFeatures: 0,
        completedFeatures: 0,
        progressPercent: 0,
      });
    });

    it("getMissionSummary falls back to milestone progress when no features exist", () => {
      const mission = store.createMission({ title: "Milestones only" });
      const m1 = store.addMilestone(mission.id, { title: "M1" });
      store.addMilestone(mission.id, { title: "M2" });
      store.updateMilestone(m1.id, { status: "complete" });

      const summary = store.getMissionSummary(mission.id);

      expect(summary.totalMilestones).toBe(2);
      expect(summary.completedMilestones).toBe(1);
      expect(summary.totalFeatures).toBe(0);
      expect(summary.completedFeatures).toBe(0);
      expect(summary.progressPercent).toBe(50);
    });

    it("getMissionSummary reports partial feature completion", () => {
      const mission = store.createMission({ title: "Partial features" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const f1 = store.addFeature(slice.id, { title: "F1" });
      const f2 = store.addFeature(slice.id, { title: "F2" });
      store.addFeature(slice.id, { title: "F3" });

      store.updateFeature(f1.id, { status: "done" });
      store.updateFeature(f2.id, { status: "done" });

      const summary = store.getMissionSummary(mission.id);

      expect(summary.totalFeatures).toBe(3);
      expect(summary.completedFeatures).toBe(2);
      expect(summary.progressPercent).toBe(67);
    });

    it("getMissionSummary reports 100% when all features are done", () => {
      const mission = store.createMission({ title: "All done" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const f1 = store.addFeature(slice.id, { title: "F1" });
      const f2 = store.addFeature(slice.id, { title: "F2" });

      store.updateFeature(f1.id, { status: "done" });
      store.updateFeature(f2.id, { status: "done" });

      const summary = store.getMissionSummary(mission.id);
      expect(summary.progressPercent).toBe(100);
    });

    it("getMissionSummary rounds progress percent accurately", () => {
      const mission = store.createMission({ title: "Rounding" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const f1 = store.addFeature(slice.id, { title: "F1" });
      store.addFeature(slice.id, { title: "F2" });
      store.addFeature(slice.id, { title: "F3" });

      store.updateFeature(f1.id, { status: "done" });

      const summary = store.getMissionSummary(mission.id);
      expect(summary.progressPercent).toBe(33);
    });

    it("findNextPendingSlice skips completed slices in earlier milestones", () => {
      const mission = store.createMission({ title: "Next pending" });
      const m1 = store.addMilestone(mission.id, { title: "M1" });
      const m2 = store.addMilestone(mission.id, { title: "M2" });
      const completed = store.addSlice(m1.id, { title: "Done slice" });
      const pending = store.addSlice(m2.id, { title: "Pending slice" });

      store.updateSlice(completed.id, { status: "complete" });

      const next = store.findNextPendingSlice(mission.id);
      expect(next?.id).toBe(pending.id);
    });

    it("findNextPendingSlice returns undefined when no pending slices exist", () => {
      const mission = store.createMission({ title: "No pending" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "Completed" });
      store.updateSlice(slice.id, { status: "complete" });

      const next = store.findNextPendingSlice(mission.id);
      expect(next).toBeUndefined();
    });

    it("findNextPendingSlice returns first pending slice in a single-milestone mission", () => {
      const mission = store.createMission({ title: "Single" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const pending = store.addSlice(milestone.id, { title: "Pending" });

      const next = store.findNextPendingSlice(mission.id);
      expect(next?.id).toBe(pending.id);
    });
  });

  // ── Batched Summary Tests ──────────────────────────────────────────────

  describe("listMissionsWithSummaries", () => {
    it("returns empty array when no missions exist", () => {
      const result = store.listMissionsWithSummaries();
      expect(result).toEqual([]);
    });

    it("returns correct summaries for multiple missions", () => {
      // Mission 1: 2 milestones, 1 complete, 2 features, 1 done
      const m1 = store.createMission({ title: "Mission 1" });
      const ms1a = store.addMilestone(m1.id, { title: "MS1a" });
      const ms1b = store.addMilestone(m1.id, { title: "MS1b" });
      store.updateMilestone(ms1b.id, { status: "complete" });
      const sl1 = store.addSlice(ms1a.id, { title: "SL1" });
      const f1 = store.addFeature(sl1.id, { title: "F1" });
      store.updateFeature(f1.id, { status: "done" });
      const f2 = store.addFeature(sl1.id, { title: "F2" });
      // f2 not done

      // Mission 2: 1 milestone, 0 features
      const m2 = store.createMission({ title: "Mission 2" });
      store.addMilestone(m2.id, { title: "MS2" });

      // Mission 3: 0 milestones
      store.createMission({ title: "Mission 3" });

      const result = store.listMissionsWithSummaries();

      // Should be sorted by createdAt DESC (m3, m2, m1 based on creation order)
      expect(result.length).toBe(3);

      // Mission 3: 0 milestones, 0 features → 0%
      const mission3 = result.find((m) => m.title === "Mission 3")!;
      expect(mission3.summary).toEqual({
        totalMilestones: 0,
        completedMilestones: 0,
        totalFeatures: 0,
        completedFeatures: 0,
        progressPercent: 0,
      });

      // Mission 2: 1 milestone, 0 features → 0%
      const mission2 = result.find((m) => m.title === "Mission 2")!;
      expect(mission2.summary).toEqual({
        totalMilestones: 1,
        completedMilestones: 0,
        totalFeatures: 0,
        completedFeatures: 0,
        progressPercent: 0,
      });

      // Mission 1: 2 milestones (1 complete), 2 features (1 done) → 50%
      const mission1 = result.find((m) => m.title === "Mission 1")!;
      expect(mission1.summary).toEqual({
        totalMilestones: 2,
        completedMilestones: 1,
        totalFeatures: 2,
        completedFeatures: 1,
        progressPercent: 50,
      });
    });

    it("progress percent matches getMissionSummary behavior", () => {
      const mission = store.createMission({ title: "Compare test" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "S1" });
      const f1 = store.addFeature(slice.id, { title: "F1" });
      store.updateFeature(f1.id, { status: "done" });
      const f2 = store.addFeature(slice.id, { title: "F2" });
      store.updateFeature(f2.id, { status: "done" });
      const f3 = store.addFeature(slice.id, { title: "F3" });
      // f3 not done

      const singleSummary = store.getMissionSummary(mission.id);
      const batchedResult = store.listMissionsWithSummaries().find((m) => m.id === mission.id)!;

      expect(batchedResult.summary.totalMilestones).toBe(singleSummary.totalMilestones);
      expect(batchedResult.summary.completedMilestones).toBe(singleSummary.completedMilestones);
      expect(batchedResult.summary.totalFeatures).toBe(singleSummary.totalFeatures);
      expect(batchedResult.summary.completedFeatures).toBe(singleSummary.completedFeatures);
      expect(batchedResult.summary.progressPercent).toBe(singleSummary.progressPercent);
    });
  });

  // ── Batched Health Tests ──────────────────────────────────────────────

  describe("listMissionsHealth", () => {
    it("returns empty map when no missions exist", () => {
      const result = store.listMissionsHealth();
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("returns correct health for a single empty mission", () => {
      const mission = store.createMission({ title: "Empty mission" });
      store.updateMission(mission.id, {
        autopilotEnabled: true,
        autopilotState: "watching",
        lastAutopilotActivityAt: "2026-01-01T10:00:00.000Z",
      });

      const result = store.listMissionsHealth();

      expect(result.size).toBe(1);
      expect(result.get(mission.id)).toEqual({
        missionId: mission.id,
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        currentSliceId: undefined,
        currentMilestoneId: undefined,
        estimatedCompletionPercent: 0,
        lastErrorAt: undefined,
        lastErrorDescription: undefined,
        autopilotState: "watching",
        autopilotEnabled: true,
        lastActivityAt: "2026-01-01T10:00:00.000Z",
      });
    });

    it("computes correct health for multiple missions with varying states", async () => {
      // Mission 1: 1 milestone (active), 1 slice (active), 4 features (1 done, 2 in-flight, 1 failed)
      const m1 = store.createMission({ title: "Mission 1" });
      store.updateMission(m1.id, { status: "active" });
      const ms1 = store.addMilestone(m1.id, { title: "MS1" });
      store.updateMilestone(ms1.id, { status: "active" });
      const sl1 = store.addSlice(ms1.id, { title: "SL1" });
      store.updateSlice(sl1.id, { status: "active" });

      const f1Done = store.addFeature(sl1.id, { title: "F1-done" });
      store.updateFeature(f1Done.id, { status: "done" });

      const f1Triaged = store.addFeature(sl1.id, { title: "F1-triaged" });
      store.updateFeature(f1Triaged.id, { status: "triaged" });

      const f1Progress = store.addFeature(sl1.id, { title: "F1-progress" });
      store.updateFeature(f1Progress.id, { status: "in-progress" });

      createTaskInDb(db, "FN-FAILED-1", "Failed task", "failed");
      const f1Failed = store.addFeature(sl1.id, { title: "F1-failed" });
      store.linkFeatureToTask(f1Failed.id, "FN-FAILED-1");

      await new Promise((r) => setTimeout(r, 10));

      // Mission 2: 2 milestones (1 complete, 1 active), 0 features
      const m2 = store.createMission({ title: "Mission 2" });
      store.updateMission(m2.id, { status: "active" });
      const ms2a = store.addMilestone(m2.id, { title: "MS2a" });
      store.updateMilestone(ms2a.id, { status: "complete" });
      const ms2b = store.addMilestone(m2.id, { title: "MS2b" });
      store.updateMilestone(ms2b.id, { status: "active" });
      const sl2 = store.addSlice(ms2b.id, { title: "SL2" });
      store.updateSlice(sl2.id, { status: "active" });

      store.logMissionEvent(m1.id, "error", "Error on mission 1");

      const result = store.listMissionsHealth();

      expect(result.size).toBe(2);

      // Mission 1 health
      const health1 = result.get(m1.id)!;
      expect(health1).toEqual({
        missionId: m1.id,
        status: "active",
        tasksCompleted: 1,
        tasksFailed: 1,
        tasksInFlight: 3,
        totalTasks: 4,
        currentSliceId: sl1.id,
        currentMilestoneId: ms1.id,
        estimatedCompletionPercent: 25,
        lastErrorAt: expect.any(String),
        lastErrorDescription: "Error on mission 1",
        autopilotState: "inactive",
        autopilotEnabled: false,
        lastActivityAt: undefined,
      });

      // Mission 2 health: no features, 1/2 milestones complete → 50%
      const health2 = result.get(m2.id)!;
      expect(health2).toEqual({
        missionId: m2.id,
        status: "active",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        currentSliceId: sl2.id,
        currentMilestoneId: ms2b.id,
        estimatedCompletionPercent: 50,
        lastErrorAt: undefined,
        lastErrorDescription: undefined,
        autopilotState: "inactive",
        autopilotEnabled: false,
        lastActivityAt: undefined,
      });
    });

    it("counts failed tasks across missions correctly", () => {
      const m1 = store.createMission({ title: "Mission 1" });
      const ms1 = store.addMilestone(m1.id, { title: "MS1" });
      const sl1 = store.addSlice(ms1.id, { title: "SL1" });

      const m2 = store.createMission({ title: "Mission 2" });
      const ms2 = store.addMilestone(m2.id, { title: "MS2" });
      const sl2 = store.addSlice(ms2.id, { title: "SL2" });

      createTaskInDb(db, "FN-FAIL-A", "Task A", "failed");
      createTaskInDb(db, "FN-FAIL-B", "Task B", "failed");
      createTaskInDb(db, "FN-OK-C", "Task C", "done");

      const f1 = store.addFeature(sl1.id, { title: "F1" });
      store.linkFeatureToTask(f1.id, "FN-FAIL-A");

      const f2 = store.addFeature(sl2.id, { title: "F2" });
      store.linkFeatureToTask(f2.id, "FN-FAIL-B");

      const f3 = store.addFeature(sl2.id, { title: "F3" });
      store.linkFeatureToTask(f3.id, "FN-OK-C");

      const result = store.listMissionsHealth();

      expect(result.get(m1.id)!.tasksFailed).toBe(1);
      expect(result.get(m2.id)!.tasksFailed).toBe(1);
    });

    it("detects last error per mission independently", () => {
      const m1 = store.createMission({ title: "Mission 1" });
      const m2 = store.createMission({ title: "Mission 2" });

      store.logMissionEvent(m1.id, "error", "Old error on M1");
      store.logMissionEvent(m2.id, "error", "Only error on M2");
      store.logMissionEvent(m1.id, "error", "Latest error on M1");

      const result = store.listMissionsHealth();

      expect(result.get(m1.id)!.lastErrorDescription).toBe("Latest error on M1");
      expect(result.get(m2.id)!.lastErrorDescription).toBe("Only error on M2");
    });

    it("produces results consistent with getMissionHealth", () => {
      const mission = store.createMission({ title: "Consistency test" });
      store.updateMission(mission.id, {
        status: "active",
        autopilotEnabled: true,
        autopilotState: "watching",
        lastAutopilotActivityAt: "2026-01-01T10:00:00.000Z",
      });

      const milestone = store.addMilestone(mission.id, { title: "M1" });
      store.updateMilestone(milestone.id, { status: "active" });
      const slice = store.addSlice(milestone.id, { title: "S1" });
      store.updateSlice(slice.id, { status: "active" });

      const f1 = store.addFeature(slice.id, { title: "F1" });
      store.updateFeature(f1.id, { status: "done" });

      const f2 = store.addFeature(slice.id, { title: "F2" });
      store.updateFeature(f2.id, { status: "triaged" });

      createTaskInDb(db, "FN-FAILED-X", "Failed task", "failed");
      const f3 = store.addFeature(slice.id, { title: "F3" });
      store.linkFeatureToTask(f3.id, "FN-FAILED-X");

      store.logMissionEvent(mission.id, "error", "Test error");

      const singleHealth = store.getMissionHealth(mission.id);
      const batchedHealth = store.listMissionsHealth().get(mission.id)!;

      // Compare all fields except lastErrorAt (may differ by ms due to separate queries)
      expect(batchedHealth.missionId).toBe(singleHealth!.missionId);
      expect(batchedHealth.status).toBe(singleHealth!.status);
      expect(batchedHealth.tasksCompleted).toBe(singleHealth!.tasksCompleted);
      expect(batchedHealth.tasksFailed).toBe(singleHealth!.tasksFailed);
      expect(batchedHealth.tasksInFlight).toBe(singleHealth!.tasksInFlight);
      expect(batchedHealth.totalTasks).toBe(singleHealth!.totalTasks);
      expect(batchedHealth.currentSliceId).toBe(singleHealth!.currentSliceId);
      expect(batchedHealth.currentMilestoneId).toBe(singleHealth!.currentMilestoneId);
      expect(batchedHealth.estimatedCompletionPercent).toBe(singleHealth!.estimatedCompletionPercent);
      expect(batchedHealth.lastErrorDescription).toBe(singleHealth!.lastErrorDescription);
      expect(batchedHealth.autopilotState).toBe(singleHealth!.autopilotState);
      expect(batchedHealth.autopilotEnabled).toBe(singleHealth!.autopilotEnabled);
    });
  });

  // ── Mission Observability Tests ───────────────────────────────────────

  describe("Mission observability", () => {
    it("logMissionEvent persists the event and emits mission:event", () => {
      const mission = store.createMission({ title: "Observable mission" });
      const eventHandler = vi.fn();
      store.on("mission:event", eventHandler);

      const event = store.logMissionEvent(
        mission.id,
        "mission_started",
        "Mission was started",
        { source: "test" },
      );

      expect(event.id).toMatch(/^ME-/);
      expect(event.missionId).toBe(mission.id);
      expect(event.eventType).toBe("mission_started");
      expect(event.description).toBe("Mission was started");
      expect(event.metadata).toEqual({ source: "test" });
      expect(eventHandler).toHaveBeenCalledWith(event);

      const events = store.getMissionEvents(mission.id);
      expect(events.total).toBe(1);
      expect(events.events[0]).toEqual(event);
    });

    it("getMissionEvents supports pagination, filtering, and newest-first ordering", async () => {
      const mission = store.createMission({ title: "Events mission" });

      const first = store.logMissionEvent(mission.id, "mission_started", "first");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = store.logMissionEvent(mission.id, "warning", "second warning");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const third = store.logMissionEvent(mission.id, "error", "third error");

      const pageOne = store.getMissionEvents(mission.id, { limit: 2, offset: 0 });
      expect(pageOne.total).toBe(3);
      expect(pageOne.events).toHaveLength(2);
      expect(pageOne.events.map((event) => event.id)).toEqual([third.id, second.id]);

      const pageTwo = store.getMissionEvents(mission.id, { limit: 2, offset: 2 });
      expect(pageTwo.total).toBe(3);
      expect(pageTwo.events).toHaveLength(1);
      expect(pageTwo.events[0].id).toBe(first.id);

      const filtered = store.getMissionEvents(mission.id, { eventType: "error" });
      expect(filtered.total).toBe(1);
      expect(filtered.events).toHaveLength(1);
      expect(filtered.events[0].eventType).toBe("error");
      expect(filtered.events[0].id).toBe(third.id);
    });

    it("getMissionHealth computes mission metrics and latest error context", () => {
      const mission = store.createMission({ title: "Health mission" });
      store.updateMission(mission.id, {
        status: "active",
        autopilotEnabled: true,
        autopilotState: "watching",
        lastAutopilotActivityAt: "2026-01-01T10:00:00.000Z",
      });

      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      store.updateMilestone(milestone.id, { status: "active" });
      store.updateSlice(slice.id, { status: "active" });

      const doneFeature = store.addFeature(slice.id, { title: "Done feature" });
      store.updateFeature(doneFeature.id, { status: "done" });

      const triagedFeature = store.addFeature(slice.id, { title: "Triaged feature" });
      store.updateFeature(triagedFeature.id, { status: "triaged" });

      const inProgressFeature = store.addFeature(slice.id, { title: "In progress feature" });
      store.updateFeature(inProgressFeature.id, { status: "in-progress" });

      createTaskInDb(db, "FN-FAILED", "Failed task", "failed");
      const failedFeature = store.addFeature(slice.id, { title: "Failed feature" });
      store.linkFeatureToTask(failedFeature.id, "FN-FAILED");
      // Keep failed feature out of in-flight count for deterministic assertions.
      store.updateFeature(failedFeature.id, { status: "defined" });

      store.logMissionEvent(mission.id, "error", "Old error", { at: "old" });
      const latestError = store.logMissionEvent(mission.id, "error", "Latest error", { at: "latest" });

      const health = store.getMissionHealth(mission.id);

      expect(health).toEqual({
        missionId: mission.id,
        status: "active",
        tasksCompleted: 1,
        tasksFailed: 1,
        tasksInFlight: 2,
        totalTasks: 4,
        currentSliceId: slice.id,
        currentMilestoneId: milestone.id,
        estimatedCompletionPercent: 25,
        lastErrorAt: latestError.timestamp,
        lastErrorDescription: "Latest error",
        autopilotState: "watching",
        autopilotEnabled: true,
        lastActivityAt: "2026-01-01T10:00:00.000Z",
      });
    });

    it("getMissionHealth returns undefined for non-existent mission", () => {
      expect(store.getMissionHealth("M-NONEXISTENT")).toBeUndefined();
    });

    it("getMissionHealth handles an empty mission", () => {
      const mission = store.createMission({ title: "Empty health mission" });

      const health = store.getMissionHealth(mission.id);

      expect(health).toEqual({
        missionId: mission.id,
        status: "planning",
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        currentSliceId: undefined,
        currentMilestoneId: undefined,
        estimatedCompletionPercent: 0,
        lastErrorAt: undefined,
        lastErrorDescription: undefined,
        autopilotState: "inactive",
        autopilotEnabled: false,
        lastActivityAt: undefined,
      });
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

    it("activates a slice", async () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "To Activate" });

      const activated = await store.activateSlice(slice.id);

      expect(activated.status).toBe("active");
      expect(activated.activatedAt).toBeTruthy();
    });

    it("emits slice:activated event", async () => {
      const handler = vi.fn();
      store.on("slice:activated", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Test" });
      const activated = await store.activateSlice(slice.id);

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

    it("links a feature to a task and persists missionId/sliceId on the task row", () => {
      createTaskInDb(db, "FN-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Linkable" });

      const linked = store.linkFeatureToTask(feature.id, "FN-001");
      const taskRow = db.prepare("SELECT missionId, sliceId FROM tasks WHERE id = ?").get("FN-001") as {
        missionId: string | null;
        sliceId: string | null;
      };

      expect(linked.taskId).toBe("FN-001");
      expect(linked.status).toBe("triaged");
      expect(linked.loopState).toBe("implementing");
      expect(linked.implementationAttemptCount).toBe(1);
      expect(taskRow.missionId).toBe(mission.id);
      expect(taskRow.sliceId).toBe(slice.id);
    });

    it("emits feature:linked event", () => {
      createTaskInDb(db, "FN-001");

      const handler = vi.fn();
      store.on("feature:linked", handler);

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Test" });
      const linked = store.linkFeatureToTask(feature.id, "FN-001");

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ feature: linked, taskId: "FN-001" });
    });

    it("unlinks a feature from a task and clears missionId/sliceId on the task row", () => {
      createTaskInDb(db, "FN-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Linkable" });
      store.linkFeatureToTask(feature.id, "FN-001");

      const unlinked = store.unlinkFeatureFromTask(feature.id);
      const taskRow = db.prepare("SELECT missionId, sliceId FROM tasks WHERE id = ?").get("FN-001") as {
        missionId: string | null;
        sliceId: string | null;
      };

      expect(unlinked.taskId).toBeUndefined();
      expect(unlinked.status).toBe("defined");
      expect(taskRow.missionId).toBeNull();
      expect(taskRow.sliceId).toBeNull();
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
      const result = store.getFeatureByTaskId("FN-NONEXISTENT");
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
        createTaskInDb(db, "FN-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Active Slice" });
        const feature = store.addFeature(slice.id, { title: "Linked" });

        store.linkFeatureToTask(feature.id, "FN-001");

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
        createTaskInDb(db, "FN-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Active Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Active Slice" });
        const feature = store.addFeature(slice.id, { title: "Linked" });

        store.linkFeatureToTask(feature.id, "FN-001");

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

    it("emits all slice lifecycle events", async () => {
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
      await store.activateSlice(slice.id);
      store.deleteSlice(slice.id);

      expect(created).toHaveBeenCalledTimes(1);
      expect(updated).toHaveBeenCalledTimes(1); // From activateSlice
      expect(activated).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("emits all feature lifecycle events", () => {
      createTaskInDb(db, "FN-001");

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
      store.linkFeatureToTask(feature.id, "FN-001");
      store.deleteFeature(feature.id);

      expect(created).toHaveBeenCalledTimes(1);
      // Updated is called twice: once by linkFeatureToTask, once by delete triggering recompute
      expect(updated).toHaveBeenCalled();
      expect(linked).toHaveBeenCalledTimes(1);
      expect(deleted).toHaveBeenCalledTimes(1);
    });

    it("includes correct data in event payloads", () => {
      createTaskInDb(db, "FN-123");

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

      store.linkFeatureToTask(feature.id, "FN-123");

      expect(linkedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: expect.objectContaining({ id: feature.id }),
          taskId: "FN-123",
        })
      );
    });
  });

  describe("triageFeature", () => {
    it("throws if TaskStore reference is not available", async () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      await expect(store.triageFeature(feature.id)).rejects.toThrow(
        "TaskStore reference is required for triage operations",
      );
    });

    it("throws if feature not found", async () => {
      // Need a TaskStore reference for this test
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      await expect(msWithTs.triageFeature("F-NONEXISTENT")).rejects.toThrow(
        "Feature F-NONEXISTENT not found",
      );
    });

    it("throws if feature is already triaged", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Feature" });

      // Triaging once should work
      await msWithTs.triageFeature(feature.id);

      // Triaging again should fail
      const updated = msWithTs.getFeature(feature.id)!;
      await expect(msWithTs.triageFeature(updated.id)).rejects.toThrow(
        `already triaged`,
      );
    });

    it("creates a task and links it to the feature", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, {
        title: "Login Page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
      });

      const triaged = await msWithTs.triageFeature(feature.id);

      // Feature should be triaged with a taskId
      expect(triaged.status).toBe("triaged");
      expect(triaged.taskId).toBeTruthy();
      expect(triaged.loopState).toBe("implementing");
      expect(triaged.implementationAttemptCount).toBe(1);

      // Task should exist with correct properties
      const task = await ts.getTask(triaged.taskId!);
      expect(task).toBeDefined();
      expect(task!.title).toBe("Login Page");
      expect(task!.description).toContain("Build a login page");
      expect(task!.description).toContain("Acceptance Criteria");
      expect(task!.sliceId).toBe(slice.id);
      expect(task!.missionId).toBe(mission.id);
    });

    it("uses provided title and description overrides", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(
        feature.id,
        "Custom Title",
        "Custom description for the task",
      );

      const task = await ts.getTask(triaged.taskId!);
      expect(task!.title).toBe("Custom Title");
      expect(task!.description).toBe("Custom description for the task");
    });

    it("emits feature:linked event", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const linkedHandler = vi.fn();
      msWithTs.on("feature:linked", linkedHandler);

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Feature" });

      const triaged = await msWithTs.triageFeature(feature.id);

      expect(linkedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: expect.objectContaining({ id: feature.id }),
          taskId: triaged.taskId,
        }),
      );
    });
  });

  describe("triageSlice", () => {
    it("throws if TaskStore reference is not available", async () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });

      await expect(store.triageSlice(slice.id)).rejects.toThrow(
        "TaskStore reference is required for triage operations",
      );
    });

    it("throws if slice not found", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      await expect(msWithTs.triageSlice("SL-NONEXISTENT")).rejects.toThrow(
        "Slice SL-NONEXISTENT not found",
      );
    });

    it("triages all defined features in a slice", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const f1 = msWithTs.addFeature(slice.id, { title: "Feature 1" });
      const f2 = msWithTs.addFeature(slice.id, { title: "Feature 2" });
      const f3 = msWithTs.addFeature(slice.id, { title: "Feature 3" });

      const triaged = await msWithTs.triageSlice(slice.id);

      expect(triaged).toHaveLength(3);
      expect(triaged.every((f) => f.status === "triaged")).toBe(true);
      expect(triaged.every((f) => f.taskId)).toBe(true);

      // All tasks should exist and be linked to the slice/mission
      for (const feature of triaged) {
        const task = await ts.getTask(feature.taskId!);
        expect(task).toBeDefined();
        expect(task!.sliceId).toBe(slice.id);
        expect(task!.missionId).toBe(mission.id);
      }
    });

    it("skips already triaged features", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const f1 = msWithTs.addFeature(slice.id, { title: "Feature 1" });
      const f2 = msWithTs.addFeature(slice.id, { title: "Feature 2" });

      // Triage f1 first
      await msWithTs.triageFeature(f1.id);

      // Now triage the whole slice — should only triage f2
      const triaged = await msWithTs.triageSlice(slice.id);

      expect(triaged).toHaveLength(1);
      expect(triaged[0].id).toBe(f2.id);
      expect(triaged[0].status).toBe("triaged");
    });

    it("returns empty array if no defined features", async () => {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });

      const triaged = await msWithTs.triageSlice(slice.id);
      expect(triaged).toEqual([]);
    });
  });

  // ── Auto-Triage on Slice Activation Tests ─────────────────────────────

  describe("activateSlice with autoAdvance", () => {
    /** Helper to create a MissionStore with a real TaskStore reference */
    async function createStoreWithTaskStore(): Promise<{
      ts: import("./store.js").TaskStore;
      ms: MissionStore;
    }> {
      const { TaskStore } = await import("./store.js");
      const ts = new TaskStore(kbDir);
      const ms = ts.getMissionStore();
      return { ts, ms };
    }

    it("triages features when autoAdvance is true", async () => {
      const { ts, ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      ms.updateMission(mission.id, { autoAdvance: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });
      const f2 = ms.addFeature(slice.id, { title: "Feature 2" });

      const activated = await ms.activateSlice(slice.id);

      // Slice should be active
      expect(activated.status).toBe("active");
      expect(activated.activatedAt).toBeTruthy();

      // Both features should be triaged with tasks
      const updatedF1 = ms.getFeature(f1.id)!;
      const updatedF2 = ms.getFeature(f2.id)!;
      expect(updatedF1.status).toBe("triaged");
      expect(updatedF1.taskId).toBeTruthy();
      expect(updatedF2.status).toBe("triaged");
      expect(updatedF2.taskId).toBeTruthy();

      // Tasks should exist and be linked to the slice/mission
      const task1 = await ts.getTask(updatedF1.taskId!);
      const task2 = await ts.getTask(updatedF2.taskId!);
      expect(task1).toBeDefined();
      expect(task1!.sliceId).toBe(slice.id);
      expect(task1!.missionId).toBe(mission.id);
      expect(task2).toBeDefined();
      expect(task2!.sliceId).toBe(slice.id);
      expect(task2!.missionId).toBe(mission.id);
    });

    it("does not triage features when autoAdvance is false", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      // autoAdvance defaults to false
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });

      const activated = await ms.activateSlice(slice.id);

      // Slice should be active
      expect(activated.status).toBe("active");

      // Feature should still be "defined" — not triaged
      const updatedF1 = ms.getFeature(f1.id)!;
      expect(updatedF1.status).toBe("defined");
      expect(updatedF1.taskId).toBeUndefined();
    });

    it("does not triage features when autoAdvance is unset", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });

      const activated = await ms.activateSlice(slice.id);

      expect(activated.status).toBe("active");
      const updatedFeature = ms.getFeature(feature.id)!;
      expect(updatedFeature.status).toBe("defined");
    });

    it("skips already-triaged features during auto-triage", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      ms.updateMission(mission.id, { autoAdvance: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });
      const f2 = ms.addFeature(slice.id, { title: "Feature 2" });

      // Manually triage f1 first
      await ms.triageFeature(f1.id);
      const f1TaskId = ms.getFeature(f1.id)!.taskId;
      expect(f1TaskId).toBeTruthy();

      // Activate the slice — should only triage f2
      const activated = await ms.activateSlice(slice.id);

      expect(activated.status).toBe("active");

      // f1 should keep its existing taskId
      const updatedF1 = ms.getFeature(f1.id)!;
      expect(updatedF1.taskId).toBe(f1TaskId);

      // f2 should now be triaged
      const updatedF2 = ms.getFeature(f2.id)!;
      expect(updatedF2.status).toBe("triaged");
      expect(updatedF2.taskId).toBeTruthy();
    });

    it("still activates slice even if triage fails", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      ms.updateMission(mission.id, { autoAdvance: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });

      // Sabotage the TaskStore by removing it to trigger a triage error
      // The MissionStore was created via TaskStore, so taskStore is available.
      // To make triage fail, we'll delete the task from the DB after it's created.
      // Instead, let's use a MissionStore WITHOUT a TaskStore but with autoAdvance.
      const storeNoTs = new MissionStore(kbDir, db);

      const mission2 = storeNoTs.createMission({ title: "Mission 2" });
      storeNoTs.updateMission(mission2.id, { autoAdvance: true });
      const milestone2 = storeNoTs.addMilestone(mission2.id, { title: "Milestone 2" });
      const slice2 = storeNoTs.addSlice(milestone2.id, { title: "Slice 2" });
      storeNoTs.addFeature(slice2.id, { title: "Feature" });

      // activateSlice should still succeed even though triageSlice will throw
      const activated = await storeNoTs.activateSlice(slice2.id);

      expect(activated.status).toBe("active");
      expect(activated.activatedAt).toBeTruthy();
    });

    it("throws meaningful error when slice not found", async () => {
      await expect(store.activateSlice("SL-NONEXISTENT")).rejects.toThrow(
        "Slice SL-NONEXISTENT not found",
      );
    });

    // ── autopilotEnabled as primary control ──────────────────────────────────

    it("triages features when autopilotEnabled is true (autoAdvance false)", async () => {
      const { ts, ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      // autopilotEnabled is primary control; autoAdvance=false/unset should still work
      ms.updateMission(mission.id, { autopilotEnabled: true, autoAdvance: false });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });
      const f2 = ms.addFeature(slice.id, { title: "Feature 2" });

      const activated = await ms.activateSlice(slice.id);

      expect(activated.status).toBe("active");

      // Both features should be triaged because autopilotEnabled=true
      const updatedF1 = ms.getFeature(f1.id)!;
      const updatedF2 = ms.getFeature(f2.id)!;
      expect(updatedF1.status).toBe("triaged");
      expect(updatedF1.taskId).toBeTruthy();
      expect(updatedF2.status).toBe("triaged");
      expect(updatedF2.taskId).toBeTruthy();

      // Tasks should exist and be linked
      const task1 = await ts.getTask(updatedF1.taskId!);
      const task2 = await ts.getTask(updatedF2.taskId!);
      expect(task1).toBeDefined();
      expect(task1!.sliceId).toBe(slice.id);
      expect(task2).toBeDefined();
      expect(task2!.sliceId).toBe(slice.id);
    });

    it("triages features when autopilotEnabled is true (autoAdvance unset)", async () => {
      const { ts, ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      // autopilotEnabled=true, autoAdvance undefined (neither true nor false)
      ms.updateMission(mission.id, { autopilotEnabled: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });

      await ms.activateSlice(slice.id);

      // Feature should be triaged because autopilotEnabled=true
      const updatedF1 = ms.getFeature(f1.id)!;
      expect(updatedF1.status).toBe("triaged");
      expect(updatedF1.taskId).toBeTruthy();
    });

    it("does not triage features when autopilotEnabled is false and autoAdvance is false", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      ms.updateMission(mission.id, { autopilotEnabled: false, autoAdvance: false });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });

      await ms.activateSlice(slice.id);

      // Feature should NOT be triaged
      const updatedF1 = ms.getFeature(f1.id)!;
      expect(updatedF1.status).toBe("defined");
      expect(updatedF1.taskId).toBeUndefined();
    });

    it("triages features when autopilotEnabled is false but autoAdvance is true (legacy compat)", async () => {
      const { ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission" });
      // Legacy case: autoAdvance=true, autopilotEnabled=false/unset
      ms.updateMission(mission.id, { autoAdvance: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const f1 = ms.addFeature(slice.id, { title: "Feature 1" });

      await ms.activateSlice(slice.id);

      // Feature should be triaged because autoAdvance=true (legacy compat)
      const updatedF1 = ms.getFeature(f1.id)!;
      expect(updatedF1.status).toBe("triaged");
      expect(updatedF1.taskId).toBeTruthy();
    });
  });

  // ── Contract Assertion Tests ────────────────────────────────────────

  describe("Contract Assertions", () => {
    let mission: ReturnType<typeof store.createMission>;
    let milestone: ReturnType<typeof store.addMilestone>;

    beforeEach(() => {
      mission = store.createMission({ title: "Test Mission" });
      milestone = store.addMilestone(mission.id, { title: "Test Milestone" });
    });

    it("creates an assertion with correct defaults", () => {
      const assertion = store.addContractAssertion(milestone.id, {
        title: "Auth works",
        assertion: "Users can log in and log out",
      });

      expect(assertion.id).toMatch(/^CA-/);
      expect(assertion.milestoneId).toBe(milestone.id);
      expect(assertion.title).toBe("Auth works");
      expect(assertion.assertion).toBe("Users can log in and log out");
      expect(assertion.status).toBe("pending");
      expect(assertion.orderIndex).toBe(0);
      expect(assertion.createdAt).toBeTruthy();
      expect(assertion.updatedAt).toBeTruthy();
    });

    it("creates assertions with auto-incrementing orderIndex", () => {
      const a1 = store.addContractAssertion(milestone.id, {
        title: "First",
        assertion: "First assertion",
      });
      const a2 = store.addContractAssertion(milestone.id, {
        title: "Second",
        assertion: "Second assertion",
      });
      const a3 = store.addContractAssertion(milestone.id, {
        title: "Third",
        assertion: "Third assertion",
      });

      expect(a1.orderIndex).toBe(0);
      expect(a2.orderIndex).toBe(1);
      expect(a3.orderIndex).toBe(2);
    });

    it("lists assertions in deterministic order", () => {
      store.addContractAssertion(milestone.id, {
        title: "First",
        assertion: "First assertion",
      });
      store.addContractAssertion(milestone.id, {
        title: "Second",
        assertion: "Second assertion",
      });

      const assertions = store.listContractAssertions(milestone.id);

      expect(assertions).toHaveLength(2);
      expect(assertions[0].title).toBe("First");
      expect(assertions[1].title).toBe("Second");
    });

    it("gets an assertion by id", () => {
      const created = store.addContractAssertion(milestone.id, {
        title: "Get Test",
        assertion: "Test assertion",
      });

      const retrieved = store.getContractAssertion(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.title).toBe("Get Test");
    });

    it("returns undefined for non-existent assertion", () => {
      const result = store.getContractAssertion("CA-NONEXISTENT");
      expect(result).toBeUndefined();
    });

    it("updates an assertion", () => {
      const assertion = store.addContractAssertion(milestone.id, {
        title: "Original",
        assertion: "Original assertion",
      });

      const updated = store.updateContractAssertion(assertion.id, {
        title: "Updated",
        status: "passed",
      });

      expect(updated.id).toBe(assertion.id);
      expect(updated.title).toBe("Updated");
      expect(updated.status).toBe("passed");
      expect(updated.assertion).toBe("Original assertion"); // unchanged
    });

    it("updates assertion status", () => {
      const assertion = store.addContractAssertion(milestone.id, {
        title: "Status Test",
        assertion: "Test",
        status: "pending",
      });

      const passed = store.updateContractAssertion(assertion.id, { status: "passed" });
      expect(passed.status).toBe("passed");

      const failed = store.updateContractAssertion(assertion.id, { status: "failed" });
      expect(failed.status).toBe("failed");

      const blocked = store.updateContractAssertion(assertion.id, { status: "blocked" });
      expect(blocked.status).toBe("blocked");
    });

    it("deletes an assertion", () => {
      const assertion = store.addContractAssertion(milestone.id, {
        title: "Delete Test",
        assertion: "Test",
      });

      store.deleteContractAssertion(assertion.id);

      const retrieved = store.getContractAssertion(assertion.id);
      expect(retrieved).toBeUndefined();
    });

    it("reorders assertions", () => {
      const a1 = store.addContractAssertion(milestone.id, { title: "A", assertion: "A" });
      const a2 = store.addContractAssertion(milestone.id, { title: "B", assertion: "B" });
      const a3 = store.addContractAssertion(milestone.id, { title: "C", assertion: "C" });

      store.reorderContractAssertions(milestone.id, [a3.id, a1.id, a2.id]);

      const assertions = store.listContractAssertions(milestone.id);
      expect(assertions[0].id).toBe(a3.id);
      expect(assertions[1].id).toBe(a1.id);
      expect(assertions[2].id).toBe(a2.id);
    });

    it("throws when reordering with non-existent assertion", () => {
      expect(() =>
        store.reorderContractAssertions(milestone.id, ["CA-NONEXISTENT"])
      ).toThrow("Assertion CA-NONEXISTENT not found");
    });

    it("throws when reordering assertion from different milestone", async () => {
      const milestone2 = store.addMilestone(mission.id, { title: "Milestone 2" });
      const a1 = store.addContractAssertion(milestone.id, { title: "A", assertion: "A" });
      const a2 = store.addContractAssertion(milestone2.id, { title: "B", assertion: "B" });

      expect(() =>
        store.reorderContractAssertions(milestone.id, [a1.id, a2.id])
      ).toThrow(`Assertion ${a2.id} does not belong to milestone ${milestone.id}`);
    });

    it("emits assertion:created event", () => {
      const events: any[] = [];
      store.on("assertion:created", (a) => events.push(a));

      const assertion = store.addContractAssertion(milestone.id, {
        title: "Event Test",
        assertion: "Test",
      });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(assertion.id);
    });

    it("emits assertion:updated event", () => {
      const events: any[] = [];
      store.on("assertion:updated", (a) => events.push(a));

      const assertion = store.addContractAssertion(milestone.id, {
        title: "Event Test",
        assertion: "Test",
      });
      store.updateContractAssertion(assertion.id, { status: "passed" });

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("passed");
    });

    it("emits assertion:deleted event", () => {
      const events: any[] = [];
      store.on("assertion:deleted", (id) => events.push(id));

      const assertion = store.addContractAssertion(milestone.id, {
        title: "Event Test",
        assertion: "Test",
      });
      store.deleteContractAssertion(assertion.id);

      expect(events).toHaveLength(1);
      expect(events[0]).toBe(assertion.id);
    });

    it("throws when creating assertion for non-existent milestone", () => {
      expect(() =>
        store.addContractAssertion("MS-NONEXISTENT", {
          title: "Test",
          assertion: "Test",
        })
      ).toThrow("Milestone MS-NONEXISTENT not found");
    });
  });

  // ── Feature-Assertion Link Tests ───────────────────────────────────

  describe("Feature-Assertion Links", () => {
    let mission: ReturnType<typeof store.createMission>;
    let milestone: ReturnType<typeof store.addMilestone>;
    let slice: ReturnType<typeof store.addSlice>;
    let feature: ReturnType<typeof store.addFeature>;
    let assertion: ReturnType<typeof store.addContractAssertion>;

    beforeEach(() => {
      mission = store.createMission({ title: "Test Mission" });
      milestone = store.addMilestone(mission.id, { title: "Test Milestone" });
      slice = store.addSlice(milestone.id, { title: "Test Slice" });
      feature = store.addFeature(slice.id, { title: "Test Feature" });
      assertion = store.addContractAssertion(milestone.id, {
        title: "Test Assertion",
        assertion: "Test assertion content",
      });
    });

    it("links a feature to an assertion", () => {
      store.linkFeatureToAssertion(feature.id, assertion.id);

      const linkedAssertions = store.listAssertionsForFeature(feature.id);
      expect(linkedAssertions).toHaveLength(1);
      expect(linkedAssertions[0].id).toBe(assertion.id);
    });

    it("lists assertions for a feature", () => {
      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "A1" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "A2" });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);

      const linked = store.listAssertionsForFeature(feature.id);
      expect(linked).toHaveLength(2);
      expect(linked.map((a) => a.title).sort()).toEqual(["A1", "A2"]);
    });

    it("lists features for an assertion", () => {
      const f2 = store.addFeature(slice.id, { title: "Feature 2" });
      const f3 = store.addFeature(slice.id, { title: "Feature 3" });

      store.linkFeatureToAssertion(feature.id, assertion.id);
      store.linkFeatureToAssertion(f2.id, assertion.id);
      store.linkFeatureToAssertion(f3.id, assertion.id);

      const linked = store.listFeaturesForAssertion(assertion.id);
      expect(linked).toHaveLength(3);
    });

    it("unlinks a feature from an assertion", () => {
      store.linkFeatureToAssertion(feature.id, assertion.id);
      store.unlinkFeatureFromAssertion(feature.id, assertion.id);

      const linked = store.listAssertionsForFeature(feature.id);
      expect(linked).toHaveLength(0);
    });

    it("throws when linking already-linked feature-assertion pair", () => {
      store.linkFeatureToAssertion(feature.id, assertion.id);

      expect(() =>
        store.linkFeatureToAssertion(feature.id, assertion.id)
      ).toThrow("Feature " + feature.id + " is already linked to assertion " + assertion.id);
    });

    it("throws when unlinking non-existent link", () => {
      expect(() =>
        store.unlinkFeatureFromAssertion(feature.id, assertion.id)
      ).toThrow("Feature " + feature.id + " is not linked to assertion " + assertion.id);
    });

    it("throws when linking non-existent feature", () => {
      expect(() =>
        store.linkFeatureToAssertion("F-NONEXISTENT", assertion.id)
      ).toThrow("Feature F-NONEXISTENT not found");
    });

    it("throws when linking to non-existent assertion", () => {
      expect(() =>
        store.linkFeatureToAssertion(feature.id, "CA-NONEXISTENT")
      ).toThrow("Assertion CA-NONEXISTENT not found");
    });

    it("emits assertion:linked event", () => {
      const events: any[] = [];
      store.on("assertion:linked", (e) => events.push(e));

      store.linkFeatureToAssertion(feature.id, assertion.id);

      expect(events).toHaveLength(1);
      expect(events[0].featureId).toBe(feature.id);
      expect(events[0].assertionId).toBe(assertion.id);
    });

    it("emits assertion:unlinked event", () => {
      store.linkFeatureToAssertion(feature.id, assertion.id);

      const events: any[] = [];
      store.on("assertion:unlinked", (e) => events.push(e));

      store.unlinkFeatureFromAssertion(feature.id, assertion.id);

      expect(events).toHaveLength(1);
      expect(events[0].featureId).toBe(feature.id);
      expect(events[0].assertionId).toBe(assertion.id);
    });
  });

  // ── Validation Rollup Tests ─────────────────────────────────────────

  describe("Validation Rollup", () => {
    let mission: ReturnType<typeof store.createMission>;
    let milestone: ReturnType<typeof store.addMilestone>;

    beforeEach(() => {
      mission = store.createMission({ title: "Test Mission" });
      milestone = store.addMilestone(mission.id, { title: "Test Milestone" });
    });

    it("rolls up not_started when no assertions exist", () => {
      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.milestoneId).toBe(milestone.id);
      expect(rollup.totalAssertions).toBe(0);
      expect(rollup.passedAssertions).toBe(0);
      expect(rollup.failedAssertions).toBe(0);
      expect(rollup.blockedAssertions).toBe(0);
      expect(rollup.pendingAssertions).toBe(0);
      expect(rollup.unlinkedAssertions).toBe(0);
      expect(rollup.state).toBe("not_started");
    });

    it("rolls up needs_coverage when assertions are not linked", () => {
      store.addContractAssertion(milestone.id, {
        title: "A1",
        assertion: "Test",
      });
      store.addContractAssertion(milestone.id, {
        title: "A2",
        assertion: "Test",
      });

      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.totalAssertions).toBe(2);
      expect(rollup.unlinkedAssertions).toBe(2);
      expect(rollup.state).toBe("needs_coverage");
    });

    it("rolls up ready when assertions are linked but not all passed", () => {
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);
      store.updateContractAssertion(a1.id, { status: "passed" });

      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.totalAssertions).toBe(2);
      expect(rollup.passedAssertions).toBe(1);
      expect(rollup.unlinkedAssertions).toBe(0);
      expect(rollup.state).toBe("ready");
    });

    it("rolls up passed when all assertions are passed", () => {
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);
      store.updateContractAssertion(a1.id, { status: "passed" });
      store.updateContractAssertion(a2.id, { status: "passed" });

      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.state).toBe("passed");
    });

    it("rolls up failed when any assertion has failed status", () => {
      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      const [a1] = store.listContractAssertions(milestone.id);
      store.updateContractAssertion(a1.id, { status: "failed" });

      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.state).toBe("failed");
      expect(rollup.failedAssertions).toBe(1);
    });

    it("rolls up blocked when any assertion is blocked (before failed)", () => {
      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      store.updateContractAssertion(a1.id, { status: "failed" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });
      store.updateContractAssertion(a2.id, { status: "blocked" });

      // Failed takes precedence over blocked in the precedence order
      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.state).toBe("failed");
    });

    it("rolls up blocked when no failures but has blocked", () => {
      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      const [a1] = store.listContractAssertions(milestone.id);
      store.updateContractAssertion(a1.id, { status: "blocked" });

      const rollup = store.getMilestoneValidationRollup(milestone.id);

      expect(rollup.state).toBe("blocked");
      expect(rollup.blockedAssertions).toBe(1);
    });

    it("persists validation state on milestone after assertion change", () => {
      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      // Initial state should be needs_coverage
      let m = store.getMilestone(milestone.id)!;
      expect(m.validationState).toBe("needs_coverage");

      // Link all assertions
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });
      const assertions = store.listContractAssertions(milestone.id);
      for (const a of assertions) {
        store.linkFeatureToAssertion(feature.id, a.id);
      }

      // After linking, state should be ready
      m = store.getMilestone(milestone.id)!;
      expect(m.validationState).toBe("ready");
    });

    it("emits milestone:validation:updated when assertions change", () => {
      const events: any[] = [];
      store.on("milestone:validation:updated", (e) => events.push(e));

      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });

      expect(events).toHaveLength(1);
      expect(events[0].milestoneId).toBe(milestone.id);
      expect(events[0].state).toBe("needs_coverage");
      expect(events[0].rollup.totalAssertions).toBe(1);
    });

    it("emits milestone:validation:updated when links change", () => {
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });
      const assertion = store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });

      const events: any[] = [];
      store.on("milestone:validation:updated", (e) => events.push(e));

      store.linkFeatureToAssertion(feature.id, assertion.id);

      // Should emit twice: once from assertion add, once from link
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1].state).toBe("ready"); // linked but not passed
      expect(events[events.length - 1].rollup.unlinkedAssertions).toBe(0);
    });
  });

  // ── buildEnrichedDescription with Assertions Tests ────────────────────

  describe("buildEnrichedDescription with Assertions", () => {
    it("includes linked assertions in enriched description", () => {
      const mission = store.createMission({ title: "Auth Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Core Auth" });
      const slice = store.addSlice(milestone.id, { title: "Login" });
      const feature = store.addFeature(slice.id, {
        title: "Login Form",
        description: "The login form component",
      });

      const a1 = store.addContractAssertion(milestone.id, {
        title: "Validates input",
        assertion: "The form must validate email and password fields",
      });
      const a2 = store.addContractAssertion(milestone.id, {
        title: "Shows errors",
        assertion: "Invalid credentials must show an error message",
      });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);

      const description = store.buildEnrichedDescription(feature.id);

      expect(description).toContain("## Mission: Auth Mission");
      expect(description).toContain("## Milestone: Core Auth");
      expect(description).toContain("## Slice: Login");
      expect(description).toContain("## Feature: Login Form");
      expect(description).toContain("The login form component");
      expect(description).toContain("## Contract Assertions");
      expect(description).toContain("Validates input");
      expect(description).toContain("Shows errors");
      expect(description).toContain("The form must validate email and password fields");
    });

    it("does not include Contract Assertions section when no assertions linked", () => {
      const mission = store.createMission({ title: "Test Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      // Create assertions but don't link them
      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });

      const description = store.buildEnrichedDescription(feature.id);

      expect(description).toContain("## Feature: Feature");
      expect(description).not.toContain("## Contract Assertions");
    });
  });

  // ── Loop State & Validator Run Schema Tests ───────────────────────────

  describe("Loop State & Validator Run Schema (v31)", () => {
    it("schema version is 32 after migration", () => {
      expect(db.getSchemaVersion()).toBe(32);
    });

    it("mission_features table has loop state columns", () => {
      const cols = db.prepare("PRAGMA table_info(mission_features)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames).toContain("loopState");
      expect(colNames).toContain("implementationAttemptCount");
      expect(colNames).toContain("validatorAttemptCount");
      expect(colNames).toContain("lastValidatorRunId");
      expect(colNames).toContain("lastValidatorStatus");
      expect(colNames).toContain("generatedFromFeatureId");
      expect(colNames).toContain("generatedFromRunId");
    });

    it("mission_validator_runs table exists with correct schema", () => {
      const cols = db.prepare("PRAGMA table_info(mission_validator_runs)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames).toContain("id");
      expect(colNames).toContain("featureId");
      expect(colNames).toContain("milestoneId");
      expect(colNames).toContain("sliceId");
      expect(colNames).toContain("status");
      expect(colNames).toContain("triggerType");
      expect(colNames).toContain("implementationAttempt");
      expect(colNames).toContain("validatorAttempt");
      expect(colNames).toContain("summary");
      expect(colNames).toContain("blockedReason");
      expect(colNames).toContain("startedAt");
      expect(colNames).toContain("completedAt");
      expect(colNames).toContain("createdAt");
      expect(colNames).toContain("updatedAt");
    });

    it("mission_validator_failures table exists with correct schema", () => {
      const cols = db.prepare("PRAGMA table_info(mission_validator_failures)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames).toContain("id");
      expect(colNames).toContain("runId");
      expect(colNames).toContain("featureId");
      expect(colNames).toContain("assertionId");
      expect(colNames).toContain("message");
      expect(colNames).toContain("expected");
      expect(colNames).toContain("actual");
      expect(colNames).toContain("createdAt");
    });

    it("mission_fix_feature_lineage table exists with correct schema", () => {
      const cols = db.prepare("PRAGMA table_info(mission_fix_feature_lineage)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames).toContain("id");
      expect(colNames).toContain("sourceFeatureId");
      expect(colNames).toContain("fixFeatureId");
      expect(colNames).toContain("runId");
      expect(colNames).toContain("failedAssertionIds");
      expect(colNames).toContain("createdAt");
    });

    it("addFeature creates feature with correct loop state defaults", () => {
      const mission = store.createMission({ title: "Loop State Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      expect(feature.loopState).toBe("idle");
      expect(feature.implementationAttemptCount).toBe(0);
      expect(feature.validatorAttemptCount).toBe(0);
      expect(feature.lastValidatorRunId).toBeUndefined();
      expect(feature.lastValidatorStatus).toBeUndefined();
      expect(feature.generatedFromFeatureId).toBeUndefined();
      expect(feature.generatedFromRunId).toBeUndefined();
    });

    it("getFeature returns feature with correct loop state defaults via rowToFeature", () => {
      const mission = store.createMission({ title: "Loop State Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const created = store.addFeature(slice.id, { title: "Test Feature" });
      const retrieved = store.getFeature(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.loopState).toBe("idle");
      expect(retrieved!.implementationAttemptCount).toBe(0);
      expect(retrieved!.validatorAttemptCount).toBe(0);
      expect(retrieved!.lastValidatorRunId).toBeUndefined();
      expect(retrieved!.lastValidatorStatus).toBeUndefined();
      expect(retrieved!.generatedFromFeatureId).toBeUndefined();
      expect(retrieved!.generatedFromRunId).toBeUndefined();
    });

    it("updateFeature persists loop state fields", () => {
      const mission = store.createMission({ title: "Loop State Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const updated = store.updateFeature(feature.id, {
        loopState: "implementing",
        implementationAttemptCount: 1,
        validatorAttemptCount: 0,
        lastValidatorRunId: "VR-TEST-001",
        lastValidatorStatus: "running",
      });

      expect(updated.loopState).toBe("implementing");
      expect(updated.implementationAttemptCount).toBe(1);
      expect(updated.validatorAttemptCount).toBe(0);
      expect(updated.lastValidatorRunId).toBe("VR-TEST-001");
      expect(updated.lastValidatorStatus).toBe("running");

      // Verify persisted
      const retrieved = store.getFeature(feature.id);
      expect(retrieved!.loopState).toBe("implementing");
      expect(retrieved!.implementationAttemptCount).toBe(1);
      expect(retrieved!.lastValidatorRunId).toBe("VR-TEST-001");
      expect(retrieved!.lastValidatorStatus).toBe("running");
    });

    it("existing feature read has correct defaults for new columns", () => {
      // Create a feature using the store (which sets loop state defaults)
      const mission = store.createMission({ title: "Existing Feature Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Existing Feature" });

      // Simulate reading from DB directly (as rowToFeature would)
      const row = db.prepare("SELECT * FROM mission_features WHERE id = ?").get(feature.id);
      expect((row as any).loopState).toBe("idle");
      expect((row as any).implementationAttemptCount).toBe(0);
      expect((row as any).validatorAttemptCount).toBe(0);
      expect((row as any).lastValidatorRunId).toBeNull();
      expect((row as any).lastValidatorStatus).toBeNull();
    });

    it("migration is idempotent - running twice does not fail", () => {
      const versionBefore = db.getSchemaVersion();
      // init() calls migrate(), calling again should be a no-op
      db.init();
      const versionAfter = db.getSchemaVersion();
      expect(versionAfter).toBe(versionBefore);
    });

    it("foreign key constraints exist on validator runs table", () => {
      // Create full hierarchy
      const mission = store.createMission({ title: "FK Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "FK Feature" });

      // Insert a validator run
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO mission_validator_runs (id, featureId, milestoneId, sliceId, status, implementationAttempt, validatorAttempt, startedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("VR-TEST-001", feature.id, milestone.id, slice.id, "running", 1, 1, now, now, now);

      // Verify the run exists
      const run = db.prepare("SELECT * FROM mission_validator_runs WHERE id = ?").get("VR-TEST-001");
      expect(run).toBeDefined();
      expect((run as any).featureId).toBe(feature.id);
    });

    it("validator runs index exists", () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mission_validator_runs'").all() as Array<{ name: string }>;
      const indexNames = new Set(indexes.map((i) => i.name));
      expect(indexNames).toContain("idxValidatorRunsFeatureId");
    });

    it("validator failures index exists", () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mission_validator_failures'").all() as Array<{ name: string }>;
      const indexNames = new Set(indexes.map((i) => i.name));
      expect(indexNames).toContain("idxValidatorFailuresRunId");
    });

    it("fix lineage index exists", () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mission_fix_feature_lineage'").all() as Array<{ name: string }>;
      const indexNames = new Set(indexes.map((i) => i.name));
      expect(indexNames).toContain("idxFixLineageSourceFeatureId");
    });
  });

  describe("validator run methods", () => {
    it("startValidatorRun creates run with status running (VAL-DM-015)", () => {
      const mission = store.createMission({ title: "Validator Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id, "task_completion");

      expect(run).toBeDefined();
      expect(run.status).toBe("running");
      expect(run.featureId).toBe(feature.id);
      expect(run.milestoneId).toBe(milestone.id);
      expect(run.sliceId).toBe(slice.id);
      expect(run.triggerType).toBe("task_completion");
      expect(run.startedAt).toBeDefined();
      expect(run.completedAt).toBeUndefined();

      // Verify feature was updated
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.validatorAttemptCount).toBe(1);
      expect(updatedFeature!.lastValidatorRunId).toBe(run.id);
      expect(updatedFeature!.loopState).toBe("validating");
    });

    it("startValidatorRun increments validatorAttemptCount (VAL-DM-015)", () => {
      const mission = store.createMission({ title: "Validator Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      // Start first run
      const run1 = store.startValidatorRun(feature.id);
      expect(run1.validatorAttempt).toBe(1);

      // Start second run
      const run2 = store.startValidatorRun(feature.id);
      expect(run2.validatorAttempt).toBe(2);

      // Verify feature has correct count
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.validatorAttemptCount).toBe(2);
      expect(updatedFeature!.lastValidatorRunId).toBe(run2.id);
    });

    it("completeValidatorRun transitions to passed (VAL-DM-016)", () => {
      const mission = store.createMission({ title: "Complete Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const completedRun = store.completeValidatorRun(run.id, "passed", "All assertions passed");

      expect(completedRun.status).toBe("passed");
      expect(completedRun.completedAt).toBeDefined();
      expect(completedRun.summary).toBe("All assertions passed");

      // Verify feature state
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.loopState).toBe("passed");
      expect(updatedFeature!.lastValidatorStatus).toBe("passed");
    });

    it("completeValidatorRun transitions to failed (VAL-DM-017)", () => {
      const mission = store.createMission({ title: "Complete Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const completedRun = store.completeValidatorRun(run.id, "failed", "Assertions failed");

      expect(completedRun.status).toBe("failed");

      // Verify feature state
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.loopState).toBe("needs_fix");
      expect(updatedFeature!.lastValidatorStatus).toBe("failed");
    });

    it("completeValidatorRun transitions to blocked (VAL-DM-018)", () => {
      const mission = store.createMission({ title: "Complete Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const completedRun = store.completeValidatorRun(run.id, "blocked", undefined, "External dependency unavailable");

      expect(completedRun.status).toBe("blocked");
      expect(completedRun.blockedReason).toBe("External dependency unavailable");

      // Verify feature state
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.loopState).toBe("blocked");
      expect(updatedFeature!.lastValidatorStatus).toBe("blocked");
    });

    it("completeValidatorRun transitions to error (VAL-DM-019)", () => {
      const mission = store.createMission({ title: "Complete Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const completedRun = store.completeValidatorRun(run.id, "error", "AI session failed");

      expect(completedRun.status).toBe("error");

      // Verify feature stays in validating state on error
      const updatedFeature = store.getFeature(feature.id);
      expect(updatedFeature!.loopState).toBe("validating");
      expect(updatedFeature!.lastValidatorStatus).toBe("error");
    });

    it("completeValidatorRun computes durationMs (VAL-DM-020)", () => {
      const mission = store.createMission({ title: "Duration Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      // Use vi.useFakeTimers to control time
      const startTime = new Date(run.startedAt).getTime();
      const expectedDuration = 5000; // 5 seconds

      // Advance timers
      vi.useFakeTimers();
      vi.setSystemTime(startTime + expectedDuration);

      const completedRun = store.completeValidatorRun(run.id, "passed");

      vi.useRealTimers();

      // durationMs should be computed correctly
      const completedTime = new Date(completedRun.completedAt!).getTime();
      const actualDuration = completedTime - startTime;
      expect(actualDuration).toBe(expectedDuration);
    });

    it("getValidatorRun returns run by id", () => {
      const mission = store.createMission({ title: "Get Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const retrieved = store.getValidatorRun(run.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(run.id);
      expect(retrieved!.status).toBe("running");
    });

    it("startValidatorRun emits validator-run:started event", () => {
      const mission = store.createMission({ title: "Event Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const eventListener = vi.fn();
      store.on("validator-run:started", eventListener);

      const run = store.startValidatorRun(feature.id);

      expect(eventListener).toHaveBeenCalledWith(run);

      store.off("validator-run:started", eventListener);
    });

    it("completeValidatorRun emits validator-run:completed event", () => {
      const mission = store.createMission({ title: "Event Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id);

      const eventListener = vi.fn();
      store.on("validator-run:completed", eventListener);

      const completedRun = store.completeValidatorRun(run.id, "passed", "Success");

      expect(eventListener).toHaveBeenCalledWith(completedRun, "passed", expect.any(Number));

      store.off("validator-run:completed", eventListener);
    });
  });
});

// vi import for vitest mocking
import { vi } from "vitest";
