import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, RegisteredProject, Task } from "@fusion/core";
import { ProjectManager } from "./project-manager.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";

// Mock the runtimes
vi.mock("./runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(() => ({
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
  })),
}));

vi.mock("./runtimes/child-process-runtime.js", () => ({
  ChildProcessRuntime: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue("active"),
    getTaskStore: vi.fn().mockImplementation(() => {
      throw new Error("Not accessible in child mode");
    }),
    getScheduler: vi.fn().mockImplementation(() => {
      throw new Error("Not accessible in child mode");
    }),
    getMetrics: vi.fn().mockReturnValue({
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    }),
    on: vi.fn().mockReturnThis(),
  })),
}));

describe("ProjectManager", () => {
  let manager: ProjectManager;
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
      getProject: vi.fn().mockResolvedValue(mockProject),
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
      updateProjectHealth: vi.fn().mockResolvedValue(undefined),
      updateProject: vi.fn().mockResolvedValue({ ...mockProject, status: "active" }),
      logActivity: vi.fn().mockResolvedValue(undefined),
      acquireGlobalSlot: vi.fn().mockResolvedValue(true),
      releaseGlobalSlot: vi.fn().mockResolvedValue(undefined),
    } as unknown as CentralCore;

    manager = new ProjectManager(mockCentralCore);
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      // Ignore errors during cleanup
    }
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("should initialize with empty runtimes", () => {
      expect(manager.listRuntimes()).toHaveLength(0);
      expect(manager.getProjectIds()).toHaveLength(0);
    });

    it("should get global metrics with empty runtimes", async () => {
      const metrics = await manager.getGlobalMetrics();
      expect(metrics.totalRuntimes).toBe(0);
      expect(metrics.totalInFlightTasks).toBe(0);
      expect(metrics.totalActiveAgents).toBe(0);
    });
  });

  describe("addProject", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    it("should throw if project not found in CentralCore", async () => {
      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(manager.addProject(testConfig)).rejects.toThrow(
        "not found in CentralCore"
      );
    });

    it("should throw if runtime already exists", async () => {
      await manager.addProject(testConfig);

      await expect(manager.addProject(testConfig)).rejects.toThrow(
        "Runtime already exists"
      );
    });

    it("should call logActivity after adding project", async () => {
      await manager.addProject(testConfig);

      expect(mockCentralCore.logActivity).toHaveBeenCalled();
    });

    it("should update project health after adding", async () => {
      await manager.addProject(testConfig);

      expect(mockCentralCore.updateProjectHealth).toHaveBeenCalledWith(
        "proj_test123",
        expect.objectContaining({ status: "active" })
      );
    });

    it("should update project status to active after adding", async () => {
      await manager.addProject(testConfig);

      expect(mockCentralCore.updateProject).toHaveBeenCalledWith(
        "proj_test123",
        { status: "active" }
      );
    });
  });

  describe("removeProject", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    it("should throw if runtime not found", async () => {
      await expect(manager.removeProject("non-existent")).rejects.toThrow(
        "Runtime not found"
      );
    });

    it("should remove runtime after adding", async () => {
      await manager.addProject(testConfig);
      expect(manager.listRuntimes()).toHaveLength(1);

      await manager.removeProject("proj_test123");
      expect(manager.listRuntimes()).toHaveLength(0);
    });

    it("should update project health after removing", async () => {
      await manager.addProject(testConfig);
      await manager.removeProject("proj_test123");

      expect(mockCentralCore.updateProjectHealth).toHaveBeenCalledWith(
        "proj_test123",
        expect.objectContaining({ status: "paused" })
      );
    });
  });

  describe("getRuntime", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    it("should return undefined for non-existent runtime", () => {
      expect(manager.getRuntime("non-existent")).toBeUndefined();
    });

    it("should return runtime after adding", async () => {
      await manager.addProject(testConfig);
      const runtime = manager.getRuntime("proj_test123");

      expect(runtime).toBeDefined();
      expect(runtime?.getStatus()).toBe("active");
    });
  });

  describe("global slots", () => {
    it("should acquire global slot", async () => {
      const acquired = await manager.acquireGlobalSlot("proj_test123");

      expect(acquired).toBe(true);
      expect(mockCentralCore.acquireGlobalSlot).toHaveBeenCalledWith("proj_test123");
    });

    it("should release global slot", async () => {
      await manager.releaseGlobalSlot("proj_test123");

      expect(mockCentralCore.releaseGlobalSlot).toHaveBeenCalledWith("proj_test123");
    });

    it("should handle acquire failure gracefully", async () => {
      (mockCentralCore.acquireGlobalSlot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Slot unavailable")
      );

      const acquired = await manager.acquireGlobalSlot("proj_test123");

      expect(acquired).toBe(false);
    });
  });

  describe("event forwarding", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    it("should support runtime:added event", async () => {
      const handler = vi.fn();
      manager.on("runtime:added", handler);

      await manager.addProject(testConfig);

      expect(handler).toHaveBeenCalledWith({
        projectId: "proj_test123",
        projectName: "Test Project",
      });
    });

    it("should support runtime:removed event", async () => {
      const handler = vi.fn();
      manager.on("runtime:removed", handler);

      await manager.addProject(testConfig);
      await manager.removeProject("proj_test123");

      expect(handler).toHaveBeenCalledWith({
        projectId: "proj_test123",
        projectName: "Test Project",
      });
    });
  });

  describe("stopAll", () => {
    it("should stop all runtimes", async () => {
      const config1: ProjectRuntimeConfig = {
        projectId: "proj_1",
        workingDirectory: "/tmp/project1",
        isolationMode: "in-process",
        maxConcurrent: 2,
        maxWorktrees: 4,
      };
      const config2: ProjectRuntimeConfig = {
        projectId: "proj_2",
        workingDirectory: "/tmp/project2",
        isolationMode: "in-process",
        maxConcurrent: 2,
        maxWorktrees: 4,
      };

      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockImplementation(
        (id: string) =>
          Promise.resolve({
            ...mockProject,
            id,
            name: `Project ${id}`,
          })
      );

      await manager.addProject(config1);
      await manager.addProject(config2);

      expect(manager.listRuntimes()).toHaveLength(2);

      await manager.stopAll();

      expect(manager.listRuntimes()).toHaveLength(0);
    });
  });
});
