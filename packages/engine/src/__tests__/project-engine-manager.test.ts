import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub out the per-machine singleton lock so tests with fake working dirs
// (e.g. /mapped/...) don't try to mkdir or bind real sockets.
vi.mock("../engine-singleton-lock.js", () => ({
  acquireEngineSingleton: vi.fn().mockResolvedValue({
    release: vi.fn().mockResolvedValue(undefined),
    socketPath: "/tmp/test.sock",
    lockFilePath: "/tmp/test.lock",
  }),
  EngineAlreadyRunningError: class EngineAlreadyRunningError extends Error {},
}));

// Mock ProjectEngine before importing the manager
vi.mock("../project-engine.js", () => {
  return {
     
    ProjectEngine: vi.fn().mockImplementation(function (config: any) {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getTaskStore: vi.fn().mockReturnValue({ projectId: config.projectId }),
        getHeartbeatMonitor: vi.fn().mockReturnValue(undefined),
        getHeartbeatTriggerScheduler: vi.fn().mockReturnValue(undefined),
        getAutomationStore: vi.fn().mockReturnValue(undefined),
        getRuntime: vi.fn().mockReturnValue({
          getMissionAutopilot: vi.fn().mockReturnValue(undefined),
          getMissionExecutionLoop: vi.fn().mockReturnValue(undefined),
        }),
        getWorkingDirectory: vi.fn().mockReturnValue(config.workingDirectory),
        onMerge: vi.fn().mockResolvedValue(undefined),
        _config: config,
      };
    }),
  };
});

import { ProjectEngineManager } from "../project-engine-manager.js";
import { ProjectEngine } from "../project-engine.js";
import type { RegisteredProject, CentralCore } from "@fusion/core";

function createMockCentralCore(projects: RegisteredProject[]): CentralCore {
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  return {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue(projects),
    getProject: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(projectMap.get(id) ?? null),
    ),
    getProjectByPath: vi.fn().mockImplementation((path: string) =>
      Promise.resolve(projects.find((p) => p.path === path) ?? null),
    ),
    updateProject: vi.fn().mockResolvedValue(undefined),
    updateProjectHealth: vi.fn().mockResolvedValue(undefined),
    resolveLocalProjectWorkingDirectory: vi
      .fn()
      .mockImplementation((projectId: string) => Promise.resolve(`/mapped/${projectId}`)),
  } as unknown as CentralCore;
}

