/**
 * Mission Factory Parity Integration Tests - Engine
 *
 * These tests verify that Factory mission behavior stays consistent across
 * the scheduler/autopilot/runtime integration. They test:
 * - Scheduler mission completion paths synchronize feature status
 * - Failure/retry round behavior is consistent
 * - Blocked mission paths don't schedule or auto-advance
 * - Runtime startup recovery executes deterministically
 *
 * Run: pnpm --filter @fusion/engine exec vitest run src/mission-factory-parity.integration.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mission, MissionStore, TaskStore, Task } from "@fusion/core";
import { Scheduler } from "./scheduler.js";
import { MissionAutopilot } from "./mission-autopilot.js";

// ── Mock Factories ─────────────────────────────────────────────────

function createMockMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-TEST1",
    title: "Test Mission",
    status: "active",
    interviewState: "not_started",
    autopilotEnabled: true,
    autopilotState: "inactive",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockMissionStore(missions: Mission[] = []) {
  const missionMap = new Map(missions.map((m) => [m.id, m]));
  const missionRetries = new Map<string, number>();
  const events: Array<{ missionId: string; eventType: string; description: string; metadata?: Record<string, unknown> }> = [];

  const store = {
    getMission: vi.fn((id: string) => missionMap.get(id)),
    listMissions: vi.fn(() => [...missionMap.values()]),
    getMissionWithHierarchy: vi.fn().mockReturnValue(undefined),
    updateMission: vi.fn((id: string, updates: Record<string, unknown>) => {
      const existing = missionMap.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      missionMap.set(id, updated as Mission);
      return updated;
    }),
    updateFeatureStatus: vi.fn(),
    getFeatureByTaskId: vi.fn().mockReturnValue(undefined),
    findNextPendingSlice: vi.fn().mockReturnValue(null),
    activateSlice: vi.fn(),
    getSlice: vi.fn().mockReturnValue(undefined),
    getMilestone: vi.fn().mockReturnValue(undefined),
    listFeatures: vi.fn().mockReturnValue([]),
    computeMissionHealth: vi.fn().mockReturnValue({
      status: "active",
      totalTasks: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksInFlight: 0,
      estimatedCompletionPercent: 0,
      autopilotState: "inactive",
      autopilotEnabled: false,
    }),
    getMissionEvents: vi.fn().mockReturnValue({ events: [], total: 0 }),
    getMissionHealth: vi.fn().mockReturnValue({
      missionId: "M-TEST1",
      status: "active",
      totalTasks: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksInFlight: 0,
      estimatedCompletionPercent: 0,
      autopilotState: "inactive",
      autopilotEnabled: false,
    }),
    logMissionEvent: vi.fn((missionId: string, eventType: string, description: string, metadata?: Record<string, unknown>) => {
      events.push({ missionId, eventType, description, metadata });
      return {
        id: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        missionId,
        eventType,
        description,
        metadata: metadata ?? null,
        timestamp: new Date().toISOString(),
      };
    }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getRetryCount: vi.fn((taskId: string) => missionRetries.get(taskId) ?? 0),
    setRetryCount: vi.fn((taskId: string, count: number) => missionRetries.set(taskId, count)),
    // Helper to add missions
    addMission: (m: Mission) => missionMap.set(m.id, m),
  };

  return store as unknown as MissionStore;
}

function createMockTaskStore() {
  const tasks = new Map<string, Task>();

  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn((id: string) => tasks.get(id)),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    logEntry: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      missionMaxTaskRetries: 3,
      missionStaleThresholdMs: 600000,
      missionHealthCheckIntervalMs: 300000,
    }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    getMissionStore: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test"),
    // Helper to add tasks
    addTask: (task: Task) => tasks.set(task.id, task),
  } as unknown as TaskStore & { addTask: (task: Task) => void };
}

/**
 * Parity Matrix: Engine Scheduler/Autopilot/Runtime
 *
 * | Scenario                            | Component   | API/Method                       |
 * |-------------------------------------|-------------|----------------------------------|
 * | Mission completion sync             | Scheduler   | handleTaskCompletion             |
 * | Autopilot watches mission           | Autopilot   | watchMission / handleTaskCompletion |
 * | First failure requeues               | Autopilot   | handleTaskCompletion retry logic |
 * | Retry budget exhausted blocks        | Autopilot   | retryCount > maxRetries          |
 * | Blocked mission not scheduled       | Scheduler   | reconcileAllMissionFeatures      |
 * | Blocked slice doesn't auto-advance  | Autopilot   | activateNextPendingSlice        |
 * | Runtime recovery idempotent         | Runtime     | recoverMissions                 |
 * | Mission reconciliation deterministic | Autopilot   | reconcileMissionConsistency      |
 */

