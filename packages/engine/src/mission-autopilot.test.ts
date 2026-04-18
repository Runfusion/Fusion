/**
 * MissionAutopilot unit tests.
 *
 * Tests the autopilot monitoring class with mocked TaskStore and MissionStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MissionAutopilot } from "./mission-autopilot.js";
import type { Mission, Milestone, Slice, MissionFeature } from "@fusion/core";

// ── Mock Factories ──────────────────────────────────────────────────

function createMockMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-TEST1",
    title: "Test Mission",
    status: "active",
    interviewState: "not_started",
    autoAdvance: true,
    autopilotEnabled: true,
    autopilotState: "inactive",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "MS-001",
    missionId: "M-TEST1",
    title: "Test Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "SL-001",
    milestoneId: "MS-001",
    title: "Test Slice",
    status: "pending",
    planState: "not_started",
    orderIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Test Feature",
    status: "defined",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMissionStore(missions: Mission[] = []) {
  const missionMap = new Map(missions.map((m) => [m.id, m]));

  return {
    getMission: vi.fn((id: string) => missionMap.get(id)),
    listMissions: vi.fn(() => [...missionMap.values()]),
    updateMission: vi.fn((id: string, updates: Partial<Mission>) => {
      const existing = missionMap.get(id);
      if (!existing) throw new Error(`Mission ${id} not found`);
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      missionMap.set(id, updated);
      return updated;
    }),
    logMissionEvent: vi.fn((missionId: string, eventType: string, description: string, metadata?: Record<string, unknown>) => ({
      id: `ME-${Date.now()}`,
      missionId,
      eventType,
      description,
      metadata: metadata ?? null,
      timestamp: new Date().toISOString(),
    })),
    getMilestone: vi.fn(),
    listMilestones: vi.fn(),
    getSlice: vi.fn(),
    listSlices: vi.fn(),
    getFeatureByTaskId: vi.fn(),
    listFeatures: vi.fn(),
    updateFeatureStatus: vi.fn(),
    getMissionWithHierarchy: vi.fn(),
    updateSlice: vi.fn((id: string, updates: Partial<any>) => ({
      id,
      ...updates,
      updatedAt: new Date().toISOString(),
    })),
    computeSliceStatus: vi.fn((id: string) => "pending"),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createMockTaskStore() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      missionStaleThresholdMs: 600_000,
      missionMaxTaskRetries: 3,
      missionHealthCheckIntervalMs: 300_000,
    }),
    getTask: vi.fn().mockResolvedValue({ id: "FN-001", column: "in-progress" }),
    moveTask: vi.fn().mockResolvedValue({ id: "FN-001", column: "todo" }),
    updateTask: vi.fn().mockResolvedValue({}),
  };
}

function createMockScheduler() {
  return {
    activateNextPendingSlice: vi.fn().mockResolvedValue(null),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("MissionAutopilot", () => {
  let autopilot: MissionAutopilot;
  let missionStore: ReturnType<typeof createMockMissionStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let scheduler: ReturnType<typeof createMockScheduler>;

  beforeEach(() => {
    vi.useFakeTimers();
    const mission = createMockMission();
    missionStore = createMockMissionStore([mission]);
    taskStore = createMockTaskStore();
    scheduler = createMockScheduler();

    autopilot = new MissionAutopilot(
      taskStore as any,
      missionStore as any,
      { scheduler },
    );
  });

  afterEach(() => {
    autopilot.stop();
    vi.useRealTimers();
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  describe("start/stop", () => {
    it("should start and be running", () => {
      autopilot.start();
      // No error means success
    });

    it("should be idempotent on start", () => {
      autopilot.start();
      autopilot.start();
      // Should not throw
    });

    it("should stop cleanly", () => {
      autopilot.start();
      autopilot.stop();
      // Should not throw
    });

    it("should be idempotent on stop", () => {
      autopilot.stop();
      // Should not throw
    });
  });

  // ── Watching ─────────────────────────────────────────────────────

  describe("watchMission", () => {
    it("should watch a mission with autopilot enabled", () => {
      autopilot.watchMission("M-TEST1");

      expect(autopilot.isWatching("M-TEST1")).toBe(true);
      expect(missionStore.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ autopilotState: "watching" }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_enabled",
        expect.stringContaining("Autopilot enabled"),
        expect.objectContaining({ source: "watchMission" }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_state_changed",
        expect.stringContaining("inactive to watching"),
        expect.objectContaining({ fromState: "inactive", toState: "watching" }),
      );
    });

    it("should not watch a mission without autopilot enabled", () => {
      const mission = createMockMission({ autopilotEnabled: false });
      const store = createMockMissionStore([mission]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      ap.watchMission("M-TEST1");
      expect(ap.isWatching("M-TEST1")).toBe(false);
    });

    it("should not watch a non-existent mission", () => {
      autopilot.watchMission("M-NONEXISTENT");
      expect(autopilot.isWatching("M-NONEXISTENT")).toBe(false);
    });

    it("should be idempotent — watching same mission twice", () => {
      autopilot.watchMission("M-TEST1");
      autopilot.watchMission("M-TEST1");
      expect(autopilot.getWatchedMissionIds()).toEqual(["M-TEST1"]);
    });
  });

  describe("unwatchMission", () => {
    it("should unwatch a mission", () => {
      autopilot.watchMission("M-TEST1");
      autopilot.unwatchMission("M-TEST1");

      expect(autopilot.isWatching("M-TEST1")).toBe(false);
      expect(missionStore.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ autopilotState: "inactive" }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_disabled",
        expect.stringContaining("Autopilot disabled"),
        expect.objectContaining({ source: "unwatchMission" }),
      );
    });

    it("should be a no-op for non-watched mission", () => {
      autopilot.unwatchMission("M-OTHER");
      // No updateMission call for state change
      expect(missionStore.updateMission).not.toHaveBeenCalledWith(
        "M-OTHER",
        expect.anything(),
      );
    });
  });

  describe("getWatchedMissionIds", () => {
    it("should return empty array when nothing is watched", () => {
      expect(autopilot.getWatchedMissionIds()).toEqual([]);
    });

    it("should return all watched mission IDs", () => {
      const m2 = createMockMission({ id: "M-TEST2", autopilotEnabled: true });
      const store = createMockMissionStore([
        createMockMission(),
        m2,
      ]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      ap.watchMission("M-TEST1");
      ap.watchMission("M-TEST2");

      expect(ap.getWatchedMissionIds()).toEqual(["M-TEST1", "M-TEST2"]);
    });
  });

  describe("getAutopilotStatus", () => {
    it("should return status for a watched mission", () => {
      autopilot.watchMission("M-TEST1");

      const status = autopilot.getAutopilotStatus("M-TEST1");
      expect(status).toEqual({
        enabled: true,
        state: "watching",
        watched: true,
        lastActivityAt: undefined,
      });
    });

    it("should return status for a non-watched mission", () => {
      const status = autopilot.getAutopilotStatus("M-NONEXISTENT");
      expect(status).toEqual({
        enabled: false,
        state: "inactive",
        watched: false,
        lastActivityAt: undefined,
      });
    });
  });

  // ── Task Completion ──────────────────────────────────────────────

  describe("handleTaskCompletion", () => {
    it("should do nothing if task has no linked feature", async () => {
      missionStore.getFeatureByTaskId.mockReturnValue(undefined);

      await autopilot.handleTaskCompletion("FN-001");
      // Should not attempt to advance
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });

    it("should do nothing if mission is not being watched", async () => {
      const feature = createMockFeature({ taskId: "FN-001", status: "done" });
      const slice = createMockSlice({ id: "SL-001" });
      const milestone = createMockMilestone();

      missionStore.getFeatureByTaskId.mockReturnValue(feature);
      missionStore.getSlice.mockReturnValue(slice);
      missionStore.getMilestone.mockReturnValue(milestone);
      // Not watching this mission

      await autopilot.handleTaskCompletion("FN-001");
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });

    it("should advance to next slice when all features are done", async () => {
      const feature = createMockFeature({ taskId: "FN-001", status: "done" });
      const slice = createMockSlice({ id: "SL-001" });
      const milestone = createMockMilestone();

      missionStore.getFeatureByTaskId.mockReturnValue(feature);
      missionStore.getSlice.mockReturnValue(slice);
      missionStore.getMilestone.mockReturnValue(milestone);
      missionStore.listFeatures.mockReturnValue([feature]);

      // Return an activated slice so advanceToNextSlice succeeds
      const activatedSlice = createMockSlice({ id: "SL-002", status: "active" });
      scheduler.activateNextPendingSlice.mockResolvedValue(activatedSlice);

      // Watch the mission first
      autopilot.watchMission("M-TEST1");

      await autopilot.handleTaskCompletion("FN-001");
      expect(scheduler.activateNextPendingSlice).toHaveBeenCalledWith("M-TEST1");
    });

    it("should not advance when not all features are done", async () => {
      const feature1 = createMockFeature({ id: "F-001", taskId: "FN-001", status: "done" });
      const feature2 = createMockFeature({ id: "F-002", status: "in-progress" });
      const slice = createMockSlice({ id: "SL-001" });
      const milestone = createMockMilestone();

      missionStore.getFeatureByTaskId.mockReturnValue(feature1);
      missionStore.getSlice.mockReturnValue(slice);
      missionStore.getMilestone.mockReturnValue(milestone);
      missionStore.listFeatures.mockReturnValue([feature1, feature2]);

      autopilot.watchMission("M-TEST1");

      await autopilot.handleTaskCompletion("FN-001");
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      missionStore.getFeatureByTaskId.mockImplementation(() => {
        throw new Error("DB error");
      });

      // Should not throw
      await autopilot.handleTaskCompletion("FN-001");
    });
  });

  describe("handleTaskFailure", () => {
    function wireMissionTask(taskId = "FN-001") {
      const feature = createMockFeature({ id: "F-001", taskId, sliceId: "SL-001", status: "in-progress" });
      const slice = createMockSlice({ id: "SL-001", milestoneId: "MS-001" });
      const milestone = createMockMilestone({ id: "MS-001", missionId: "M-TEST1" });

      missionStore.getFeatureByTaskId.mockReturnValue(feature);
      missionStore.getSlice.mockReturnValue(slice);
      missionStore.getMilestone.mockReturnValue(milestone);

      return { feature, slice, milestone };
    }

    it("increments retries and requeues failed tasks", async () => {
      wireMissionTask();
      autopilot.watchMission("M-TEST1");

      await autopilot.handleTaskFailure("FN-001");

      expect(taskStore.moveTask).toHaveBeenCalledWith("FN-001", "todo");
      expect(taskStore.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ error: null, status: null, paused: false }),
      );
      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("marks feature blocked after max retries and does not retry again", async () => {
      const { feature } = wireMissionTask();
      autopilot.watchMission("M-TEST1");
      taskStore.getSettings.mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 1,
        missionHealthCheckIntervalMs: 300_000,
      });

      await autopilot.handleTaskFailure("FN-001");
      await autopilot.handleTaskFailure("FN-001");

      expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith(feature.id, "blocked");
      expect(taskStore.moveTask).toHaveBeenCalledTimes(1);
      expect(taskStore.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ status: "failed", paused: true }),
      );
    });

    it("clears retry budget for a task after successful completion", async () => {
      wireMissionTask();
      autopilot.watchMission("M-TEST1");
      taskStore.getSettings.mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 1,
        missionHealthCheckIntervalMs: 300_000,
      });

      await autopilot.handleTaskFailure("FN-001");

      missionStore.listFeatures.mockReturnValue([
        createMockFeature({ id: "F-001", taskId: "FN-001", sliceId: "SL-001", status: "in-progress" }),
      ]);
      await autopilot.handleTaskCompletion("FN-001");
      await autopilot.handleTaskFailure("FN-001");

      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalledWith("F-001", "blocked");
      expect(taskStore.moveTask).toHaveBeenCalledTimes(2);
    });

    it("is a no-op when task is not linked to a feature", async () => {
      missionStore.getFeatureByTaskId.mockReturnValue(undefined);

      await autopilot.handleTaskFailure("FN-001");

      expect(taskStore.moveTask).not.toHaveBeenCalled();
      expect(taskStore.updateTask).not.toHaveBeenCalled();
    });

    it("is a no-op for missions that are not being watched", async () => {
      wireMissionTask();

      await autopilot.handleTaskFailure("FN-001");

      expect(taskStore.moveTask).not.toHaveBeenCalled();
      expect(taskStore.updateTask).not.toHaveBeenCalled();
      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("clears task error when retrying", async () => {
      wireMissionTask();
      autopilot.watchMission("M-TEST1");

      await autopilot.handleTaskFailure("FN-001");

      expect(taskStore.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ error: null, status: null }),
      );
    });
  });

  // ── Advance to Next Slice ────────────────────────────────────────

  describe("advanceToNextSlice", () => {
    it("should update state to activating then watching", async () => {
      const activatedSlice = createMockSlice({ id: "SL-002", status: "active" });
      scheduler.activateNextPendingSlice.mockResolvedValue(activatedSlice);

      autopilot.watchMission("M-TEST1");
      await autopilot.advanceToNextSlice("M-TEST1");

      // Should have been called with activating then watching
      const calls = missionStore.updateMission.mock.calls.filter(
        (call: any[]) => call[1]?.autopilotState !== undefined,
      );
      const states = calls.map((call: any[]) => call[1].autopilotState);
      expect(states).toContain("activating");
      expect(states).toContain("watching");
    });

    it("should update lastAutopilotActivityAt on success", async () => {
      const activatedSlice = createMockSlice({ id: "SL-002", status: "active" });
      scheduler.activateNextPendingSlice.mockResolvedValue(activatedSlice);

      autopilot.watchMission("M-TEST1");
      await autopilot.advanceToNextSlice("M-TEST1");

      expect(missionStore.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ lastAutopilotActivityAt: expect.any(String) }),
      );
    });

    it("should do nothing if mission is not being watched", async () => {
      await autopilot.advanceToNextSlice("M-TEST1");
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });

    it("logs retry events when slice activation fails", async () => {
      scheduler.activateNextPendingSlice.mockRejectedValueOnce(new Error("boom"));

      autopilot.watchMission("M-TEST1");
      await autopilot.advanceToNextSlice("M-TEST1");

      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_retry",
        expect.stringContaining("Retrying slice activation"),
        expect.objectContaining({ retryCount: 1, maxRetries: 3 }),
      );
    });
  });

  // ── Check and Start Mission ──────────────────────────────────────

  describe("checkAndStartMission", () => {
    it("should transition planning mission to active", async () => {
      const mission = createMockMission({ status: "planning" });
      const store = createMockMissionStore([mission]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      const activatedSlice = createMockSlice({ id: "SL-001", status: "active" });
      scheduler.activateNextPendingSlice.mockResolvedValue(activatedSlice);

      await ap.checkAndStartMission("M-TEST1");

      expect(store.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ status: "active" }),
      );
      expect(store.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "mission_started",
        expect.stringContaining("started by autopilot"),
        expect.objectContaining({ source: "checkAndStartMission" }),
      );
    });

    it("should not transition active mission", async () => {
      // Mission is already active
      await autopilot.checkAndStartMission("M-TEST1");

      // Should not change status
      const statusCalls = missionStore.updateMission.mock.calls.filter(
        (call: any[]) => call[1]?.status !== undefined,
      );
      expect(statusCalls.length).toBe(0);
    });

    it("should not transition mission without autopilot enabled", async () => {
      const mission = createMockMission({ status: "planning", autopilotEnabled: false });
      const store = createMockMissionStore([mission]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      await ap.checkAndStartMission("M-TEST1");
      // No status update should happen
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });
  });

  // ── Check Mission Completion ─────────────────────────────────────

  describe("checkMissionCompletion", () => {
    it("should detect when all milestones are complete", async () => {
      const m1 = createMockMilestone({ status: "complete" });
      missionStore.listMilestones.mockReturnValue([m1]);

      autopilot.watchMission("M-TEST1");
      const result = await autopilot.checkMissionCompletion("M-TEST1");

      expect(result).toBe(true);
      expect(missionStore.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ status: "complete" }),
      );
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "mission_completed",
        expect.stringContaining("marked complete"),
        expect.objectContaining({ milestoneCount: 1 }),
      );
      expect(autopilot.isWatching("M-TEST1")).toBe(false);
    });

    it("should return false when milestones are not all complete", async () => {
      const m1 = createMockMilestone({ status: "active" });
      missionStore.listMilestones.mockReturnValue([m1]);

      const result = await autopilot.checkMissionCompletion("M-TEST1");
      expect(result).toBe(false);
    });

    it("should return false when there are no milestones", async () => {
      missionStore.listMilestones.mockReturnValue([]);

      const result = await autopilot.checkMissionCompletion("M-TEST1");
      expect(result).toBe(false);
    });

    it("should return false for non-existent mission", async () => {
      const result = await autopilot.checkMissionCompletion("M-NONEXISTENT");
      expect(result).toBe(false);
    });

    it("should return false when all milestones are complete but one feature is defined", async () => {
      // Simulate the stale status gap: all milestones are "complete" but a feature
      // is still "defined" (e.g., added after milestones appeared complete).
      missionStore.listMilestones.mockReturnValue([createMockMilestone({ status: "complete" })]);
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone({ id: "MS-001", status: "complete" }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "complete" }),
            features: [
              createMockFeature({ id: "F-DONE", status: "done" }),
              createMockFeature({ id: "F-DEFINED", status: "defined" }),
            ],
          }],
        }],
      });

      const result = await autopilot.checkMissionCompletion("M-TEST1");
      expect(result).toBe(false);
      // recomputeMissionStatusChain should have been called to fix stale statuses
      expect(missionStore.updateSlice).toHaveBeenCalled();
      expect(missionStore.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "error",
        expect.stringContaining("stale"),
        expect.objectContaining({ source: "checkMissionCompletion" }),
      );
    });

    it("should return true when all milestones and all features are done", async () => {
      missionStore.listMilestones.mockReturnValue([createMockMilestone({ status: "complete" })]);
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone({ id: "MS-001", status: "complete" }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "complete" }),
            features: [
              createMockFeature({ id: "F-001", status: "done" }),
              createMockFeature({ id: "F-002", status: "done" }),
            ],
          }],
        }],
      });

      const result = await autopilot.checkMissionCompletion("M-TEST1");
      expect(result).toBe(true);
      expect(missionStore.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ status: "complete" }),
      );
    });
  });

  describe("reconcileMissionConsistency", () => {
    it("should fix stale complete slices with defined features", async () => {
      // Simulate a slice marked "complete" but with a "defined" feature.
      // This is a stale state that reconciliation should detect and fix.
      const mission = createMockMission();
      const staleHierarchy = {
        ...mission,
        milestones: [{
          ...createMockMilestone({ id: "MS-001", status: "complete" }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "complete" }),
            features: [
              createMockFeature({ id: "F-001", status: "done" }),
              createMockFeature({ id: "F-DEFINED", status: "defined" }),
            ],
          }],
        }],
      };

      // getMissionWithHierarchy is called by recomputeMissionStatusChain.
      // We need to return something (even if stale) so the method doesn't error.
      missionStore.getMissionWithHierarchy.mockReturnValue(staleHierarchy);

      const fixed = await (autopilot as any).reconcileMissionConsistency(staleHierarchy);
      expect(fixed).toBe(1);
      // getMissionWithHierarchy called → recomputeMissionStatusChain triggered
      expect(missionStore.getMissionWithHierarchy).toHaveBeenCalled();
    });

    it("should return 0 when all complete slices have all features done", async () => {
      const mission = createMockMission();
      const hierarchy = {
        ...mission,
        milestones: [{
          ...createMockMilestone({ id: "MS-001", status: "complete" }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "complete" }),
            features: [
              createMockFeature({ id: "F-001", status: "done" }),
              createMockFeature({ id: "F-002", status: "done" }),
            ],
          }],
        }],
      };

      const fixed = await (autopilot as any).reconcileMissionConsistency(hierarchy);
      expect(fixed).toBe(0);
    });
  });

  describe("health check", () => {
    it("fixes feature status when linked task is done", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "triaged", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "done" });

      await (autopilot as any).runHealthCheck();

      expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
      autopilot.stop();
    });

    it("does not promote a feature to done when the linked task has unresolved dependencies", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "triaged", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockImplementation(async (taskId: string) => {
        if (taskId === "FN-001") {
          return {
            id: "FN-001",
            column: "done",
            dependencies: ["FN-DEP-1"],
            blockedBy: undefined,
          };
        }
        return {
          id: "FN-DEP-1",
          column: "in-progress",
        };
      });

      await autopilot.recoverMissions(missionStore as any);

      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalledWith("F-001", "done");
      autopilot.stop();
    });

    it("fixes feature status when task is in-progress but feature is triaged", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "triaged", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

      await (autopilot as any).runHealthCheck();

      expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "in-progress");
      autopilot.stop();
    });

    it("fixes feature status when task regresses to todo/triage", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "in-progress", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "todo" });

      await (autopilot as any).runHealthCheck();

      expect(missionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "triaged");
      autopilot.stop();
    });

    it("triggers failure recovery for failed in-progress tasks", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "in-progress", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress", status: "failed" });
      const failureSpy = vi.spyOn(autopilot, "handleTaskFailure").mockResolvedValue();

      await (autopilot as any).runHealthCheck();

      expect(failureSpy).toHaveBeenCalledWith("FN-001");
      autopilot.stop();
    });

    it("leaves consistent feature/task states unchanged", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "in-progress", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "in-progress" });

      await (autopilot as any).runHealthCheck();

      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
      autopilot.stop();
    });

    it("skips features that do not have linked tasks", async () => {
      autopilot.start();
      autopilot.watchMission("M-TEST1");
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...createMockMission(),
        milestones: [{
          ...createMockMilestone(),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "in-progress", taskId: undefined })],
          }],
        }],
      });

      await (autopilot as any).runHealthCheck();

      expect(taskStore.getTask).not.toHaveBeenCalled();
      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
      autopilot.stop();
    });

    it("does not create a health-check timer when disabled", async () => {
      taskStore.getSettings.mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 3,
        missionHealthCheckIntervalMs: 0,
      });

      autopilot.start();
      await vi.runOnlyPendingTimersAsync();

      expect((autopilot as any).healthCheckTimer).toBeNull();
    });

    it("uses default health-check interval when setting is undefined", async () => {
      taskStore.getSettings.mockResolvedValue({
        missionStaleThresholdMs: 600_000,
        missionMaxTaskRetries: 3,
        missionHealthCheckIntervalMs: undefined,
      });

      autopilot.start();
      await vi.runOnlyPendingTimersAsync();

      expect((autopilot as any).healthCheckTimer).not.toBeNull();
    });
  });

  // ── Poll / stale detection ──────────────────────────────────────

  describe("poll stale detection", () => {
    it("recovers stale activating missions back to watching and advances slices", async () => {
      const staleMission = createMockMission({
        autopilotState: "activating",
        lastAutopilotActivityAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      const store = createMockMissionStore([staleMission]);
      const localScheduler = createMockScheduler();
      localScheduler.activateNextPendingSlice.mockResolvedValue(
        createMockSlice({ id: "SL-002", status: "active" }),
      );

      store.getMissionWithHierarchy.mockReturnValue({
        ...staleMission,
        milestones: [{
          ...createMockMilestone({ missionId: staleMission.id }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "active" }),
            features: [createMockFeature({ status: "done" })],
          }],
        }],
      });

      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler: localScheduler });
      ap.start();
      ap.watchMission("M-TEST1");
      store.updateMission("M-TEST1", {
        autopilotState: "activating",
        lastAutopilotActivityAt: staleMission.lastAutopilotActivityAt,
      });
      store.updateMission.mockClear();
      store.logMissionEvent.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(store.updateMission).toHaveBeenCalledWith(
        "M-TEST1",
        expect.objectContaining({ autopilotState: "watching" }),
      );
      expect(localScheduler.activateNextPendingSlice).toHaveBeenCalledWith("M-TEST1");
      expect(store.logMissionEvent).toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_stale",
        expect.stringContaining("stale"),
        expect.objectContaining({ staleThresholdMs: 600_000 }),
      );

      ap.stop();
    });

    it("does not recover missions that are not in activating state", async () => {
      const staleWatchingMission = createMockMission({
        autopilotState: "watching",
        lastAutopilotActivityAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      const store = createMockMissionStore([staleWatchingMission]);
      const localScheduler = createMockScheduler();
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler: localScheduler });

      ap.start();
      ap.watchMission("M-TEST1");
      store.logMissionEvent.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(localScheduler.activateNextPendingSlice).not.toHaveBeenCalled();
      expect(store.logMissionEvent).not.toHaveBeenCalledWith(
        "M-TEST1",
        "autopilot_stale",
        expect.any(String),
        expect.anything(),
      );

      ap.stop();
    });
  });

  describe("recoverStaleMission", () => {
    it("activates pending work when active slice is complete", async () => {
      const mission = createMockMission();
      const store = createMockMissionStore([mission]);
      const localScheduler = createMockScheduler();
      localScheduler.activateNextPendingSlice.mockResolvedValue(
        createMockSlice({ id: "SL-002", status: "active" }),
      );
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler: localScheduler });

      store.getMissionWithHierarchy.mockReturnValue({
        ...mission,
        milestones: [{
          ...createMockMilestone({ missionId: mission.id }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "active" }),
            features: [createMockFeature({ status: "done" })],
          }],
        }],
      });

      ap.watchMission("M-TEST1");
      await ap.recoverStaleMission("M-TEST1");

      expect(localScheduler.activateNextPendingSlice).toHaveBeenCalledWith("M-TEST1");
    });

    it("handles mission not found gracefully", async () => {
      missionStore.getMissionWithHierarchy.mockReturnValue(undefined);

      await expect(autopilot.recoverStaleMission("M-TEST1")).resolves.toBeUndefined();
      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });
  });

  describe("recoverMissions", () => {
    it("watches eligible missions and skips complete/archived missions", async () => {
      const missions = [
        createMockMission({ id: "M-ONE", status: "active", autopilotEnabled: true }),
        createMockMission({ id: "M-TWO", status: "complete", autopilotEnabled: true }),
        createMockMission({ id: "M-THREE", status: "archived", autopilotEnabled: true }),
        createMockMission({ id: "M-FOUR", status: "active", autopilotEnabled: false }),
      ];
      const store = createMockMissionStore(missions);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      store.getMissionWithHierarchy.mockReturnValue(undefined);
      await ap.recoverMissions(store as any);

      expect(ap.isWatching("M-ONE")).toBe(true);
      expect(ap.isWatching("M-TWO")).toBe(false);
      expect(ap.isWatching("M-THREE")).toBe(false);
      expect(ap.isWatching("M-FOUR")).toBe(false);
    });

    it("recovers missions stuck in activating state", async () => {
      const mission = createMockMission({ autopilotState: "activating" });
      const store = createMockMissionStore([mission]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });
      const recoverStaleSpy = vi.spyOn(ap, "recoverStaleMission").mockResolvedValue();

      store.getMissionWithHierarchy.mockReturnValue(undefined);
      await ap.recoverMissions(store as any);

      expect(recoverStaleSpy).toHaveBeenCalledWith(mission.id);
    });

    it("fixes feature/task inconsistencies during recovery", async () => {
      const mission = createMockMission();
      const store = createMockMissionStore([mission]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      store.getMissionWithHierarchy.mockReturnValue({
        ...mission,
        milestones: [{
          ...createMockMilestone({ missionId: mission.id }),
          slices: [{
            ...createMockSlice({ status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "triaged", taskId: "FN-001" })],
          }],
        }],
      });
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "done" });

      await ap.recoverMissions(store as any);

      expect(store.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
    });

    it("advances slices when active slice features are already done", async () => {
      const mission = createMockMission();
      const store = createMockMissionStore([mission]);
      const localScheduler = createMockScheduler();
      localScheduler.activateNextPendingSlice.mockResolvedValue(
        createMockSlice({ id: "SL-002", status: "active" }),
      );
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler: localScheduler });

      const hierarchy = {
        ...mission,
        milestones: [{
          ...createMockMilestone({ missionId: mission.id }),
          slices: [{
            ...createMockSlice({ id: "SL-001", status: "active" }),
            features: [createMockFeature({ id: "F-001", status: "done", taskId: "FN-001" })],
          }],
        }],
      };
      store.getMissionWithHierarchy.mockReturnValue(hierarchy);
      taskStore.getTask.mockResolvedValue({ id: "FN-001", column: "done" });

      await ap.recoverMissions(store as any);

      expect(localScheduler.activateNextPendingSlice).toHaveBeenCalledWith(mission.id);
    });

    it("handles empty mission lists", async () => {
      const store = createMockMissionStore([]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      await expect(ap.recoverMissions(store as any)).resolves.toBeUndefined();
    });
  });

  // ── Stop cleanup ─────────────────────────────────────────────────

  describe("stop cleanup", () => {
    it("should unwatch all missions on stop", () => {
      const m2 = createMockMission({ id: "M-TEST2", autopilotEnabled: true });
      const store = createMockMissionStore([
        createMockMission(),
        m2,
      ]);
      const ap = new MissionAutopilot(taskStore as any, store as any, { scheduler });

      ap.start();
      ap.watchMission("M-TEST1");
      ap.watchMission("M-TEST2");
      expect(ap.getWatchedMissionIds()).toHaveLength(2);

      ap.stop();
      expect(ap.getWatchedMissionIds()).toHaveLength(0);
    });
  });

  // ── setScheduler ─────────────────────────────────────────────────

  describe("setScheduler", () => {
    it("should allow setting scheduler after construction", async () => {
      // Create autopilot without scheduler
      const ap = new MissionAutopilot(taskStore as any, missionStore as any);
      ap.start();
      ap.watchMission("M-TEST1");

      // advanceToNextSlice should be a no-op without scheduler
      await ap.advanceToNextSlice("M-TEST1");

      const newScheduler = createMockScheduler();
      ap.setScheduler(newScheduler);

      // Now advanceToNextSlice should use the new scheduler
      newScheduler.activateNextPendingSlice.mockResolvedValue(
        createMockSlice({ id: "SL-002", status: "active" }),
      );
      await ap.advanceToNextSlice("M-TEST1");
      expect(newScheduler.activateNextPendingSlice).toHaveBeenCalledWith("M-TEST1");

      ap.stop();
    });
  });

  // ── Slice Advancement ────────────────────────────────────────────

  describe("slice advancement", () => {
    it("should advance slice when autopilot is watching", async () => {
      autopilot.watchMission("M-TEST1");
      const activatedSlice = createMockSlice({ id: "SL-002", status: "active" });
      scheduler.activateNextPendingSlice.mockResolvedValue(activatedSlice);

      await autopilot.advanceToNextSlice("M-TEST1");

      expect(scheduler.activateNextPendingSlice).toHaveBeenCalledWith("M-TEST1");
    });

    it("should not advance slice when mission is not being watched", async () => {
      // Don't watch the mission
      await autopilot.advanceToNextSlice("M-TEST1");

      expect(scheduler.activateNextPendingSlice).not.toHaveBeenCalled();
    });
  });
});