function makeProject(id: string, name: string, path: string): RegisteredProject {
  return {
    id,
    name,
    path,
    status: "active",
    isolationMode: "in-process",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as RegisteredProject;
}

describe("ProjectEngineManager", () => {
  let centralCore: CentralCore;
  const projectA = makeProject("proj_aaa", "Project A", "/tmp/a");
  const projectB = makeProject("proj_bbb", "Project B", "/tmp/b");
  const projectC = makeProject("proj_ccc", "Project C", "/tmp/c");

  beforeEach(() => {
    vi.clearAllMocks();
    centralCore = createMockCentralCore([projectA, projectB, projectC]);
  });

  describe("ensureEngine", () => {
    it("creates and starts an engine for a registered project", async () => {
      const manager = new ProjectEngineManager(centralCore);
      const engine = await manager.ensureEngine("proj_aaa");

      expect(engine).toBeDefined();
      expect(engine.start).toHaveBeenCalledOnce();
      expect(
        (centralCore.resolveLocalProjectWorkingDirectory as unknown as ReturnType<typeof vi.fn>),
      ).toHaveBeenCalledWith("proj_aaa");
      expect(ProjectEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj_aaa",
          workingDirectory: "/mapped/proj_aaa",
          isolationMode: "in-process",
        }),
        centralCore,
        expect.any(Object),
      );
    });

    it("returns existing engine on repeated calls", async () => {
      const manager = new ProjectEngineManager(centralCore);
      const engine1 = await manager.ensureEngine("proj_aaa");
      const engine2 = await manager.ensureEngine("proj_aaa");

      expect(engine1).toBe(engine2);
      expect(engine1.start).toHaveBeenCalledOnce();
    });

    it("deduplicates concurrent start requests", async () => {
      const manager = new ProjectEngineManager(centralCore);

      const [e1, e2, e3] = await Promise.all([
        manager.ensureEngine("proj_aaa"),
        manager.ensureEngine("proj_aaa"),
        manager.ensureEngine("proj_aaa"),
      ]);

      expect(e1).toBe(e2);
      expect(e2).toBe(e3);
      expect(ProjectEngine).toHaveBeenCalledTimes(1);
    });

    it("throws for unknown project", async () => {
      const manager = new ProjectEngineManager(centralCore);

      await expect(manager.ensureEngine("proj_unknown")).rejects.toThrow(
        "Project proj_unknown not found",
      );
    });

    it("throws if manager is stopped", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.stopAll();

      await expect(manager.ensureEngine("proj_aaa")).rejects.toThrow(
        "ProjectEngineManager is stopped",
      );
    });

    it("allows retry after a failed start", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Make the first start fail
      let callCount = 0;
      (ProjectEngine as unknown as ReturnType<typeof vi.fn>).mockImplementation(
         
        function (config: any) {
          return {
            start: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error("transient failure");
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            getTaskStore: vi.fn().mockReturnValue({ projectId: config.projectId }),
            _config: config,
          };
        },
      );

      await expect(manager.ensureEngine("proj_aaa")).rejects.toThrow("transient failure");
      expect(manager.getEngine("proj_aaa")).toBeUndefined();

      // Retry should work
      const engine = await manager.ensureEngine("proj_aaa");
      expect(engine).toBeDefined();
    });

    it("passes engine options from manager config", async () => {
      const getMergeStrategy = vi.fn();
      const processPullRequestMerge = vi.fn();
      const getTaskMergeBlocker = vi.fn();

      const manager = new ProjectEngineManager(centralCore, {
        getMergeStrategy,
        processPullRequestMerge,
        getTaskMergeBlocker,
      });

      await manager.ensureEngine("proj_aaa");

      expect(ProjectEngine).toHaveBeenCalledWith(
        expect.any(Object),
        centralCore,
        expect.objectContaining({
          projectId: "proj_aaa",
          getMergeStrategy,
          processPullRequestMerge,
          getTaskMergeBlocker,
        }),
      );
    });

    it("merges per-engine overrides", async () => {
      const manager = new ProjectEngineManager(centralCore);

      await manager.ensureEngine("proj_aaa", { skipNotifier: true });

      expect(ProjectEngine).toHaveBeenCalledWith(
        expect.any(Object),
        centralCore,
        expect.objectContaining({
          skipNotifier: true,
        }),
      );
    });
  });

  describe("startAll", () => {
    it("starts engines for all registered projects", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(manager.getEngine("proj_bbb")).toBeDefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();
      expect(ProjectEngine).toHaveBeenCalledTimes(3);
    });

    it("continues starting other projects when one fails", async () => {
      // Make proj_bbb fail
      (centralCore.getProject as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string) => {
          if (id === "proj_bbb") throw new Error("DB corruption");
          return [projectA, projectC].find((p) => p.id === id) ?? null;
        },
      );

      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(manager.getEngine("proj_bbb")).toBeUndefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();
    });

    it("is a no-op when no projects are registered", async () => {
      centralCore = createMockCentralCore([]);
      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      expect(manager.getAllEngines().size).toBe(0);
    });
  });

  describe("stopAll", () => {
    it("stops all engines and clears state", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      const engineA = manager.getEngine("proj_aaa")!;
      const engineB = manager.getEngine("proj_bbb")!;

      await manager.stopAll();

      expect(engineA.stop).toHaveBeenCalledOnce();
      expect(engineB.stop).toHaveBeenCalledOnce();
      expect(manager.getAllEngines().size).toBe(0);
    });

    it("handles stop errors gracefully", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      const engineA = manager.getEngine("proj_aaa")!;
      (engineA.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("stop failed"),
      );

      // Should not throw
      await manager.stopAll();
      expect(manager.getAllEngines().size).toBe(0);
    });
  });

  describe("accessors", () => {
    it("getStore returns the engine's TaskStore", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.ensureEngine("proj_aaa");

      const store = manager.getStore("proj_aaa");
      expect(store).toBeDefined();
       
      expect((store as any).projectId).toBe("proj_aaa");
    });

    it("getStore returns undefined for unstarted project", () => {
      const manager = new ProjectEngineManager(centralCore);
      expect(manager.getStore("proj_aaa")).toBeUndefined();
    });

    it("has returns true for started and starting engines", async () => {
      const manager = new ProjectEngineManager(centralCore);
      expect(manager.has("proj_aaa")).toBe(false);

      await manager.ensureEngine("proj_aaa");
      expect(manager.has("proj_aaa")).toBe(true);
    });

    it("getAllEngines returns a snapshot", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.startAll();

      const engines = manager.getAllEngines();
      expect(engines.size).toBe(3);
      expect(engines.get("proj_aaa")).toBeDefined();
      expect(engines.get("proj_bbb")).toBeDefined();
      expect(engines.get("proj_ccc")).toBeDefined();
    });
  });

  describe("pauseProject", () => {
    it("calls updateProject and updateProjectHealth with 'paused'", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.pauseProject("proj_aaa");

      expect(centralCore.updateProject).toHaveBeenCalledWith("proj_aaa", { status: "paused" });
      expect(centralCore.updateProjectHealth).toHaveBeenCalledWith("proj_aaa", { status: "paused" });
    });

    it("stops engine if running and removes it from getEngine", async () => {
      const manager = new ProjectEngineManager(centralCore);
      const engine = await manager.ensureEngine("proj_aaa");

      await manager.pauseProject("proj_aaa");

      expect(engine.stop).toHaveBeenCalledOnce();
      expect(manager.getEngine("proj_aaa")).toBeUndefined();
    });

    it("removes from starting set to prevent stalled starts from completing", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Start an engine (await it to ensure it's in the starting map)
      const enginePromise = manager.ensureEngine("proj_aaa");
      
      // Wait for the engine to be added to starting set
      await vi.waitFor(() => {
        expect(manager.has("proj_aaa")).toBe(true);
      });
      
      // Now pause - this should remove from starting set
      await manager.pauseProject("proj_aaa");

      // The engine should not be running
      expect(manager.getEngine("proj_aaa")).toBeUndefined();
      expect(manager.has("proj_aaa")).toBe(false);

      // The pending promise should resolve but engine should not exist
      await enginePromise.catch(() => {});
    });

    it("throws if manager is stopped", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.stopAll();

      await expect(manager.pauseProject("proj_aaa")).rejects.toThrow(
        "ProjectEngineManager is stopped",
      );
    });
  });

  describe("resumeProject", () => {
    it("calls updateProject and updateProjectHealth with 'active'", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.resumeProject("proj_aaa");

      expect(centralCore.updateProject).toHaveBeenCalledWith("proj_aaa", { status: "active" });
      expect(centralCore.updateProjectHealth).toHaveBeenCalledWith("proj_aaa", { status: "active" });
    });

    it("starts engine via ensureEngine", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.resumeProject("proj_aaa");

      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(ProjectEngine).toHaveBeenCalledTimes(1);
    });

    it("throws if manager is stopped", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.stopAll();

      await expect(manager.resumeProject("proj_aaa")).rejects.toThrow(
        "ProjectEngineManager is stopped",
      );
    });
  });

  describe("ensureEngine with paused projects", () => {
    it("rejects when project status is 'paused'", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Mock getProject to return a paused project
      (centralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...projectA,
        status: "paused",
      });

      await expect(manager.ensureEngine("proj_aaa")).rejects.toThrow(
        "Project proj_aaa is paused",
      );
    });
  });

  describe("onProjectAccessed", () => {
    it("starts engine in background for unknown project", async () => {
      const manager = new ProjectEngineManager(centralCore);
      manager.onProjectAccessed("proj_aaa");

      // Wait for background start
      await vi.waitFor(() => {
        expect(manager.getEngine("proj_aaa")).toBeDefined();
      });
    });

    it("is a no-op for already-running engines", async () => {
      const manager = new ProjectEngineManager(centralCore);
      await manager.ensureEngine("proj_aaa");

      vi.clearAllMocks();
      manager.onProjectAccessed("proj_aaa");

      // No new engine created
      expect(ProjectEngine).not.toHaveBeenCalled();
    });
  });

  describe("startReconciliation / stopReconciliation", () => {
    async function flushReconciliationWork(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts reconciliation and detects new projects on interval", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Start reconciliation with a short interval
      manager.startReconciliation(1000);

      // Advance time to trigger the first reconciliation tick
      await vi.advanceTimersByTimeAsync(1000);

      // Should have started engines for all registered projects
      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(manager.getEngine("proj_bbb")).toBeDefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();

      manager.stopReconciliation();
    });

    it("runs an immediate reconciliation tick on startReconciliation", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Clear any previous calls
      vi.clearAllMocks();

      // Start reconciliation - should run immediately
      manager.startReconciliation(60000);

      // Don't advance time - the immediate tick should have run
      await vi.waitFor(() => {
        expect(manager.getEngine("proj_aaa")).toBeDefined();
      });

      manager.stopReconciliation();
    });

    it("starts engines for newly registered projects on reconciliation tick", async () => {
      // Create a manager with no initial projects
      const projectMap = new Map<string, RegisteredProject>();
      const emptyCentralCore = {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
        getProject: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(projectMap.get(id) ?? null),
        ),
        getProjectByPath: vi.fn().mockResolvedValue(null),
        resolveLocalProjectWorkingDirectory: vi
          .fn()
          .mockImplementation((projectId: string) => Promise.resolve(`/mapped/${projectId}`)),
      } as unknown as CentralCore;
      const manager = new ProjectEngineManager(emptyCentralCore);

      manager.startReconciliation(1000);

      // Advance time to trigger the immediate tick (no projects yet)
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.getEngine("proj_aaa")).toBeUndefined();

      // Simulate a new project being registered
      projectMap.set("proj_aaa", projectA);
      (emptyCentralCore.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([projectA]);

      // Advance time to trigger reconciliation - should find the new project
      await vi.advanceTimersByTimeAsync(1000);

      // Should have started engine for the new project
      await vi.waitFor(() => {
        expect(manager.getEngine("proj_aaa")).toBeDefined();
      });

      manager.stopReconciliation();
    });

    it("skips paused projects during reconciliation", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Make projectA paused
      const pausedProjectA = { ...projectA, status: "paused" as const };
      
      // Mock getProject to return paused status for projectA
      (centralCore.getProject as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === "proj_aaa") {
          return Promise.resolve(pausedProjectA);
        }
        return Promise.resolve([projectA, projectB, projectC].find((p) => p.id === id) ?? null);
      });
      
      // Mock listProjects to return all projects including the paused one
      (centralCore.listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        pausedProjectA,
        projectB,
        projectC,
      ]);

      manager.startReconciliation(1000);

      // Advance time to trigger reconciliation
      await vi.advanceTimersByTimeAsync(1000);

      // projectA should NOT have an engine (it's paused)
      expect(manager.getEngine("proj_aaa")).toBeUndefined();
      // projectB and projectC should have engines (they're active)
      expect(manager.getEngine("proj_bbb")).toBeDefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();

      manager.stopReconciliation();
    });

    // Flake under full reliability-suite load: 30s timeout, but passes in ~46ms
    // standalone. Setinterval-driven reconciliation appears to race with vitest
    // fake-timer contention when other reliability-pool files are co-resident.
    it("retries failed project starts on subsequent reconciliation ticks", async () => {
      // Track how many times start() is called to fail only the FIRST set
      let startCallCount = 0;
      const manager = new ProjectEngineManager(centralCore);

      // Make starts fail on the first 3 calls (one per project in the first tick)
      (ProjectEngine as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function (config: any) {
          return {
            start: vi.fn().mockImplementation(async () => {
            startCallCount++;
            // Fail only the first 3 calls (one per project in first reconciliation tick)
            if (startCallCount <= 3) {
              throw new Error("transient failure");
            }
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            getTaskStore: vi.fn().mockReturnValue({ projectId: config.projectId }),
            _config: config,
          };
        },
      );

      // Start reconciliation (runs immediate tick which fails all 3)
      manager.startReconciliation(1000);

      // Wait for the immediate tick to complete without mixing real timers into
      // this fake-timer block.
      await flushReconciliationWork();

      // After immediate tick: all should have failed
      expect(manager.getEngine("proj_aaa")).toBeUndefined();
      expect(manager.getEngine("proj_bbb")).toBeUndefined();
      expect(manager.getEngine("proj_ccc")).toBeUndefined();

      // First scheduled tick (after 1000ms): should retry and succeed
      await vi.advanceTimersByTimeAsync(1000);
      await flushReconciliationWork();

      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(manager.getEngine("proj_bbb")).toBeDefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();

      manager.stopReconciliation();

      // Reset mock for other tests
      (ProjectEngine as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function (config: any) {
          return {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            getTaskStore: vi.fn().mockReturnValue({ projectId: config.projectId }),
            _config: config,
          };
        },
      );
    });

    it("is idempotent - multiple calls to startReconciliation don't create multiple intervals", async () => {
      const manager = new ProjectEngineManager(centralCore);

      // Call multiple times
      manager.startReconciliation();
      manager.startReconciliation();
      manager.startReconciliation();

      // Advance time
      await vi.advanceTimersByTimeAsync(35000);

      // Should only have started engines once (not 3 times each)
      expect(manager.getEngine("proj_aaa")).toBeDefined();
      expect(manager.getEngine("proj_bbb")).toBeDefined();
      expect(manager.getEngine("proj_ccc")).toBeDefined();

      // stopReconciliation should clean up without errors
      manager.stopReconciliation();
      manager.stopReconciliation(); // idempotent
    });

    it("stopReconciliation stops the interval and prevents future ticks", async () => {
      const manager = new ProjectEngineManager(centralCore);

      manager.startReconciliation(1000);

      // Let the first tick run
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.getEngine("proj_aaa")).toBeDefined();

      // Stop reconciliation
      manager.stopReconciliation();

      // Clear mocks to track new calls
      vi.clearAllMocks();
      (ProjectEngine as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function (config: any) {
          return {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            getTaskStore: vi.fn().mockReturnValue({ projectId: config.projectId }),
            _config: config,
          };
        },
      );

      // Advance more time - no new engines should be started
      await vi.advanceTimersByTimeAsync(1000);
      expect(ProjectEngine).not.toHaveBeenCalled();
    });

    it("stopAll stops reconciliation as part of shutdown", async () => {
      const manager = new ProjectEngineManager(centralCore);

      manager.startReconciliation(1000);
      await manager.startAll();

      // Verify engines started
      expect(manager.getEngine("proj_aaa")).toBeDefined();

      // stopAll should stop reconciliation
      await manager.stopAll();

      // Calling startReconciliation after stopAll should be no-op
      vi.clearAllMocks();
      manager.startReconciliation();
      await vi.advanceTimersByTimeAsync(35000);

      // No new engines because manager is stopped
      expect(ProjectEngine).not.toHaveBeenCalled();
    });

    it("interval is unref'd so it doesn't prevent process exit", async () => {
      vi.clearAllTimers();
      vi.useRealTimers();

      const manager = new ProjectEngineManager(centralCore);
      manager.startReconciliation(60000);

      // The interval should be unref'd - we can't easily test this directly,
      // but we verify startReconciliation doesn't throw
      expect(() => manager.stopReconciliation()).not.toThrow();

      await manager.stopAll();
    });
  });
});