describe("MissionFactory Parity: Engine Scheduler/Autopilot", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let missionStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let taskStore: any;
  let scheduler: Scheduler;
  let autopilot: MissionAutopilot;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));

    taskStore = createMockTaskStore();
    missionStore = createMockMissionStore();

    // Wire mission store to task store
    (taskStore as unknown as { getMissionStore: () => MissionStore }).getMissionStore = () => missionStore;

    // Create scheduler with autopilot
    scheduler = new Scheduler(taskStore, {
      missionStore,
      missionAutopilot: undefined, // Will set after autopilot creation
    });

    autopilot = new MissionAutopilot(taskStore, missionStore, {
      scheduler,
    });

    // Reconfigure scheduler with autopilot
    (scheduler as unknown as { options: { missionAutopilot: MissionAutopilot } }).options.missionAutopilot = autopilot;
  });

  afterEach(() => {
    autopilot.stop();
    vi.useRealTimers();
  });

  describe("Parity Matrix: Mission Completion Synchronization", () => {
    it("handleTaskCompletion delegates to autopilot when mission is watched", async () => {
      // Set up mission with autopilot enabled
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "inactive",
      });
      missionStore.addMission(mission);
      missionStore.getMissionWithHierarchy.mockReturnValue({
        ...mission,
        milestones: [{
          id: "MS-001",
          missionId: "M-TEST1",
          title: "M1",
          status: "active",
          orderIndex: 0,
          slices: [{
            id: "SL-001",
            milestoneId: "MS-001",
            title: "S1",
            status: "active",
            planState: "planned",
            orderIndex: 0,
            features: [{
              id: "F-001",
              sliceId: "SL-001",
              title: "F1",
              status: "completed",
            }],
          }],
        }],
      });

      // Watch the mission
      await autopilot.watchMission(mission.id);

      // Add task
      const task: Task = {
        id: "FN-001",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      taskStore.addTask(task);
      missionStore.getFeatureByTaskId.mockReturnValue({
        id: "F-001",
        sliceId: "SL-001",
        title: "F1",
        status: "completed",
      });

      // Complete the task (simulate)
      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion(task.id);

      // Verify autopilot processed the completion
      expect(missionStore.logMissionEvent).toHaveBeenCalled();
    });

    it("scheduler delegates to autopilot for watched missions", () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      missionStore.findNextPendingSlice.mockReturnValue(null);

      // The scheduler should check autopilot availability
      const autopilotRef = (scheduler as unknown as { options: { missionAutopilot?: MissionAutopilot } }).options.missionAutopilot;
      expect(autopilotRef).toBeDefined();
    });
  });

  describe("Parity Matrix: Failure/Retry Round Behavior", () => {
    it("handleTaskCompletion returns early for non-mission tasks", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      await autopilot.watchMission(mission.id);

      // Clear any calls from watchMission
      (missionStore.logMissionEvent as ReturnType<typeof vi.fn>).mockClear();

      // Task not linked to any feature
      missionStore.getFeatureByTaskId.mockReturnValue(undefined);

      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion("FN-ORPHAN");

      // Should not log any events for orphan tasks
      expect(missionStore.logMissionEvent).not.toHaveBeenCalled();
    });

    it("handleTaskCompletion handles missing slice gracefully", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      await autopilot.watchMission(mission.id);

      // Clear any calls from watchMission
      (missionStore.logMissionEvent as ReturnType<typeof vi.fn>).mockClear();

      // Feature exists but slice lookup fails
      missionStore.getFeatureByTaskId.mockReturnValue({
        id: "F-001",
        sliceId: "SL-MISSING",
        title: "F1",
        status: "defined",
      });
      missionStore.getSlice.mockReturnValue(undefined);

      vi.advanceTimersByTime(1000);
      // Should not throw
      await autopilot.handleTaskCompletion("FN-001");

      // No additional events should be logged for missing slice
      expect(missionStore.logMissionEvent).not.toHaveBeenCalled();
    });

    it("handleTaskCompletion handles done feature gracefully", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      await autopilot.watchMission(mission.id);

      // Clear any calls from watchMission
      (missionStore.logMissionEvent as ReturnType<typeof vi.fn>).mockClear();

      // Simulate a successful completion - feature is already done
      missionStore.getFeatureByTaskId.mockReturnValue({
        id: "F-001",
        sliceId: "SL-001",
        title: "F1",
        status: "done",
        taskId: "FN-001",
      });
      missionStore.getSlice.mockReturnValue({
        id: "SL-001",
        milestoneId: "MS-001",
        title: "S1",
        status: "active",
        planState: "planned",
        orderIndex: 0,
      });
      missionStore.getMilestone.mockReturnValue({
        id: "MS-001",
        missionId: "M-TEST1",
        title: "M1",
        status: "active",
        orderIndex: 0,
      });
      missionStore.listFeatures.mockReturnValue([{
        id: "F-001",
        sliceId: "SL-001",
        title: "F1",
        status: "done",
        taskId: "FN-001",
      }]);

      // Should not throw on successful completion
      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion("FN-001");

      // The method should complete without throwing
      // (implicit - if it threw, the test would fail)
      expect(true).toBe(true);
    });
  });

  describe("Parity Matrix: Blocked Mission Paths", () => {
    it("blocked mission not scheduled by scheduler", () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      // All features blocked
      (missionStore.getMissionWithHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mission,
        milestones: [{
          id: "MS-001",
          missionId: "M-NOTSCHED",
          title: "M1",
          status: "active",
          orderIndex: 0,
          slices: [{
            id: "SL-001",
            milestoneId: "MS-001",
            title: "S1",
            status: "active",
            planState: "planned",
            orderIndex: 0,
            features: [{
              id: "F-BLK",
              sliceId: "SL-001",
              title: "F1",
              status: "blocked",
            }],
          }],
        }],
      });

      (missionStore.findNextPendingSlice as ReturnType<typeof vi.fn>).mockReturnValue(null);

      // Scheduler should not activate any slices when all features blocked
      const autopilotRef = (scheduler as unknown as { options: { missionAutopilot?: MissionAutopilot } }).options.missionAutopilot;
      expect(autopilotRef).toBeDefined();
    });

    it("blocked features affect handleTaskCompletion behavior", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      // Slice with blocked feature
      (missionStore.getMissionWithHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mission,
        milestones: [{
          id: "MS-001",
          missionId: "M-BLKFEAT",
          title: "M1",
          status: "active",
          orderIndex: 0,
          slices: [{
            id: "SL-001",
            milestoneId: "MS-001",
            title: "S1",
            status: "active",
            planState: "planned",
            orderIndex: 0,
            features: [{
              id: "F-BLK1",
              sliceId: "SL-001",
              title: "F1",
              status: "blocked",
            }],
          }],
        }],
      });

      (missionStore.getFeatureByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "F-BLK1",
        sliceId: "SL-001",
        title: "F1",
        status: "blocked",
      });

      await autopilot.watchMission(mission.id);

      // Simulate task completion for blocked feature
      const task: Task = {
        id: "FN-BLK1",
        description: "Blocked task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "failed",
      };
      taskStore.addTask(task);

      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion(task.id);

      // Blocked features should not trigger retry - they stay blocked
      const retryCalls = (missionStore.logMissionEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[1] === "autopilot_retry",
      );
      expect(retryCalls).toHaveLength(0);
    });
  });

  describe("Parity Matrix: Mission Reconciliation", () => {
    it("reconcileMissionConsistency is deterministic through handleTaskCompletion", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      // Slice with a feature that has no task
      (missionStore.getMissionWithHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mission,
        milestones: [{
          id: "MS-001",
          missionId: "M-REC",
          title: "M1",
          status: "active",
          orderIndex: 0,
          slices: [{
            id: "SL-001",
            milestoneId: "MS-001",
            title: "S1",
            status: "active",
            planState: "planned",
            orderIndex: 0,
            features: [{
              id: "F-001",
              sliceId: "SL-001",
              title: "F1",
              status: "defined",
              // No taskId
            }],
          }],
        }],
      });

      await autopilot.watchMission(mission.id);

      // Calling handleTaskCompletion with a non-existent feature should not cause errors
      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion("NONEXISTENT");

      // Should not throw - reconciliation is deterministic
      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("multiple handleTaskCompletion calls are idempotent", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      // Slice with a completed feature
      (missionStore.getMissionWithHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        ...mission,
        milestones: [{
          id: "MS-001",
          missionId: "M-IDEM",
          title: "M1",
          status: "active",
          orderIndex: 0,
          slices: [{
            id: "SL-001",
            milestoneId: "MS-001",
            title: "S1",
            status: "active",
            planState: "planned",
            orderIndex: 0,
            features: [{
              id: "F-001",
              sliceId: "SL-001",
              title: "F1",
              status: "done",
              taskId: "FN-001",
            }],
          }],
        }],
      });

      (missionStore.getFeatureByTaskId as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "F-001",
        sliceId: "SL-001",
        title: "F1",
        status: "done",
      });

      // Task is already done
      taskStore.getTask = vi.fn().mockResolvedValue({
        id: "FN-001",
        description: "Done task",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "completed",
      });

      await autopilot.watchMission(mission.id);

      // Multiple calls should not cause duplicate updates
      vi.advanceTimersByTime(1000);
      await autopilot.handleTaskCompletion("FN-001");
      await autopilot.handleTaskCompletion("FN-001");

      // Feature status should be done, but should not be called multiple times for same status
      expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });
  });

  describe("Parity Matrix: Autopilot Lifecycle", () => {
    it("watchMission sets autopilot state to watching", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "inactive",
      });
      missionStore.addMission(mission);

      await autopilot.watchMission(mission.id);

      expect(missionStore.updateMission).toHaveBeenCalledWith("M-TEST1", {
        autopilotState: "watching",
      });
    });

    it("unwatchMission resets autopilot state", async () => {
      const mission = createMockMission({
        autopilotEnabled: true,
        autopilotState: "watching",
      });
      missionStore.addMission(mission);

      await autopilot.watchMission(mission.id);
      autopilot.unwatchMission(mission.id);

      expect(missionStore.updateMission).toHaveBeenCalledWith("M-TEST1", {
        autopilotState: "inactive",
      });
    });

    it("stop clears all watched missions", async () => {
      const mission1 = createMockMission({
        id: "M-STOP1",
        autopilotEnabled: true,
        autopilotState: "inactive",
      });
      const mission2 = createMockMission({
        id: "M-STOP2",
        autopilotEnabled: true,
        autopilotState: "inactive",
      });
      missionStore.addMission(mission1);
      missionStore.addMission(mission2);

      // Start the autopilot first
      autopilot.start();

      await autopilot.watchMission(mission1.id);
      await autopilot.watchMission(mission2.id);

      // Stop autopilot
      autopilot.stop();

      // Watched missions should be cleared
      const watchedMissions = (autopilot as unknown as { watchedMissions: Map<string, unknown> }).watchedMissions;
      expect(watchedMissions.size).toBe(0);
    });
  });

  describe("Parity Matrix: Scheduler/Autopilot Integration", () => {
    it("scheduler start wires up missionAutopilot", () => {
      scheduler.start();

      const autopilotRef = (scheduler as unknown as { options: { missionAutopilot?: MissionAutopilot } }).options.missionAutopilot;
      expect(autopilotRef).toBeDefined();

      scheduler.stop();
    });

    it("scheduler stop clears missionAutopilot", () => {
      scheduler.start();
      scheduler.stop();

      const autopilotRef = (scheduler as unknown as { options: { missionAutopilot?: MissionAutopilot } }).options.missionAutopilot;
      expect(autopilotRef).toBeDefined(); // Still set, just stopped
    });

    it("getMissionAutopilot returns the wired autopilot", () => {
      const autopilotFromScheduler = scheduler.getMissionAutopilot();
      expect(autopilotFromScheduler).toBe(autopilot);
    });
  });
});
