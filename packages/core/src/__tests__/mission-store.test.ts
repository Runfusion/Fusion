import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MissionStore, deriveMilestoneAcceptanceCriteriaFromFeatures } from "../mission-store.js";
import { GoalStore } from "../goal-store.js";
import { Database } from "../db.js";
import type { MissionFeature } from "../mission-types.js";
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
  options?: { column?: string; deletedAt?: string | null },
): void {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO tasks (id, description, "column", status, createdAt, updatedAt, "deletedAt") VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, description, options?.column ?? "triage", status ?? null, now, now, options?.deletedAt ?? null);
}

function createGoalInDb(database: Database, goalId: string, title = "Test goal"): void {
  const now = new Date().toISOString();
  database.prepare(
    "INSERT INTO goals (id, title, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(goalId, title, null, "active", now, now);
}

describe("MissionStore", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: MissionStore;
  let goalStore: GoalStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    // In-memory SQLite for test speed — see store.test.ts beforeEach for
    // the broader rationale. MissionStore tests don't exercise
    // cross-instance persistence, so this is safe across the whole file.
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new MissionStore(fusionDir, db);
    goalStore = new GoalStore(fusionDir, db);
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

    it("ignores autopilotEnabled on create and persists stopped defaults", () => {
      const mission = store.createMission({
        title: "Stopped by default",
        autopilotEnabled: true,
      });

      expect(mission.autopilotEnabled).toBe(false);
      expect(mission.autoAdvance).toBe(false);
      expect(mission.status).toBe("planning");
      expect(mission.autopilotState).toBe("inactive");

      const persisted = store.getMission(mission.id);
      expect(persisted?.autopilotEnabled).toBe(false);
      expect(persisted?.autoAdvance).toBe(false);
      expect(persisted?.status).toBe("planning");
      expect(persisted?.autopilotState).toBe("inactive");
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

    it("round-trips mission branchStrategy on create", () => {
      const mission = store.createMission({
        title: "Branch strategy",
        branchStrategy: { mode: "custom-new", branchName: "feature/mission" },
      });

      const fetched = store.getMission(mission.id);
      expect(fetched?.branchStrategy).toEqual({ mode: "custom-new", branchName: "feature/mission" });
    });

    it("updates mission branchStrategy", () => {
      const mission = store.createMission({ title: "Original" });
      const updated = store.updateMission(mission.id, {
        branchStrategy: { mode: "auto-per-task" },
      });

      expect(updated.branchStrategy).toEqual({ mode: "auto-per-task" });
      expect(store.getMission(mission.id)?.branchStrategy).toEqual({ mode: "auto-per-task" });
    });

    it("reads undefined branchStrategy for legacy and corrupt rows", () => {
      const mission = store.createMission({ title: "Legacy row" });
      db.prepare("UPDATE missions SET branchStrategy = NULL WHERE id = ?").run(mission.id);
      expect(store.getMission(mission.id)?.branchStrategy).toBeUndefined();

      db.prepare("UPDATE missions SET branchStrategy = ? WHERE id = ?").run("{not-json", mission.id);
      expect(store.getMission(mission.id)?.branchStrategy).toBeUndefined();
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
        linkedGoalCount: 0,
        eventCount: 0,
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

    it("getMissionSummary reports linked goal counts", () => {
      const mission = store.createMission({ title: "Goal-linked mission" });
      createGoalInDb(db, "G-001", "North Star");
      createGoalInDb(db, "G-002", "Reliability");

      expect(store.getMissionSummary(mission.id).linkedGoalCount).toBe(0);

      store.linkGoal(mission.id, "G-001");
      store.linkGoal(mission.id, "G-002");

      expect(store.getMissionSummary(mission.id).linkedGoalCount).toBe(2);
    });

    it("getMissionSummary reports unfiltered event counts", () => {
      const mission = store.createMission({ title: "Eventful mission" });

      expect(store.getMissionSummary(mission.id).eventCount).toBe(0);

      store.logMissionEvent(mission.id, "mission_started", "started");
      store.logMissionEvent(mission.id, "warning", "warning");
      store.logMissionEvent(mission.id, "error", "error");

      expect(store.getMissionSummary(mission.id).eventCount).toBe(3);
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
      // Mission 1: 2 milestones, 2 features (1 done after F2 is added to prevent premature milestone completion)
      // Note: When F1 is set to done, SL1 becomes complete and ms1a becomes complete. Adding F2 after makes SL1 active again.
      const m1 = store.createMission({ title: "Mission 1" });
      const ms1a = store.addMilestone(m1.id, { title: "MS1a" });
      const ms1b = store.addMilestone(m1.id, { title: "MS1b" });
      store.updateMilestone(ms1b.id, { status: "complete" });
      const sl1 = store.addSlice(ms1a.id, { title: "SL1" });
      const f1 = store.addFeature(sl1.id, { title: "F1" });
      const f2 = store.addFeature(sl1.id, { title: "F2" });
      // f2 not done - set f1 to done AFTER f2 is created to prevent premature completion
      store.updateFeature(f1.id, { status: "done" });

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
        linkedGoalCount: 0,
        eventCount: 0,
        progressPercent: 0,
      });

      // Mission 2: 1 milestone, 0 features → 0%
      const mission2 = result.find((m) => m.title === "Mission 2")!;
      expect(mission2.summary).toEqual({
        totalMilestones: 1,
        completedMilestones: 0,
        totalFeatures: 0,
        completedFeatures: 0,
        linkedGoalCount: 0,
        eventCount: 0,
        progressPercent: 0,
      });

      // Mission 1: 2 milestones (1 complete), 2 features (1 done) → 50%
      const mission1 = result.find((m) => m.title === "Mission 1")!;
      expect(mission1.summary).toEqual({
        totalMilestones: 2,
        completedMilestones: 1,
        totalFeatures: 2,
        completedFeatures: 1,
        linkedGoalCount: 0,
        eventCount: 0,
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
      store.addFeature(slice.id, { title: "F3" });
      createGoalInDb(db, "G-003", "North Star");
      createGoalInDb(db, "G-004", "Reliability");
      store.linkGoal(mission.id, "G-003");
      store.linkGoal(mission.id, "G-004");
      store.logMissionEvent(mission.id, "mission_started", "started");
      store.logMissionEvent(mission.id, "warning", "warning");

      const singleSummary = store.getMissionSummary(mission.id);
      const batchedResult = store.listMissionsWithSummaries().find((m) => m.id === mission.id)!;

      expect(batchedResult.summary.totalMilestones).toBe(singleSummary.totalMilestones);
      expect(batchedResult.summary.completedMilestones).toBe(singleSummary.completedMilestones);
      expect(batchedResult.summary.totalFeatures).toBe(singleSummary.totalFeatures);
      expect(batchedResult.summary.completedFeatures).toBe(singleSummary.completedFeatures);
      expect(batchedResult.summary.linkedGoalCount).toBe(singleSummary.linkedGoalCount);
      expect(batchedResult.summary.eventCount).toBe(singleSummary.eventCount);
      expect(batchedResult.summary.progressPercent).toBe(singleSummary.progressPercent);
    });

    it("preserves persisted interviewState when listing missions with summaries", () => {
      const interviewMission = store.createMission({ title: "Interview mission" });
      store.updateMissionInterviewState(interviewMission.id, "in_progress");

      const listed = store.listMissionsWithSummaries().find((mission) => mission.id === interviewMission.id);

      expect(listed).toBeDefined();
      expect(listed?.interviewState).toBe("in_progress");
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

    it("getMissionEvents supports pagination, filtering, and newest-first ordering", () => {
      const mission = store.createMission({ title: "Events mission" });

      const first = store.logMissionEvent(mission.id, "mission_started", "first");
      const second = store.logMissionEvent(mission.id, "warning", "second warning");
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

    it("persists milestone acceptance criteria on create", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, {
        title: "Original",
        acceptanceCriteria: "Ship all phase outputs",
      });

      const fetched = store.getMilestone(milestone.id);
      expect(fetched?.acceptanceCriteria).toBe("Ship all phase outputs");
    });

    it("updates milestone acceptance criteria and persists across reopen", () => {
      const fileDb = new Database(fusionDir);
      fileDb.init();
      const fileStore = new MissionStore(fusionDir, fileDb);

      const mission = fileStore.createMission({ title: "Parent" });
      const milestone = fileStore.addMilestone(mission.id, { title: "Original" });
      fileStore.updateMilestone(milestone.id, { acceptanceCriteria: "All validators pass" });

      fileDb.close();

      const reopenedDb = new Database(fusionDir);
      reopenedDb.init();
      const reopenedStore = new MissionStore(fusionDir, reopenedDb);
      const reopened = reopenedStore.getMilestone(milestone.id);

      expect(reopened?.acceptanceCriteria).toBe("All validators pass");
      reopenedDb.close();
    });

    it("partial milestone acceptance criteria update preserves other fields", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, {
        title: "Original",
        description: "Phase 1",
        verification: "Run smoke tests",
      });

      const updated = store.updateMilestone(milestone.id, {
        acceptanceCriteria: "Phase complete when smoke tests pass",
      });

      expect(updated.title).toBe("Original");
      expect(updated.description).toBe("Phase 1");
      expect(updated.verification).toBe("Run smoke tests");
      expect(updated.acceptanceCriteria).toBe("Phase complete when smoke tests pass");
    });

    it("clears milestone acceptance criteria when updated with undefined", () => {
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, {
        title: "Original",
        acceptanceCriteria: "Initial criteria",
      });

      const updated = store.updateMilestone(milestone.id, { acceptanceCriteria: undefined });
      const fetched = store.getMilestone(milestone.id);

      expect(updated.acceptanceCriteria).toBeUndefined();
      expect(fetched?.acceptanceCriteria).toBeUndefined();
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

  describe("milestone acceptance criteria derivation", () => {
    const makeFeature = (overrides: Partial<MissionFeature>): MissionFeature => ({
      id: "F-1",
      sliceId: "SL-1",
      title: "Feature",
      status: "defined",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    });

    it("derives milestone acceptance from feature acceptance criteria", () => {
      const derived = deriveMilestoneAcceptanceCriteriaFromFeatures([
        makeFeature({ title: "Login", acceptanceCriteria: "  Auth succeeds  " }),
      ]);

      expect(derived).toBe("- Login: Auth succeeds");
    });

    it("falls back to feature description when acceptance criteria is blank", () => {
      const derived = deriveMilestoneAcceptanceCriteriaFromFeatures([
        makeFeature({ title: "Login", acceptanceCriteria: "   ", description: "  Works across browsers " }),
      ]);

      expect(derived).toBe("- Login: Works across browsers");
    });

    it("skips features without acceptance text and returns undefined when none contribute", () => {
      const derived = deriveMilestoneAcceptanceCriteriaFromFeatures([
        makeFeature({ title: "Login", acceptanceCriteria: "", description: "   " }),
      ]);

      expect(derived).toBeUndefined();
    });

    it("does not overwrite explicit milestone acceptance criteria", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, {
        title: "Milestone",
        acceptanceCriteria: "Explicit criteria",
      });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      store.addFeature(slice.id, {
        title: "Feature",
        acceptanceCriteria: "Feature criteria",
      });

      const updated = store.applyDerivedMilestoneAcceptanceCriteria(milestone.id);
      expect(updated.acceptanceCriteria).toBe("Explicit criteria");
    });

    it("preserves explicit milestone criteria when re-applied after feature changes", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, {
        title: "Feature",
        acceptanceCriteria: "Initial acceptance",
      });

      const firstDerived = store.applyDerivedMilestoneAcceptanceCriteria(milestone.id);
      expect(firstDerived.acceptanceCriteria).toBe("- Feature: Initial acceptance");

      store.updateMilestone(milestone.id, { acceptanceCriteria: "Manual lock" });
      store.updateFeature(feature.id, { acceptanceCriteria: "Changed acceptance" });

      const preserved = store.applyDerivedMilestoneAcceptanceCriteria(milestone.id);
      expect(preserved.acceptanceCriteria).toBe("Manual lock");
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

    it("deletes a feature when no task is linked", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "To Delete" });
      store.deleteFeature(feature.id);

      const retrieved = store.getFeature(feature.id);
      expect(retrieved).toBeUndefined();
    });

    it("blocks delete when feature is linked to a live task", () => {
      createTaskInDb(db, "FN-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Guarded" });
      store.linkFeatureToTask(feature.id, "FN-001");

      expect(() => store.deleteFeature(feature.id)).toThrow(
        `Feature ${feature.id} is linked to task FN-001; pass force to delete anyway`,
      );
      expect(store.getFeature(feature.id)).toBeDefined();
    });

    it("deletes linked feature with force and keeps task row", () => {
      createTaskInDb(db, "FN-001");

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Force Delete" });
      store.linkFeatureToTask(feature.id, "FN-001");

      store.deleteFeature(feature.id, true);

      expect(store.getFeature(feature.id)).toBeUndefined();
      const taskRow = db.prepare("SELECT id, missionId, sliceId FROM tasks WHERE id = ?").get("FN-001") as {
        id: string;
        missionId: string | null;
        sliceId: string | null;
      };
      expect(taskRow.id).toBe("FN-001");
      expect(taskRow.missionId).toBeNull();
      expect(taskRow.sliceId).toBeNull();
    });

    it("allows delete without force when linked task is archived", () => {
      createTaskInDb(db, "FN-ARCHIVE", "Archived", undefined, { column: "archived" });

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Archived Link" });
      store.updateFeature(feature.id, { taskId: "FN-ARCHIVE", status: "triaged" });

      store.deleteFeature(feature.id);
      expect(store.getFeature(feature.id)).toBeUndefined();
    });

    it("allows delete without force when linked task is soft-deleted", () => {
      createTaskInDb(db, "FN-DELETED", "Deleted", undefined, { deletedAt: new Date().toISOString() });

      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Deleted Link" });
      store.updateFeature(feature.id, { taskId: "FN-DELETED", status: "triaged" });

      store.deleteFeature(feature.id);
      expect(store.getFeature(feature.id)).toBeUndefined();
    });

    it("throws not found on second delete", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Idempotent" });

      store.deleteFeature(feature.id);
      expect(() => store.deleteFeature(feature.id)).toThrow(`Feature ${feature.id} not found`);
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

    it("throws a clear error when linking to a task not on the active board", () => {
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Linkable" });

      expect(() => store.linkFeatureToTask(feature.id, "FN-ARCHIVED")).toThrow(
        `Cannot link feature ${feature.id} to task FN-ARCHIVED: task is not on the active board (it may be archived, deleted, or never existed). Only active tasks can be linked to features.`,
      );

      const unchanged = store.getFeature(feature.id)!;
      expect(unchanged.taskId).toBeUndefined();
      expect(unchanged.status).toBe("defined");
      expect(unchanged.loopState).toBe("idle");
      expect(unchanged.implementationAttemptCount).toBe(0);
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

    it("blocks milestone delete when child feature links to live task", () => {
      createTaskInDb(db, "FN-LIVE");
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Child" });
      const slice = store.addSlice(milestone.id, { title: "Grandchild" });
      const feature = store.addFeature(slice.id, { title: "Guarded" });
      store.linkFeatureToTask(feature.id, "FN-LIVE");

      expect(() => store.deleteMilestone(milestone.id)).toThrow("pass force to delete anyway");
      expect(store.getMilestone(milestone.id)).toBeDefined();
    });

    it("force deletes milestone with linked features", () => {
      createTaskInDb(db, "FN-LIVE");
      const mission = store.createMission({ title: "Parent" });
      const milestone = store.addMilestone(mission.id, { title: "Child" });
      const slice = store.addSlice(milestone.id, { title: "Grandchild" });
      const feature = store.addFeature(slice.id, { title: "Guarded" });
      store.linkFeatureToTask(feature.id, "FN-LIVE");

      store.deleteMilestone(milestone.id, true);
      expect(store.getMilestone(milestone.id)).toBeUndefined();
      const taskRow = db.prepare("SELECT id, missionId, sliceId FROM tasks WHERE id = ?").get("FN-LIVE") as {
        id: string;
        missionId: string | null;
        sliceId: string | null;
      };
      expect(taskRow.id).toBe("FN-LIVE");
      expect(taskRow.missionId).toBeNull();
      expect(taskRow.sliceId).toBeNull();
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

    it("blocks slice delete when child feature links to live task", () => {
      createTaskInDb(db, "FN-SLICE");
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Guarded" });
      store.linkFeatureToTask(feature.id, "FN-SLICE");

      expect(() => store.deleteSlice(slice.id)).toThrow("pass force to delete anyway");
      expect(store.getSlice(slice.id)).toBeDefined();
    });

    it("force deletes slice with linked features", () => {
      createTaskInDb(db, "FN-SLICE");
      const mission = store.createMission({ title: "Mission" });
      const milestone = store.addMilestone(mission.id, { title: "Milestone" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Guarded" });
      store.linkFeatureToTask(feature.id, "FN-SLICE");

      store.deleteSlice(slice.id, true);
      expect(store.getSlice(slice.id)).toBeUndefined();
      const taskRow = db.prepare("SELECT id, missionId, sliceId FROM tasks WHERE id = ?").get("FN-SLICE") as {
        id: string;
        missionId: string | null;
        sliceId: string | null;
      };
      expect(taskRow.id).toBe("FN-SLICE");
      expect(taskRow.missionId).toBeNull();
      expect(taskRow.sliceId).toBeNull();
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

      it("does not complete slice when done feature has linked assertions without validator pass", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const feature = store.addFeature(slice.id, { title: "Feature" });

        const assertion = store.addContractAssertion(milestone.id, {
          title: "AC",
          assertion: "Must pass",
        });
        store.linkFeatureToAssertion(feature.id, assertion.id);

        store.transitionLoopState(feature.id, "implementing");
        store.updateFeature(feature.id, { status: "done" });
        expect(store.computeSliceStatus(slice.id)).toBe("pending");

        store.updateFeature(feature.id, { lastValidatorStatus: "passed" });
        expect(store.computeSliceStatus(slice.id)).toBe("complete");
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

    describe("updateFeature status cascade", () => {
      it("updateFeature with status change triggers slice and milestone recompute", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const feature = store.addFeature(slice.id, { title: "Feature" });

        // Initially milestone should be "planning"
        expect(store.computeMilestoneStatus(milestone.id)).toBe("planning");

        // Update feature status to triaged (without taskId change)
        store.updateFeature(feature.id, { status: "triaged" });

        // Milestone should now be "active" since a feature has status triaged
        expect(store.computeMilestoneStatus(milestone.id)).toBe("active");
      });

      it("updateFeature status change without taskId change still cascades to slice status", () => {
        createTaskInDb(db, "FN-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const f1 = store.addFeature(slice.id, { title: "F1" });
        const f2 = store.addFeature(slice.id, { title: "F2" });

        // Link features to task (makes slice active)
        store.linkFeatureToTask(f1.id, "FN-001");
        createTaskInDb(db, "FN-002");
        store.linkFeatureToTask(f2.id, "FN-002");

        // Both slices should be active
        expect(store.computeSliceStatus(slice.id)).toBe("active");
        expect(store.computeMilestoneStatus(milestone.id)).toBe("active");

        // Update f1 status to done (not changing taskId)
        store.updateFeature(f1.id, { status: "done", lastValidatorStatus: "passed" });

        // Slice should still be "active" (partial completion)
        expect(store.computeSliceStatus(slice.id)).toBe("active");

        // Update f2 status to done
        store.updateFeature(f2.id, { status: "done", lastValidatorStatus: "passed" });

        // Now slice should be "complete"
        expect(store.computeSliceStatus(slice.id)).toBe("complete");
        expect(store.computeMilestoneStatus(milestone.id)).toBe("complete");
      });

      it("milestone status transitions correctly through the full lifecycle", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const f1 = store.addFeature(slice.id, { title: "F1" });
        const f2 = store.addFeature(slice.id, { title: "F2" });
        const f3 = store.addFeature(slice.id, { title: "F3" });

        // Initially: milestone is "planning", slice is "pending"
        expect(store.computeMilestoneStatus(milestone.id)).toBe("planning");
        expect(store.computeSliceStatus(slice.id)).toBe("pending");

        // Link first feature to task → milestone should become "active"
        createTaskInDb(db, "FN-001");
        store.linkFeatureToTask(f1.id, "FN-001");
        expect(store.computeMilestoneStatus(milestone.id)).toBe("active");

        // Link second feature to task → milestone stays "active"
        createTaskInDb(db, "FN-002");
        store.linkFeatureToTask(f2.id, "FN-002");
        expect(store.computeMilestoneStatus(milestone.id)).toBe("active");

        // Mark all features as "done" using updateFeature (not updateFeatureStatus)
        // → milestone should become "complete"
        store.updateFeature(f1.id, { status: "done", lastValidatorStatus: "passed" });
        store.updateFeature(f2.id, { status: "done", lastValidatorStatus: "passed" });
        store.updateFeature(f3.id, { status: "done", lastValidatorStatus: "passed" });

        expect(store.computeMilestoneStatus(milestone.id)).toBe("complete");
      });
    });

    describe("addFeature status cascade", () => {
      it("addFeature triggers status recompute and downgrades slice from complete to pending", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const feature = store.addFeature(slice.id, { title: "Feature" });

        // Initially slice should be pending (one defined feature)
        expect(store.getSlice(slice.id)?.status).toBe("pending");

        // Mark feature done
        store.updateFeature(feature.id, { status: "done" });

        // Slice should now be complete
        expect(store.getSlice(slice.id)?.status).toBe("complete");
        expect(store.getMilestone(milestone.id)?.status).toBe("complete");
        expect(store.getMission(mission.id)?.status).toBe("complete");

        // Add a new feature → slice should downgrade
        const newFeature = store.addFeature(slice.id, { title: "New Feature" });

        // New feature is "defined", so slice should no longer be complete
        expect(newFeature.status).toBe("defined");
        expect(store.getSlice(slice.id)?.status).toBe("pending");
        // Milestone with only "pending" slices becomes "planning"
        expect(store.getMilestone(milestone.id)?.status).toBe("planning");
        // Mission with only "planning" milestones becomes "planning"
        expect(store.getMission(mission.id)?.status).toBe("planning");
      });

      it("adding feature to complete slice downgrades mission from complete to active", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const f1 = store.addFeature(slice.id, { title: "Feature 1" });
        const f2 = store.addFeature(slice.id, { title: "Feature 2" });

        // Both features done → all complete
        store.updateFeature(f1.id, { status: "done" });
        store.updateFeature(f2.id, { status: "done" });

        expect(store.getMission(mission.id)?.status).toBe("complete");

        // Add third feature → mission should no longer be complete
        const f3 = store.addFeature(slice.id, { title: "Feature 3" });
        expect(f3.status).toBe("defined");
        expect(store.getMission(mission.id)?.status).not.toBe("complete");
      });

      it("computeSliceStatus returns pending when features are mixed defined/done", () => {
        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const f1 = store.addFeature(slice.id, { title: "F1" });
        const f2 = store.addFeature(slice.id, { title: "F2" });

        // Mark f1 done (has taskId), f2 stays defined
        store.updateFeature(f1.id, { status: "done" });
        // f2 is still "defined"

        // computeSliceStatus: allDone=false, anyActive=false (no taskId on any feature)
        // → returns "pending"
        const status = store.computeSliceStatus(slice.id);
        expect(status).toBe("pending");
      });

      it("computeSliceStatus returns active when a feature has taskId linked", () => {
        createTaskInDb(db, "FN-001");

        const mission = store.createMission({ title: "Mission" });
        const milestone = store.addMilestone(mission.id, { title: "Milestone" });
        const slice = store.addSlice(milestone.id, { title: "Slice" });
        const f1 = store.addFeature(slice.id, { title: "F1" });
        const f2 = store.addFeature(slice.id, { title: "F2" });

        // f1 has taskId → anyActive=true → slice is "active"
        store.linkFeatureToTask(f1.id, "FN-001");
        // f2 stays "defined"

        const status = store.computeSliceStatus(slice.id);
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
      const linkedGoal = goalStore.createGoal({ title: "Ship linked goal visibility" });
      store.linkGoal(mission.id, linkedGoal.id);
      const m1 = store.addMilestone(mission.id, { title: "Milestone 1" });
      const m2 = store.addMilestone(mission.id, { title: "Milestone 2" });
      const s1 = store.addSlice(m1.id, { title: "Slice 1" });
      const s2 = store.addSlice(m1.id, { title: "Slice 2" });
      const f1 = store.addFeature(s1.id, { title: "Feature 1" });
      const f2 = store.addFeature(s1.id, { title: "Feature 2" });

      const withHierarchy = store.getMissionWithHierarchy(mission.id)!;

      expect(withHierarchy.id).toBe(mission.id);
      expect(withHierarchy.title).toBe("Hierarchy Test");
      expect(withHierarchy.linkedGoals).toEqual([linkedGoal]);
      expect(withHierarchy.milestones).toHaveLength(2);

      const m1Data = withHierarchy.milestones.find((m) => m.id === m1.id)!;
      expect(m1Data.slices).toHaveLength(2);

      const s1Data = m1Data.slices.find((s) => s.id === s1.id)! as import("../mission-types.js").SliceWithFeatures;
      expect(s1Data.features).toHaveLength(2);
      expect(s1Data.features.find((f: import("../mission-types.js").MissionFeature) => f.id === f1.id)).toBeDefined();
      expect(s1Data.features.find((f: import("../mission-types.js").MissionFeature) => f.id === f2.id)).toBeDefined();
    });

    it("returns an empty linkedGoals array when no goals are linked", () => {
      const mission = store.createMission({ title: "Hierarchy without goals" });

      const withHierarchy = store.getMissionWithHierarchy(mission.id)!;

      expect(withHierarchy.linkedGoals).toEqual([]);
    });

    it("reports detail eventCount consistently with mission summaries", () => {
      const mission = store.createMission({ title: "Hierarchy event counts" });

      const emptyHierarchy = store.getMissionWithHierarchy(mission.id)!;
      const emptySummary = store.getMissionSummary(mission.id);
      expect(emptyHierarchy.eventCount).toBe(0);
      expect(emptyHierarchy.eventCount).toBe(emptySummary.eventCount);

      store.logMissionEvent(mission.id, "mission_started", "started");
      store.logMissionEvent(mission.id, "warning", "warning");
      store.logMissionEvent(mission.id, "error", "error");

      const populatedHierarchy = store.getMissionWithHierarchy(mission.id)!;
      const populatedSummary = store.getMissionSummary(mission.id);
      expect(populatedHierarchy.eventCount).toBe(3);
      expect(populatedHierarchy.eventCount).toBe(populatedSummary.eventCount);
    });
  });

  describe("task goal provenance", () => {
    async function createStoreWithTaskStore() {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      return { ts, ms: ts.getMissionStore(), goals: ts.getGoalStore() };
    }

    it("returns empty arrays for unknown and unlinked tasks", async () => {
      const { ts, ms } = await createStoreWithTaskStore();
      const task = await ts.createTask({ title: "Standalone task", description: "No mission link" });

      expect(ms.listGoalIdsForTask("FN-DOES-NOT-EXIST")).toEqual([]);
      expect(ms.listGoalsForTask("FN-DOES-NOT-EXIST")).toEqual([]);
      expect(ms.listGoalIdsForTask(task.id)).toEqual([]);
      expect(ms.listGoalsForTask(task.id)).toEqual([]);
    });

    it("returns an empty array for mission-linked tasks when the mission has no goals", async () => {
      const { ts, ms } = await createStoreWithTaskStore();
      const mission = ms.createMission({ title: "Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      const task = await ts.createTask({ title: "Task", description: "Linked task" });

      ms.linkFeatureToTask(feature.id, task.id);

      expect(ms.listGoalIdsForTask(task.id)).toEqual([]);
      expect(ms.listGoalsForTask(task.id)).toEqual([]);
    });

    it("preserves stable ordering for multiple linked goals and matches hierarchy mapping", async () => {
      const { ts, ms, goals } = await createStoreWithTaskStore();
      const mission = ms.createMission({ title: "Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      const goalA = goals.createGoal({ title: "Goal A" });
      const goalB = goals.createGoal({ title: "Goal B" });

      ms.linkGoal(mission.id, goalA.id);
      ms.linkGoal(mission.id, goalB.id);

      const task = await ts.createTask({ title: "Task", description: "Linked task" });
      ms.linkFeatureToTask(feature.id, task.id);

      expect(ms.listGoalIdsForTask(task.id)).toEqual([goalA.id, goalB.id]);
      expect(ms.listGoalsForTask(task.id)).toEqual(ms.getMissionWithHierarchy(mission.id)?.linkedGoals ?? []);
    });

    it("keeps archived linked goals in task provenance", async () => {
      const { ts, ms, goals } = await createStoreWithTaskStore();
      const mission = ms.createMission({ title: "Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      const goal = goals.createGoal({ title: "Archived goal" });
      ms.linkGoal(mission.id, goal.id);
      const archivedGoal = goals.archiveGoal(goal.id);

      const task = await ts.createTask({ title: "Task", description: "Linked task" });
      ms.linkFeatureToTask(feature.id, task.id);

      expect(ms.listGoalIdsForTask(task.id)).toEqual([goal.id]);
      expect(ms.listGoalsForTask(task.id)).toEqual([archivedGoal]);
    });

    it("falls back through feature linkage when tasks.missionId is unset", async () => {
      const { ts, ms, goals } = await createStoreWithTaskStore();
      const mission = ms.createMission({ title: "Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      const goal = goals.createGoal({ title: "Fallback goal" });
      ms.linkGoal(mission.id, goal.id);

      const task = await ts.createTask({ title: "Task", description: "Linked task" });
      ms.linkFeatureToTask(feature.id, task.id);
      // Clear missionId on THIS test's in-memory TaskStore db (the outer `db`
      // belongs to a different store) so the lookup genuinely exercises the
      // feature-linkage fallback instead of the normal task→mission path.
      (ts as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare("UPDATE tasks SET missionId = NULL WHERE id = ?")
        .run(task.id);

      expect(ms.listGoalIdsForTask(task.id)).toEqual([goal.id]);
      expect(ms.listGoalsForTask(task.id)).toEqual([goal]);
    });

    it("resolves provenance for triaged tasks without storing goal ids on the task row", async () => {
      const { ts, ms, goals } = await createStoreWithTaskStore();
      const goal = goals.createGoal({ title: "Goal title" });
      const mission = ms.createMission({ title: "Mission" });
      ms.linkGoal(mission.id, goal.id);
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature", description: "Desc" });

      const triaged = await ms.triageFeature(feature.id);
      const task = await ts.getTask(triaged.taskId!);

      expect(ms.listGoalsForTask(triaged.taskId!)).toEqual([
        expect.objectContaining({ id: goal.id, title: goal.title }),
      ]);
      expect(task?.missionId).toBe(mission.id);
      expect(task).not.toHaveProperty("goalId");
      expect(task).not.toHaveProperty("goalIds");
    });

    it("resolves provenance identically for manual feature linkage", async () => {
      const { ts, ms, goals } = await createStoreWithTaskStore();
      const goal = goals.createGoal({ title: "Manual goal" });
      const mission = ms.createMission({ title: "Mission" });
      ms.linkGoal(mission.id, goal.id);
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      const task = await ts.createTask({ title: "Manual task", description: "Manual" });

      ms.linkFeatureToTask(feature.id, task.id);

      expect(ms.listGoalIdsForTask(task.id)).toEqual([goal.id]);
      expect(ms.listGoalsForTask(task.id)).toEqual([
        expect.objectContaining({ id: goal.id, title: goal.title }),
      ]);
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
      store.deleteFeature(feature.id, true);

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
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      await expect(msWithTs.triageFeature("F-NONEXISTENT")).rejects.toThrow(
        "Feature F-NONEXISTENT not found",
      );
    });

    it("throws if feature is already triaged", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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

    it("inherits mission baseBranch when no explicit override is provided", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission", baseBranch: "develop" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(feature.id);
      const task = await ts.getTask(triaged.taskId!);

      expect(task?.baseBranch).toBe("develop");
    });

    it("explicit baseBranch override takes precedence over mission default", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission", baseBranch: "develop" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(feature.id, undefined, undefined, { baseBranch: "release/1.0" });
      const task = await ts.getTask(triaged.taskId!);

      expect(task?.baseBranch).toBe("release/1.0");
    });

    it("uses mission branchStrategy auto-per-task when branch options are omitted", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission", branchStrategy: { mode: "auto-per-task" } });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(feature.id);
      const task = await ts.getTask(triaged.taskId!);

      expect(task?.branchContext?.assignmentMode).toBe("per-task-derived");
      // Non-shared members must NOT carry a groupId: stamping a synthetic
      // `mission:<id>` would let the legacy membership fallback sweep them into a
      // shared group later created for the same mission.
      expect(task?.branchContext?.groupId).toBeUndefined();
      // And no branch group is ensured for a non-shared mission triage.
      expect(ts.getBranchGroupBySource("mission", mission.id)).toBeNull();
    });

    it("uses mission branchStrategy existing branch when branch options are omitted", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({
        title: "Mission",
        branchStrategy: { mode: "existing", branchName: "release/shared" },
      });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(feature.id);
      const task = await ts.getTask(triaged.taskId!);

      expect(task?.branch).toMatch(/^release\/shared\//);
      expect(task?.branch).not.toBe("release/shared");
      // U1: branchContext.groupId carries the real BranchGroup id, not the synthetic `mission:<id>` string.
      expect(task?.branchContext?.groupId).toBe(ts.getBranchGroupBySource("mission", mission.id)?.id);
      expect(task?.branchContext?.groupId).toMatch(/^BG-/);
      expect(task?.branchContext?.assignmentMode).toBe("shared");
    });

    it("explicit branch options override mission branchStrategy defaults", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission", branchStrategy: { mode: "auto-per-task" } });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const feature = msWithTs.addFeature(slice.id, { title: "Original" });

      const triaged = await msWithTs.triageFeature(feature.id, undefined, undefined, {
        branch: "hotfix/shared",
        assignmentMode: "shared",
      });
      const task = await ts.getTask(triaged.taskId!);

      expect(task?.branch).toMatch(/^hotfix\/shared\//);
      expect(task?.branch).not.toBe("hotfix/shared");
      // U1: branchContext.groupId carries the real BranchGroup id, not the synthetic `mission:<id>` string.
      expect(task?.branchContext?.groupId).toBe(ts.getBranchGroupBySource("mission", mission.id)?.id);
      expect(task?.branchContext?.groupId).toMatch(/^BG-/);
      expect(task?.branchContext?.assignmentMode).toBe("shared");
    });

    it("uses provided title and description overrides", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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

    it("links duplicate feature triage calls to the same canonical task", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const featureA = msWithTs.addFeature(slice.id, { title: "Feature A" });
      const featureB = msWithTs.addFeature(slice.id, { title: "Feature B" });

      const first = await msWithTs.triageFeature(featureA.id, "Same Task", "Same deterministic description");
      const second = await msWithTs.triageFeature(featureB.id, "Same Task", "Same deterministic description");

      expect(first.taskId).toBeTruthy();
      expect(second.taskId).toBe(first.taskId);

      const tasks = await ts.listTasks({ slim: true });
      expect(tasks).toHaveLength(1);
    });

    it("emits feature:linked event", async () => {      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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

    it("fires the task-created hook during feature triage", async () => {
      const { TaskStore } = await import("../store.js");
      const { setTaskCreatedHook } = await import("../task-creation-hooks.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const hook = vi.fn();
      setTaskCreatedHook(hook);

      try {
        const mission = msWithTs.createMission({ title: "Mission" });
        const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
        const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
        const feature = msWithTs.addFeature(slice.id, { title: "Hook Feature" });

        const triaged = await msWithTs.triageFeature(feature.id);

        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ id: triaged.taskId, title: "Hook Feature" }),
          ts,
        );
      } finally {
        setTaskCreatedHook(undefined);
      }
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
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      await expect(msWithTs.triageSlice("SL-NONEXISTENT")).rejects.toThrow(
        "Slice SL-NONEXISTENT not found",
      );
    });

    it("triages all defined features in a slice", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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

    it("triageSlice inherits mission baseBranch when no override is provided", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission", baseBranch: "develop" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const f1 = msWithTs.addFeature(slice.id, { title: "Feature 1" });

      const triaged = await msWithTs.triageSlice(slice.id);
      const task = await ts.getTask(triaged[0].taskId!);

      expect(triaged[0].id).toBe(f1.id);
      expect(task?.baseBranch).toBe("develop");
    });

    it("triageSlice uses mission auto-per-task branchStrategy defaults", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({
        title: "Mission",
        branchStrategy: { mode: "auto-per-task" },
      });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      const f1 = msWithTs.addFeature(slice.id, { title: "Feature 1" });

      const triaged = await msWithTs.triageSlice(slice.id);
      const task = await ts.getTask(triaged[0].taskId!);

      expect(triaged[0].id).toBe(f1.id);
      expect(task?.branchContext?.assignmentMode).toBe("per-task-derived");
      // Non-shared invariant: a per-task-derived member must NOT carry a groupId
      // and must NOT create a synthetic mission:<id> branch group.
      expect(task?.branchContext?.groupId).toBeUndefined();
      expect(ts.getBranchGroupBySource("mission", mission.id)).toBeNull();
    });

    it("triageSlice respects explicit branch options over mission strategy defaults", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({
        title: "Mission",
        baseBranch: "develop",
        branchStrategy: { mode: "auto-per-task" },
      });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      msWithTs.addFeature(slice.id, { title: "Feature 1" });

      const triaged = await msWithTs.triageSlice(slice.id, {
        branch: "feature/manual",
        assignmentMode: "shared",
        baseBranch: "release",
      });
      const task = await ts.getTask(triaged[0].taskId!);

      expect(task?.branch).toMatch(/^feature\/manual\//);
      expect(task?.branch).not.toBe("feature/manual");
      expect(task?.baseBranch).toBe("release");
      // U1: branchContext.groupId carries the real BranchGroup id, not the synthetic `mission:<id>` string.
      expect(task?.branchContext?.groupId).toBe(ts.getBranchGroupBySource("mission", mission.id)?.id);
      expect(task?.branchContext?.groupId).toMatch(/^BG-/);
      expect(task?.branchContext?.assignmentMode).toBe("shared");
    });

    it("triageSlice shared mode creates distinct per-task branches with one shared merge target", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({
        title: "Mission",
        branchStrategy: { mode: "existing", branchName: "feature/shared" },
      });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      msWithTs.addFeature(slice.id, { title: "Feature 1" });
      msWithTs.addFeature(slice.id, { title: "Feature 2" });

      const triaged = await msWithTs.triageSlice(slice.id);
      const firstTask = await ts.getTask(triaged[0].taskId!);
      const secondTask = await ts.getTask(triaged[1].taskId!);

      expect(firstTask?.branch).toMatch(/^feature\/shared\//);
      expect(secondTask?.branch).toMatch(/^feature\/shared\//);
      expect(firstTask?.branch).not.toBe("feature/shared");
      expect(secondTask?.branch).not.toBe("feature/shared");
      expect(firstTask?.branch).not.toBe(secondTask?.branch);
      const branchGroup = ts.getBranchGroupBySource("mission", mission.id);
      // U1: both members carry the real BranchGroup id so listTasksByBranchGroup(group.id) resolves them.
      expect(branchGroup?.id).toMatch(/^BG-/);
      expect(firstTask?.branchContext?.groupId).toBe(branchGroup?.id);
      expect(secondTask?.branchContext?.groupId).toBe(branchGroup?.id);
      expect(firstTask?.branchContext?.assignmentMode).toBe("shared");
      expect(secondTask?.branchContext?.assignmentMode).toBe("shared");
      expect(firstTask?.branchContext?.source).toBe("mission");
      expect(secondTask?.branchContext?.source).toBe("mission");

      expect(branchGroup?.branchName).toBe("feature/shared");

      // U1: members enumerate by the real group id.
      const members = await ts.listTasksByBranchGroup(branchGroup!.id);
      expect(members.map((task) => task.id).sort()).toEqual(
        [firstTask!.id, secondTask!.id].sort(),
      );
    });

    it("triageSlice does not inject baseBranch when mission has none", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
      const msWithTs = ts.getMissionStore();

      const mission = msWithTs.createMission({ title: "Mission" });
      const milestone = msWithTs.addMilestone(mission.id, { title: "Milestone" });
      const slice = msWithTs.addSlice(milestone.id, { title: "Slice" });
      msWithTs.addFeature(slice.id, { title: "Feature 1" });

      const triaged = await msWithTs.triageSlice(slice.id);
      const task = await ts.getTask(triaged[0].taskId!);

      expect(task?.baseBranch).toBeUndefined();
    });

    it("returns empty array if no defined features", async () => {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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
      ts: import("../store.js").TaskStore;
      ms: MissionStore;
    }> {
      const { TaskStore } = await import("../store.js");
      const ts = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
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

    it("auto-triage uses mission branchStrategy defaults", async () => {
      const { ts, ms } = await createStoreWithTaskStore();

      const mission = ms.createMission({ title: "Mission", branchStrategy: { mode: "auto-per-task" } });
      ms.updateMission(mission.id, { autoAdvance: true });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature 1" });

      await ms.activateSlice(slice.id);

      const task = await ts.getTask(ms.getFeature(feature.id)!.taskId!);
      expect(task?.branchContext?.assignmentMode).toBe("per-task-derived");
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
      const storeNoTs = new MissionStore(fusionDir, db);

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
      expect(linkedAssertions).toHaveLength(2);
      expect(linkedAssertions.some((a) => a.id === assertion.id)).toBe(true);
    });

    it("lists assertions for a feature", () => {
      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "A1" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "A2" });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);

      const linked = store.listAssertionsForFeature(feature.id);
      expect(linked).toHaveLength(3);
      expect(linked.map((a) => a.title)).toEqual(expect.arrayContaining(["A1", "A2"]));
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
      expect(linked).toHaveLength(1);
      expect(linked[0].sourceFeatureId).toBe(feature.id);
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

      expect(rollup.totalAssertions).toBe(3);
      expect(rollup.passedAssertions).toBe(1);
      expect(rollup.unlinkedAssertions).toBe(0);
      expect(rollup.state).toBe("ready");
    });

    it("rolls up passed when all assertions are passed", () => {
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });

      const [managed] = store.listAssertionsForFeature(feature.id);
      const a1 = store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });
      const a2 = store.addContractAssertion(milestone.id, { title: "A2", assertion: "T" });

      store.linkFeatureToAssertion(feature.id, a1.id);
      store.linkFeatureToAssertion(feature.id, a2.id);
      store.updateContractAssertion(managed.id, { status: "passed" });
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
      const assertions = store.listContractAssertions(milestone.id)
        .filter((a) => a.sourceFeatureId !== feature.id);
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

    it("flags rollup when milestone prose exists but no assertions are linked", () => {
      const updatedMission = store.updateMission(mission.id, { status: "active" });
      expect(updatedMission.status).toBe("active");
      store.updateMilestone(milestone.id, { acceptanceCriteria: "Milestone prose" });

      const warningEvents: Array<{ id: string; code: unknown }> = [];
      store.on("mission:event", (event) => {
        if (event.eventType === "warning") {
          warningEvents.push({ id: event.id, code: event.metadata?.code });
        }
      });

      const rollup = store.getMilestoneValidationRollup(milestone.id);
      expect(rollup.hasProseButNoAssertions).toBe(true);
      expect(store.milestoneHasProseButNoAssertions(milestone.id)).toBe(true);

      const assertion = store.addContractAssertion(milestone.id, { title: "A1", assertion: "Temp" });
      store.deleteContractAssertion(assertion.id);

      expect(warningEvents.some((event) => event.code === "milestone_missing_structured_assertions")).toBe(true);
    });

    it("does not flag rollup when assertions exist", () => {
      store.updateMilestone(milestone.id, { acceptanceCriteria: "Milestone prose" });
      const assertion = store.addContractAssertion(milestone.id, { title: "A1", assertion: "Test" });
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      const feature = store.addFeature(slice.id, { title: "Feature" });
      store.linkFeatureToAssertion(feature.id, assertion.id);

      const rollup = store.getMilestoneValidationRollup(milestone.id);
      expect(rollup.hasProseButNoAssertions).toBe(false);
      expect(store.milestoneHasProseButNoAssertions(milestone.id)).toBe(false);
    });

    it("does not flag rollup when neither milestone nor features have prose", () => {
      const slice = store.addSlice(milestone.id, { title: "Slice" });
      store.addFeature(slice.id, { title: "Feature" });

      const rollup = store.getMilestoneValidationRollup(milestone.id);
      expect(rollup.hasProseButNoAssertions).toBe(false);
      expect(store.milestoneHasProseButNoAssertions(milestone.id)).toBe(false);
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

      const managed = store.listAssertionsForFeature(feature.id);
      expect(managed).toHaveLength(1);
      store.unlinkFeatureFromAssertion(feature.id, managed[0].id);

      // Create assertions but don't link them
      store.addContractAssertion(milestone.id, { title: "A1", assertion: "T" });

      const description = store.buildEnrichedDescription(feature.id);

      expect(description).toContain("## Feature: Feature");
      expect(description).not.toContain("## Contract Assertions");
    });
  });

  describe("Feature assertion canonical seam", () => {
    it("creates exactly one managed assertion with acceptance criteria text", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Feature", acceptanceCriteria: "AC text" });
      const linked = store.listAssertionsForFeature(feature.id);
      expect(linked).toHaveLength(1);
      expect(linked[0].assertion).toBe("AC text");
      expect(linked[0].sourceFeatureId).toBe(feature.id);
    });

    it("lazily re-links exactly one managed assertion for legacy acceptance-criteria features", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Feature", acceptanceCriteria: "AC text" });
      const [managed] = store.listAssertionsForFeature(feature.id);
      store.unlinkFeatureFromAssertion(feature.id, managed.id);
      store.deleteContractAssertion(managed.id);

      const first = store.ensureFeatureAssertionLinked(feature.id);
      const second = store.ensureFeatureAssertionLinked(feature.id);

      expect(first).toHaveLength(1);
      expect(first[0].assertion).toBe("AC text");
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(first[0].id);
      expect(store.listAssertionsForFeature(feature.id)).toHaveLength(1);
    });

    it("derives managed assertion text from description or fallback", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const fromDescription = store.addFeature(slice.id, { title: "Desc Feature", description: "Desc text" });
      const fallback = store.addFeature(slice.id, { title: "Fallback Feature" });
      expect(store.ensureFeatureAssertionLinked(fromDescription.id)[0].assertion).toBe("Desc text");
      expect(store.ensureFeatureAssertionLinked(fallback.id)[0].assertion).toBe("Verify implementation of: Fallback Feature");
    });

    it("syncs managed assertion in place on acceptanceCriteria update", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Feature", acceptanceCriteria: "Old" });
      const before = store.listAssertionsForFeature(feature.id)[0];
      store.updateFeature(feature.id, { acceptanceCriteria: "New" });
      const after = store.listAssertionsForFeature(feature.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before.id);
      expect(after[0].assertion).toBe("New");
    });

    it("does not change managed assertion on status-only update", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Feature" });
      const before = store.listAssertionsForFeature(feature.id)[0];
      store.updateFeature(feature.id, { status: "triaged" });
      const after = store.listAssertionsForFeature(feature.id)[0];
      expect(after.id).toBe(before.id);
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("removes managed assertion row on feature delete", () => {
      const mission = store.createMission({ title: "M" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Feature" });
      const assertionId = store.listAssertionsForFeature(feature.id)[0].id;
      store.deleteFeature(feature.id);
      expect(store.getContractAssertion(assertionId)).toBeUndefined();
    });
  });

  describe("seedContractAssertionsForFeatures", () => {
    it("seeds and links authored assertions idempotently", () => {
      const mission = store.createMission({ title: "Seed mission" });
      const milestone = store.addMilestone(mission.id, { title: "M1" });
      const slice = store.addSlice(milestone.id, { title: "S1" });
      const feature = store.addFeature(slice.id, { title: "F1", acceptanceCriteria: "AC" });

      const beforeManaged = store.listAssertionsForFeature(feature.id).length;

      const first = store.seedContractAssertionsForFeatures([
        {
          featureId: feature.id,
          milestoneId: milestone.id,
          title: "Authored assertion",
          assertion: "Feature output is deterministic",
        },
      ]);

      expect(first.created).toBe(1);
      expect(first.linked).toBe(1);
      expect(first.skippedExisting).toBe(0);

      const second = store.seedContractAssertionsForFeatures([
        {
          featureId: feature.id,
          milestoneId: milestone.id,
          title: "Authored assertion",
          assertion: "Feature output is deterministic",
        },
      ]);

      expect(second.created).toBe(0);
      expect(second.linked).toBe(0);
      expect(second.skippedExisting).toBe(1);
      expect(store.listAssertionsForFeature(feature.id).length).toBe(beforeManaged + 1);
    });
  });

  describe("backfillFeatureAssertions", () => {
    const makeLegacyFeature = (sliceId: string, input: { title: string; description?: string; acceptanceCriteria?: string }) => {
      const feature = store.addFeature(sliceId, input);
      const managed = store.listAssertionsForFeature(feature.id);
      for (const assertion of managed) {
        store.unlinkFeatureFromAssertion(feature.id, assertion.id);
        store.deleteContractAssertion(assertion.id);
      }
      expect(store.listAssertionsForFeature(feature.id)).toHaveLength(0);
      return feature;
    };

    it("repairs missing links using acceptance criteria, description, and fallback text", () => {
      const mission = store.createMission({ title: "Repair Mission" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });

      const fromAcceptance = makeLegacyFeature(slice.id, { title: "F-AC", acceptanceCriteria: "Ship AC" });
      const fromDescription = makeLegacyFeature(slice.id, { title: "F-DESC", description: "Ship DESC" });
      const fromFallback = makeLegacyFeature(slice.id, { title: "F-FALLBACK" });

      const report = store.backfillFeatureAssertions({ dryRun: false });
      expect(report.scanned).toBe(3);
      expect(report.alreadyLinked).toBe(0);
      expect(report.skippedErrors).toHaveLength(0);
      expect(report.repaired).toHaveLength(3);

      const acRow = report.repaired.find((row) => row.featureId === fromAcceptance.id)!;
      const descRow = report.repaired.find((row) => row.featureId === fromDescription.id)!;
      const fallbackRow = report.repaired.find((row) => row.featureId === fromFallback.id)!;

      expect(acRow.milestoneId).toBe(milestone.id);
      expect(acRow.textSource).toBe("acceptanceCriteria");
      expect(store.listAssertionsForFeature(fromAcceptance.id)[0].assertion).toBe("Ship AC");

      expect(descRow.textSource).toBe("description");
      expect(store.listAssertionsForFeature(fromDescription.id)[0].assertion).toBe("Ship DESC");

      expect(fallbackRow.textSource).toBe("fallback");
      expect(store.listAssertionsForFeature(fromFallback.id)[0].assertion).toBe("Verify implementation of: F-FALLBACK");
    });

    it("skips already linked features and remains idempotent", () => {
      const mission = store.createMission({ title: "Repair Mission" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });

      const legacy = makeLegacyFeature(slice.id, { title: "Legacy", acceptanceCriteria: "Legacy AC" });
      const alreadyLinked = store.addFeature(slice.id, { title: "Already Linked", acceptanceCriteria: "Keep" });

      const firstRun = store.backfillFeatureAssertions({ dryRun: false });
      expect(firstRun.scanned).toBe(2);
      expect(firstRun.alreadyLinked).toBe(1);
      expect(firstRun.repaired).toHaveLength(1);
      expect(firstRun.repaired[0]?.featureId).toBe(legacy.id);

      const linkedAssertionIds = store.listAssertionsForFeature(alreadyLinked.id).map((assertion) => assertion.id);
      expect(linkedAssertionIds).toHaveLength(1);

      const secondRun = store.backfillFeatureAssertions({ dryRun: false });
      expect(secondRun.scanned).toBe(2);
      expect(secondRun.alreadyLinked).toBe(2);
      expect(secondRun.repaired).toHaveLength(0);
    });

    it("supports dry-run mode without writing links", () => {
      const mission = store.createMission({ title: "Repair Mission" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });

      const legacy = makeLegacyFeature(slice.id, { title: "Legacy", description: "legacy description" });
      const beforeLinks = db.prepare("SELECT COUNT(*) as count FROM mission_feature_assertions").get() as { count: number };

      const report = store.backfillFeatureAssertions({ dryRun: true });
      expect(report.repaired).toHaveLength(1);
      expect(report.repaired[0]?.featureId).toBe(legacy.id);
      expect(report.repaired[0]?.assertionId).toBe("(dry-run)");
      expect(report.repaired[0]?.textSource).toBe("description");

      const afterLinks = db.prepare("SELECT COUNT(*) as count FROM mission_feature_assertions").get() as { count: number };
      expect(afterLinks.count).toBe(beforeLinks.count);
      expect(store.listAssertionsForFeature(legacy.id)).toHaveLength(0);
    });
  });
  // ── Loop State & Validator Run Schema Tests ───────────────────────────

  describe("Loop State & Validator Run Schema (v31)", () => {
    it("schema version is 101 after migration", () => {
      expect(db.getSchemaVersion()).toBe(112);
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
      expect(colNames).toContain("taskId");
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

    it("startValidatorRun accepts and persists optional taskId", () => {
      const mission = store.createMission({ title: "Validator Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id, "task_completion", "KB-999");

      expect(run.taskId).toBe("KB-999");

      // Verify by reading back from DB
      const runFromDb = store.getValidatorRun(run.id);
      expect(runFromDb?.taskId).toBe("KB-999");
    });

    it("startValidatorRun works without taskId (backward compatibility)", () => {
      const mission = store.createMission({ title: "Validator Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id, "manual");

      expect(run.taskId).toBeUndefined();

      // Verify by reading back from DB
      const runFromDb = store.getValidatorRun(run.id);
      expect(runFromDb?.taskId).toBeUndefined();
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

    it("listStaleRunningValidatorRuns filters by age", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

      const mission = store.createMission({ title: "Stale Run Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const staleFeature = store.addFeature(slice.id, { title: "Stale Feature" });
      const freshFeature = store.addFeature(slice.id, { title: "Fresh Feature" });

      const staleRun = store.startValidatorRun(staleFeature.id, "manual");
      vi.setSystemTime(new Date("2026-01-15T12:09:00.000Z"));
      const freshRun = store.startValidatorRun(freshFeature.id, "auto");

      const staleRuns = store.listStaleRunningValidatorRuns(5 * 60 * 1000, new Date("2026-01-15T12:10:00.000Z").getTime());

      expect(staleRuns.map((run) => run.id)).toEqual([staleRun.id]);
      expect(staleRuns.some((run) => run.id === freshRun.id)).toBe(false);

      vi.useRealTimers();
    });

    it("reapValidatorRun transitions running run to error and unwedges live feature", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

      const mission = store.createMission({ title: "Reap Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id, "manual");
      vi.setSystemTime(new Date("2026-01-15T12:06:00.000Z"));

      const completedListener = vi.fn();
      store.on("validator-run:completed", completedListener);
      const reapedRun = store.reapValidatorRun(run.id, "stale owner");

      expect(reapedRun.status).toBe("error");
      expect(reapedRun.summary).toBe("stale owner");
      expect(reapedRun.completedAt).toBe("2026-01-15T12:06:00.000Z");
      expect(store.getFeature(feature.id)).toMatchObject({
        loopState: "needs_fix",
        lastValidatorStatus: "error",
        lastValidatorRunId: run.id,
      });
      expect(completedListener).toHaveBeenCalledWith(reapedRun, "error", 360000);
      store.off("validator-run:completed", completedListener);

      vi.useRealTimers();
    });

    it("reapValidatorRun leaves completed or archived parent state untouched", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

      const completeMission = store.createMission({ title: "Complete Parent" });
      const completeMilestone = store.addMilestone(completeMission.id, { title: "MS" });
      const completeSlice = store.addSlice(completeMilestone.id, { title: "SL" });
      const completeFeature = store.addFeature(completeSlice.id, { title: "Feature" });
      const completeRun = store.startValidatorRun(completeFeature.id, "manual");
      store.updateFeature(completeFeature.id, { loopState: "passed", lastValidatorStatus: "passed", status: "done" });
      store.updateMission(completeMission.id, { status: "complete" });

      const archivedMission = store.createMission({ title: "Archived Parent" });
      const archivedMilestone = store.addMilestone(archivedMission.id, { title: "MS" });
      const archivedSlice = store.addSlice(archivedMilestone.id, { title: "SL" });
      const archivedFeature = store.addFeature(archivedSlice.id, { title: "Feature" });
      const archivedRun = store.startValidatorRun(archivedFeature.id, "auto");
      store.updateFeature(archivedFeature.id, { loopState: "blocked", lastValidatorStatus: "blocked" });
      store.updateMission(archivedMission.id, { status: "archived" });

      vi.setSystemTime(new Date("2026-01-15T12:08:00.000Z"));

      expect(store.reapValidatorRun(completeRun.id, "complete mission stale").status).toBe("error");
      expect(store.reapValidatorRun(archivedRun.id, "archived mission stale").status).toBe("error");
      expect(store.getFeature(completeFeature.id)).toMatchObject({ loopState: "passed", lastValidatorStatus: "passed", lastValidatorRunId: completeRun.id });
      expect(store.getFeature(archivedFeature.id)).toMatchObject({ loopState: "blocked", lastValidatorStatus: "blocked", lastValidatorRunId: archivedRun.id });

      vi.useRealTimers();
    });

    it("reapValidatorRun is idempotent for terminal runs", () => {
      const mission = store.createMission({ title: "Idempotent Reap Test" });
      const milestone = store.addMilestone(mission.id, { title: "MS" });
      const slice = store.addSlice(milestone.id, { title: "SL" });
      const feature = store.addFeature(slice.id, { title: "Test Feature" });

      const run = store.startValidatorRun(feature.id, "manual");
      const reaped = store.reapValidatorRun(run.id, "first reap");
      const featureAfterFirstReap = store.getFeature(feature.id);

      const second = store.reapValidatorRun(run.id, "second reap");
      const featureAfterSecondReap = store.getFeature(feature.id);

      expect(second).toEqual(reaped);
      expect(featureAfterSecondReap).toEqual(featureAfterFirstReap);
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

  it("persists mission autoMerge true/false/undefined", () => {
    const enabled = store.createMission({ title: "Enabled", autoMerge: true });
    const disabled = store.createMission({ title: "Disabled", autoMerge: false });
    const unset = store.createMission({ title: "Unset" });

    expect(store.getMission(enabled.id)?.autoMerge).toBe(true);
    expect(store.getMission(disabled.id)?.autoMerge).toBe(false);
    expect(store.getMission(unset.id)?.autoMerge).toBeUndefined();

    store.updateMission(enabled.id, { autoMerge: false });
    store.updateMission(disabled.id, { autoMerge: true });

    expect(store.getMission(enabled.id)?.autoMerge).toBe(false);
    expect(store.getMission(disabled.id)?.autoMerge).toBe(true);
  });

  it("exports and applies mission hierarchy snapshots", () => {
    const mission = store.createMission({ title: "Snapshot Mission" });
    const milestone = store.addMilestone(mission.id, { title: "MS" });
    const slice = store.addSlice(milestone.id, { title: "SL" });
    store.addFeature(slice.id, { title: "F" });

    const snapshot = store.getMissionHierarchySnapshot();
    const result = store.applyMissionHierarchySnapshot(snapshot);
    const snapshot2 = store.getMissionHierarchySnapshot();

    expect(result.applied).toBeGreaterThan(0);
    expect(snapshot2.payload).toEqual(snapshot.payload);
  });
});

// vi import for vitest mocking
import { vi } from "vitest";
