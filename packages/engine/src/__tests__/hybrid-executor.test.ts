import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, RegisteredProject } from "@fusion/core";
import { HybridExecutor } from "../hybrid-executor.js";
import type { ProjectRuntimeConfig } from "../project-runtime.js";

// Mock the ProjectManager
const mockRuntimes = new Map();
const mockProjectIds: string[] = [];
const mockProjectManagerInstances: Array<{
  addProject: ReturnType<typeof vi.fn>;
  removeProject: ReturnType<typeof vi.fn>;
  getRuntime: ReturnType<typeof vi.fn>;
  listRuntimes: ReturnType<typeof vi.fn>;
  getProjectIds: ReturnType<typeof vi.fn>;
  getGlobalMetrics: ReturnType<typeof vi.fn>;
  acquireGlobalSlot: ReturnType<typeof vi.fn>;
  releaseGlobalSlot: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../project-manager.js", () => ({
  ProjectManager: vi.fn().mockImplementation(() => {
    const instance = {
      addProject: vi.fn().mockImplementation((config: ProjectRuntimeConfig) => {
        const runtime = {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn().mockReturnValue("active"),
          getTaskStore: vi.fn(),
          getScheduler: vi.fn(),
          getMetrics: vi.fn().mockReturnValue({
            inFlightTasks: 0,
            activeAgents: 0,
            lastActivityAt: new Date().toISOString(),
          }),
          on: vi.fn().mockReturnThis(),
        };
        mockRuntimes.set(config.projectId, runtime);
        mockProjectIds.push(config.projectId);
        return Promise.resolve(runtime);
      }),
      removeProject: vi.fn().mockImplementation((projectId: string) => {
        mockRuntimes.delete(projectId);
        const index = mockProjectIds.indexOf(projectId);
        if (index > -1) mockProjectIds.splice(index, 1);
        return Promise.resolve(undefined);
      }),
      getRuntime: vi.fn().mockImplementation((projectId: string) => {
        return mockRuntimes.get(projectId);
      }),
      listRuntimes: vi.fn().mockImplementation(() => {
        return Array.from(mockRuntimes.values());
      }),
      getProjectIds: vi.fn().mockImplementation(() => {
        return [...mockProjectIds];
      }),
      getGlobalMetrics: vi.fn().mockResolvedValue({
        totalInFlightTasks: 0,
        totalActiveAgents: 0,
        runtimeCountByStatus: {
          active: 0,
          paused: 0,
          errored: 0,
          stopped: 0,
          starting: 0,
          stopping: 0,
        },
        totalRuntimes: 0,
      }),
      acquireGlobalSlot: vi.fn().mockResolvedValue(true),
      releaseGlobalSlot: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockImplementation(() => {
        mockRuntimes.clear();
        mockProjectIds.length = 0;
        return Promise.resolve(undefined);
      }),
      on: vi.fn().mockReturnThis(),
    };

    mockProjectManagerInstances.push(instance);
    return instance;
  }),
}));

const mockNodeHealthMonitorInstances: Array<{
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  checkAllNodes: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../node-health-monitor.js", () => ({
  NodeHealthMonitor: vi.fn().mockImplementation(() => {
    const instance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      checkAllNodes: vi.fn().mockResolvedValue({
        checked: 0,
        online: 0,
        offline: 0,
        error: 0,
        connecting: 0,
      }),
    };

    mockNodeHealthMonitorInstances.push(instance);
    return instance;
  }),
}));

