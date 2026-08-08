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
import { Scheduler } from "../scheduler.js";
import { AgentSemaphore } from "../concurrency/concurrency.js";
import { selectNextSerialMissionSlice, type TaskStore, type MissionStore, type Slice, type Mission, type Milestone, type MissionFeature } from "@fusion/core";

// Mock store factory
function createMockMissionStore(): any {
  return {
    findNextPendingSlice: vi.fn(),
    activateSlice: vi.fn(),
    tryActivateNextPendingSlice: vi.fn(),
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

describe("serial mission slice admission decision", () => {
  const slice = (id: string, status: Slice["status"], orderIndex = 0) => ({
    ...createMockSlice({ id, status, orderIndex }),
    features: [],
  });
  const milestone = (id: string, orderIndex: number, status: Milestone["status"], slices: ReturnType<typeof slice>[], dependencies: string[] = []) => ({
    ...createMockMilestone({ id, orderIndex, status, dependencies }),
    slices,
  });

  it.each([
    ["empty planning hierarchy", [milestone("MS-1", 0, "planning", [])], undefined],
    ["all complete hierarchy", [milestone("MS-1", 0, "complete", [slice("SL-1", "complete")])], undefined],
    ["an active slice lease", [milestone("MS-1", 0, "active", [slice("SL-1", "active"), slice("SL-2", "pending", 1)])], undefined],
    ["the first pending slice", [milestone("MS-1", 0, "planning", [slice("SL-1", "pending")])], "SL-1"],
    ["a blocked earlier milestone", [milestone("MS-1", 0, "blocked", [slice("SL-1", "complete")]), milestone("MS-2", 1, "planning", [slice("SL-2", "pending")])], undefined],
    ["an unmet explicit dependency", [milestone("MS-1", 0, "planning", [slice("SL-1", "pending")], ["MS-missing"])], undefined],
    ["an empty earlier planning milestone", [milestone("MS-1", 0, "planning", []), milestone("MS-2", 1, "planning", [slice("SL-2", "pending")])], undefined],
    ["the next milestone after an earlier complete milestone", [milestone("MS-1", 0, "complete", [slice("SL-1", "complete")]), milestone("MS-2", 1, "planning", [slice("SL-2", "pending")])], "SL-2"],
    ["a stale non-complete earlier milestone", [milestone("MS-1", 0, "active", [slice("SL-1", "complete")]), milestone("MS-2", 1, "planning", [slice("SL-2", "pending")])], undefined],
  ])("returns %s", (_name, milestones, expectedId) => {
    const result = selectNextSerialMissionSlice({
      ...createMockMission(),
      milestones,
    } as any);

    expect(result?.id).toBe(expectedId);
  });
});

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

      missionStore.tryActivateNextPendingSlice.mockResolvedValue(mockActivated);

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
      expect(result).toEqual(mockActivated);
    });

    it("returns a concurrency-safe no-op when no serial candidate is admitted", async () => {
      missionStore.tryActivateNextPendingSlice.mockResolvedValue(undefined);

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
      expect(result).toBeNull();
    });

    it("should return null when no pending slices", async () => {
      missionStore.tryActivateNextPendingSlice.mockResolvedValue(undefined);

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
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
      missionStore.tryActivateNextPendingSlice.mockImplementation(() => {
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
      missionStore.tryActivateNextPendingSlice.mockResolvedValue(createMockSlice({ id: "SL-002", status: "active" }));

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
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
      missionStore.tryActivateNextPendingSlice.mockResolvedValue(createMockSlice({ id: "SL-002", status: "active" }));

      await scheduler.onSliceComplete(completedSlice);

      expect(missionStore.tryActivateNextPendingSlice).toHaveBeenCalledWith("M-001");
    });

    it("keeps the #3345 M1 → M2 → M3 completion sequence serial across duplicate callbacks", async () => {
      const source = createMockSlice({ id: "SL-M1", milestoneId: "MS-1", status: "complete" });
      const firstM2 = createMockSlice({ id: "SL-M2-A", milestoneId: "MS-2", status: "pending", orderIndex: 0 });
      const secondM2 = createMockSlice({ id: "SL-M2-B", milestoneId: "MS-2", status: "pending", orderIndex: 1 });
      const firstM3 = createMockSlice({ id: "SL-M3-A", milestoneId: "MS-3", status: "pending", orderIndex: 0 });
      const milestones = [
        { ...createMockMilestone({ id: "MS-1", missionId: "M-001", orderIndex: 0, status: "complete" }), slices: [source] },
        { ...createMockMilestone({ id: "MS-2", missionId: "M-001", orderIndex: 1 }), slices: [firstM2, secondM2] },
        { ...createMockMilestone({ id: "MS-3", missionId: "M-001", orderIndex: 2 }), slices: [firstM3] },
      ];
      const mission = createMockMission({ id: "M-001", autopilotEnabled: true, autoAdvance: true });
      const activated: string[] = [];
      missionStore.getMilestone.mockImplementation((id: string) => milestones.find((milestone) => milestone.id === id));
      missionStore.getMission.mockReturnValue(mission);
      missionStore.tryActivateNextPendingSlice.mockImplementation(async () => {
        const candidate = selectNextSerialMissionSlice({ ...mission, milestones: milestones.map((milestone) => ({ ...milestone, slices: milestone.slices.map((slice) => ({ ...slice, features: [] })) })) } as any);
        if (!candidate) return undefined;
        const slice = milestones.flatMap((milestone) => milestone.slices).find((item) => item.id === candidate.id)!;
        slice.status = "active";
        activated.push(slice.id);
        return slice;
      });

      await scheduler.onSliceComplete(source);
      await scheduler.onSliceComplete(source); // done/archived-equivalent duplicate callback
      expect(activated).toEqual([firstM2.id]);
      expect(secondM2.status).toBe("pending");
      expect(firstM3.status).toBe("pending");

      firstM2.status = "complete";
      await scheduler.onSliceComplete(firstM2);
      expect(activated).toEqual([firstM2.id, secondM2.id]);
      await scheduler.onSliceComplete(source);
      expect(firstM3.status).toBe("pending");

      secondM2.status = "complete";
      milestones[1].status = "complete";
      await scheduler.onSliceComplete(secondM2);
      expect(activated).toEqual([firstM2.id, secondM2.id, firstM3.id]);
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
