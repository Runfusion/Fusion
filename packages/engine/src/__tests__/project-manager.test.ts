import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CentralCore, RegisteredProject, Task } from "@fusion/core";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { ChildProcessRuntime } from "../runtimes/child-process-runtime.js";
import { RemoteNodeRuntime } from "../runtimes/remote-node-runtime.js";
import { ProjectManager } from "../project/project-manager.js";
import { ISOLATION_BLOCKER_READ_TIMEOUT_MS } from "../project/isolation-transition-blockers.js";
import type { ProjectRuntimeConfig } from "../project/project-runtime.js";

// Mock the runtimes
vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
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
  }),
}));

vi.mock("../runtimes/child-process-runtime.js", () => ({
  ChildProcessRuntime: vi.fn().mockImplementation(function () {
    return {
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
    };
  }),
}));

vi.mock("../runtimes/remote-node-runtime.js", () => ({
  RemoteNodeRuntime: vi.fn().mockImplementation(function () {
    return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue("active"),
    getTaskStore: vi.fn().mockImplementation(() => {
      throw new Error("TaskStore not accessible for remote node runtime");
    }),
    getScheduler: vi.fn().mockImplementation(() => {
      throw new Error("Scheduler not accessible for remote node runtime");
    }),
    getMetrics: vi.fn().mockReturnValue({
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    }),
    on: vi.fn().mockReturnThis(),
    };
  }),
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
      getNode: vi.fn().mockResolvedValue(undefined),
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

    it("routes to RemoteNodeRuntime when assigned node is remote", async () => {
      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockProject,
        nodeId: "node_remote_1",
      });
      (mockCentralCore.getNode as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "node_remote_1",
        name: "Remote 1",
        type: "remote",
        url: "https://remote.example.com",
        apiKey: "remote-token",
        status: "online",
        maxConcurrent: 4,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await manager.addProject(testConfig);

      expect(RemoteNodeRuntime).toHaveBeenCalledWith({
        nodeConfig: expect.objectContaining({ id: "node_remote_1", type: "remote" }),
        projectId: "proj_test123",
        projectName: "Test Project",
      });
    });

    it("routes to InProcessRuntime when assigned node is local", async () => {
      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockProject,
        nodeId: "node_local_1",
      });
      (mockCentralCore.getNode as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "node_local_1",
        name: "Local 1",
        type: "local",
        status: "online",
        maxConcurrent: 4,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await manager.addProject(testConfig);

      expect(InProcessRuntime).toHaveBeenCalled();
      expect(RemoteNodeRuntime).not.toHaveBeenCalled();
    });

    it("routes to InProcessRuntime when no node assignment exists", async () => {
      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockProject,
        nodeId: undefined,
      });

      await manager.addProject(testConfig);

      expect(InProcessRuntime).toHaveBeenCalled();
      expect(mockCentralCore.getNode).not.toHaveBeenCalled();
    });

    it("falls back to InProcessRuntime and logs warning when assigned node is missing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (mockCentralCore.getProject as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockProject,
        nodeId: "node_missing",
      });
      (mockCentralCore.getNode as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await manager.addProject(testConfig);

      expect(InProcessRuntime).toHaveBeenCalled();
      expect(RemoteNodeRuntime).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[project-manager] Assigned node node_missing not found")
      );

      warnSpy.mockRestore();
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

  /*

  FNXC:CapacityModel 2026-07-28-20:40 (drop the cross-project cap):

  The "global slots" block is DELETED with the acquireGlobalSlot/releaseGlobalSlot

  methods it covered. Measured before removing them: those methods had NO production

  callers — only these tests — so the central-DB `currentlyActive` counter they

  maintained was never incremented by real work. Keeping the tests would have

  pinned a passthrough that nothing calls.

  */

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

  /*
  FNXC:WorktreeLiveness 2026-10-08-06:05 (RUFU-323):
  The restart/isolation-transition guard consumes `metrics.inFlightTasks`, which the runtime now
  derives from LIVE worktree holders rather than the ownership-registry size. These tests pin the
  guard's half of that contract: a zero derived count releases the transition — the shape a landed
  terminal park produces — a non-zero count still refuses with the `active_tasks` payload, and
  `force` still bypasses. The derivation itself is pinned in `project-runtime.test.ts`.
  */
  describe("restartProjectRuntime in-flight guard", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    beforeEach(() => {
      mockCentralCore.resolveLocalProjectWorkingDirectory = vi.fn().mockResolvedValue("/tmp/test-project");
    });

    function stubInFlight(count: number) {
      const runtime = manager.getRuntime("proj_test123") as unknown as {
        getMetrics: ReturnType<typeof vi.fn>;
      };
      runtime.getMetrics.mockReturnValue({
        inFlightTasks: count,
        activeAgents: count,
        lastActivityAt: new Date().toISOString(),
      });
      return runtime;
    }

    it("permits the transition when the only remaining holder is a terminal card", async () => {
      await manager.addProject(testConfig);
      const runtime = stubInFlight(0);

      await manager.restartProjectRuntime("proj_test123", { reason: "isolation-change" });

      // The guard released, the old runtime was stopped, and a fresh one took its place.
      expect(runtime.stop).toHaveBeenCalled();
      expect(manager.getRuntime("proj_test123")).not.toBe(runtime);
    });

    it("refuses while work is genuinely live, naming the live count", async () => {
      await manager.addProject(testConfig);
      const runtime = stubInFlight(2);

      await expect(manager.restartProjectRuntime("proj_test123")).rejects.toEqual(
        expect.objectContaining({ kind: "active_tasks", count: 2 }),
      );

      expect(runtime.stop).not.toHaveBeenCalled();
      expect(manager.getRuntime("proj_test123")).toBe(runtime);
    });

    it("still lets force bypass the guard over live work", async () => {
      await manager.addProject(testConfig);
      const runtime = stubInFlight(2);

      await manager.restartProjectRuntime("proj_test123", { force: true });

      expect(runtime.stop).toHaveBeenCalled();
      expect(manager.getRuntime("proj_test123")).not.toBe(runtime);
    });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-06:20 (RUFU-328):
  The durable half of the same guard. `metrics.inFlightTasks` answers from process memory, and the
  recorded incident was memory that never unwound: two cards whose rows already read `status: "failed"`
  kept the metric above zero and refused every unforced transition for hours, with a payload that named
  nothing. The contract pinned here is the three-way meaning of the new capability, because the dangerous
  direction is a FALSE release:
    - a proven-empty answer releases even though the metric is non-zero (the bug fix);
    - a non-empty answer refuses and names the cards (the diagnosability the reporter asked for);
    - every hostile outcome — no capability, `null`, a throw, or a method that never returns — refuses
      with the EXACT historical `{ kind, count }` shape and no ids, so uncertainty can never buy a restart
      nor hold the transition open past the bound.
  The budget assertions use fake timers: the repo forbids a test that waits on a real timeout.
  */
  describe("restartProjectRuntime durable blocker veto", () => {
    const testConfig: ProjectRuntimeConfig = {
      projectId: "proj_test123",
      workingDirectory: "/tmp/test-project",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };

    beforeEach(() => {
      mockCentralCore.resolveLocalProjectWorkingDirectory = vi.fn().mockResolvedValue("/tmp/test-project");
    });

    /** A runtime whose metric says `count` is busy, plus the optional veto seam the caller may consult. */
    function stubBusyRuntime(
      count: number,
      blockers?: (options?: { budgetMs?: number }) => Promise<unknown>,
    ) {
      const runtime = manager.getRuntime("proj_test123") as unknown as {
        getMetrics: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        getInFlightBlockers?: ReturnType<typeof vi.fn>;
      };
      runtime.getMetrics.mockReturnValue({
        inFlightTasks: count,
        activeAgents: count,
        lastActivityAt: new Date().toISOString(),
      });
      const veto = blockers ? vi.fn(blockers) : undefined;
      if (veto) runtime.getInFlightBlockers = veto;
      return { runtime, veto };
    }

    it("releases the transition when the durable read proves the busy metric is stale", async () => {
      await manager.addProject(testConfig);
      const { runtime, veto } = stubBusyRuntime(1, async () => ({
        taskIds: [],
        reason: "declared-clear",
        // The runtime already paid 600 ms of a 10 000 ms drain out of its own decision.
        drainMs: 9_400,
        contradictedInMemory: ["SANE-435"],
      }));

      await manager.restartProjectRuntime("proj_test123", { reason: "isolation-change" });

      // The guard released even though the in-memory metric said 1, and the veto ran inside the bound.
      expect(veto).toHaveBeenCalledTimes(1);
      expect(veto).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: ISOLATION_BLOCKER_READ_TIMEOUT_MS }));
      expect(runtime.stop).toHaveBeenCalledTimes(1);
      const stopOptions = runtime.stop.mock.calls[0][0] as { drainMs: number };
      expect(typeof stopOptions?.drainMs).toBe("number");
      expect(stopOptions.drainMs).toBeLessThanOrEqual(9_400);
      expect(manager.getRuntime("proj_test123")).not.toBe(runtime);
    });

    it("refuses and names the cards when durable state names them", async () => {
      await manager.addProject(testConfig);
      const { runtime, veto } = stubBusyRuntime(2, async () => ({
        taskIds: ["SANE-435", "SANE-453"],
        reason: "declared-blocked",
        drainMs: 8_000,
      }));

      await expect(manager.restartProjectRuntime("proj_test123")).rejects.toEqual({
        kind: "active_tasks",
        count: 2,
        taskIds: ["SANE-435", "SANE-453"],
      });

      // The refusal is the whole answer: nothing was stopped and the runtime is untouched.
      expect(veto).toHaveBeenCalledTimes(1);
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(manager.getRuntime("proj_test123")).toBe(runtime);
    });

    it("keeps the historical bare-count refusal when the runtime has no durable read path", async () => {
      await manager.addProject(testConfig);
      // No `getInFlightBlockers` on the stub: the shape a transport without the capability presents.
      const { runtime } = stubBusyRuntime(3);

      // Exact equality, not `objectContaining` — this asserts the ids key is ABSENT, so a caller that
      // invents an empty list here would fail instead of reporting "blocked by nothing".
      await expect(manager.restartProjectRuntime("proj_test123")).rejects.toEqual({
        kind: "active_tasks",
        count: 3,
      });
      expect(runtime.stop).not.toHaveBeenCalled();
    });

    it.each([
      { case: "cannot-answer", answer: () => Promise.resolve({ taskIds: null, reason: "store-unavailable" }) },
      { case: "a rejected read", answer: () => Promise.reject(new Error("store down")) },
    ])("refuses conservatively on $case, with the historical shape and no ids", async ({ answer }) => {
      await manager.addProject(testConfig);
      const { runtime } = stubBusyRuntime(2, answer);

      await expect(manager.restartProjectRuntime("proj_test123")).rejects.toEqual({
        kind: "active_tasks",
        count: 2,
      });
      expect(runtime.stop).not.toHaveBeenCalled();
    });

    it("refuses within the budget when the veto never returns, absorbing its late rejection", async () => {
      await manager.addProject(testConfig);
      let rejectLate!: (error: Error) => void;
      const { runtime, veto } = stubBusyRuntime(
        1,
        () => new Promise((_resolve, rejectPromise) => { rejectLate = rejectPromise; }),
      );

      vi.useFakeTimers();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        let refused = false;
        const pending = manager.restartProjectRuntime("proj_test123").catch(() => { refused = true; });

        await vi.advanceTimersByTimeAsync(ISOLATION_BLOCKER_READ_TIMEOUT_MS - 1);
        // One millisecond short of the bound the guard is still (correctly) waiting, not guessing.
        expect(refused).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBeUndefined();
        expect(refused).toBe(true);

        // The abandoned read rejecting after the decision is already made must not surface as an
        // unhandled rejection on the guard's side of the seam.
        rejectLate(new Error("late store failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).not.toHaveBeenCalled();
        expect(veto).toHaveBeenCalledTimes(1);
        expect(runtime.stop).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
        vi.useRealTimers();
      }
    });

    it("never consults the durable read for a force transition or an idle metric", async () => {
      await manager.addProject(testConfig);
      const force = stubBusyRuntime(4, async () => ({ taskIds: [], drainMs: 1 }));

      await manager.restartProjectRuntime("proj_test123", { force: true });

      expect(force.veto).not.toHaveBeenCalled();
      expect(force.runtime.stop).toHaveBeenCalledTimes(1);
      // `force` also keeps the historical unbudgeted shutdown: it never paid for a durable decision.
      expect(force.runtime.stop.mock.calls[0][0]).toBeUndefined();

      // The replacement runtime, now with an idle metric: a busy answer is the only case where the
      // refusal is worth a durable read.
      const idle = stubBusyRuntime(0, async () => ({ taskIds: ["should-not-be-read"], drainMs: 1 }));

      await manager.restartProjectRuntime("proj_test123");

      expect(idle.veto).not.toHaveBeenCalled();
      expect(idle.runtime.stop).toHaveBeenCalledTimes(1);
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
