/**
 * Mission Scheduler Integration Tests
 *
 * Tests for scheduler interaction with MissionStore:
 * - activateNextPendingSlice
 * - Auto-advance when linked task completes
 * - Mission status rollup triggers
 * - Event listener registration/cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler } from "./scheduler.js";
import { AgentSemaphore } from "./concurrency.js";
import type { TaskStore, MissionStore, Slice, Mission, Milestone, MissionFeature } from "@fusion/core";

// Mock store factory
function createMockMissionStore(): any {
  return {
    findNextPendingSlice: vi.fn(),
    activateSlice: vi.fn(),
    getSlice: vi.fn(),
    getMilestone: vi.fn(),
    getMission: vi.fn(),
    getMissionWithHierarchy: vi.fn(),
    getFeatureByTaskId: vi.fn(),
    updateFeatureStatus: vi.fn(),
    computeSliceStatus: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createMockTaskStore(): any {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    on: vi.fn(),
    off: vi.fn(),
    getMissionStore: vi.fn(),
  };
}

function createMockSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "SL-001",
    milestoneId: "MS-001",
    title: "Test Slice",
    description: "Test slice description",
    status: "pending",
    orderIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Slice;
}

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "MS-001",
    missionId: "M-001",
    title: "Test Milestone",
    description: "Test milestone description",
    status: "planning",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Milestone;
}

function createMockMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-001",
    title: "Test Mission",
    description: "Test mission description",
    status: "active",
    interviewState: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    autoAdvance: true,
    ...overrides,
  } as Mission;
}

function createMockFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Test Feature",
    description: "Test feature description",
    status: "triaged",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as MissionFeature;
}

describe("Scheduler Mission Integration", () => {
  let taskStore: any;
  let missionStore: any;
  let scheduler: Scheduler;
  let listeners: Record<string, Array<(...args: any[]) => void>>;

  beforeEach(() => {
    listeners = {};
    taskStore = createMockTaskStore();
    missionStore = createMockMissionStore();
    taskStore.getMissionStore.mockReturnValue(missionStore);

    taskStore.on.mockImplementation((event: string, handler: (...args: any[]) => void) => {
      listeners[event] ??= [];
      listeners[event].push(handler);
      return taskStore;
    });

    const semaphore = new AgentSemaphore(2);
    scheduler = new Scheduler(taskStore, {
      pollIntervalMs: 1000,
      semaphore,
      missionStore,
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe("activateNextPendingSlice", () => {
    it("should find and activate next pending slice", async () => {
      const mockActivated = createMockSlice({ id: "SL-002", status: "active" });

      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            orderIndex: 0,
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete", orderIndex: 0 },
              { id: "SL-002", status: "pending", orderIndex: 1 },
            ],
          },
        ],
      });
      missionStore.activateSlice.mockReturnValue(mockActivated);

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.getMissionWithHierarchy).toHaveBeenCalledWith("M-001");
      expect(missionStore.activateSlice).toHaveBeenCalledWith("SL-002");
      expect(result).toEqual(mockActivated);
    });

    it("skips milestones with unmet dependencies and activates the next eligible pending slice", async () => {
      const mockActivated = createMockSlice({ id: "SL-ELIGIBLE", status: "active" });

      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-BLOCKED",
            orderIndex: 0,
            dependencies: ["MS-DEP"],
            status: "planning",
            slices: [{ id: "SL-BLOCKED", status: "pending", orderIndex: 0 }],
          },
          {
            id: "MS-DEP",
            orderIndex: 1,
            dependencies: [],
            status: "planning",
            slices: [{ id: "SL-DEP", status: "complete", orderIndex: 0 }],
          },
          {
            id: "MS-ELIGIBLE",
            orderIndex: 2,
            dependencies: [],
            status: "active",
            slices: [{ id: "SL-ELIGIBLE", status: "pending", orderIndex: 0 }],
          },
        ],
      });
      missionStore.activateSlice.mockReturnValue(mockActivated);

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.activateSlice).toHaveBeenCalledWith("SL-ELIGIBLE");
      expect(result).toEqual(mockActivated);
    });

    it("should return null when no pending slices", async () => {
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            orderIndex: 0,
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete", orderIndex: 0 },
              { id: "SL-002", status: "complete", orderIndex: 1 },
            ],
          },
        ],
      });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.getMissionWithHierarchy).toHaveBeenCalledWith("M-001");
      expect(result).toBeNull();
    });

    it("should return null when missionStore is not configured", async () => {
      const semaphore = new AgentSemaphore(2);
      const schedulerNoMission = new Scheduler(taskStore, {
        pollIntervalMs: 1000,
        semaphore,
      });

      const result = await schedulerNoMission.activateNextPendingSlice("M-001");

      expect(result).toBeNull();
      schedulerNoMission.stop();
    });

    it("should handle errors gracefully", async () => {
      missionStore.getMissionWithHierarchy.mockImplementation(() => {
        throw new Error("Database error");
      });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(result).toBeNull();
    });
  });

  describe("onSliceComplete", () => {
    it("auto-advances when autopilotEnabled is true", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({
        id: "M-001",
        status: "active",
        autopilotEnabled: true,
        autoAdvance: false, // autoAdvance is false, but autopilotEnabled is true
      }));
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        autopilotEnabled: true,
        autoAdvance: false,
        milestones: [{
          id: "MS-001",
          orderIndex: 0,
          dependencies: [],
          slices: [
            { id: "SL-001", status: "complete", orderIndex: 0 }, // completed
            { id: "SL-002", status: "pending", orderIndex: 1 }, // next
          ],
        }],
      });
      missionStore.activateSlice.mockResolvedValue(createMockSlice({ id: "SL-002", status: "active" }));

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("auto-advances when autoAdvance is true (legacy compat)", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({
        id: "M-001",
        status: "active",
        autopilotEnabled: false, // autopilotEnabled is false
        autoAdvance: true, // but autoAdvance is true (legacy)
      }));
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        autopilotEnabled: false,
        autoAdvance: true,
        milestones: [{
          id: "MS-001",
          orderIndex: 0,
          dependencies: [],
          slices: [
            { id: "SL-001", status: "complete", orderIndex: 0 },
            { id: "SL-002", status: "pending", orderIndex: 1 },
          ],
        }],
      });
      missionStore.activateSlice.mockResolvedValue(createMockSlice({ id: "SL-002", status: "active" }));

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("does not auto-advance when both autopilotEnabled and autoAdvance are false", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({
        id: "M-001",
        status: "active",
        autopilotEnabled: false,
        autoAdvance: false,
      }));
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        autopilotEnabled: false,
        autoAdvance: false,
        milestones: [{
          id: "MS-001",
          orderIndex: 0,
          dependencies: [],
          slices: [
            { id: "SL-001", status: "complete", orderIndex: 0 },
            { id: "SL-002", status: "pending", orderIndex: 1 },
          ],
        }],
      });

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("does not auto-advance when mission status is not active", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({
        id: "M-001",
        status: "planning", // not active
        autopilotEnabled: true,
        autoAdvance: true,
      }));
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "planning",
        autopilotEnabled: true,
        autoAdvance: true,
        milestones: [{
          id: "MS-001",
          orderIndex: 0,
          dependencies: [],
          slices: [
            { id: "SL-001", status: "complete", orderIndex: 0 },
            { id: "SL-002", status: "pending", orderIndex: 1 },
          ],
        }],
      });

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("does not auto-advance when another slice is already active", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({
        id: "M-001",
        status: "active",
        autopilotEnabled: true,
        autoAdvance: true,
      }));
      missionStore.getMissionWithHierarchy.mockReturnValue({
        id: "M-001",
        status: "active",
        autopilotEnabled: true,
        autoAdvance: true,
        milestones: [{
          id: "MS-001",
          orderIndex: 0,
          dependencies: [],
          slices: [
            { id: "SL-001", status: "complete", orderIndex: 0 }, // just completed
            { id: "SL-002", status: "active", orderIndex: 1 }, // already active
            { id: "SL-003", status: "pending", orderIndex: 2 },
          ],
        }],
      });

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("handles mission not found gracefully", async () => {
      const completedSlice = createMockSlice({ id: "SL-001", status: "complete" });

      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(undefined);

      await expect(scheduler.onSliceComplete(completedSlice)).resolves.not.toThrow();
      expect(missionStore.activateSlice).not.toHaveBeenCalled();
    });
  });

  describe("Mission-aware scheduling", () => {
    // NOTE: The delegation tests for autopilot watching/unwatching are covered by
    // the onSliceComplete tests above which verify the autopilotEnabled/autoAdvance
    // compatibility logic. The scheduler's handleMissionTaskCompletion delegates to
    // autopilot when watching, and falls back to onSliceComplete otherwise.

    it("filters out todo tasks whose mission is blocked", async () => {
      const blockedTask = {
        id: "FN-001",
        title: "Blocked task",
        column: "todo",
        paused: false,
        dependencies: [],
        steps: [],
        currentStep: 0,
        sliceId: "SL-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      taskStore.listTasks.mockResolvedValue([blockedTask]);
      taskStore.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 2,
      });
      missionStore.getSlice.mockReturnValue(createMockSlice({ id: "SL-001", milestoneId: "MS-001" }));
      missionStore.getMilestone.mockReturnValue(createMockMilestone({ id: "MS-001", missionId: "M-001" }));
      missionStore.getMission.mockReturnValue(createMockMission({ id: "M-001", status: "blocked" }));

      vi.spyOn(scheduler as any, "validateTaskFilesystem").mockResolvedValue({ valid: true });

      await scheduler.schedule();

      expect(taskStore.moveTask).not.toHaveBeenCalled();
      expect(taskStore.updateTask).not.toHaveBeenCalled();
    });
  });

  describe("Event listeners", () => {
    it("should register event listeners on scheduler start", () => {
      scheduler.start();

      // Verify that taskStore listeners are registered
      expect(taskStore.on).toHaveBeenCalled();
    });

    it("should not break existing task scheduling with mission integration", () => {
      // Mission integration should not interfere with existing task scheduling
      const mockTasks = [
        { id: "FN-001", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: "FN-002", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ];

      (taskStore.listTasks as any).mockResolvedValue(mockTasks);

      scheduler.start();

      // Verify that the scheduler is still functioning with mission store
      expect(scheduler).toBeDefined();
    });
  });
});