describe("HybridExecutor", () => {
  let executor: HybridExecutor;
  let mockCentralCore: CentralCore;
  const mockProject: RegisteredProject = {
    id: "proj_test123",
    name: "Test Project",
    path: "/tmp/test-project",
    status: "initializing",
    isolationMode: "in-process",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockCentralCore = {
      listProjects: vi.fn().mockResolvedValue([mockProject]),
      getProject: vi.fn().mockResolvedValue(mockProject),
      registerProject: vi.fn().mockResolvedValue(mockProject),
      unregisterProject: vi.fn().mockResolvedValue(undefined),
      updateProject: vi.fn().mockResolvedValue(mockProject),
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
      updateProjectHealth: vi.fn().mockResolvedValue(undefined),
      logActivity: vi.fn().mockResolvedValue(undefined),
      acquireGlobalSlot: vi.fn().mockResolvedValue(true),
      releaseGlobalSlot: vi.fn().mockResolvedValue(undefined),
      removeAllListeners: vi.fn(),
      on: vi.fn().mockReturnThis(),
    } as unknown as CentralCore;

    executor = new HybridExecutor(mockCentralCore);
  });

  afterEach(async () => {
    try {
      await executor.shutdown();
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
    mockRuntimes.clear();
    mockProjectIds.length = 0;
    mockProjectManagerInstances.length = 0;
    mockNodeHealthMonitorInstances.length = 0;
  });

  describe("initialization", () => {
    it("should start with initialized = false", () => {
      expect(executor.isInitialized()).toBe(false);
    });

    it("should set initialized = true after initialize()", async () => {
      await executor.initialize();
      expect(executor.isInitialized()).toBe(true);
    });

    it("should load existing projects on initialize", async () => {
      await executor.initialize();
      expect(mockCentralCore.listProjects).toHaveBeenCalled();
    });

    it("should forward remote-node assigned projects to ProjectManager for routing", async () => {
      const remoteAssignedProject: RegisteredProject = {
        ...mockProject,
        id: "proj_remote_1",
        name: "Remote Assigned Project",
        status: "active",
        nodeId: "node_remote_1",
      };
      (mockCentralCore.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([
        remoteAssignedProject,
      ]);

      await executor.initialize();

      const manager = mockProjectManagerInstances[0];
      expect(manager?.addProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj_remote_1",
          isolationMode: "in-process",
          workingDirectory: "/tmp/test-project",
        })
      );
    });

    it("should setup CentralCore listeners on initialize", async () => {
      await executor.initialize();
      expect(mockCentralCore.on).toHaveBeenCalledWith(
        "project:registered",
        expect.any(Function)
      );
      expect(mockCentralCore.on).toHaveBeenCalledWith(
        "project:unregistered",
        expect.any(Function)
      );
      expect(mockCentralCore.on).toHaveBeenCalledWith(
        "project:updated",
        expect.any(Function)
      );
    });

    it("should create and start node health monitor on initialize", async () => {
      await executor.initialize();

      expect(mockNodeHealthMonitorInstances).toHaveLength(1);
      expect(mockNodeHealthMonitorInstances[0]?.start).toHaveBeenCalledTimes(1);
      expect(executor.getNodeHealthMonitor()).toBe(mockNodeHealthMonitorInstances[0]);
    });

    it("should be idempotent (initialize multiple times)", async () => {
      await executor.initialize();
      const callCount = (mockCentralCore.listProjects as ReturnType<typeof vi.fn>).mock.calls.length;

      await executor.initialize();
      expect(mockCentralCore.listProjects).toHaveBeenCalledTimes(callCount);
      expect(mockNodeHealthMonitorInstances).toHaveLength(1);
      expect(mockNodeHealthMonitorInstances[0]?.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("project lifecycle", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    beforeEach(async () => {
      await executor.initialize();
    });

    it("should add a project runtime", async () => {
      const runtime = await executor.addProject(testConfig);
      expect(runtime).toBeDefined();
    });

    it("should emit project:added when adding project", async () => {
      const handler = vi.fn();
      executor.on("project:added", handler);

      await executor.addProject(testConfig);

      expect(handler).toHaveBeenCalledWith({
        projectId: "proj_test123",
        projectName: "Test Project",
      });
    });

    it("should remove a project runtime", async () => {
      await executor.addProject(testConfig);
      await executor.removeProject("proj_test123");
      // Should not throw
    });

    it("should emit project:removed when removing project", async () => {
      const handler = vi.fn();
      executor.on("project:removed", handler);

      await executor.addProject(testConfig);
      await executor.removeProject("proj_test123");

      expect(handler).toHaveBeenCalledWith({
        projectId: "proj_test123",
        projectName: "Test Project",
      });
    });

    it("should get a runtime by project ID", async () => {
      await executor.addProject(testConfig);
      const runtime = executor.getRuntime("proj_test123");
      expect(runtime).toBeDefined();
    });

    it("should list all runtimes", async () => {
      await executor.addProject(testConfig);
      const runtimes = executor.listRuntimes();
      expect(Array.isArray(runtimes)).toBe(true);
    });

    it("should get all project IDs", async () => {
      await executor.addProject(testConfig);
      const ids = executor.getProjectIds();
      expect(ids).toContain("proj_test123");
    });
  });

  describe("global metrics", () => {
    beforeEach(async () => {
      await executor.initialize();
    });

    it("should get global metrics", async () => {
      const metrics = await executor.getGlobalMetrics();

      expect(metrics).toHaveProperty("totalInFlightTasks");
      expect(metrics).toHaveProperty("totalActiveAgents");
      expect(metrics).toHaveProperty("runtimeCountByStatus");
      expect(metrics).toHaveProperty("totalRuntimes");
    });
  });

  describe("concurrency slots", () => {
    beforeEach(async () => {
      await executor.initialize();
    });

    it("should acquire global slot", async () => {
      const acquired = await executor.acquireGlobalSlot("proj_test123");
      expect(acquired).toBe(true);
    });

    it("should release global slot", async () => {
      await executor.releaseGlobalSlot("proj_test123");
      // Should not throw
    });
  });

  describe("event forwarding", () => {
    beforeEach(async () => {
      await executor.initialize();
    });

    it("should support task:created event", () => {
      const handler = vi.fn();
      executor.on("task:created", handler);

      // The event should be listenable
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support task:moved event", () => {
      const handler = vi.fn();
      executor.on("task:moved", handler);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support task:updated event", () => {
      const handler = vi.fn();
      executor.on("task:updated", handler);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support error event", () => {
      const handler = vi.fn();
      executor.on("error", handler);
      expect(handler).not.toHaveBeenCalled();
    });

    it("should support health:changed event", () => {
      const handler = vi.fn();
      executor.on("health:changed", handler);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    beforeEach(async () => {
      await executor.initialize();
    });

    it("should set initialized = false after shutdown", async () => {
      await executor.shutdown();
      expect(executor.isInitialized()).toBe(false);
    });

    it("should be safe to call shutdown multiple times", async () => {
      await executor.shutdown();
      await executor.shutdown(); // Should not throw
      expect(executor.isInitialized()).toBe(false);
    });

    it("should remove CentralCore listeners on shutdown", async () => {
      await executor.shutdown();
      expect(mockCentralCore.removeAllListeners).toHaveBeenCalledWith(
        "project:registered"
      );
      expect(mockCentralCore.removeAllListeners).toHaveBeenCalledWith(
        "project:unregistered"
      );
      expect(mockCentralCore.removeAllListeners).toHaveBeenCalledWith(
        "project:updated"
      );
    });

    it("should stop node health monitor before stopping runtimes", async () => {
      const monitor = mockNodeHealthMonitorInstances[0];
      const manager = mockProjectManagerInstances[0];

      await executor.shutdown();

      expect(monitor?.stop).toHaveBeenCalledTimes(1);
      expect(manager?.stopAll).toHaveBeenCalledTimes(1);

      const monitorStopOrder = monitor?.stop.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
      const stopAllOrder = manager?.stopAll.mock.invocationCallOrder[0] ?? Number.MIN_SAFE_INTEGER;
      expect(monitorStopOrder).toBeLessThan(stopAllOrder);
      expect(executor.getNodeHealthMonitor()).toBeNull();
    });
  });

  describe("updateProject", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    beforeEach(async () => {
      await executor.initialize();
      await executor.addProject(testConfig);
    });

    it("should throw if runtime not found", async () => {
      await expect(
        executor.updateProject("non-existent", { maxConcurrent: 4 })
      ).rejects.toThrow("Runtime not found");
    });

    it("reuses the registered project path when isolation mode changes without an explicit working directory", async () => {
      const manager = mockProjectManagerInstances[0];
      manager?.addProject.mockClear();

      await executor.updateProject("proj_test123", { isolationMode: "child-process" });

      expect(mockCentralCore.getProject).toHaveBeenCalledWith("proj_test123");
      expect(manager?.removeProject).toHaveBeenCalledWith("proj_test123");
      expect(manager?.addProject).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "proj_test123",
        workingDirectory: "/tmp/test-project",
        isolationMode: "child-process",
      }));
    });
  });
});
