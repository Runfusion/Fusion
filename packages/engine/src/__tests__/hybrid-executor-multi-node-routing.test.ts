import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore } from "@fusion/core";
import { HybridExecutor } from "../hybrid-executor.js";
import { shouldUseHybridExecutor } from "../hybrid-executor-gate.js";

const projectManagerState = vi.hoisted(() => ({
  projectIds: [] as string[],
  stopAll: vi.fn().mockResolvedValue(undefined),
}));

const nodeHealthState = vi.hoisted(() => ({
  nodes: new Map<string, string>(),
}));

vi.mock("../project-manager.js", () => ({
  ProjectManager: vi.fn().mockImplementation(function () {
    return {
    on: vi.fn(),
    addProject: vi.fn().mockImplementation(async ({ projectId }: { projectId: string }) => {
      projectManagerState.projectIds.push(projectId);
      return { getStatus: () => "running" };
    }),
    getRuntime: vi.fn(),
    listRuntimes: vi.fn().mockReturnValue([]),
    getProjectIds: vi.fn().mockImplementation(() => [...projectManagerState.projectIds]),
    getGlobalMetrics: vi.fn().mockResolvedValue({
      totalProjects: projectManagerState.projectIds.length,
      activeProjects: projectManagerState.projectIds.length,
      totalTasksInProgress: 0,
      totalTasksQueued: 0,
      globalConcurrencyUtilization: 0,
      averageTaskLatencyMs: 0,
      throughputPerMinute: 0,
      errorRate: 0,
    }),
    acquireGlobalSlot: vi.fn().mockResolvedValue(true),
    releaseGlobalSlot: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    stopAll: projectManagerState.stopAll,
    };
  }),
}));

vi.mock("../node-health-monitor.js", () => ({
  NodeHealthMonitor: vi.fn().mockImplementation(function (centralCore: CentralCore) {
    return {
    start: vi.fn().mockImplementation(async () => {
      const nodes = await centralCore.listNodes();
      nodeHealthState.nodes.clear();
      for (const node of nodes) {
        nodeHealthState.nodes.set(node.id, node.status);
      }
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    getNodeHealth: vi.fn().mockImplementation((nodeId: string) => nodeHealthState.nodes.get(nodeId)),
    };
  }),
}));

describe("HybridExecutor multi-node routing", () => {
  const originalEnv = process.env.FUSION_HYBRID_EXECUTOR;
  let tempDir: string;

  beforeEach(() => {
    projectManagerState.projectIds.length = 0;
    projectManagerState.stopAll.mockClear();
    nodeHealthState.nodes.clear();
    delete process.env.FUSION_HYBRID_EXECUTOR;
    tempDir = mkdtempSync(join(tmpdir(), "fn-4775-hybrid-routing-"));
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FUSION_HYBRID_EXECUTOR;
    else process.env.FUSION_HYBRID_EXECUTOR = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createCentralWithProject(projectName: string): Promise<{ central: CentralCore; projectId: string }> {
    const central = new CentralCore(tempDir);
    await central.init();
    const projectPath = join(tempDir, projectName);
    mkdirSync(projectPath, { recursive: true });
    const project = await central.registerProject({ name: projectName, path: projectPath });
    await central.updateProject(project.id, { status: "active" });
    return { central, projectId: project.id };
  }

  it("enables multi-node and initializes with node visibility", async () => {
    const { central, projectId } = await createCentralWithProject("proj-multi-node");
    try {
      const remoteNode = await central.registerNode({
        name: "remote-1",
        type: "remote",
        url: "http://127.0.0.1:5055",
        apiKey: "test-key",
      });

      await expect(shouldUseHybridExecutor(central)).resolves.toEqual({ enabled: true, reason: "multi-node" });

      const executor = new HybridExecutor(central);
      await expect(executor.initialize()).resolves.toBeUndefined();
      expect(executor.getProjectIds()).toEqual([projectId]);
      expect(executor.getNodeHealthMonitor()).not.toBeNull();
      const monitor = executor.getNodeHealthMonitor();
      expect(monitor?.getNodeHealth(remoteNode.id)).toBe("offline");

      await executor.shutdown();
    } finally {
      await central.close();
    }
  });

  it("does NOT auto-enable for local-only multi-project (set FUSION_HYBRID_EXECUTOR=1 to force)", async () => {
    const central = new CentralCore(tempDir);
    await central.init();
    try {
      const projectPathA = join(tempDir, "proj-a");
      const projectPathB = join(tempDir, "proj-b");
      mkdirSync(projectPathA, { recursive: true });
      mkdirSync(projectPathB, { recursive: true });

      const projectA = await central.registerProject({ name: "Project A", path: projectPathA });
      const projectB = await central.registerProject({ name: "Project B", path: projectPathB });
      await central.updateProject(projectA.id, { status: "active" });
      await central.updateProject(projectB.id, { status: "initializing" });

      // FNXC:PgMigrationQuarantine 2026-07-18-01:45: central node rows persist across test
      // instances, so isolate the local-only gate input from a previous test's remote registration.
      vi.spyOn(central, "listNodes").mockResolvedValueOnce([{ id: "local-only", type: "local" }] as any);
      vi.spyOn(central, "listProjects").mockResolvedValue([projectA, projectB] as any);

      // Gate intentionally OFF: ProjectEngineManager handles local
      // multi-project; running HybridExecutor here duplicates InProcessRuntime
      // creation and adds ~7s to cold start.
      await expect(shouldUseHybridExecutor(central)).resolves.toEqual({ enabled: false, reason: "single-node-local-only" });

      // Force-enabled path still works when explicitly initialized.
      const executor = new HybridExecutor(central);
      await executor.initialize();
      expect(new Set(executor.getProjectIds())).toEqual(new Set([projectA.id, projectB.id]));
      await executor.shutdown();
    } finally {
      await central.close();
    }
  });

  it("degrades to central-unavailable when listNodes throws", async () => {
    const { central } = await createCentralWithProject("proj-central-fail");
    try {
      vi.spyOn(central, "listNodes").mockRejectedValueOnce(new Error("central boom"));
      const decision = await shouldUseHybridExecutor(central);
      expect(decision).toEqual({ enabled: false, reason: "central-unavailable" });

      const startup = async () => {
        if (!decision.enabled) return;
        const executor = new HybridExecutor(central);
        await executor.initialize();
      };

      await expect(startup()).resolves.toBeUndefined();
    } finally {
      await central.close();
    }
  });

  it("respects env override=0 over multi-node", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "0";
    const { central } = await createCentralWithProject("proj-env-off");
    try {
      await central.registerNode({
        name: "remote-override",
        type: "remote",
        url: "http://127.0.0.1:5056",
        apiKey: "test-key",
      });

      await expect(shouldUseHybridExecutor(central)).resolves.toEqual({ enabled: false, reason: "env-override" });
    } finally {
      await central.close();
    }
  });
});
